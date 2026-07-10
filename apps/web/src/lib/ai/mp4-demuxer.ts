/**
 * MP4 Demuxer wrapper using mp4box.js.
 *
 * Key capabilities:
 * - Extract codec configuration for VideoDecoder
 * - Read stss (Sync Sample Box) to find I-Frame timestamps
 * - Provide encoded chunks for both random I-Frame access and sequential decode
 */

import * as MP4Box from "mp4box";

export interface DemuxedCodecConfig {
	codec: string;
	codedWidth: number;
	codedHeight: number;
	description?: ArrayBuffer;
}

export class MP4Demuxer {
	private file: any;
	private info: any = null;
	private samples: any[] = [];
	private resolveReady!: () => void;
	private ready: Promise<void>;
	private trackId = 0;

	constructor() {
		this.file = (MP4Box as any).createFile();
		this.ready = new Promise<void>((resolve) => {
			this.resolveReady = resolve;
		});

		this.file.onReady = (info: any) => {
			this.info = info;
			// Find the first video track
			const videoTrack = info.tracks.find(
				(t: any) => t.type === "video" || t.codec?.startsWith("avc") || t.codec?.startsWith("hev") || t.codec?.startsWith("hvc"),
			);
			if (videoTrack) {
				this.trackId = videoTrack.id;
				// Enable extraction to collect samples
				this.file.setExtractionOptions(this.trackId, null, {
					nbSamples: Infinity,
				});
				// CRITICAL: Start extraction immediately so that subsequent parts of the
				// buffer appended by appendBuffer will trigger onSamples.
				this.file.start();
			}
			this.resolveReady();
		};

		this.file.onSamples = (
			_trackId: number,
			_user: any,
			samples: any[],
		) => {
			this.samples.push(...samples);
		};
	}

	/** Feed an ArrayBuffer of file data to the demuxer. */
	async load(arrayBuffer: ArrayBuffer): Promise<void> {
		const buf = arrayBuffer as any;
		buf.fileStart = 0;
		this.file.appendBuffer(buf);
		this.file.flush();
		await this.ready;

		// Wait a short tick for any remaining async calls, then stop extraction
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		this.file.stop();
	}

	/** Get VideoDecoder configuration from the video track. */
	getCodecConfig(): DemuxedCodecConfig {
		if (!this.info) throw new Error("MP4 not loaded");

		const videoTrack = this.info.tracks.find(
			(t: any) => t.id === this.trackId,
		);
		if (!videoTrack) throw new Error("No video track found");

		// Build codec string
		const codec = videoTrack.codec;
		const codedWidth = (videoTrack as any).video?.width ?? (videoTrack as any).track_width ?? 1920;
		const codedHeight = (videoTrack as any).video?.height ?? (videoTrack as any).track_height ?? 1080;

		// Extract description (SPS/PPS for H.264, VPS/SPS/PPS for H.265)
		let description: ArrayBuffer | undefined;
		const trak = this.file.getTrackById(this.trackId);
		if (trak) {
			const entry = (trak as any).mdia?.minf?.stbl?.stsd?.entries?.[0];
			if (entry) {
				const avcC = entry.avcC ?? entry.hvcC;
				if (avcC) {
					const DataStream = (MP4Box as any).DataStream;
					const stream = new DataStream(
						undefined,
						0,
						DataStream.BIG_ENDIAN || false,
					);
					avcC.write(stream);
					description = stream.buffer.slice(0, stream.position);
				}
			}
		}

		return { codec, codedWidth, codedHeight, description };
	}

	/** Get total duration in seconds. */
	getDuration(): number {
		if (!this.info) return 0;
		return (this.info.duration ?? 0) / (this.info.timescale ?? 1000);
	}

	/**
	 * Get timestamps of all sync samples (I-Frames) from the stss box.
	 * These are the only frames that can be independently decoded.
	 */
	getSyncSampleTimestamps(): number[] {
		const timescale = this.getTrackTimescale();
		return this.samples
			.filter((s) => s.is_sync)
			.map((s) => s.cts / timescale);
	}

	/**
	 * Get encoded chunk for a specific sync sample timestamp.
	 * Only returns I-Frames (sync=true) that can be decoded independently.
	 */
	getEncodedChunkAtSync(timestamp: number): EncodedVideoChunk | null {
		const timescale = this.getTrackTimescale();
		const sample = this.samples.find(
			(s) => s.is_sync && Math.abs(s.cts / timescale - timestamp) < 0.1,
		);
		if (!sample) return null;
		return this.sampleToChunk(sample);
	}

	/**
	 * Get the nearest sync sample timestamp at or before the given time.
	 * Used by Fine Pass to start sequential decode from a valid I-Frame.
	 */
	getNearestSyncBefore(timestamp: number): number {
		const timescale = this.getTrackTimescale();
		let best = 0;
		for (const s of this.samples) {
			if (!s.is_sync) continue;
			const t = s.cts / timescale;
			if (t <= timestamp && t > best) best = t;
		}
		return best;
	}

	/**
	 * Get all encoded chunks (sequential, including P/B-Frames) between
	 * [startTime, endTime]. Starts from the nearest sync sample before startTime
	 * to ensure GOP integrity.
	 */
	getSequentialChunks(startTime: number, endTime: number): EncodedVideoChunk[] {
		const timescale = this.getTrackTimescale();
		const nearestSync = this.getNearestSyncBefore(startTime);
		const chunks: EncodedVideoChunk[] = [];

		for (const sample of this.samples) {
			const t = sample.cts / timescale;
			if (t < nearestSync) continue;
			if (t > endTime + 0.5) break;
			chunks.push(this.sampleToChunk(sample));
		}

		return chunks;
	}

	private getTrackTimescale(): number {
		if (!this.info) return 1;
		const track = this.info.tracks.find((t: any) => t.id === this.trackId);
		return (track as any)?.timescale ?? 1;
	}

	private sampleToChunk(sample: any): EncodedVideoChunk {
		return new EncodedVideoChunk({
			type: sample.is_sync ? "key" : "delta",
			timestamp: (sample.cts / this.getTrackTimescale()) * 1_000_000, // seconds → μs
			duration:
				(sample.duration / this.getTrackTimescale()) * 1_000_000,
			data: sample.data,
		});
	}
}
