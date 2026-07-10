import { create } from "zustand";

type TranscodeStatus = "idle" | "loading" | "transcoding" | "success" | "error";

interface TranscodeState {
	isOpen: boolean;
	fileName: string;
	progress: number;
	status: TranscodeStatus;
	error: string | null;
	fileToTranscode: File | null;
	deferredResolve: ((file: File | null) => void) | null;
	
	startTranscodeFlow: (file: File) => Promise<File | null>;
	resolveFlow: (file: File | null) => void;
	
	setProgress: (progress: number) => void;
	setStatus: (status: TranscodeStatus) => void;
	setError: (error: string | null) => void;
}

export const useTranscodeStore = create<TranscodeState>((set, get) => ({
	isOpen: false,
	fileName: "",
	progress: 0,
	status: "idle",
	error: null,
	fileToTranscode: null,
	deferredResolve: null,

	startTranscodeFlow: (file) => {
		return new Promise<File | null>((resolve) => {
			set({
				isOpen: true,
				fileName: file.name,
				progress: 0,
				status: "idle",
				error: null,
				fileToTranscode: file,
				deferredResolve: resolve,
			});
		});
	},

	resolveFlow: (file) => {
		const { deferredResolve } = get();
		if (deferredResolve) {
			deferredResolve(file);
		}
		set({ isOpen: false, fileToTranscode: null, deferredResolve: null });
	},

	setProgress: (progress) => set({ progress }),
	setStatus: (status) => set({ status }),
	setError: (error) => set({ error, status: "error" }),
}));
