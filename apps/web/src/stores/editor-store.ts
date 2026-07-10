import { create } from "zustand";
import { DEFAULT_CANVAS_PRESETS } from "@/constants/project-constants";
import type { TCanvasSize } from "@/lib/project/types";
import type { TimelineElement } from "@/lib/timeline/types";

export type GhostClip = Partial<TimelineElement> & {
	id: string;
	trackId: string;
	start: number;
	end: number;
	type: string;
	label: string;
	originalClipId?: string;
	operationId: string;
	isInvalid: boolean;
	operationData?: any;
};

export interface Keyframe {
	id: string;
	time: number;
	value: number;
	interpolation: string;
}

export interface ActiveOperation {
	id: string;
	type: string;
	label: string;
	enabled: boolean;
	data?: any;
}

interface EditorState {
	isInitializing: boolean;
	isPanelsReady: boolean;
	canvasPresets: TCanvasSize[];
	isTimelineLocked: boolean;
	ghostClips: GhostClip[];
	ghostKeyframes: Record<string, Keyframe[]>;
	activeOperations: ActiveOperation[];
	aiMode: "local" | "cloud";
	// Global AI activity so any surface (header, timeline) can show a
	// non-blocking "AI is working" state — the user keeps editing in parallel.
	aiStatus: "idle" | "running";
	aiStatusLabel: string;
	setAiStatus: (status: "idle" | "running", label?: string) => void;
	chatMessages: any[];
	setChatMessages: (msgs: any[] | ((prev: any[]) => any[])) => void;
	setInitializing: (loading: boolean) => void;
	setPanelsReady: (ready: boolean) => void;
	setTimelineLocked: (locked: boolean) => void;
	setGhostClips: (clips: GhostClip[]) => void;
	clearGhostClips: () => void;
	setAiMode: (mode: "local" | "cloud") => void;
	initializeApp: () => Promise<void>;

	// Ghost State Actions
	setGhostStateFromStream: (partialOps: any[], tracks?: any[]) => void;
	toggleOperation: (id: string, enabled: boolean) => void;
	commitGhostClips: (editor: any) => void;
	clearGhostState: () => void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
	isInitializing: true,
	isPanelsReady: false,
	canvasPresets: DEFAULT_CANVAS_PRESETS,
	isTimelineLocked: false,
	ghostClips: [],
	ghostKeyframes: {},
	activeOperations: [],
	aiMode: "local",
	aiStatus: "idle",
	aiStatusLabel: "",
	setAiStatus: (status, label) =>
		set({ aiStatus: status, aiStatusLabel: label ?? "" }),
	chatMessages: [
		{
			id: "welcome",
			role: "system",
			content: "ChronoX AI is ready. Send a command to start editing.",
		}
	],
	setChatMessages: (msgs) => set((state) => ({
		chatMessages: typeof msgs === "function" ? msgs(state.chatMessages) : msgs
	})),
	setInitializing: (loading) => set({ isInitializing: loading }),
	setPanelsReady: (ready) => set({ isPanelsReady: ready }),
	setTimelineLocked: (locked) => set({ isTimelineLocked: locked }),
	setGhostClips: (clips) => set({ ghostClips: clips }),
	clearGhostClips: () => set({ ghostClips: [], ghostKeyframes: {}, activeOperations: [] }),
	setAiMode: (mode) => set({ aiMode: mode }),
	initializeApp: async () => {
		set({ isInitializing: true, isPanelsReady: false });
		set({ isPanelsReady: true, isInitializing: false });
	},

	// Ghost State Actions
	setGhostStateFromStream: (partialOps: any[], tracks?: any[]) => {
		// Compiles stream operations into checklist and ghost clips.
		// opId MUST be unique per operation (index-based): multiple ops often
		// target the same clip_id (e.g. split + color + speed on one clip).
		const operations: ActiveOperation[] = [];
		const clips: GhostClip[] = [];
		const keyframes: Record<string, Keyframe[]> = {};

		// Resolve which real track/clip an operation points at, so the ghost
		// preview lands on the actual working area instead of a placeholder.
		const resolveTarget = (op: any): { trackId?: string; element?: any } => {
			if (!tracks || tracks.length === 0) return {};
			const identifier = op.clip_id || op.clipId || op.clip_name || op.name;
			if (identifier) {
				const searchStr = String(identifier).toLowerCase();
				for (const t of tracks) {
					const found = t.elements?.find(
						(e: any) =>
							e.id === identifier ||
							e.name?.toLowerCase().includes(searchStr)
					);
					if (found) return { trackId: t.id, element: found };
				}
			}
			return {};
		};

		partialOps.forEach((op, index) => {
			if (!op || typeof op.action !== "string") return;
			const opId = `op_${index}_${op.action}`;

			operations.push({
				id: opId,
				type: op.action,
				label: `${op.action.toUpperCase()} ${op.clip_id ? `(${String(op.clip_id).substring(0, 6)})` : ""}`,
				enabled: true,
				data: op,
			});

			// Parse ghost clip
			if (op.action === "trim" || op.action === "split" || op.action === "add_overlay" || op.action === "transform" || op.action === "change_speed") {
				const target = resolveTarget(op);
				const anchorStart = target.element?.startTime ?? 0;
				const anchorDur = target.element?.duration ?? 5.0;
				clips.push({
					id: `ghost_${opId}`,
					trackId: target.trackId || op.trackId || "main_video",
					start: typeof op.start === "number" ? op.start : (typeof op.time === "number" ? op.time : anchorStart),
					end: typeof op.end === "number" ? op.end : (typeof op.start === "number" ? op.start + (op.duration || 5.0) : anchorStart + anchorDur),
					type: op.overlay_type || "video",
					label: `${op.action} Preview`,
					originalClipId: op.clip_id,
					operationId: opId,
					isInvalid: !tracks || tracks.length === 0 ? false : !target.element && !!op.clip_id,
					operationData: op,
				});
			}
		});

		set({
			activeOperations: operations,
			ghostClips: clips,
			ghostKeyframes: keyframes,
		});
	},

	toggleOperation: (id: string, enabled: boolean) => {
		const updatedOps = get().activeOperations.map((op) =>
			op.id === id ? { ...op, enabled } : op
		);
		
		// Filter ghost clips based on enabled operations
		const enabledOpIds = new Set(updatedOps.filter((o) => o.enabled).map((o) => o.id));
		const updatedClips = get().ghostClips.map((clip) => ({
			...clip,
			isInvalid: !enabledOpIds.has(clip.operationId),
		}));

		set({
			activeOperations: updatedOps,
			ghostClips: updatedClips,
		});
	},

	commitGhostClips: (editor: any) => {
		// Apply all enabled operations to actual editor using commands
		const enabledOps = get().activeOperations.filter((op) => op.enabled);
		if (enabledOps.length === 0) return;

		// We will trigger BatchCommand inside chat-sidebar.tsx where the editor context is fully available.
		// So this action can be called and cleared.
		get().clearGhostState();
	},

	clearGhostState: () => {
		set({
			ghostClips: [],
			ghostKeyframes: {},
			activeOperations: [],
		});
	},
}));

// Dev-only inspection/testing handle (Playwright etc.), matching window.__chronox.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
	(window as any).__chronoxStore = useEditorStore;
}
