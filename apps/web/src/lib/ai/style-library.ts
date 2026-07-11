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
	profile?: StyleProfileData;
	recipe?: string; // Markdown recipe text
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
	profile?: StyleProfileData;
	recipe?: string;
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
		recipe: input.recipe,
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

// ── Style Presets Card-Based Interface & Storage ──

export interface StyleCard {
	id: string;
	category: "color" | "transitions" | "pacing" | "effects";
	name: string;
	summary: string;
	timeRange: [number, number] | null;
	recipeMd: string;
	createdAt: string;
	saved: boolean;
}

const CARDS_STORAGE_KEY = "chronox_style_cards_v1";

function readAllCards(): StyleCard[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(CARDS_STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeAllCards(cards: StyleCard[]) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(cards));
}

export function listStyleCards(): StyleCard[] {
	return readAllCards().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveStyleCard(card: Omit<StyleCard, "createdAt">): StyleCard {
	const cards = readAllCards();
	const existing = cards.findIndex((c) => c.id === card.id);
	const fullCard: StyleCard = {
		...card,
		createdAt: existing >= 0 ? cards[existing].createdAt : new Date().toISOString(),
	};
	if (existing >= 0) {
		cards[existing] = fullCard;
	} else {
		cards.push(fullCard);
	}
	writeAllCards(cards);
	return fullCard;
}

export function deleteStyleCard(id: string): boolean {
	const cards = readAllCards();
	const next = cards.filter((c) => c.id !== id);
	if (next.length === cards.length) return false;
	writeAllCards(next);
	return true;
}

export function searchStyleCards(query: string): StyleCard[] {
	const q = query.trim().toLowerCase();
	if (!q) return listStyleCards();

	const cards = readAllCards();

	// Parse tags (e.g., "#color" or "category:color")
	let categoryFilter: string | null = null;
	const cleanQueryWords: string[] = [];
	
	q.split(/\s+/).forEach(word => {
		if (word.startsWith("#") || word.startsWith("category:")) {
			const tag = word.replace("#", "").replace("category:", "");
			if (["color", "transitions", "pacing", "effects"].includes(tag)) {
				categoryFilter = tag;
			}
		} else {
			cleanQueryWords.push(word);
		}
	});

	const cleanQuery = cleanQueryWords.join(" ");

	// Filter Stage 1: Pre-filtering
	let filtered = cards;
	if (categoryFilter) {
		filtered = cards.filter(c => c.category === categoryFilter);
	}

	if (cleanQueryWords.length === 0) {
		return filtered;
	}

	// Helper for text matching score (Jaccard similarity on word list)
	const getWordSet = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/));
	const queryWords = getWordSet(cleanQuery);

	const textScores = filtered.map(card => {
		const cardText = `${card.name} ${card.summary} ${card.recipeMd}`;
		const cardWords = getWordSet(cardText);
		
		let intersection = 0;
		queryWords.forEach(w => {
			if (w && cardWords.has(w)) intersection++;
		});
		
		const union = queryWords.size + cardWords.size - intersection;
		const score = union > 0 ? intersection / union : 0;
		return { card, score };
	});

	// Helper for keyword match score (exact match frequency)
	const keywordScores = filtered.map(card => {
		const cardText = `${card.name} ${card.summary} ${card.recipeMd}`.toLowerCase();
		let score = 0;
		cleanQueryWords.forEach(w => {
			if (w && cardText.includes(w)) {
				score += 1;
				// Bonus for matching title
				if (card.name.toLowerCase().includes(w)) score += 2;
			}
		});
		return { card, score };
	});

	// Rank using RRF (Reciprocal Rank Fusion)
	const rankedText = [...textScores].sort((a, b) => b.score - a.score);
	const rankedKeyword = [...keywordScores].sort((a, b) => b.score - a.score);

	const rrfScores = filtered.map(card => {
		const textRank = rankedText.findIndex(item => item.card.id === card.id);
		const keywordRank = rankedKeyword.findIndex(item => item.card.id === card.id);
		
		// RRF formula: 1 / (60 + rank)
		const textRRF = textRank >= 0 ? 1 / (60 + textRank) : 0;
		const keywordRRF = keywordRank >= 0 ? 1 / (60 + keywordRank) : 0;
		
		return {
			card,
			score: textRRF + keywordRRF
		};
	});

	// Sort final results by RRF score and return
	return rrfScores
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.map(item => item.card);
}

