import { describe, expect, test, beforeEach } from "bun:test";

// style-library persists via window.localStorage — stub both for bun:test.
const store = new Map<string, string>();
(globalThis as any).window = {
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
};

import {
	listStyles,
	saveStyle,
	deleteStyle,
	findStyle,
} from "@/lib/ai/style-library";

const profile = {
	avg_shot_len: 1.8,
	beat_sync: 0.72,
	bpm: 128,
	color: { warmth: 0.05, contrast: 0.24 },
	transitions: { hard: 10, whip: 3, flash_white: 2 },
};

describe("Style Library persistence", () => {
	beforeEach(() => store.clear());

	test("save → list → find round-trip", () => {
		const saved = saveStyle({
			name: "Fast Travel Vlog",
			referenceName: "florence.mp4",
			summary: "fast-paced; 72% on-beat cuts",
			profile,
		});
		expect(saved.id).toBeString();

		const all = listStyles();
		expect(all.length).toBe(1);
		expect(all[0].profile.beat_sync).toBe(0.72);

		// exact, case-insensitive and substring lookups all resolve
		expect(findStyle("fast travel vlog")?.id).toBe(saved.id);
		expect(findStyle("travel")?.id).toBe(saved.id);
		expect(findStyle("nonexistent")).toBeUndefined();
	});

	test("same name overwrites instead of duplicating", () => {
		const first = saveStyle({
			name: "Moody",
			referenceName: "a.mp4",
			summary: "v1",
			profile,
		});
		const second = saveStyle({
			name: "moody",
			referenceName: "b.mp4",
			summary: "v2",
			profile,
		});
		expect(second.id).toBe(first.id);
		const all = listStyles();
		expect(all.length).toBe(1);
		expect(all[0].referenceName).toBe("b.mp4");
	});

	test("delete removes the style", () => {
		const s = saveStyle({
			name: "Temp",
			referenceName: "t.mp4",
			summary: "",
			profile,
		});
		expect(deleteStyle(s.id)).toBe(true);
		expect(listStyles().length).toBe(0);
		expect(deleteStyle(s.id)).toBe(false);
	});

	test("corrupt storage degrades to empty library, not a crash", () => {
		store.set("chronox_style_library_v1", "{not json");
		expect(listStyles()).toEqual([]);
	});
});
