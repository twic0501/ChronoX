/**
 * Scene Analysis Web Worker.
 *
 * Runs entirely off the main thread using WebCodecs VideoDecoder + OffscreenCanvas.
 * Two-Pass detection:
 *   1. Coarse Pass: Decode only I-Frames (from stss box) → find candidate regions
 *   2. Fine Pass: Sequential decode in narrow regions → find exact Hard Cut timestamps
 *
 * GOP-safe: Never feeds P/B-Frames without preceding I-Frame to VideoDecoder.
 * Backpressure: Monitors decodeQueueSize to prevent buffer overflow.
 */

/// <reference lib="webworker" />

import { MP4Demuxer } from "./mp4-demuxer";
import { computeRGBHistogram, findCandidateRegions, findExactCut, histogramDistance } from "./histogram";
import type {
	ColorStats,
	FrameStats,
	SceneBoundary,
	WorkerInputMessage,
	WorkerOutputMessage,
} from "./types";

// ─── Color Stats Computation ────────────────────────────────

function computeColorStats(imageData: ImageData): ColorStats {
	const data = imageData.data;
	const pixelCount = data.length / 4;

	let totalBrightness = 0;
	let totalSaturation = 0;
	let totalWarmth = 0;
	const brightnesses: number[] = [];

	// For dominant color extraction (simplified k-means with 3 buckets)
	const colorBuckets: { r: number; g: number; b: number; count: number }[] = [
		{ r: 0, g: 0, b: 0, count: 0 },
		{ r: 0, g: 0, b: 0, count: 0 },
		{ r: 0, g: 0, b: 0, count: 0 },
	];

	// Histogram for shadows/midtones/highlights
	let shadowPixels = 0;
	let midtonePixels = 0;
	let highlightPixels = 0;

	for (let i = 0; i < data.length; i += 4) {
		const r = data[i] / 255;
		const g = data[i + 1] / 255;
		const b = data[i + 2] / 255;

		const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
		totalBrightness += brightness;
		brightnesses.push(brightness);

		const maxVal = Math.max(r, g, b);
		const minVal = Math.min(r, g, b);
		totalSaturation += maxVal - minVal;
		totalWarmth += r - b;

		// Shadows/Midtones/Highlights classification
		if (brightness < 0.25) shadowPixels++;
		else if (brightness < 0.75) midtonePixels++;
		else highlightPixels++;

		// Simple dominant color bucketing by luminance range
		const bucketIdx = brightness < 0.33 ? 0 : brightness < 0.66 ? 1 : 2;
		colorBuckets[bucketIdx].r += data[i];
		colorBuckets[bucketIdx].g += data[i + 1];
		colorBuckets[bucketIdx].b += data[i + 2];
		colorBuckets[bucketIdx].count++;
	}

	const avgBrightness = totalBrightness / pixelCount;
	const avgSaturation = totalSaturation / pixelCount;
	const avgWarmth = totalWarmth / pixelCount;

	// Contrast as standard deviation of brightness
	let sumSqDiff = 0;
	for (const b of brightnesses) {
		sumSqDiff += (b - avgBrightness) ** 2;
	}
	const contrast = Math.min(Math.sqrt(sumSqDiff / pixelCount) * 2, 1);

	// Dominant colors
	const dominantColors = colorBuckets
		.filter((b) => b.count > 0)
		.map((b) => {
			const r = Math.round(b.r / b.count);
			const g = Math.round(b.g / b.count);
			const bl = Math.round(b.b / b.count);
			return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
		});

	return {
		brightness: avgBrightness,
		contrast,
		saturation: avgSaturation,
		warmth: avgWarmth,
		dominantColors,
		histogram: {
			shadows: Math.round((shadowPixels / pixelCount) * 100),
			midtones: Math.round((midtonePixels / pixelCount) * 100),
			highlights: Math.round((highlightPixels / pixelCount) * 100),
		},
	};
}

// ─── Single I-Frame Decoder ─────────────────────────────────

async function decodeSingleKeyframe(
	demuxer: MP4Demuxer,
	config: DemuxedCodecConfig,
	timestamp: number,
): Promise<VideoFrame | null> {
	return new Promise<VideoFrame | null>((resolve) => {
		let resolved = false;
		const decoder = new VideoDecoder({
			output: (frame) => {
				if (!resolved) {
					resolved = true;
					resolve(frame);
				} else {
					frame.close();
				}
			},
			error: () => {
				if (!resolved) {
					resolved = true;
					resolve(null);
				}
			},
		});

		const decoderConfig: VideoDecoderConfig = {
			codec: config.codec,
			codedWidth: config.codedWidth,
			codedHeight: config.codedHeight,
			...(config.description ? { description: config.description } : {}),
		};
		decoder.configure(decoderConfig);

		const chunk = demuxer.getEncodedChunkAtSync(timestamp);
		if (!chunk) {
			resolve(null);
			return;
		}

		decoder.decode(chunk);
		decoder.flush().then(() => {
			if (!resolved) {
				resolved = true;
				resolve(null);
			}
			decoder.close();
		});
	});
}

// ─── Import type for codec config ───────────────────────────

interface DemuxedCodecConfig {
	codec: string;
	codedWidth: number;
	codedHeight: number;
	description?: ArrayBuffer;
}

// ─── Sequential Region Decoder (Fine Pass) ──────────────────

async function decodeRegionSequential(
	demuxer: MP4Demuxer,
	config: DemuxedCodecConfig,
	offscreen: OffscreenCanvas,
	ctx: OffscreenCanvasRenderingContext2D,
	regionStart: number,
	regionEnd: number,
): Promise<FrameStats[]> {
	const stats: FrameStats[] = [];

	return new Promise<FrameStats[]>((resolve) => {
		const decoder = new VideoDecoder({
			output: (frame) => {
				const t = frame.timestamp / 1_000_000;
				// Only process frames within the region of interest
				if (t >= regionStart - 0.05 && t <= regionEnd + 0.05) {
					ctx.drawImage(frame, 0, 0, 64, 64);
					const pixels = ctx.getImageData(0, 0, 64, 64);
					stats.push({
						timestamp: t,
						stats: computeColorStats(pixels),
						rgbHistogram: computeRGBHistogram(pixels),
					});
				}
				frame.close(); // ALWAYS close to free GPU memory
			},
			error: () => {},
		});

		const decoderConfig: VideoDecoderConfig = {
			codec: config.codec,
			codedWidth: config.codedWidth,
			codedHeight: config.codedHeight,
			...(config.description ? { description: config.description } : {}),
		};
		decoder.configure(decoderConfig);

		// Get sequential chunks starting from nearest sync before region
		const chunks = demuxer.getSequentialChunks(regionStart, regionEnd);

		let chunkIdx = 0;

		async function feedChunks() {
			while (chunkIdx < chunks.length) {
				// ═══ BACKPRESSURE: Don't flood the decoder ═══
				while (decoder.decodeQueueSize > 10) {
					await new Promise<void>((r) => setTimeout(r, 5));
				}
				decoder.decode(chunks[chunkIdx]);
				chunkIdx++;
			}
			await decoder.flush();
			decoder.close();
			resolve(stats);
		}

		feedChunks();
	});
}

// ─── Keyframe Extraction for Vision Tagging ─────────────────

async function extractKeyframeBase64(
	demuxer: MP4Demuxer,
	config: DemuxedCodecConfig,
	timestamp: number,
): Promise<string | undefined> {
	const frame = await decodeSingleKeyframe(demuxer, config, timestamp);
	if (!frame) return undefined;

	try {
		const canvas = new OffscreenCanvas(256, 256);
		const ctx = canvas.getContext("2d");
		if (!ctx) return undefined;

		ctx.drawImage(frame, 0, 0, 256, 256);
		frame.close();

		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
		const arrayBuffer = await blob.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);
		let binary = "";
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	} catch {
		frame.close();
		return undefined;
	}
}

// ─── Main Worker Entry ──────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerInputMessage>) => {
	if (e.data.type !== "analyze") return;

	const { fileArrayBuffer } = e.data;

	try {
		// 1. Load and demux the MP4 file
		const demuxer = new MP4Demuxer();
		await demuxer.load(fileArrayBuffer);

		const config = demuxer.getCodecConfig();
		const totalDuration = demuxer.getDuration();
		const syncTimestamps = demuxer.getSyncSampleTimestamps();

		if (syncTimestamps.length === 0) {
			self.postMessage({
				type: "error",
				message: "No sync samples (I-Frames) found in video",
			} satisfies WorkerOutputMessage);
			return;
		}

		// 2. COARSE PASS: Decode only I-Frames
		const offscreen = new OffscreenCanvas(64, 64);
		const ctx = offscreen.getContext("2d")!;
		const coarseStats: FrameStats[] = [];

		for (let i = 0; i < syncTimestamps.length; i++) {
			const t = syncTimestamps[i];
			const frame = await decodeSingleKeyframe(demuxer, config, t);
			if (!frame) continue;

			ctx.drawImage(frame, 0, 0, 64, 64);
			const pixels = ctx.getImageData(0, 0, 64, 64);

			coarseStats.push({
				timestamp: t,
				stats: computeColorStats(pixels),
				rgbHistogram: computeRGBHistogram(pixels),
			});

			frame.close();

			self.postMessage({
				type: "coarse_progress",
				timestamp: t,
				totalSyncSamples: syncTimestamps.length,
				processedSyncSamples: i + 1,
			} satisfies WorkerOutputMessage);
		}

		// 3. Find candidate regions
		const candidateRegions = findCandidateRegions(coarseStats, 0.75);

		// 4. FINE PASS: Frame-by-frame in narrow regions
		const preciseBoundaries: SceneBoundary[] = [];

		for (let i = 0; i < candidateRegions.length; i++) {
			const region = candidateRegions[i];

			self.postMessage({
				type: "fine_progress",
				regionIndex: i,
				totalRegions: candidateRegions.length,
			} satisfies WorkerOutputMessage);

			const fineStats = await decodeRegionSequential(
				demuxer,
				config,
				offscreen,
				ctx,
				region.start,
				region.end,
			);

			const boundary = findExactCut(fineStats, 0.75);
			if (boundary) {
				preciseBoundaries.push(boundary);
			}
		}

		// 5. Build scene segments
		const allBoundaryTimes = [
			0,
			...preciseBoundaries.map((b) => b.timestamp),
			totalDuration,
		].sort((a, b) => a - b);

		// Remove duplicates within 0.1s
		const dedupedTimes: number[] = [allBoundaryTimes[0]];
		for (let i = 1; i < allBoundaryTimes.length; i++) {
			if (allBoundaryTimes[i] - dedupedTimes[dedupedTimes.length - 1] > 0.1) {
				dedupedTimes.push(allBoundaryTimes[i]);
			}
		}

		const scenes = [];
		for (let i = 0; i < dedupedTimes.length - 1; i++) {
			const startTime = dedupedTimes[i];
			const endTime = dedupedTimes[i + 1];

			// Find best coarse frame for this scene's color stats
			const sceneFrames = coarseStats.filter(
				(f) => f.timestamp >= startTime && f.timestamp < endTime,
			);

			// Use the middle frame or fallback to nearest
			const midTime = (startTime + endTime) / 2;
			const representativeFrame =
				sceneFrames.length > 0
					? sceneFrames.reduce((best, f) =>
							Math.abs(f.timestamp - midTime) <
							Math.abs(best.timestamp - midTime)
								? f
								: best,
						)
					: coarseStats.length > 0
					? coarseStats.reduce((best, f) =>
							Math.abs(f.timestamp - midTime) <
							Math.abs(best.timestamp - midTime)
								? f
								: best,
						)
					: null;

			// Extract a 256×256 keyframe for vision tagging
			const nearestSync = demuxer.getNearestSyncBefore(midTime);
			const keyframeBase64 = await extractKeyframeBase64(
				demuxer,
				config,
				nearestSync || startTime,
			);

			scenes.push({
				id: crypto.randomUUID(),
				startTime,
				endTime,
				duration: endTime - startTime,
				colorStats: representativeFrame
					? representativeFrame.stats
					: {
							brightness: 0.5,
							contrast: 0.5,
							saturation: 0.5,
							warmth: 0.0,
							dominantColors: ["#808080"],
							histogram: {
								shadows: 0.33,
								midtones: 0.34,
								highlights: 0.33,
							},
						},
				keyframeBase64,
			});
		}

		// 6. Send final result
		self.postMessage({
			type: "analysis_complete",
			scenes,
			boundaries: preciseBoundaries,
			totalDuration,
		} satisfies WorkerOutputMessage);
	} catch (error) {
		self.postMessage({
			type: "error",
			message: `Scene analysis failed: ${error instanceof Error ? error.message : String(error)}`,
		} satisfies WorkerOutputMessage);
	}
};
