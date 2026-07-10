import { create } from "zustand";

/**
 * Mimic tab state lives OUTSIDE the component so nothing is lost when the
 * user switches to another properties tab (the tab component unmounts).
 * An in-flight analysis also keeps writing here, so coming back mid-run
 * shows live progress instead of a reset panel.
 */

export interface MimicStats {
	tempoBpm?: number;
	totalBeats?: number;
	scenesDetected?: number;
}

export interface MimicAnalysis {
	referenceName: string;
	summary: string;
	profile: Record<string, unknown>;
}

interface MimicState {
	referenceFile: File | null;
	targetDuration: number;
	selectedAudioId: string;
	isUploading: boolean;
	isProcessing: boolean;
	uploadProgress: number;
	snappedCuts: number[];
	apiMutations: any[];
	mimicStats: MimicStats | null;
	lastAnalysis: MimicAnalysis | null;
	styleName: string;
	applyIntensity: number; // percent, 10–100

	set: (partial: Partial<MimicState>) => void;
	setReferenceFile: (file: File | null) => void;
	clearProposal: () => void;
}

export const useMimicStore = create<MimicState>((set) => ({
	referenceFile: null,
	targetDuration: 30,
	selectedAudioId: "none",
	isUploading: false,
	isProcessing: false,
	uploadProgress: 0,
	snappedCuts: [],
	apiMutations: [],
	mimicStats: null,
	lastAnalysis: null,
	styleName: "",
	applyIntensity: 100,

	set: (partial) => set(partial),
	setReferenceFile: (file) =>
		set({
			referenceFile: file,
			snappedCuts: [],
			apiMutations: [],
			mimicStats: null,
		}),
	clearProposal: () =>
		set({ snappedCuts: [], apiMutations: [], mimicStats: null }),
}));
