import { create } from "zustand";

/**
 * Tracks which cut (pair of adjacent clips) has a transition applied so the
 * timeline can render an NLE-style marker box at the junction. Keyed by
 * `${leftElementId}->${rightElementId}` — survives ripples since it follows
 * the elements, not their times.
 */

export interface TransitionMarker {
	type: string;
	name: string;
	duration: number;
}

interface TransitionMarkersState {
	markers: Record<string, TransitionMarker>;
	setMarker: (cutKey: string, marker: TransitionMarker) => void;
	removeMarker: (cutKey: string) => void;
	clear: () => void;
}

export const cutKeyOf = (leftId: string, rightId: string) =>
	`${leftId}->${rightId}`;

export const useTransitionMarkersStore = create<TransitionMarkersState>(
	(set) => ({
		markers: {},
		setMarker: (cutKey, marker) =>
			set((s) => ({ markers: { ...s.markers, [cutKey]: marker } })),
		removeMarker: (cutKey) =>
			set((s) => {
				const { [cutKey]: _, ...rest } = s.markers;
				return { markers: rest };
			}),
		clear: () => set({ markers: {} }),
	}),
);
