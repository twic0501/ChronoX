/**
 * Scene Analyzer — Main Thread Orchestrator.
 *
 * Spawns the scene-analysis.worker.ts Web Worker, feeds it the video file,
 * and collects results. After Two-Pass scene detection completes,
 * triggers Gemma4 Vision content tagging for each scene.
 */

import type {
	SceneSegment,
	VideoSceneMap,
	WorkerInputMessage,
	WorkerOutputMessage,
} from "./types";
import { tagAllScenes } from "./content-tagger";

export interface SceneAnalysisCallbacks {
	onCoarseProgress?: (processed: number, total: number) => void;
	onFineProgress?: (regionIndex: number, totalRegions: number) => void;
	onVisionTagging?: (processed: number, total: number) => void;
	onComplete?: (sceneMap: VideoSceneMap) => void;
	onError?: (message: string) => void;
}

// Cache scene maps by mediaId to avoid re-analysis
const sceneMapCache = new Map<string, VideoSceneMap>();

/**
 * Analyze a video file to detect scenes and extract per-scene color statistics.
 *
 * @param mediaId - Unique media identifier from the timeline
 * @param file - The video File object (from OPFS or file input)
 * @param callbacks - Progress and completion callbacks
 * @returns The completed VideoSceneMap
 */
export async function analyzeVideoScenes(
	mediaId: string,
	file: File,
	callbacks?: SceneAnalysisCallbacks,
): Promise<VideoSceneMap> {
	// Check cache first
	const cached = sceneMapCache.get(mediaId);
	if (cached) {
		callbacks?.onComplete?.(cached);
		return cached;
	}

	return new Promise<VideoSceneMap>(async (resolve, reject) => {
		try {
			// Read file into ArrayBuffer for transfer to Worker
			const arrayBuffer = await file.arrayBuffer();

			// Spawn worker
			const worker = new Worker(
				new URL("./scene-analysis.worker.ts", import.meta.url),
				{ type: "module" },
			);

			worker.onmessage = async (
				e: MessageEvent<WorkerOutputMessage>,
			) => {
				const msg = e.data;

				switch (msg.type) {
					case "coarse_progress":
						callbacks?.onCoarseProgress?.(
							msg.processedSyncSamples,
							msg.totalSyncSamples,
						);
						break;

					case "fine_progress":
						callbacks?.onFineProgress?.(
							msg.regionIndex,
							msg.totalRegions,
						);
						break;

					case "analysis_complete": {
						worker.terminate();

						// Stage 2: Vision tagging with Gemma4
						const scenesForTagging: SceneSegment[] = msg.scenes.map(
							(s) => ({
								...s,
								contentTag: "", // Will be filled by vision
							}),
						);

						let taggedScenes: SceneSegment[];

						try {
							const tags = await tagAllScenes(
								scenesForTagging,
								(processed, total) => {
									callbacks?.onVisionTagging?.(
										processed,
										total,
									);
								},
							);

							taggedScenes = scenesForTagging.map((scene) => {
								const tag = tags.find(
									(t) => t.sceneId === scene.id,
								);
								return {
									...scene,
									contentTag:
										tag?.tag ?? "unknown scene",
								};
							});
						} catch {
							// Vision tagging failed — use fallback tags
							taggedScenes = scenesForTagging.map((scene) => ({
								...scene,
								contentTag: "untagged scene",
							}));
						}

						const sceneMap: VideoSceneMap = {
							mediaId,
							totalDuration: msg.totalDuration,
							scenes: taggedScenes,
							boundaries: msg.boundaries,
							analyzedAt: new Date(),
						};

						// Cache the result
						sceneMapCache.set(mediaId, sceneMap);

						callbacks?.onComplete?.(sceneMap);
						resolve(sceneMap);
						break;
					}

					case "error":
						worker.terminate();
						callbacks?.onError?.(msg.message);
						reject(new Error(msg.message));
						break;
				}
			};

			worker.onerror = (e) => {
				worker.terminate();
				const message = `Worker error: ${e.message}`;
				callbacks?.onError?.(message);
				reject(new Error(message));
			};

			// Send file to worker (transfer ownership of ArrayBuffer)
			worker.postMessage(
				{
					type: "analyze",
					fileArrayBuffer: arrayBuffer,
					fileName: file.name,
				} satisfies WorkerInputMessage,
				[arrayBuffer],
			);
		} catch (error) {
			const message = `Failed to start scene analysis: ${error instanceof Error ? error.message : String(error)}`;
			callbacks?.onError?.(message);
			reject(new Error(message));
		}
	});
}

/**
 * Server-side scene analysis. Sends the media path to the backend, which runs
 * ffmpeg/PySceneDetect/cv2 — this works on source files whose avcC box the
 * browser's WebCodecs decoder cannot parse (the client-worker path fails on
 * those). Returns a VideoSceneMap compatible with the LLM prompt formatter.
 */
export async function analyzeScenesViaBackend(
	mediaId: string,
	videoPath: string,
	callbacks?: SceneAnalysisCallbacks,
): Promise<VideoSceneMap> {
	const cached = sceneMapCache.get(mediaId);
	if (cached) {
		callbacks?.onComplete?.(cached);
		return cached;
	}

	const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
	const res = await fetch(`${API_URL}/api/ai/scene-map`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ video_path: videoPath }),
	});
	if (!res.ok) {
		const msg = `Scene-map backend failed: ${res.status}`;
		callbacks?.onError?.(msg);
		throw new Error(msg);
	}
	const data = await res.json();

	const scenes: SceneSegment[] = (data.scenes ?? []).map(
		(s: any, i: number): SceneSegment => ({
			id: `${mediaId}_scene_${i}`,
			startTime: s.start ?? 0,
			endTime: s.end ?? 0,
			duration: s.duration ?? Math.max(0, (s.end ?? 0) - (s.start ?? 0)),
			contentTag: s.contentTag ?? "scene",
			colorStats: {
				brightness: s.colorStats?.brightness ?? 0.5,
				contrast: s.colorStats?.contrast ?? 0.1,
				saturation: s.colorStats?.saturation ?? 0.1,
				warmth: s.colorStats?.warmth ?? 0,
				dominantColors: s.colorStats?.dominantColors ?? [],
				histogram: {
					shadows: s.colorStats?.histogram?.shadows ?? 33,
					midtones: s.colorStats?.histogram?.midtones ?? 34,
					highlights: s.colorStats?.histogram?.highlights ?? 33,
				},
			},
		}),
	);

	const sceneMap: VideoSceneMap = {
		mediaId,
		totalDuration: data.totalDuration ?? (scenes.at(-1)?.endTime ?? 0),
		scenes,
		boundaries: [],
		analyzedAt: new Date(),
	};
	sceneMapCache.set(mediaId, sceneMap);
	callbacks?.onComplete?.(sceneMap);
	return sceneMap;
}

/**
 * Get cached scene map for a media ID, if available.
 */
export function getCachedSceneMap(mediaId: string): VideoSceneMap | undefined {
	return sceneMapCache.get(mediaId);
}

/**
 * Clear cached scene map for a media ID.
 */
export function clearSceneMapCache(mediaId: string): void {
	sceneMapCache.delete(mediaId);
}

/**
 * Format a VideoSceneMap into the text format expected by the LLM prompt.
 */
export function formatSceneMapForPrompt(
	sceneMap: VideoSceneMap,
	clipName: string,
	timeRange?: [number, number],
): string {
	let filteredScenes = sceneMap.scenes;

	// Apply time_range filter if provided
	if (timeRange) {
		filteredScenes = sceneMap.scenes.filter(
			(s) => s.endTime > timeRange[0] && s.startTime < timeRange[1],
		);
	}

	const lines: string[] = [
		`=== VIDEO SCENE ANALYSIS ===`,
		`Clip "${clipName}" (${sceneMap.totalDuration.toFixed(1)}s, ${filteredScenes.length} scenes):`,
		``,
	];

	for (let i = 0; i < filteredScenes.length; i++) {
		const s = filteredScenes[i];
		const cs = s.colorStats;
		lines.push(
			`Scene ${i + 1} [${s.startTime.toFixed(1)}s → ${s.endTime.toFixed(1)}s] — "${s.contentTag}"`,
		);
		lines.push(
			`  brightness=${cs.brightness.toFixed(2)}, contrast=${cs.contrast.toFixed(2)}, saturation=${cs.saturation.toFixed(2)}, warmth=${cs.warmth.toFixed(2)}`,
		);
		lines.push(`  dominant: ${cs.dominantColors.join(", ")}`);
		lines.push(
			`  histogram: shadows=${cs.histogram.shadows}%, midtones=${cs.histogram.midtones}%, highlights=${cs.histogram.highlights}%`,
		);
		lines.push(``);
	}

	lines.push(`=== END ANALYSIS ===`);
	return lines.join("\n");
}
