/**
 * Agentic NLE — the local model as an autonomous editing agent.
 *
 * Instead of emitting one JSON blob of operations, the model is given a set of
 * high-level editing TOOLS (the app's features) and orchestrates them itself:
 * it calls one tool at a time, sees the real result, and decides the next step
 * until the goal is done. The backend `/api/ai/agent-step` proxies to the
 * configured provider (Gemini, OpenAI, Claude, Grok, Ollama); every tool
 * below executes against the live timeline here.
 */

import { getCachedSceneMap, analyzeScenesViaBackend } from "./scene-analyzer";
import { dryRunActions } from "./compiler";
import {
	fetchMimicFlow,
	applyMimicToTimeline,
	applySavedStyle,
	findAudioClip,
	backendPathOf,
	type MimicFlowData,
} from "./style-apply";
import { listStyles, saveStyle, findStyle } from "./style-library";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// Orange & Teal cinematic grade (matches the SYSTEM_PROMPT preset).
const CINEMATIC_GRADE = {
	lift_b: 0.05,
	lift_g: 0.02,
	lift_r: -0.03,
	gain_r: 1.12,
	gain_g: 1.06,
	gain_b: 0.9,
	contrast: 0.15,
	saturation: 0.05,
};

// Capture frames from ONE media source at several source-time offsets, as raw
// base64 JPEGs (downscaled), for the vision colorist. Loads the video once and
// seeks sequentially — reliable for many scenes cut from the same clip (a fresh
// <video> per scene flakes out on repeated seeks). Returns an array aligned to
// `times` (null where a seek/capture failed).
async function captureFramesFromSource(
	src: string,
	times: number[],
	maxW = 512,
): Promise<(string | null)[]> {
	return new Promise((resolve) => {
		const video = document.createElement("video");
		video.muted = true;
		video.crossOrigin = "anonymous";
		video.preload = "auto";
		const out: (string | null)[] = new Array(times.length).fill(null);
		const canvas = document.createElement("canvas");
		let idx = 0;
		let settled = false;
		const cleanup = () => {
			video.removeAttribute("src");
			video.load();
		};
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(guard);
			cleanup();
			resolve(out);
		};
		// Overall cap scales with the number of seeks.
		const guard = setTimeout(done, 5000 + times.length * 3000);
		const seekNext = () => {
			if (idx >= times.length) return done();
			const dur = video.duration || times[idx] + 1;
			video.currentTime = Math.max(0, Math.min(times[idx], dur - 0.05));
		};
		video.onseeked = () => {
			try {
				const scale = Math.min(1, maxW / (video.videoWidth || maxW));
				canvas.width = Math.max(1, Math.round((video.videoWidth || maxW) * scale));
				canvas.height = Math.max(1, Math.round((video.videoHeight || maxW) * scale));
				canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
				out[idx] = canvas.toDataURL("image/jpeg", 0.8).split(",")[1] || null;
			} catch {
				out[idx] = null;
			}
			idx++;
			seekNext();
		};
		video.onerror = () => done();
		video.onloadedmetadata = () => seekNext();
		video.src = src;
	});
}

// Extract one representative frame per video clip (in timeline order) as base64
// JPEG, plus a text hint from the cached scene analysis. Shared by the vision
// grading and vision curation tools. `indexToClip[i]` maps a scene index back
// to its timeline clip.
async function extractSceneFrames(editor: any): Promise<{
	clips: any[];
	scenes: Array<{ index: number; image: string; hint: string }>;
	indexToClip: any[];
}> {
	const clips = clipsToTarget(editor)
		.slice()
		.sort((a: any, b: any) => (a.startTime ?? 0) - (b.startTime ?? 0));
	const scenes: Array<{ index: number; image: string; hint: string }> = [];
	const indexToClip: any[] = [];
	if (clips.length === 0) return { clips, scenes, indexToClip };
	const assets = editor.media.getAssets();
	const bySrc = new Map<string, Array<{ i: number; mid: number }>>();
	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		const asset = assets.find((a: any) => a.id === clip.mediaId);
		const src =
			asset?.url || (asset?.file ? URL.createObjectURL(asset.file) : null);
		if (!src) continue;
		const rate = clip.retime?.rate ?? 1;
		const mid = (clip.trimStart ?? 0) + ((clip.duration ?? 0) * rate) / 2;
		if (!bySrc.has(src)) bySrc.set(src, []);
		bySrc.get(src)!.push({ i, mid });
	}
	for (const [src, entries] of bySrc) {
		const frames = await captureFramesFromSource(
			src,
			entries.map((e) => e.mid),
		);
		entries.forEach((e, k) => {
			const image = frames[k];
			if (!image) return;
			const clip = clips[e.i];
			indexToClip[e.i] = clip;
			const si = sceneInfoForSegment(editor, clip);
			const hint = si
				? `${si.tag}; brightness=${si.brightness?.toFixed?.(2) ?? "?"}; warmth=${si.warmth?.toFixed?.(2) ?? "?"}`
				: "scene";
			scenes.push({ index: e.i, image, hint });
		});
	}
	scenes.sort((a, b) => a.index - b.index);
	return { clips, scenes, indexToClip };
}

// POST scene frames to a backend vision endpoint using the app's saved AI config
// (empty key → backend falls back to its .env key).
async function callVisionScenes(path: string, scenes: any[]): Promise<any> {
	let cfg: any = {};
	try {
		cfg = JSON.parse(localStorage.getItem("chronox.ai.cfg") || "{}");
	} catch {}
	const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
	const res = await fetch(`${API_URL}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			provider: cfg.provider,
			model: cfg.model,
			api_key: cfg.apiKey,
			scenes,
		}),
	});
	return res.json();
}

export interface AgentEvent {
	type: "tool" | "final" | "error" | "ask";
	tool?: string;
	args?: any;
	result?: string;
	content?: string;
	usage?: { input: number; output: number };
}

interface ToolDef {
	schema: any; // OpenAI-compatible function schema
	run: (args: any, editor: any) => Promise<string> | string;
}

// ─── Tool helpers ────────────────────────────────────────────
function videoTrackOf(editor: any) {
	return editor.timeline.getTracks().find((t: any) => t.type === "video");
}

function firstVideoClip(editor: any) {
	return videoTrackOf(editor)?.elements?.[0];
}

function resolveClip(editor: any, clipId?: string) {
	const tracks = editor.timeline.getTracks();
	for (const t of tracks) {
		const el = t.elements.find((e: any) => e.id === clipId);
		if (el) return { track: t, clip: el };
	}
	const vt = videoTrackOf(editor);
	return vt?.elements?.[0]
		? { track: vt, clip: vt.elements[0] }
		: { track: null, clip: null };
}

function sceneMapForClip(editor: any, clip: any) {
	const asset = editor.media
		.getAssets()
		.find((a: any) => a.id === clip?.mediaId);
	return asset ? getCachedSceneMap(asset.id) : undefined;
}

// Match a split segment's source time range to the cached scene map.
// Returns the matching scene's contentTag and colorStats so the LLM knows
// what each segment visually contains ("landscape", "person talking", etc.).
function sceneInfoForSegment(
	editor: any,
	clip: any,
): { tag: string; brightness?: number; warmth?: number; dominantColors?: string[] } | undefined {
	const sm = sceneMapForClip(editor, clip);
	if (!sm || sm.scenes.length === 0) return undefined;
	// Segment's range in source-media time
	const trimStart = clip.trimStart ?? 0;
	const rate = clip.retime?.rate ?? 1;
	const srcStart = trimStart;
	const srcEnd = trimStart + (clip.duration ?? 0) * rate;
	const srcMid = (srcStart + srcEnd) / 2;
	// Find the scene whose time range covers the midpoint of this segment
	const match = sm.scenes.find(
		(s) => srcMid >= s.startTime && srcMid < s.endTime,
	) ?? sm.scenes.find(
		(s) => s.startTime < srcEnd && s.endTime > srcStart, // overlap fallback
	);
	if (!match) return undefined;
	return {
		tag: match.contentTag,
		brightness: match.colorStats?.brightness,
		warmth: match.colorStats?.warmth,
		dominantColors: match.colorStats?.dominantColors,
	};
}

// Like sceneMapForClip, but self-serves: if the cache is empty (e.g. after a
// page reload), run the server-side analysis now and wait for it instead of
// telling the model to "try again later".
async function ensureSceneMap(editor: any, clip: any) {
	const cached = sceneMapForClip(editor, clip);
	if (cached && cached.scenes.length > 0) return cached;
	const asset = editor.media
		.getAssets()
		.find((a: any) => a.id === clip?.mediaId);
	if (!asset) return undefined;
	const path =
		(asset.file as any)?.originalPath || (asset.file as any)?.proxyPath;
	if (!path) return undefined;
	try {
		return await analyzeScenesViaBackend(asset.id, path, {});
	} catch (e) {
		console.error("[agent] scene analysis failed:", e);
		return undefined;
	}
}

// Resolve which video clips a tool should hit.
// When clip_id is provided, return ONLY that specific clip — do NOT expand
// to siblings sharing the same mediaId. This is critical for per-segment
// operations like individual color grading after a scene cut.
// No clip_id → all video clips (for bulk operations like mute-all).
function clipsToTarget(editor: any, clipId?: string): any[] {
	const videoClips: any[] = [];
	for (const t of editor.timeline.getTracks())
		if (t.type === "video") videoClips.push(...t.elements);
	if (!clipId) return videoClips;
	const target = videoClips.find((c) => c.id === clipId);
	return target ? [target] : [];
}

async function runOps(editor: any, ops: any[]): Promise<number> {
	if (ops.length === 0) return 0;
	const { BatchCommand } = await import("@/lib/commands/batch-command");
	const dry = dryRunActions(ops, editor, { strict: false });
	if (dry.success && dry.commands && dry.commands.length > 0) {
		editor.command.execute({ command: new BatchCommand(dry.commands) });
		return dry.commands.length;
	}
	return 0;
}

// ─── Tools ───────────────────────────────────────────────────
const TOOLS: Record<string, ToolDef> = {
	list_clips: {
		schema: {
			type: "function",
			function: {
				name: "list_clips",
				description:
					"List every clip on the timeline with its id, name, type (video/audio) and duration in seconds. Call this FIRST to see what you are working with.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: (_args, editor) => {
			// Split commands append " (left)"/" (right)" to names on every cut —
			// after 87 splits a name carries ~86 suffixes. Strip them, or one
			// list_clips result costs tens of thousands of tokens.
			const cleanName = (n: string) =>
				(n ?? "").replace(/\s*\((left|right)\)/g, "").slice(0, 48);
			const clips: any[] = [];
			for (const t of editor.timeline.getTracks()) {
				for (const el of t.elements) {
					const info: any = {
						clip_id: el.id,
						name: cleanName(el.name ?? el.type),
						type: el.type,
						track_type: t.type,
						duration: Math.round(el.duration * 10) / 10,
					};
					// Annotate video segments with scene tag so the LLM
					// knows what each segment visually contains.
					if (t.type === "video") {
						const si = sceneInfoForSegment(editor, el);
						if (si) info.scene_tag = si.tag;
					}
					clips.push(info);
				}
			}
			if (clips.length === 0)
				return "The timeline is empty — no clips to edit.";
			// Compact form when >12 clips: only collapse audio segments.
			// Video segments ALWAYS list their individual UUIDs so the LLM
			// can target each one for per-segment color grading / effects.
			if (clips.length > 12) {
				const bySource = new Map<string, any[]>();
				for (const c of clips) {
					const k = `${c.track_type}:${c.name}`;
					if (!bySource.has(k)) bySource.set(k, []);
					bySource.get(k)!.push(c);
				}
				const lines: string[] = [];
				for (const [k, group] of bySource) {
					if (group[0].track_type === "video") {
						// Always list each video segment individually with scene tag
						for (const c of group) {
							const tag = c.scene_tag ? ` [${c.scene_tag}]` : "";
							lines.push(
								`${k}: clip_id ${c.clip_id}, ${c.duration}s (${c.type})${tag}`,
							);
						}
					} else if (group.length === 1) {
						const c = group[0];
						lines.push(
							`${k}: clip_id ${c.clip_id}, ${c.duration}s (${c.type})`,
						);
					} else {
						const total = group.reduce((s, c) => s + c.duration, 0);
						lines.push(
							`${k}: ${group.length} audio segments, total ${total.toFixed(1)}s`,
						);
					}
				}
				return lines.join("\n");
			}
			return JSON.stringify(clips);
		},
	},

	load_brief_from_notion: {
		schema: {
			type: "function",
			function: {
				name: "load_brief_from_notion",
				description:
					"Read an editing brief, script, shot list or plan from the user's Notion, then follow it for the edit. Pass a Notion page URL/id as `page`, or a `query` to search the workspace (e.g. 'travel vlog brief'). Call this FIRST when the user says the plan/brief/script is in Notion, or asks to edit 'according to Notion / according to the brief'.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search text for the page" },
						page: { type: "string", description: "Notion page URL or id" },
					},
				},
			},
		},
		run: async (args, _editor) => {
			let token = "";
			try {
				token = localStorage.getItem("chronox.notion.token") || "";
			} catch {}
			const API_URL =
				process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
			let data: any;
			try {
				const res = await fetch(`${API_URL}/api/notion/brief`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						token: token || undefined,
						query: args.query,
						page_id: args.page,
					}),
				});
				data = await res.json();
			} catch (e: any) {
				return `Notion request failed: ${e?.message ?? e}`;
			}
			if (!data || data.error)
				return `Could not read the Notion brief: ${data?.error ?? "unknown error"}`;
			const md = String(data.markdown || "").slice(0, 4000);
			if (!md.trim()) return "The Notion page was empty.";
			return `Editing brief from Notion${data.title ? ` "${data.title}"` : ""} — follow it for this edit:\n\n${md}`;
		},
	},

	analyze_scenes: {
		schema: {
			type: "function",
			function: {
				name: "analyze_scenes",
				description:
					"Analyze a video clip's scenes: how many scenes it has and how many are scenery/landscape vs contain a person. Call before cutting or filtering by scene.",
				parameters: {
					type: "object",
					properties: { clip_id: { type: "string" } },
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const { clip } = resolveClip(editor, args.clip_id);
			if (!clip) return "No such clip.";
			const sm = await ensureSceneMap(editor, clip);
			if (!sm || sm.scenes.length === 0)
				return "Scene analysis failed for this clip — the source file may be missing on the server.";

			// Segment-aware: if this is a split segment, find its matching scene
			// and return specific visual details instead of generic counts.
			const si = sceneInfoForSegment(editor, clip);
			if (si) {
				const parts: string[] = [
					`This segment's visual content: "${si.tag}"`,
				];
				if (si.brightness !== undefined)
					parts.push(`brightness=${si.brightness.toFixed(2)}`);
				if (si.warmth !== undefined)
					parts.push(`warmth=${si.warmth.toFixed(2)}`);
				if (si.dominantColors && si.dominantColors.length > 0)
					parts.push(`dominant colors: ${si.dominantColors.join(", ")}`);
				parts.push(
					`Suggestion: ${si.tag.includes("person") ? "Use warm tones (positive warmth, gain_r > 1.0)" : "Use cool/blue tones (negative warmth, lift_b > 0) or cinematic teal"}`,
				);
				return parts.join(". ");
			}

			// Full video (unsplit): return overall counts
			let scenery = 0;
			let person = 0;
			for (const s of sm.scenes)
				s.contentTag.includes("person") ? person++ : scenery++;
			return `${sm.scenes.length} scenes detected over ${sm.totalDuration.toFixed(0)}s: ${scenery} scenery/landscape, ${person} contain people.`;
		},
	},

	cut_into_scenes: {
		schema: {
			type: "function",
			function: {
				name: "cut_into_scenes",
				description:
					"Split a video clip at every detected scene boundary into separate clips.",
				parameters: {
					type: "object",
					properties: { clip_id: { type: "string" } },
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const { track, clip } = resolveClip(editor, args.clip_id);
			if (!track || !clip) return "No such clip.";
			const sm = await ensureSceneMap(editor, clip);
			if (!sm || sm.scenes.length === 0)
				return "No scene analysis available — cannot cut by scene.";
			const { SplitElementsCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			const clipStart = clip.startTime;
			const clipEnd = clip.startTime + clip.duration;
			const trimStart = clip.trimStart ?? 0;
			const rate = clip.retime?.rate ?? 1;
			const cutPoints = sm.scenes
				.map((s: any) => clipStart + (s.startTime - trimStart) / rate)
				.filter((t: number) => t > clipStart + 0.2 && t < clipEnd - 0.2)
				.sort((a: number, b: number) => a - b);
			let currentId = clip.id;
			let n = 0;
			for (const t of cutPoints) {
				const cmd = new SplitElementsCommand({
					elements: [{ trackId: track.id, elementId: currentId }],
					splitTime: t,
				});
				editor.command.execute({ command: cmd });
				const right = cmd.getRightSideElements?.()[0];
				if (!right) break;
				currentId = right.elementId;
				n++;
			}
			return `Split into ${n + 1} clips at ${n} scene boundaries.`;
		},
	},

	keep_only_scenery: {
		schema: {
			type: "function",
			function: {
				name: "keep_only_scenery",
				description:
					"Delete the shots that contain a talking person, keeping only the scenery/landscape shots. Run after cut_into_scenes.",
				parameters: {
					type: "object",
					properties: { clip_id: { type: "string" } },
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const { track, clip } = resolveClip(editor, args.clip_id);
			if (!track || !clip) return "No such clip.";
			// The scene map lives on the source media, shared by every segment
			const sm = await ensureSceneMap(editor, clip);
			if (!sm || sm.scenes.length === 0) return "No scene analysis available.";
			const { DeleteElementsCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			const vt = editor.timeline
				.getTracks()
				.find((t: any) => t.id === track.id);
			const segments = (vt?.elements ?? []).filter(
				(e: any) => e.mediaId === clip.mediaId,
			);
			const sceneTagOf = (seg: any): string => {
				const trimStart = seg.trimStart ?? 0;
				const mid = trimStart + seg.duration / 2;
				return sm.scenes.reduce((best: any, s: any) => {
					const bm = (best.startTime + best.endTime) / 2;
					const smid = (s.startTime + s.endTime) / 2;
					return Math.abs(smid - mid) < Math.abs(bm - mid) ? s : best;
				}, sm.scenes[0]).contentTag;
			};
			const toDelete = segments.filter((seg: any) =>
				sceneTagOf(seg).includes("person"),
			);
			if (toDelete.length === 0) return "No person shots found to remove.";
			if (toDelete.length >= segments.length)
				return "Refusing to delete every shot — nothing tagged as scenery.";
			editor.command.execute({
				command: new DeleteElementsCommand({
					elements: toDelete.map((s: any) => ({
						trackId: track.id,
						elementId: s.id,
					})),
				}),
			});
			return `Deleted ${toDelete.length} person shots, ${segments.length - toDelete.length} scenery clips remain.`;
		},
	},

	grade_cinematic: {
		schema: {
			type: "function",
			function: {
				name: "grade_cinematic",
				description:
					"Apply an Orange & Teal cinematic color grade. Omit clip_id to grade the WHOLE video as one adjustment layer (like a DaVinci/Premiere adjustment layer — one control for the entire timeline, the professional way). Pass a clip_id only to grade one specific shot differently.",
				parameters: {
					type: "object",
					properties: { clip_id: { type: "string" } },
				},
			},
		},
		run: async (args, editor) => {
			// No clip_id → a single global adjustment layer, not a per-clip stamp.
			if (!args.clip_id) {
				const n = await runOps(editor, [
					{
						action: "add_adjustment",
						effect_type: "color-adjust",
						params: CINEMATIC_GRADE,
					},
				]);
				return n > 0
					? "Applied a cinematic color grade as one adjustment layer over the whole timeline."
					: "Could not create the grade adjustment layer.";
			}
			// Specific shot → per-clip grade.
			const n = await runOps(editor, [
				{
					action: "adjust_color",
					clip_id: args.clip_id,
					params: CINEMATIC_GRADE,
				},
			]);
			return `Applied cinematic grade to the target clip (${n} op).`;
		},
	},

	grade_scenes_vision: {
		schema: {
			type: "function",
			function: {
				name: "grade_scenes_vision",
				description:
					"Let an AI colorist actually LOOK at each scene's frame (vision) and design a bespoke, tasteful colour grade for every scene — tuned to that scene's real light/subject/mood, visibly distinct from its neighbours, and cohesive across the montage. This is the correct tool whenever the user wants each scene coloured differently/appropriately ('different color for each scene', 'appropriate color grading'). Call it AFTER cutting into scenes. It reads the pixels and self-tunes — do NOT hand-roll adjust_color per clip or apply fixed presets for this goal.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: async (_args, editor) => {
			const { scenes, indexToClip } = await extractSceneFrames(editor);
			if (scenes.length === 0)
				return "Could not extract scene frames to grade — cut into scenes first, or the media source is unavailable.";

			let data: any;
			try {
				data = await callVisionScenes("/api/ai/grade-scenes", scenes);
			} catch (e: any) {
				return `Vision grading request failed: ${e?.message ?? e}`;
			}
			if (!data || data.error)
				return `Vision grading failed: ${data?.error ?? "unknown error"}`;

			const grades = Array.isArray(data.grades) ? data.grades : [];
			if (grades.length === 0) return "The colorist returned no grades.";

			const ops: any[] = [];
			const notes: string[] = [];
			for (const g of grades) {
				const clip = indexToClip[g.scene];
				if (!clip || !g.params || typeof g.params !== "object") continue;
				ops.push({ action: "adjust_color", clip_id: clip.id, params: g.params });
				if (g.rationale) notes.push(`scene ${g.scene}: ${g.rationale}`);
			}
			const n = await runOps(editor, ops);
			return n > 0
				? `Vision colorist graded ${n} scenes — each frame was looked at and tuned individually.\n${notes
						.slice(0, 12)
						.join("\n")}`
				: "Could not apply the vision grades.";
		},
	},

	curate_scenes_vision: {
		schema: {
			type: "function",
			function: {
				name: "curate_scenes_vision",
				description:
					"Let an AI editor LOOK at each scene's frame (vision) and decide which shots to KEEP and which to CUT — dropping blurry, badly-exposed, empty/black, shaky or near-duplicate scenes and keeping the strong, varied ones. Use this whenever the user wants to trim/clean up footage, remove bad or boring shots, or auto-select the best scenes ('curate scenes', 'remove bad/boring shots', 'select beautiful scenes'). Call it AFTER cutting into scenes. It reads the pixels and judges quality — never deletes every scene.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: async (_args, editor) => {
			const { scenes, indexToClip } = await extractSceneFrames(editor);
			if (scenes.length === 0)
				return "Could not extract scene frames — cut into scenes first, or the media source is unavailable.";

			let data: any;
			try {
				data = await callVisionScenes("/api/ai/curate-scenes", scenes);
			} catch (e: any) {
				return `Scene curation request failed: ${e?.message ?? e}`;
			}
			if (!data || data.error)
				return `Scene curation failed: ${data?.error ?? "unknown error"}`;

			const judged = Array.isArray(data.scenes) ? data.scenes : [];
			if (judged.length === 0) return "The reviewer returned no decisions.";

			// Collect clips the reviewer wants to cut.
			const cutList: any[] = [];
			const cutReasons: string[] = [];
			for (const j of judged) {
				const clip = indexToClip[j.scene];
				if (!clip) continue;
				if (j.keep === false) {
					cutList.push(clip);
					cutReasons.push(`cut scene ${j.scene}: ${j.reason ?? ""}`.trim());
				}
			}
			if (cutList.length === 0)
				return `Reviewed ${scenes.length} scenes with vision — all worth keeping, nothing cut.`;
			// Safety: never empty the timeline.
			if (cutList.length >= scenes.length)
				return `The reviewer flagged all ${scenes.length} scenes — skipping the delete so the timeline is not emptied. Consider re-shooting or lowering the bar.`;

			const { DeleteElementsCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			const dels = cutList
				.map((c) => {
					const { track } = resolveClip(editor, c.id);
					return track ? { trackId: track.id, elementId: c.id } : null;
				})
				.filter(Boolean) as Array<{ trackId: string; elementId: string }>;
			if (dels.length === 0) return "Could not resolve scenes to cut.";
			editor.command.execute({
				command: new DeleteElementsCommand({ elements: dels }),
			});

			// Ripple-close the gaps the deletions left.
			const track = videoTrackOf(editor);
			if (track) {
				const { UpdateElementStartTimeCommand } = await import(
					"@/lib/commands/timeline/element"
				);
				const { BatchCommand } = await import("@/lib/commands/batch-command");
				const sorted = [...track.elements].sort(
					(a: any, b: any) => a.startTime - b.startTime,
				);
				const cmds: any[] = [];
				let cursor = 0;
				for (const el of sorted) {
					if (Math.abs(el.startTime - cursor) > 0.001) {
						cmds.push(
							new UpdateElementStartTimeCommand({
								elements: [{ trackId: track.id, elementId: el.id }],
								startTime: cursor,
							}),
						);
					}
					cursor += el.duration;
				}
				if (cmds.length > 0)
					editor.command.execute({ command: new BatchCommand(cmds) });
			}

			return `Vision editor cut ${dels.length} weak scenes, kept ${scenes.length - dels.length}, and closed the gaps.\n${cutReasons
				.slice(0, 12)
				.join("\n")}`;
		},
	},

	adjust_color: {
		schema: {
			type: "function",
			function: {
				name: "adjust_color",
				description:
					"Adjust a clip's color wheels, warmth, saturation, contrast, or exposure. Use this to style individual scenes appropriately (e.g. cold blue tones for nature/winter, warm yellow/red tones for humans/indoor warmth, or cinematic contrast adjustments).",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						lift_r: { type: "number", description: "Shadows Red shift (-0.5 to 0.5)" },
						lift_g: { type: "number", description: "Shadows Green shift (-0.5 to 0.5)" },
						lift_b: { type: "number", description: "Shadows Blue shift (-0.5 to 0.5)" },
						gain_r: { type: "number", description: "Highlights Red gain (0.5 to 2.0)" },
						gain_g: { type: "number", description: "Highlights Green gain (0.5 to 2.0)" },
						gain_b: { type: "number", description: "Highlights Blue gain (0.5 to 2.0)" },
						contrast: { type: "number", description: "Contrast (-1.0 to 1.0)" },
						saturation: { type: "number", description: "Saturation (-1.0 to 1.0)" },
						exposure: { type: "number", description: "Exposure (-2.0 to 2.0)" },
						warmth: { type: "number", description: "Warmth factor (-1.0 to 1.0; negative is cold/blue, positive is warm/yellow)" },
					},
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const { clip_id, ...params } = args;
			const n = await runOps(editor, [
				{
					action: "adjust_color",
					clip_id,
					params,
				},
			]);
			return n > 0
				? `Adjusted color of clip ${clip_id} with custom parameters.`
				: `Could not apply color adjustments to clip ${clip_id}.`;
		},
	},

	apply_look: {
		schema: {
			type: "function",
			function: {
				name: "apply_look",
				description:
					"Build a complete cinematic LOOK as a stack of adjustment layers over the WHOLE timeline (never stamped per-clip). Use this for global film looks. `look` presets: 'cinematic' (teal-orange grade + 2.39 letterbox + vignette), 'warm', 'teal_orange', 'moody' (grade + heavy vignette + halation glow), 'bw' (grayscale + vignette). Optionally set letterbox true/false and vignette true/false to override the preset.",
				parameters: {
					type: "object",
					properties: {
						look: { type: "string" },
						letterbox: { type: "boolean" },
						vignette: { type: "boolean" },
					},
				},
			},
		},
		run: async (args, editor) => {
			const look = String(args.look || "cinematic").toLowerCase();
			const effects: Array<{ effect_type: string; params?: any }> = [];

			// Grade component per preset
			if (look === "bw") {
				effects.push({ effect_type: "grayscale", params: { intensity: 1 } });
			} else if (look === "warm") {
				effects.push({
					effect_type: "color-adjust",
					params: {
						...CINEMATIC_GRADE,
						gain_r: 1.16,
						gain_b: 0.86,
						lift_r: 0.02,
					},
				});
			} else if (look === "moody") {
				effects.push({
					effect_type: "color-adjust",
					params: {
						...CINEMATIC_GRADE,
						contrast: 0.22,
						saturation: -0.05,
						gain_b: 0.96,
					},
				});
				effects.push({ effect_type: "halation", params: { intensity: 0.35 } });
			} else {
				// cinematic / teal_orange default
				effects.push({ effect_type: "color-adjust", params: CINEMATIC_GRADE });
			}

			// Letterbox: default on for cinematic/teal_orange/moody, off for warm/bw,
			// overridable by the caller.
			const wantsLetterbox =
				typeof args.letterbox === "boolean"
					? args.letterbox
					: look === "cinematic" || look === "teal_orange" || look === "moody";
			if (wantsLetterbox)
				effects.push({
					effect_type: "letterbox",
					params: { aspectRatio: 2.39 },
				});

			// Vignette: default on unless explicitly disabled; heavier for moody.
			const wantsVignette =
				typeof args.vignette === "boolean" ? args.vignette : true;
			if (wantsVignette)
				effects.push({
					effect_type: "vignette",
					params: { intensity: look === "moody" ? 0.55 : 0.35 },
				});

			const n = await runOps(editor, [{ action: "add_adjustment", effects }]);
			return n > 0
				? `Applied "${look}" look as ${effects.length} adjustment layer(s) over the whole timeline (${effects
						.map((e) => e.effect_type)
						.join(" + ")}). The user can toggle each layer independently.`
				: "Could not build the look.";
		},
	},

	mute_clip: {
		schema: {
			type: "function",
			function: {
				name: "mute_clip",
				description:
					"Mute a clip's audio (set volume to 0). Omit clip_id to mute all video clips.",
				parameters: {
					type: "object",
					properties: { clip_id: { type: "string" } },
				},
			},
		},
		run: async (args, editor) => {
			const targets = clipsToTarget(editor, args.clip_id);
			if (targets.length === 0) return "No clips to mute.";
			const ops = targets.map((c) => ({
				action: "adjust_volume",
				clip_id: c.id,
				volume: 0,
			}));
			const n = await runOps(editor, ops);
			return `Muted ${n} clip(s).`;
		},
	},

	add_effect: {
		schema: {
			type: "function",
			function: {
				name: "add_effect",
				description:
					'Add a visual effect to ONE specific clip (pass clip_id). effect must be one of: halation, glitch, letterbox, camera-shake, vignette, blur, grayscale, invert, sharpen, film_grain, duotone, posterize, pixelate, chromatic_aberration, lens_distortion, radial_blur, mirror. For a GLOBAL look across the whole video (letterbox, vignette, grade, film glow) do NOT stamp every clip — omit clip_id and it is created as a single adjustment layer instead. Optional params, e.g. {"aspectRatio": 2.39} for letterbox or {"intensity": 0.5}.',
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						effect: { type: "string" },
						params: { type: "object" },
					},
					required: ["effect"],
				},
			},
		},
		run: async (args, editor) => {
			const params =
				args.params && typeof args.params === "object"
					? args.params
					: undefined;

			// No target clip → this is a GLOBAL effect. Create ONE adjustment layer
			// spanning the timeline instead of stamping the effect onto every clip.
			if (!args.clip_id) {
				const n = await runOps(editor, [
					{ action: "add_adjustment", effect_type: args.effect, params },
				]);
				return n > 0
					? `Added ${args.effect} as a global adjustment layer over the whole timeline.`
					: `Could not add ${args.effect} as an adjustment layer.`;
			}

			// Specific clip → per-clip effect (idempotent).
			const targets = clipsToTarget(editor, args.clip_id);
			if (targets.length === 0) return "No clips to apply the effect to.";
			const ops = targets
				.filter(
					(c) => !(c.effects ?? []).some((ef: any) => ef.type === args.effect),
				)
				.map((c) => ({
					action: "add_effect",
					clip_id: c.id,
					effect_type: args.effect,
					params,
				}));
			if (ops.length === 0) return `Clip already has ${args.effect}.`;
			const n = await runOps(editor, ops);
			return n > 0
				? `Added ${args.effect} to the clip.`
				: `Could not add effect ${args.effect}.`;
		},
	},

	set_clip_speed: {
		schema: {
			type: "function",
			function: {
				name: "set_clip_speed",
				description:
					"Change playback speed (retime). speed < 1 = slow motion (0.5 = half speed), > 1 = fast. Optional curve for a cinematic speed RAMP: ease_in (starts normal, ends ramped), ease_out, or ease_in_out. Omit clip_id to retime ALL video clips.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						speed: { type: "number" },
						curve: {
							type: "string",
							description: "ease_in | ease_out | ease_in_out (optional)",
						},
					},
					required: ["speed"],
				},
			},
		},
		run: async (args, editor) => {
			const targets = clipsToTarget(editor, args.clip_id);
			if (targets.length === 0) return "No clips to retime.";
			const speed = Number(args.speed);
			if (!Number.isFinite(speed) || speed <= 0)
				return "Invalid speed — pass a number like 0.5 (slow-mo) or 2 (2x).";
			const ops = targets.map((c) => ({
				action: "change_speed",
				clip_id: c.id,
				speed,
				curve: args.curve,
				maintain_pitch: true,
			}));
			const n = await runOps(editor, ops);
			return `Retimed ${n} clip(s) to ${speed}x${args.curve ? ` with ${args.curve} ramp` : ""}. Clip durations on the timeline changed accordingly.`;
		},
	},

	close_gaps: {
		schema: {
			type: "function",
			function: {
				name: "close_gaps",
				description:
					"Ripple: pack all video clips together from t=0, removing every gap left by deleted shots. Run after deleting clips.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: async (_args, editor) => {
			const track = videoTrackOf(editor);
			if (!track || track.elements.length === 0) return "No video clips.";
			const { UpdateElementStartTimeCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			const { BatchCommand } = await import("@/lib/commands/batch-command");
			const sorted = [...track.elements].sort(
				(a: any, b: any) => a.startTime - b.startTime,
			);
			const cmds: any[] = [];
			let cursor = 0;
			for (const el of sorted) {
				if (Math.abs(el.startTime - cursor) > 0.001) {
					cmds.push(
						new UpdateElementStartTimeCommand({
							elements: [{ trackId: track.id, elementId: el.id }],
							startTime: cursor,
						}),
					);
				}
				cursor += el.duration;
			}
			if (cmds.length === 0) return "No gaps found — clips are already packed.";
			editor.command.execute({ command: new BatchCommand(cmds) });
			return `Closed gaps: moved ${cmds.length} clips, sequence now runs 0 → ${cursor.toFixed(1)}s with no holes.`;
		},
	},

	add_transition: {
		schema: {
			type: "function",
			function: {
				name: "add_transition",
				description:
					"Add REAL transitions at the cuts between video clips — a genuine two-clip blend, not a fake overlay. type: 'dissolve' (cross-dissolve, clips overlap), 'dip_black' (dip to black), 'flash_white' (white flash), 'whip' (whip-pan motion blur, clips overlap), 'zoom_punch' (scale punch on the cut, great for beat drops), 'slide' (incoming clip slides over the outgoing, clips overlap), 'push' (outgoing pushed out while incoming slides in, clips overlap), 'spin' (rotation whip with blur, clips overlap), 'zoom' (zoom-through with radial blur, clips overlap), 'glitch' (digital glitch burst on the cut), 'blur_dissolve' (defocus crossfade, clips overlap), or 'fade' (fade in at the very start + fade out at the very end). duration in seconds (default 0.5). Omit clip_id to apply to EVERY cut (montage). Pass clip_id to add a transition only on the cut BEFORE that clip. Read the 'transitions' skill for placement guidance.",
				parameters: {
					type: "object",
					properties: {
						type: { type: "string" },
						duration: { type: "number" },
						clip_id: { type: "string" },
					},
				},
			},
		},
		run: async (args, editor) => {
			const { applyTimelineTransition } = await import("./transitions");
			return applyTimelineTransition(editor, {
				type: args.type,
				duration: Number(args.duration) || undefined,
				clipId: args.clip_id ? String(args.clip_id) : undefined,
			});
		},
	},

	add_music: {
		schema: {
			type: "function",
			function: {
				name: "add_music",
				description:
					"Add an audio asset from the media library to the timeline as the soundtrack, starting at t=0. Pass part of the asset's name (e.g. 'tokyo').",
				parameters: {
					type: "object",
					properties: {
						name_contains: {
							type: "string",
							description: "part of the audio file name",
						},
					},
					required: ["name_contains"],
				},
			},
		},
		run: async (args, editor) => {
			const q = String(args.name_contains || "").toLowerCase();
			const asset = editor.media
				.getAssets()
				.find(
					(a: any) => a.type === "audio" && a.name?.toLowerCase().includes(q),
				);
			if (!asset)
				return `No audio asset matching "${args.name_contains}" in the media library.`;
			const already = editor.timeline
				.getTracks()
				.filter((t: any) => t.type === "audio")
				.flatMap((t: any) => t.elements)
				.find((e: any) => e.mediaId === asset.id);
			if (already)
				return `"${asset.name}" is already on the timeline (clip_id ${already.id}, ${already.duration.toFixed(1)}s).`;
			const { buildElementFromMedia } = await import(
				"@/lib/timeline/element-utils"
			);
			const element = buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: asset.name,
				duration: asset.duration ?? 30,
				startTime: 0,
				sourceOriginalPath: (asset.file as any)?.originalPath,
				sourceProxyPath: (asset.file as any)?.proxyPath,
			});
			editor.timeline.insertElement({ element, placement: { mode: "auto" } });
			const placed = editor.timeline
				.getTracks()
				.filter((t: any) => t.type === "audio")
				.flatMap((t: any) => t.elements)
				.find((e: any) => e.mediaId === asset.id);
			return placed
				? `Added "${asset.name}" as soundtrack: clip_id ${placed.id}, duration ${placed.duration.toFixed(1)}s.`
				: "Insert failed — audio track not created.";
		},
	},

	trim_audio_before_vocals: {
		schema: {
			type: "function",
			function: {
				name: "trim_audio_before_vocals",
				description:
					"Detect where the vocals/rap start in an audio clip (speech-to-text) and trim the clip to keep ONLY the instrumental intro before the vocals.",
				parameters: {
					type: "object",
					properties: { clip_id: { type: "string" } },
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const found = findAudioClip(editor, args.clip_id);
			if (!found) return "No such audio clip.";
			const { clip } = found;
			const path = backendPathOf(editor, clip);
			if (!path)
				return "Audio file has no backend path — re-import the audio so it uploads to the server.";
			const res = await fetch(`${API_URL}/api/ai/transcribe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ audio_path: path, language: null }),
			});
			if (!res.ok) return `Vocal detection failed: ${await res.text()}`;
			const data = await res.json();
			if (data.fallback)
				return "Whisper model not available on the worker — cannot locate vocals.";
			const segs: any[] = (data.transcription ?? []).filter(
				(s: any) => (s.text ?? "").trim().length > 0,
			);
			if (segs.length === 0) return "No vocals detected in this audio.";
			// "Before the rap" ≠ "before the first vocal": many tracks open with a
			// sung hook. Rank three signals for where the rap verse actually starts:
			const norm = (t: string) =>
				t
					.toLowerCase()
					.replace(/[^a-z0-9 ]+/g, "")
					.trim();
			let vocalStart = -1;
			let rule = "";
			// Rule 1: a chant/buildup — ≥5 consecutive short near-identical
			// segments (e.g. a repeated one-word shout). Rap starts where it ends.
			for (let i = 0; i < segs.length; i++) {
				let j = i;
				const base = norm(segs[i].text);
				while (
					j + 1 < segs.length &&
					norm(segs[j + 1].text) === base &&
					base.split(" ").length <= 2
				)
					j++;
				if (j - i + 1 >= 5) {
					vocalStart = segs[j].end;
					rule = `end of the repeated "${segs[i].text.trim()}" chant`;
					break;
				}
			}
			// Rule 2: first dense verse — ≥4 words at ≥2.5 words/sec after t=20s.
			if (vocalStart < 0) {
				const dense = segs.find((s: any) => {
					const d = s.end - s.start;
					const w = (s.text ?? "").trim().split(/\s+/).length;
					return s.start >= 20 && w >= 4 && d > 0 && w / d >= 2.5;
				});
				if (dense) {
					vocalStart = dense.start;
					rule = "first dense verse";
				}
			}
			// Rule 3: fall back to the first vocal.
			if (vocalStart < 0) {
				vocalStart = segs[0].start;
				rule = "first vocal";
			}
			vocalStart = Math.max(0, vocalStart - 0.1);
			if (vocalStart < 3)
				return `Vocals start almost immediately (${vocalStart.toFixed(1)}s) — intro too short to use.`;
			const sourceDuration =
				clip.sourceDuration ??
				clip.trimStart + clip.duration + (clip.trimEnd ?? 0);
			const { UpdateElementTrimCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			editor.command.execute({
				command: new UpdateElementTrimCommand({
					elementId: clip.id,
					trimStart: clip.trimStart ?? 0,
					trimEnd: Math.max(
						0,
						sourceDuration - (clip.trimStart ?? 0) - vocalStart,
					),
					duration: vocalStart,
				}),
			});
			return `Rap starts at ${vocalStart.toFixed(1)}s (detected: ${rule}). Audio trimmed to the ${vocalStart.toFixed(1)}s section before the rap.`;
		},
	},

	fit_clips_to_audio: {
		schema: {
			type: "function",
			function: {
				name: "fit_clips_to_audio",
				description:
					"Shrink every video clip so the whole sequence exactly fits the soundtrack's length, with each cut landing on a musical beat (auto beat-sync). Run AFTER the soundtrack is added and trimmed.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: async (args, editor) => {
			const track = videoTrackOf(editor);
			if (!track || track.elements.length === 0) return "No video clips.";
			const found = findAudioClip(editor, undefined);
			if (!found) return "No soundtrack on the timeline — add music first.";
			const audio = found.clip;
			const A = audio.duration;
			const path = backendPathOf(editor, audio);
			let beats: number[] = [];
			if (path) {
				try {
					const res = await fetch(`${API_URL}/api/ai/detect-beats`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ audio_path: path, mode: "beat" }),
					});
					if (res.ok) {
						const data = await res.json();
						const off = audio.trimStart ?? 0;
						beats = (data.beats ?? [])
							.map((b: number) => b - off)
							.filter((b: number) => b > 0.4 && b < A - 0.25);
					}
				} catch {}
			}
			const clips = [...track.elements].sort(
				(a: any, b: any) => a.startTime - b.startTime,
			);
			const N = clips.length;
			// Cut points: ideal even spacing, snapped to the nearest beat.
			const cuts: number[] = [];
			let lastCut = 0;
			for (let i = 1; i < N; i++) {
				const ideal = (A * i) / N;
				let t = ideal;
				if (beats.length > 0) {
					let best = beats[0];
					for (const b of beats)
						if (Math.abs(b - ideal) < Math.abs(best - ideal)) best = b;
					t = best;
				}
				if (t <= lastCut + 0.2) t = lastCut + 0.2; // keep monotonic
				cuts.push(t);
				lastCut = t;
			}
			cuts.push(A);
			const { UpdateElementTrimCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			const { BatchCommand } = await import("@/lib/commands/batch-command");
			const cmds: any[] = [];
			let start = 0;
			for (let i = 0; i < N; i++) {
				const clip: any = clips[i];
				const d = Math.max(0.2, cuts[i] - start);
				const sourceDuration =
					clip.sourceDuration ??
					clip.trimStart + clip.duration + (clip.trimEnd ?? 0);
				cmds.push(
					new UpdateElementTrimCommand({
						elementId: clip.id,
						trimStart: clip.trimStart ?? 0,
						trimEnd: Math.max(0, sourceDuration - (clip.trimStart ?? 0) - d),
						startTime: start,
						duration: Math.min(d, clip.duration),
					}),
				);
				start = cuts[i];
			}
			editor.command.execute({ command: new BatchCommand(cmds) });
			return `Beat-sync fit: ${N} clips compressed to ${A.toFixed(1)}s total, cuts snapped to ${beats.length > 0 ? beats.length + " detected beats" : "even spacing (no beats detected)"}.`;
		},
	},

	mimic_style: {
		schema: {
			type: "function",
			function: {
				name: "mimic_style",
				description:
					"Analyze a reference video's editing style (color grade, camera motion, beat-sync, letterbox) and recreate it on the timeline: color-match deltas, ANIMATED push-ins/pull-outs, beat punches on cuts, transitions. Pass part of the reference asset's name (e.g. 'florence'). Optional intensity 0–1 blends the style in instead of copying it fully (default 1). After a successful run you can persist the style with save_style.",
				parameters: {
					type: "object",
					properties: {
						reference_name_contains: {
							type: "string",
							description: "part of the reference video's file name",
						},
						intensity: {
							type: "number",
							description: "0–1, how strongly to apply the style (default 1)",
						},
					},
					required: ["reference_name_contains"],
				},
			},
		},
		run: async (args, editor) => {
			const q = String(args.reference_name_contains || "").toLowerCase();
			const ref = editor.media
				.getAssets()
				.find(
					(a: any) => a.type === "video" && a.name?.toLowerCase().includes(q),
				);
			if (!ref)
				return `No video asset matching "${args.reference_name_contains}" in the media library.`;
			const refPath =
				(ref.file as any)?.originalPath || (ref.file as any)?.proxyPath;
			if (!refPath)
				return "Reference video has no backend path — wait for its upload to finish and retry.";
			const data = await fetchMimicFlow(editor, {
				referenceVideoPath: refPath,
			});
			if (data.status !== "success")
				return `Style analysis failed: ${data.error ?? "unknown error"}`;
			lastMimicAnalysis = { referenceName: ref.name, data };
			const intensity = typeof args.intensity === "number" ? args.intensity : 1;
			const result = await applyMimicToTimeline(editor, data, { intensity });
			return `Mimic "${ref.name}": ${data.summary ?? "style extracted"}. ${result.description} This style can now be persisted with save_style for later reuse.`;
		},
	},

	save_style: {
		schema: {
			type: "function",
			function: {
				name: "save_style",
				description:
					"Persist an extracted editing style into the Style Library so it can be re-applied to ANY future project with apply_style. Uses the style from the most recent mimic_style run; alternatively pass reference_name_contains to analyze a reference video and save it WITHOUT applying anything.",
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "short name for the style, e.g. 'fast travel vlog'",
						},
						reference_name_contains: {
							type: "string",
							description:
								"optional: analyze this reference video instead of using the last mimic run",
						},
					},
					required: ["name"],
				},
			},
		},
		run: async (args, editor) => {
			let source = lastMimicAnalysis;
			if (args.reference_name_contains) {
				const q = String(args.reference_name_contains).toLowerCase();
				const ref = editor.media
					.getAssets()
					.find(
						(a: any) => a.type === "video" && a.name?.toLowerCase().includes(q),
					);
				if (!ref)
					return `No video asset matching "${args.reference_name_contains}" in the media library.`;
				const refPath =
					(ref.file as any)?.originalPath || (ref.file as any)?.proxyPath;
				if (!refPath)
					return "Reference video has no backend path — wait for its upload to finish and retry.";
				// Analyze-only: no target paths, nothing is applied to the timeline.
				const res = await fetch(`${API_URL}/api/ai/mimic-flow`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ reference_video_path: refPath }),
				});
				if (!res.ok) return `Style analysis failed: ${await res.text()}`;
				const data: MimicFlowData = await res.json();
				if (data.status !== "success")
					return `Style analysis failed: ${data.error ?? "unknown error"}`;
				source = { referenceName: ref.name, data };
			}
			if (!source?.data?.style_profile)
				return "No style to save — run mimic_style first, or pass reference_name_contains.";
			const style = saveStyle({
				name: String(args.name || source.referenceName),
				referenceName: source.referenceName,
				summary: source.data.summary ?? "",
				profile: source.data.style_profile,
			});
			return `Saved style "${style.name}" (from ${style.referenceName}) to the Style Library: ${style.summary}. Apply it any time with apply_style.`;
		},
	},

	list_styles: {
		schema: {
			type: "function",
			function: {
				name: "list_styles",
				description:
					"List the saved editing styles in the Style Library that can be applied with apply_style.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: () => {
			const styles = listStyles();
			if (styles.length === 0)
				return "The Style Library is empty — extract a style with mimic_style and persist it with save_style.";
			return styles
				.map(
					(s) => `"${s.name}" — learned from ${s.referenceName}: ${s.summary}`,
				)
				.join("\n");
		},
	},

	apply_style: {
		schema: {
			type: "function",
			function: {
				name: "apply_style",
				description:
					"Apply a SAVED style from the Style Library to the current timeline. The style is re-adapted to this footage (color deltas, beat grid, motion — never a hard copy). intensity 0–1 controls how strongly it is applied (default 1, use ~0.5 for a subtle blend).",
				parameters: {
					type: "object",
					properties: {
						style_name: { type: "string" },
						intensity: { type: "number" },
					},
					required: ["style_name"],
				},
			},
		},
		run: async (args, editor) => {
			const style = findStyle(String(args.style_name ?? ""));
			if (!style) {
				const names = listStyles()
					.map((s) => `"${s.name}"`)
					.join(", ");
				return names
					? `No saved style matching "${args.style_name}". Available: ${names}.`
					: "The Style Library is empty — extract and save a style first (mimic_style → save_style).";
			}
			const intensity = typeof args.intensity === "number" ? args.intensity : 1;
			const result = await applySavedStyle(editor, style, intensity);
			return `Applied style "${style.name}" (learned from ${style.referenceName}). ${result.description}`;
		},
	},

	list_skills: {
		schema: {
			type: "function",
			function: {
				name: "list_skills",
				description:
					"List the editing-technique skills (markdown knowledge files) you can read. Each skill documents HOW a technique is built in this editor — read the relevant one before attempting a technique you are not sure about.",
				parameters: { type: "object", properties: {} },
			},
		},
		run: async () => {
			const { listSkills } = await import("./skills");
			return listSkills()
				.map((s) => `- ${s.name}: ${s.description}`)
				.join("\n");
		},
	},

	read_skill: {
		schema: {
			type: "function",
			function: {
				name: "read_skill",
				description:
					"Read one skill's full markdown recipe (from list_skills). Pass the skill name or a topic keyword like 'grid', 'beat', 'grading'. Apply what it documents with the editing tools.",
				parameters: {
					type: "object",
					properties: { skill: { type: "string" } },
					required: ["skill"],
				},
			},
		},
		run: async (args) => {
			const { getSkill, listSkills } = await import("./skills");
			const skill = getSkill(String(args.skill ?? ""));
			if (!skill) {
				const names = listSkills()
					.map((s) => s.name)
					.join(", ");
				return `No skill matching "${args.skill}". Available: ${names}.`;
			}
			return `SKILL ${skill.name}\n\n${skill.content}`;
		},
	},

	set_transform: {
		schema: {
			type: "function",
			function: {
				name: "set_transform",
				description:
					"Set a clip's transform (position x/y in canvas px, scale where 1 = 100%, rotate in degrees, opacity 0–1) and/or animate it with a preset: 'pop_in' (scale+fade entrance), 'slide_in' (slides from `from`: 'left'|'right'), 'spin_in' (rotate+scale entrance), 'ken_burns' (slow push-in across the whole clip), 'shake' (0.5s impact jitter), 'punch' (quick scale hit at time `at` seconds into the clip). Static values apply immediately; presets add keyframes.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						x: { type: "number" },
						y: { type: "number" },
						scale: { type: "number" },
						rotate: { type: "number" },
						opacity: { type: "number" },
						animate: { type: "string" },
						from: { type: "string" },
						at: { type: "number" },
					},
				},
			},
		},
		run: async (args, editor) => {
			const { applyClipTransform } = await import("./transforms");
			return applyClipTransform(editor, {
				clipId: args.clip_id ? String(args.clip_id) : undefined,
				x: args.x,
				y: args.y,
				scale: args.scale,
				rotate: args.rotate,
				opacity: args.opacity,
				animate: args.animate,
				from: args.from,
				at: args.at,
			});
		},
	},

	delete_clip: {
		schema: {
			type: "function",
			function: {
				name: "delete_clip",
				description: "Delete a specific clip from the timeline by its ID.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
					},
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "delete",
					clip_id: args.clip_id,
				},
			]);
			return n > 0
				? `Deleted clip ${args.clip_id} from the timeline.`
				: `Could not delete clip ${args.clip_id}.`;
		},
	},

	change_speed: {
		schema: {
			type: "function",
			function: {
				name: "change_speed",
				description: "Change the playback speed of a clip (slow motion or fast forward) with optional retime curves.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						speed: { type: "number", description: "Speed multiplier (e.g., 0.5 for 50% slow motion, 2.0 for 200% fast forward)" },
						maintain_pitch: { type: "boolean", description: "Whether to maintain audio pitch (default: true)" },
						reverse: { type: "boolean", description: "Whether to play the clip in reverse (default: false)" },
						curve: { type: "string", enum: ["ease_in", "ease_out", "ease_in_out"], description: "Easing curve for speed change" },
					},
					required: ["clip_id", "speed"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "change_speed",
					clip_id: args.clip_id,
					speed: args.speed,
					maintain_pitch: args.maintain_pitch ?? true,
					reverse: args.reverse ?? false,
					curve: args.curve,
				},
			]);
			return n > 0
				? `Changed playback speed of clip ${args.clip_id} to ${args.speed}x.`
				: `Could not change speed of clip ${args.clip_id}.`;
		},
	},

	split_clip: {
		schema: {
			type: "function",
			function: {
				name: "split_clip",
				description: "Split a specific clip into two separate clips at a given global timeline timestamp (in seconds).",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						time: { type: "number", description: "Global timeline seconds where the split should happen" },
					},
					required: ["clip_id", "time"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "split",
					clip_id: args.clip_id,
					time: args.time,
				},
			]);
			return n > 0
				? `Split clip ${args.clip_id} at timeline position ${args.time}s.`
				: `Could not split clip ${args.clip_id} at position ${args.time}s.`;
		},
	},

	trim_clip: {
		schema: {
			type: "function",
			function: {
				name: "trim_clip",
				description: "Trim a clip to keep only a specific range (start and end in seconds, relative to the clip's original media).",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						start: { type: "number", description: "Start time in seconds relative to source media (to keep)" },
						end: { type: "number", description: "End time in seconds relative to source media (to keep)" },
					},
					required: ["clip_id", "start", "end"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "trim",
					clip_id: args.clip_id,
					start: args.start,
					end: args.end,
				},
			]);
			return n > 0
				? `Trimmed clip ${args.clip_id} to range [${args.start}s, ${args.end}s].`
				: `Could not trim clip ${args.clip_id}.`;
		},
	},

	j_l_cut: {
		schema: {
			type: "function",
			function: {
				name: "j_l_cut",
				description: "Create a cinematic J-Cut or L-Cut. Positive offset creates L-Cut (audio from current clip overlaps into next video clip). Negative offset creates J-Cut (audio from next clip starts before the video).",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						offset: { type: "number", description: "Offset in seconds (negative for J-Cut, positive for L-Cut)" },
					},
					required: ["clip_id", "offset"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "demux_audio",
					clip_id: args.clip_id,
					offset: args.offset,
				},
			]);
			return n > 0
				? `Created J/L-Cut on clip ${args.clip_id} with offset ${args.offset}s.`
				: `Could not create J/L-Cut on clip ${args.clip_id}.`;
		},
	},

	add_overlay: {
		schema: {
			type: "function",
			function: {
				name: "add_overlay",
				description: "Add a picture-in-picture overlay (image/video) on top of the timeline.",
				parameters: {
					type: "object",
					properties: {
						asset_id: { type: "string", description: "ID of the media asset from library" },
						overlay_type: { type: "string", enum: ["video", "image"] },
						name: { type: "string", description: "Visual label for the overlay" },
						start: { type: "number", description: "Timeline start position in seconds" },
						duration: { type: "number", description: "Duration in seconds" },
						x: { type: "number", description: "Canvas X coordinate (default: 0)" },
						y: { type: "number", description: "Canvas Y coordinate (default: 0)" },
						scale: { type: "number", description: "Scale multiplier (default: 0.5)" },
						rotation: { type: "number", description: "Rotation angle in degrees (default: 0)" },
					},
					required: ["asset_id", "overlay_type", "start", "duration"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "add_overlay",
					asset_id: args.asset_id,
					overlay_type: args.overlay_type,
					name: args.name || "Overlay",
					start: args.start,
					duration: args.duration,
					x: args.x ?? 0,
					y: args.y ?? 0,
					scale: args.scale ?? 0.5,
					rotation: args.rotation ?? 0,
				},
			]);
			return n > 0
				? `Added overlay to the timeline starting at ${args.start}s.`
				: `Could not add overlay.`;
		},
	},

	add_mask: {
		schema: {
			type: "function",
			function: {
				name: "add_mask",
				description: "Apply a geometric mask (cropping/shaping) to a specific clip.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						mask_type: { type: "string", enum: ["rectangle", "ellipse"] },
						invert: { type: "boolean", description: "Invert the mask selection (default: false)" },
						feather: { type: "number", description: "Mask border softness feather in pixels (default: 10)" },
					},
					required: ["clip_id", "mask_type"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "add_mask",
					clip_id: args.clip_id,
					mask_type: args.mask_type,
					invert: args.invert ?? false,
					feather: args.feather ?? 10,
				},
			]);
			return n > 0
				? `Added mask to clip ${args.clip_id}.`
				: `Could not apply mask to clip ${args.clip_id}.`;
		},
	},

	add_subtitle: {
		schema: {
			type: "function",
			function: {
				name: "add_subtitle",
				description: "Add a text subtitle to the timeline.",
				parameters: {
					type: "object",
					properties: {
						text: { type: "string", description: "Subtitle text content" },
						start: { type: "number", description: "Start time on global timeline in seconds" },
						end: { type: "number", description: "End time on global timeline in seconds" },
					},
					required: ["text", "start", "end"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "add_subtitle",
					text: args.text,
					start: args.start,
					end: args.end,
				},
			]);
			return n > 0
				? `Added subtitle text: "${args.text}" from ${args.start}s to ${args.end}s.`
				: `Could not add subtitle.`;
		},
	},

	duplicate_clip: {
		schema: {
			type: "function",
			function: {
				name: "duplicate_clip",
				description: "Duplicate a clip onto a new parallel track layer.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						with_mask: { type: "boolean", description: "Duplicate with a mask (default: false)" },
						mask_type: { type: "string", enum: ["rectangle", "ellipse"] },
						invert: { type: "boolean" },
						feather: { type: "number" },
					},
					required: ["clip_id"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "duplicate_layer",
					clip_id: args.clip_id,
					with_mask: args.with_mask ?? false,
					mask_type: args.mask_type,
					invert: args.invert ?? false,
					feather: args.feather ?? 10,
				},
			]);
			return n > 0
				? `Duplicated clip ${args.clip_id} to a new layer.`
				: `Could not duplicate clip ${args.clip_id}.`;
		},
	},

	adjust_blend: {
		schema: {
			type: "function",
			function: {
				name: "adjust_blend",
				description: "Adjust opacity and blend modes for overlay overlay composites.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string" },
						opacity: { type: "number", description: "Opacity value (0.0 to 1.0)" },
						blend_mode: { type: "string", enum: ["normal", "multiply", "screen", "overlay", "darken"] },
					},
					required: ["clip_id", "opacity", "blend_mode"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "blend_mode",
					clip_id: args.clip_id,
					opacity: args.opacity,
					blend_mode: args.blend_mode,
				},
			]);
			return n > 0
				? `Adjusted blend mode of clip ${args.clip_id} to ${args.blend_mode} with opacity ${args.opacity}.`
				: `Could not adjust blend mode of clip ${args.clip_id}.`;
		},
	},

	upsert_keyframe: {
		schema: {
			type: "function",
			function: {
				name: "upsert_keyframe",
				description: "Add or update a keyframe for a clip property (e.g., scale, rotate, opacity, x, y) at a specific relative time inside the clip.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string", description: "Target clip ID" },
						property: { type: "string", enum: ["scale", "rotate", "opacity", "x", "y"], description: "The animated property" },
						time: { type: "number", description: "Time offset in seconds relative to the clip's start" },
						value: { type: "number", description: "Numeric value of the property at this keyframe" },
						interpolation: { type: "string", enum: ["linear", "hold", "ease_in", "ease_out", "ease_in_out"], description: "Interpolation curve to next keyframe (default: linear)" },
					},
					required: ["clip_id", "property", "time", "value"],
				},
			},
		},
		run: async (args, editor) => {
			const kfId = `kf-${Math.random().toString(36).substr(2, 9)}`;
			const n = await runOps(editor, [
				{
					action: "upsert_keyframe",
					clip_id: args.clip_id,
					property: args.property,
					keyframe: {
						id: kfId,
						time: args.time,
						value: args.value,
						interpolation: args.interpolation ?? "linear",
					},
				},
			]);
			return n > 0
				? `Upserted keyframe for ${args.property} on clip ${args.clip_id} at ${args.time}s.`
				: `Could not upsert keyframe.`;
		},
	},

	delete_keyframe: {
		schema: {
			type: "function",
			function: {
				name: "delete_keyframe",
				description: "Delete an existing keyframe from a clip.",
				parameters: {
					type: "object",
					properties: {
						clip_id: { type: "string", description: "Target clip ID" },
						property: { type: "string", description: "Target property (scale, rotate, opacity, x, y)" },
						keyframe_id: { type: "string", description: "ID of the keyframe to delete" },
					},
					required: ["clip_id", "property", "keyframe_id"],
				},
			},
		},
		run: async (args, editor) => {
			const n = await runOps(editor, [
				{
					action: "delete_keyframe",
					clip_id: args.clip_id,
					property: args.property,
					keyframe_id: args.keyframe_id,
				},
			]);
			return n > 0
				? `Deleted keyframe ${args.keyframe_id} on clip ${args.clip_id}.`
				: `Could not delete keyframe.`;
		},
	},
};

// The most recent mimic_style analysis, kept so save_style can persist it.
let lastMimicAnalysis: {
	referenceName: string;
	data: MimicFlowData;
} | null = null;

const FINISH_TOOL = {
	type: "function",
	function: {
		name: "finish",
		description:
			"Call this when the entire goal is complete. Provide a short summary of what you did.",
		parameters: {
			type: "object",
			properties: { summary: { type: "string" } },
		},
	},
};

const ASK_USER_TOOL = {
	type: "function",
	function: {
		name: "ask_user",
		description:
			"Ask the user ONE short clarifying question when the goal is ambiguous or a creative choice genuinely matters. Provide 2–4 concrete options. Returns the user's answer. Do NOT ask when the goal is already clear.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string" },
				options: {
					type: "array",
					items: { type: "string" },
					description: "2–4 short answer choices",
				},
			},
			required: ["question"],
		},
	},
};

const SYSTEM_PROMPT = `You are ChronoX, an autonomous cinematic video-editing agent.
You accomplish the user's goal by calling the available editing tools — ONE step at a time.
After each tool result, decide the next step based on what actually happened.

=== 4-LAYER VERIFICATION PIPELINE ===
For every request, you MUST mentally execute and verify through these 4 verification layers:

1. LAYER 1: Context Retrieval & Ingestion
   - Retrieve all timeline clips using list_clips.
   - For any target video clip, retrieve its visual ingest details (tags, brightness, contrast) by calling analyze_scenes to "see" the footage.
   - Cross-reference with the editing knowledge (NotebookLM rules, J-cuts, match cuts) and SurfSense semantic memory (episodic keeper decisions).

2. LAYER 2: Multi-Agent Visual Reasoning (Intent Reasoning & Error vs. Technique Distinction)
   - Analyze the visual properties returned by analyze_scenes.
   - You MUST distinguish between:
     * UNINTENTIONAL mistakes: Out-of-focus blurry footage, dark/underexposed camera errors (these should be trimmed, color corrected, or cut out).
     * INTENTIONAL techniques: Cinematic glow/blur transitions, stylized low-light grading, intentional shadows (these should be preserved or enhanced).
   - If the user says "cut boring/blurry scenes", target clips that have actual blurry tags or low quality/extreme contrast issues.

3. LAYER 3: Constraints & Rules Filtering (Golden Rules & Constraints)
   - Enforce these strict editing constraints on every command:
     * Audio voiceover/dialogue volume: Peak -6dB to -3dB.
     * Background music: Call apply_ducking to reduce background music by -12dB when dialogue is present.
     * Cuts: Every audio cut MUST have a crossfade transition (2-5 frames) to avoid click/pop sounds.
     * Motion: Avoid linear keyframes. Call set_easing with 'ease_in_out' for all punch-in, zoom, and text moves.
     * Genre: Talkshows must keep speech clear (enhance_speech) and avoid complex transitions/letterboxes. Cinematic/montage must cut on beats (fit_clips_to_audio).

4. LAYER 4: Direct Execution & Memory Write-back (Execution & Memory Logging)
   - Perform the validated atomic edits directly on the timeline.
   - Keep a mental log of applied operations so they write back to the episodic memory loop (KEEP/DELETE feedback).

Rules:
- If the user says the plan / brief / script / shot list is in Notion (or asks to edit according to Notion / brief), call load_brief_from_notion FIRST and treat its returned brief as the authoritative goal for the whole edit.
- Call list_clips first to discover the clips and their ids.
- After splitting a clip (via cut_into_scenes or split), you MUST call list_clips again to discover the new clip IDs before applying color adjustments, grading, or effects to them!
- When the user asks you to perform multiple operations in a single prompt (e.g. split into scenes AND grade them), do not stop after the first step. You MUST loop through the clips, analyze them, and execute color grading (using adjust_color) or effects step-by-step until all parts of the user request are fully satisfied.
- CRITICAL — PER-SCENE COLOR GRADING: When the user wants each scene coloured differently or "appropriately" ("different color for each scene", "appropriate color grading", "each scene a different/fitting colour"), call grade_scenes_vision ONCE after cutting into scenes. An AI colorist LOOKS at each scene's actual frame and designs a bespoke grade — distinct per scene, tuned to real content, cohesive overall. Do NOT hand-roll adjust_color per clip and do NOT apply fixed presets/category rules for this goal: that makes same-tag scenes identical and produces flat, ugly tints — exactly the bug to avoid. Only use per-clip adjust_color when the user asks to grade ONE specific shot a particular way.
- VISION SCENE SELECTION: When the user wants to clean up / trim footage, remove bad or boring shots, or auto-pick the best scenes ("curate scenes", "remove bad/blurry/boring shots", "keep beautiful scenes", "select appropriate scenes"), call curate_scenes_vision ONCE after cutting into scenes. An AI editor LOOKS at each frame and keeps the strong, varied shots while cutting blurry/badly-exposed/empty/duplicate ones, then closes the gaps. Prefer this over keep_only_scenery (which only filters by a coarse person/scenery tag) unless the user specifically asks to remove people.
- Before cutting or filtering by scene, call analyze_scenes to understand the footage.
- Use the real clip_id values returned by the tools — never invent ids.
- Do not repeat a tool that already succeeded.
- When the whole goal is done, call finish with a short summary.
- Only use the tools. Do not answer general questions.
- If the goal is ambiguous or a creative choice genuinely matters (which look,
  how aggressive, which soundtrack), call ask_user ONCE with 2–4 concrete
  options instead of guessing — then continue with the answer. Never ask when
  the goal is already clear, and never ask more than twice per run.
- The Style Library persists learned editing styles across projects:
  mimic_style learns from a reference video on this timeline, save_style
  persists it, list_styles shows what is saved, apply_style re-applies a
  saved style ADAPTED to the current footage (intensity < 1 blends it in).
- SKILLS are markdown recipes documenting how techniques are built in this
  editor (transitions, grading looks, grid/split-screen layouts, beat sync,
  pacing, transform animation, editing theory / Rule of Six, cut types like
  J-cut and match cut, transition psychology). Before attempting a technique you are not
  certain about — e.g. a grid layout, a specific look, beat placement —
  call read_skill with the topic and follow the documented recipe instead
  of improvising parameters. list_skills shows what is available.

For a full "cinematic montage" goal, the effective order is:
1. cut_into_scenes → keep_only_scenery → close_gaps (no holes in the sequence)
2. grade_cinematic + mute_clip on the video clips
3. add_music (soundtrack) → trim_audio_before_vocals (keep the instrumental intro)
4. fit_clips_to_audio (shrink clips to the soundtrack, cuts on beats)
5. mimic_style with the reference video, if the user names one
Skip any step the user did not ask for.`;

export interface RunAgentOptions {
	editor: any;
	goal: string;
	/** Which LLM drives the agent loop: "gemini" | "openai" | "grok" | "anthropic" | "ollama". */
	provider?: string;
	/** Provider model id (defaults per provider on the backend). */
	model?: string;
	/** User-supplied API key from the in-app provider settings. */
	apiKey?: string;
	maxSteps?: number;
	onEvent?: (e: AgentEvent) => void;
	/**
	 * Called when the agent needs the user's input mid-run (ask_user tool).
	 * Resolve with the user's answer; the run continues with it. When absent
	 * the agent is told to use its best judgment instead of blocking.
	 */
	onAskUser?: (question: string, options: string[]) => Promise<string>;
	signal?: AbortSignal;
}

/**
 * Run the autonomous editing agent loop until the model calls finish,
 * stops calling tools, or maxSteps is reached.
 */
export async function runEditingAgent({
	editor,
	goal,
	provider = process.env.NEXT_PUBLIC_AI_PROVIDER || "gemini",
	model = process.env.NEXT_PUBLIC_AI_MODEL,
	apiKey,
	maxSteps = 16,
	onEvent,
	onAskUser,
	signal,
}: RunAgentOptions): Promise<string> {
	const toolSchemas = [
		...Object.values(TOOLS).map((t) => t.schema),
		ASK_USER_TOOL,
		FINISH_TOOL,
	];
	const projectBrief = editor.project?.getActiveOrNull?.()?.metadata?.aiBrief;
	const messages: any[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		...(projectBrief
			? [
					{
						role: "system",
						content: `PROJECT BRIEF (the user's creative intent for this project — honour it in every edit): ${projectBrief}`,
					},
				]
			: []),
		{ role: "user", content: goal },
	];

	let finalSummary = "";
	let totalIn = 0;
	let totalOut = 0;
	// Adaptive pacing: after a rate-limit hit, space subsequent steps out so a
	// free-tier quota (e.g. Gemini: 5 req/min) can sustain a long agent run.
	let paceMs = 0;
	let nudges = 0;
	for (let step = 0; step < maxSteps; step++) {
		if (signal?.aborted) throw new DOMException("aborted", "AbortError");
		if (paceMs > 0 && step > 0) await new Promise((r) => setTimeout(r, paceMs));

		// Cloud providers throw transient 503/429 under load — retry with
		// backoff instead of dropping the whole agent run.
		let msg: any = null;
		let lastErr = "";
		const delays = [0, 4000, 10000, 26000, 30000];
		for (let attempt = 0; attempt < delays.length; attempt++) {
			if (delays[attempt] > 0)
				await new Promise((r) => setTimeout(r, delays[attempt]));
			const res = await fetch(`${API_URL}/api/ai/agent-step`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages,
					tools: toolSchemas,
					provider,
					model,
					api_key: apiKey,
				}),
				signal,
			});
			if (res.ok) {
				msg = await res.json();
				break;
			}
			lastErr = await res.text().catch(() => String(res.status));
			const transient =
				/503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(lastErr);
			if (!transient) throw new Error(`agent-step failed: ${lastErr}`);
			if (/429|RESOURCE_EXHAUSTED/i.test(lastErr)) paceMs = 13000;
			onEvent?.({
				type: "tool",
				tool: "retry",
				result: `Provider busy (attempt ${attempt + 1}/${delays.length}), retrying…`,
			});
		}
		if (!msg) throw new Error(`agent-step failed after retries: ${lastErr}`);
		const toolCalls: any[] = msg.tool_calls ?? [];

		// Accumulate real token usage across steps (reported by every provider).
		if (msg.usage) {
			totalIn += Number(msg.usage.input_tokens) || 0;
			totalOut += Number(msg.usage.output_tokens) || 0;
		}
		const usage = { input: totalIn, output: totalOut };

		if (toolCalls.length === 0) {
			const text = (msg.content ?? "").trim();
			// Some models occasionally return an empty message mid-run. That is
			// not "done" — nudge them to continue instead of ending the run.
			if (!text && nudges < 2) {
				nudges++;
				messages.push({
					role: "user",
					content:
						"Continue: call the next tool now, or call finish with a summary if the whole goal is complete.",
				});
				continue;
			}
			finalSummary = text || "Done.";
			onEvent?.({ type: "final", content: finalSummary, usage });
			break;
		}

		messages.push({
			role: "assistant",
			content: msg.content ?? "",
			tool_calls: toolCalls,
		});

		let finished = false;
		for (const tc of toolCalls) {
			const name = tc.function?.name;
			let args = tc.function?.arguments ?? {};
			if (typeof args === "string") {
				try {
					args = JSON.parse(args);
				} catch {
					args = {};
				}
			}

			if (name === "finish") {
				finalSummary = args.summary || msg.content || "Done.";
				onEvent?.({ type: "final", content: finalSummary, usage });
				finished = true;
				break;
			}

			if (name === "ask_user") {
				const question = String(args.question ?? "").trim();
				const options = Array.isArray(args.options)
					? args.options.map((o: any) => String(o)).slice(0, 4)
					: [];
				onEvent?.({ type: "ask", tool: name, args, content: question });
				let answer =
					"The user is not available right now — use your best judgment and continue.";
				if (onAskUser && question) {
					try {
						answer = `The user answered: ${await onAskUser(question, options)}`;
					} catch {
						// user dismissed / run aborted — fall through to best judgment
					}
				}
				if (signal?.aborted) throw new DOMException("aborted", "AbortError");
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					name,
					content: answer,
				});
				continue;
			}

			const tool = TOOLS[name];
			let result: string;
			try {
				result = tool ? await tool.run(args, editor) : `Unknown tool: ${name}`;
			} catch (err: any) {
				result = `Tool ${name} failed: ${err?.message ?? err}`;
			}
			onEvent?.({ type: "tool", tool: name, args, result });
			// Carry tool_call_id + name so the provider can correlate the
			// result with its call.
			messages.push({
				role: "tool",
				tool_call_id: tc.id,
				name,
				content: result,
			});
		}
		if (finished) break;
	}

	return finalSummary;
}

// Dev-only test seam: exposes the AI tool layer so the timeline mutations of
// each tool can be exercised deterministically from the browser console
// (mirrors window.__chronox for EditorCore). Never attached in production.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
	(window as any).__chronoxAI = { TOOLS, dryRunActions };
}
