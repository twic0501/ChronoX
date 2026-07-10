import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/lib/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/lib/commands";
import {
	analyzeVideoScenes,
	analyzeScenesViaBackend,
} from "@/lib/ai/scene-analyzer";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	/**
	 * Upload the source file to the backend so server-side tools (scene
	 * detection, mimic, export) have a real filesystem path. Returns the
	 * static /static/... paths, and stamps them onto the asset's File object
	 * so timeline elements inherit sourceOriginalPath/sourceProxyPath.
	 */
	private async uploadToBackend(
		asset: MediaAsset,
	): Promise<{ originalPath?: string; proxyPath?: string }> {
		try {
			const API_URL =
				process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
			const form = new FormData();
			form.append("file", asset.file, asset.name);
			const res = await fetch(`${API_URL}/api/upload`, {
				method: "POST",
				body: form,
			});
			if (!res.ok) throw new Error(`upload ${res.status}`);
			const data = await res.json();
			// Stamp paths so buildElementFromMedia copies them onto the element
			(asset.file as any).originalPath = data.original_path;
			(asset.file as any).proxyPath = data.proxy_path;
			return { originalPath: data.original_path, proxyPath: data.proxy_path };
		} catch (err) {
			console.error(`[MediaManager] Backend upload failed for ${asset.name}:`, err);
			return {};
		}
	}

	private triggerSceneAnalysis(asset: MediaAsset) {
		if (!asset.file) return;
		// Audio assets: upload only (so server-side tools — transcribe, beat
		// detection — can read the file). No scene analysis for audio.
		if (asset.type === "audio") {
			void this.uploadToBackend(asset);
			return;
		}
		if (asset.type !== "video") return;
		console.log(`[MediaManager] Uploading + scene-analyzing ${asset.name}`);

		void (async () => {
			// Upload first so the backend can decode the source (browser
			// WebCodecs chokes on some avcC boxes; server-side ffmpeg does not).
			const { originalPath, proxyPath } = await this.uploadToBackend(asset);
			// Scene detection uses the ORIGINAL (written to disk immediately);
			// the proxy transcodes in the background for playback only.
			const analyzePath = originalPath || proxyPath;

			if (analyzePath) {
				try {
					const sceneMap = await analyzeScenesViaBackend(asset.id, analyzePath, {
						onComplete: (sm) =>
							console.log(`[Scene Analysis Backend] ${asset.name}: ${sm.scenes.length} scenes`),
					});
					toast.success(
						`Finished analyzing ${asset.name}! Detected ${sceneMap.scenes.length} scenes.`,
					);
					return;
				} catch (err) {
					console.error(`[Scene Analysis Backend Error] ${asset.name}:`, err);
					// fall through to the client-side worker as a last resort
				}
			}

			// Fallback: client-side WebCodecs analysis (may fail on bad avcC).
			analyzeVideoScenes(asset.id, asset.file, {
				onComplete: (sceneMap) =>
					toast.success(
						`Finished analyzing ${asset.name}! Detected ${sceneMap.scenes.length} scenes.`,
					),
				onError: (err) =>
					console.error(`[Scene Analysis Error] ${asset.name}:`, err),
			});
		})();
	}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();
		this.triggerSceneAnalysis(newAsset);

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			this.editor.project.ratchetFpsForImportedMedia({
				importedAssets: [newAsset],
			});
			return newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand(projectId, uniqueIds[0])
				: new BatchCommand(
						uniqueIds.map((id) => new RemoveMediaAssetCommand(projectId, id)),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;
			this.notify();

			// Trigger scene analysis in background for all video files
			mediaAssets.forEach((asset) => {
				this.triggerSceneAnalysis(asset);
			});
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
