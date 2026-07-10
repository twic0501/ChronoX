/**
 * Skill registry metadata + matching, kept free of raw-md imports so it can
 * run under bun:test. The md contents are attached in ./index.ts (bundler-only).
 */

export interface SkillMeta {
	/** Stable id, also the md filename: `<name>.skill.md` */
	name: string;
	description: string;
	keywords: string[];
}

export interface AgentSkill extends SkillMeta {
	content: string;
}

export const SKILL_METAS: SkillMeta[] = [
	{
		name: "transitions",
		description:
			"Catalog of every transition type (dissolve, whip, push, spin, zoom, glitch…), how each is built from keyframes, durations, and beat placement rules.",
		keywords: [
			"transition",
			"dissolve",
			"whip",
			"slide",
			"push",
			"spin",
			"zoom",
			"glitch",
			"flash",
			"fade",
			"cut",
		],
	},
	{
		name: "color-grading",
		description:
			"Color-adjust parameter recipes: cinematic orange & teal, moody, vintage/VHS, bright vlog; adjustment-layer discipline and mimic delta mapping.",
		keywords: [
			"color",
			"grade",
			"grading",
			"lut",
			"cinematic",
			"teal",
			"orange",
			"moody",
			"vintage",
			"look",
			"contrast",
			"saturation",
		],
	},
	{
		name: "transform-animation",
		description:
			"Keyframe animation on transform/opacity: pop_in, slide_in, spin_in, ken_burns, shake, punch presets and zoom guidelines.",
		keywords: [
			"transform",
			"keyframe",
			"animation",
			"animate",
			"scale",
			"position",
			"rotate",
			"pop",
			"ken burns",
			"shake",
			"punch",
			"zoom in",
		],
	},
	{
		name: "masks-grid",
		description:
			"Masks (rectangle, ellipse, split, polygon), split-screen construction, N×M grid layouts with per-cell transforms, mask reveal wipes.",
		keywords: [
			"mask",
			"grid",
			"split screen",
			"split-screen",
			"layout",
			"wipe",
			"reveal",
			"iris",
			"multicam",
			"collage",
		],
	},
	{
		name: "beat-sync",
		description:
			"Beat-synchronised editing: cutting on beats/downbeats, beat punches, fit_clips_to_audio flow, reading a mimic style profile's rhythm fields.",
		keywords: [
			"beat",
			"music",
			"bpm",
			"sync",
			"rhythm",
			"downbeat",
			"snap",
			"tempo",
			"audio",
		],
	},
	{
		name: "editing-theory",
		description:
			"Walter Murch's Rule of Six (emotion > story > rhythm > eye-trace > continuity), movement matching, cut-on-blink, hidden cuts, ruthless trimming, visual hooks.",
		keywords: [
			"theory",
			"murch",
			"rule of six",
			"emotion",
			"eye-trace",
			"eye trace",
			"anchor",
			"continuity",
			"180",
			"blink",
			"one-shot",
			"why cut",
		],
	},
	{
		name: "cut-types",
		description:
			"Cut vocabulary: hard cut, jump cut, match cut (graphic/movement/audio), contrast cut, cutaway, cross-cutting, J-cut/L-cut sound bridges, audio ducking under dialogue.",
		keywords: [
			"jump cut",
			"match cut",
			"contrast",
			"cutaway",
			"cross-cutting",
			"parallel",
			"j-cut",
			"l-cut",
			"j cut",
			"l cut",
			"sound bridge",
			"dialogue",
			"ducking",
		],
	},
	{
		name: "transition-psychology",
		description:
			"What each transition MEANS to the viewer (dissolve = time, fade = ending, flash = energy), pacing by shot complexity, the 0→max→0 adjustment-layer construction pattern, matte reveals.",
		keywords: [
			"psychology",
			"meaning",
			"mean",
			"why",
			"emotion",
			"dissolve",
			"fade to black",
			"light leak",
			"matte",
			"adjustment layer",
			"custom transition",
			"design transition",
			"pacing",
		],
	},
	{
		name: "pacing-montage",
		description:
			"Montage structure: hook/body/ending shot-length grammar, what footage to keep, speed ramps, applying mimic pacing adaptively.",
		keywords: [
			"pacing",
			"montage",
			"structure",
			"hook",
			"shot length",
			"speed ramp",
			"retime",
			"story",
			"edit plan",
		],
	},
];

/** Fuzzy lookup: exact name → name substring → keyword/description hit. */
export function matchSkill<T extends SkillMeta>(
	query: string,
	skills: T[],
): T | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const byName =
		skills.find((s) => s.name === q) ??
		skills.find((s) => s.name.includes(q) || q.includes(s.name));
	if (byName) return byName;

	// Keyword scoring: sum the LENGTH of every matched keyword, so more and
	// more-specific matches win — "j-cut" (cut-types) beats the generic "cut"
	// (transitions), and "sync cuts to the beat" resolves to beat-sync.
	let best: T | undefined;
	let bestScore = 0;
	for (const s of skills) {
		let score = s.keywords
			.filter((k) => q.includes(k) || k.includes(q))
			.reduce((sum, k) => sum + k.length, 0);
		if (score === 0 && s.description.toLowerCase().includes(q)) score = 0.5;
		if (score > bestScore) {
			bestScore = score;
			best = s;
		}
	}
	return best;
}
