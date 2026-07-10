// ─── Scene Analysis Types ───────────────────────────────────

/** Color statistics computed from a 64×64 downscaled frame. */
export interface ColorStats {
	brightness: number; // 0–1
	contrast: number; // 0–1
	saturation: number; // 0–1
	warmth: number; // -1 to 1 (positive=warm, negative=cool)
	dominantColors: string[]; // hex, top 3
	histogram: {
		shadows: number; // % pixels in dark range
		midtones: number;
		highlights: number;
	};
}

/** Frame-level statistics with raw histogram for scene detection. */
export interface FrameStats {
	timestamp: number; // seconds
	stats: ColorStats;
	rgbHistogram: number[]; // 48 values: 3 channels × 16 bins
}

/** A detected scene boundary. */
export interface SceneBoundary {
	timestamp: number; // seconds — first frame of the new scene
	type: "hard_cut";
	confidence: number; // histogram distance value (0–1)
}

/** A candidate region found during Coarse Pass that needs Fine Pass refinement. */
export interface CandidateRegion {
	start: number; // seconds — timestamp of frame before spike
	end: number; // seconds — timestamp of frame after spike
}

/** A complete scene segment with color stats and content tag. */
export interface SceneSegment {
	id: string;
	startTime: number;
	endTime: number;
	duration: number;
	colorStats: ColorStats;
	contentTag: string; // FROM Gemma4 Vision
	keyframeBase64?: string; // 256×256 JPEG for vision tagging
}

/** Complete scene map for a video. */
export interface VideoSceneMap {
	mediaId: string;
	totalDuration: number;
	scenes: SceneSegment[];
	boundaries: SceneBoundary[];
	analyzedAt: Date;
}

// ─── Worker Messages ────────────────────────────────────────

export interface WorkerInputMessage {
	type: "analyze";
	fileArrayBuffer: ArrayBuffer;
	fileName: string;
}

export interface WorkerCoarseProgressMessage {
	type: "coarse_progress";
	timestamp: number;
	totalSyncSamples: number;
	processedSyncSamples: number;
}

export interface WorkerFineProgressMessage {
	type: "fine_progress";
	regionIndex: number;
	totalRegions: number;
}

export interface WorkerCompleteMessage {
	type: "analysis_complete";
	scenes: Omit<SceneSegment, "contentTag">[];
	boundaries: SceneBoundary[];
	totalDuration: number;
}

export interface WorkerErrorMessage {
	type: "error";
	message: string;
}

export type WorkerOutputMessage =
	| WorkerCoarseProgressMessage
	| WorkerFineProgressMessage
	| WorkerCompleteMessage
	| WorkerErrorMessage;
