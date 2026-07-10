/**
 * Style Library — persistent store of editing styles extracted from
 * reference videos by the mimic engine.
 *
 * A SavedStyle keeps the worker's measured `style_profile` (pacing, color,
 * motion, beat-sync, transition mix, letterbox, vignette) — NOT the concrete
 * mutations. Re-applying a style sends the profile back to the worker's
 * mimic-flow with the CURRENT timeline's footage, so every application is
 * re-adapted to the new material instead of stamping a frozen recipe.
 */

const STORAGE_KEY = "chronox_style_library_v1";

/** The worker's `analyze_video_style` output — kept opaque on purpose:
 * the worker owns this shape, the client just round-trips it. */
export type StyleProfileData = Record<string, unknown> & {
	duration?: number;
	avg_shot_len?: number;
	beat_sync?: number;
	bpm?: number | null;
	color?: Record<string, number>;
	transitions?: Record<string, number> | null;
	letterbox_aspect?: number | null;
	vignette?: number;
};

export interface SavedStyle {
	id: string;
	name: string;
	/** File name of the reference video the style was learned from. */
	referenceName: string;
	/** Human-readable style summary from the worker (_summarize_style). */
	summary: string;
	createdAt: string; // ISO
	profile: StyleProfileData;
}

function readAll(): SavedStyle[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeAll(styles: SavedStyle[]) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
}

export function listStyles(): SavedStyle[] {
	return readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveStyle(input: {
	name: string;
	referenceName: string;
	summary: string;
	profile: StyleProfileData;
}): SavedStyle {
	const styles = readAll();
	// Same name → overwrite (user is iterating on the style, not duplicating it)
	const existing = styles.findIndex(
		(s) => s.name.toLowerCase() === input.name.toLowerCase(),
	);
	const style: SavedStyle = {
		id:
			existing >= 0
				? styles[existing].id
				: (globalThis.crypto?.randomUUID?.() ?? `style_${Date.now()}`),
		name: input.name.trim(),
		referenceName: input.referenceName,
		summary: input.summary,
		createdAt: new Date().toISOString(),
		profile: input.profile,
	};
	if (existing >= 0) styles[existing] = style;
	else styles.push(style);
	writeAll(styles);
	return style;
}

export function deleteStyle(id: string): boolean {
	const styles = readAll();
	const next = styles.filter((s) => s.id !== id);
	if (next.length === styles.length) return false;
	writeAll(next);
	return true;
}

/** Fuzzy lookup by name — exact match wins, then substring either way. */
export function findStyle(query: string): SavedStyle | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const styles = readAll();
	return (
		styles.find((s) => s.name.toLowerCase() === q) ??
		styles.find(
			(s) =>
				s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()),
		)
	);
}
