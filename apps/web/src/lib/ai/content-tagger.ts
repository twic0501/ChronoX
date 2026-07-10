import type { SceneSegment } from "./types";

// Custom browser-safe pLimit implementation to avoid Node async_hooks import errors
function pLimit(concurrency: number) {
	const queue: (() => void)[] = [];
	let activeCount = 0;

	const next = () => {
		activeCount--;
		if (queue.length > 0) {
			const fn = queue.shift()!;
			fn();
		}
	};

	const run = async <T>(fn: () => Promise<T>): Promise<T> => {
		activeCount++;
		try {
			return await fn();
		} finally {
			next();
		}
	};

	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const task = () => {
				run(fn).then(resolve).catch(reject);
			};

			if (activeCount < concurrency) {
				task();
			} else {
				queue.push(task);
			}
		});
	};

	return enqueue;
}

// Max 2 concurrent vision requests to prevent GPU OOM
const visionLimiter = pLimit(2);

export interface ContentTagResult {
	sceneId: string;
	tag: string;
}

/**
 * Tag all scenes with semantic content descriptions using Gemma4 Vision.
 *
 * @param scenes - Scene segments with keyframeBase64 field populated
 * @param onProgress - Progress callback (processed, total)
 * @returns Array of scene IDs mapped to their content tags
 */
export async function tagAllScenes(
	scenes: SceneSegment[],
	onProgress?: (processed: number, total: number) => void,
): Promise<ContentTagResult[]> {
	// Filter scenes that have keyframe images
	const scenesWithImages = scenes.filter((s) => s.keyframeBase64);

	if (scenesWithImages.length === 0) {
		// No images available — return generic tags
		return scenes.map((s) => ({ sceneId: s.id, tag: "untagged scene" }));
	}

	let processed = 0;
	const total = scenesWithImages.length;

	const tagPromises = scenesWithImages.map((scene) =>
		visionLimiter(async (): Promise<ContentTagResult> => {
			try {
				const response = await fetch(
					"http://127.0.0.1:8000/api/vision-tag",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							image: scene.keyframeBase64,
						}),
					},
				);

				processed++;
				onProgress?.(processed, total);

				if (!response.ok) {
					return { sceneId: scene.id, tag: "unknown scene" };
				}

				const data = await response.json();
				return {
					sceneId: scene.id,
					tag: data.tag || "unknown scene",
				};
			} catch {
				processed++;
				onProgress?.(processed, total);
				return { sceneId: scene.id, tag: "unknown scene" };
			}
		}),
	);

	const taggedResults = await Promise.all(tagPromises);

	// Merge results: scenes with images get their tags, others get "untagged"
	const tagMap = new Map<string, string>();
	for (const result of taggedResults) {
		tagMap.set(result.sceneId, result.tag);
	}

	return scenes.map((s) => ({
		sceneId: s.id,
		tag: tagMap.get(s.id) ?? "untagged scene",
	}));
}
