/**
 * Agentic NLE — the local model as an autonomous editing agent.
 *
 * Instead of emitting one JSON blob of operations, the model is given a set of
 * high-level editing TOOLS (the app's features) and orchestrates them itself:
 * it calls one tool at a time, sees the real result, and decides the next step
 * until the goal is done. The backend `/api/ai/agent-step` is a thin Ollama
 * tool-call proxy; every tool below executes against the live timeline here.
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

export interface AgentEvent {
	type: "tool" | "final" | "error" | "ask";
	tool?: string;
	args?: any;
	result?: string;
	content?: string;
	usage?: { input: number; output: number };
}

interface ToolDef {
	schema: any; // Ollama function schema
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

// Resolve which video clips a grade/mute should hit. A clip_id after a
// scene-cut only names one segment, but the user means the whole source
// footage — so expand to every segment sharing that clip's media. No clip_id
// → all video clips.
function clipsToTarget(editor: any, clipId?: string): any[] {
	const videoClips: any[] = [];
	for (const t of editor.timeline.getTracks())
		if (t.type === "video") videoClips.push(...t.elements);
	if (!clipId) return videoClips;
	const target = videoClips.find((c) => c.id === clipId);
	if (!target) return [];
	if (target.mediaId) {
		const siblings = videoClips.filter((c) => c.mediaId === target.mediaId);
		if (siblings.length > 0) return siblings;
	}
	return [target];
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
					clips.push({
						clip_id: el.id,
						name: cleanName(el.name ?? el.type),
						type: el.type,
						track_type: t.type,
						duration: Math.round(el.duration * 10) / 10,
					});
				}
			}
			if (clips.length === 0)
				return "The timeline is empty — no clips to edit.";
			// Compact form: segments of the same source collapse into one line.
			const bySource = new Map<string, any[]>();
			for (const c of clips) {
				const k = `${c.track_type}:${c.name}`;
				if (!bySource.has(k)) bySource.set(k, []);
				bySource.get(k)!.push(c);
			}
			if (clips.length > 12) {
				const lines: string[] = [];
				for (const [k, group] of bySource) {
					if (group.length === 1) {
						const c = group[0];
						lines.push(
							`${k}: clip_id ${c.clip_id}, ${c.duration}s (${c.type})`,
						);
					} else {
						const total = group.reduce((s, c) => s + c.duration, 0);
						lines.push(
							`${k}: ${group.length} segments, total ${total.toFixed(1)}s, first clip_id ${group[0].clip_id} (pass any segment id — tools that act on the whole source expand it automatically)`,
						);
					}
				}
				return lines.join("\n");
			}
			return JSON.stringify(clips);
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

Rules:
- Call list_clips first to discover the clips and their ids.
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
	/** Which LLM drives the agent loop: "ollama" | "gemini" | "openai" | "grok" | "anthropic". */
	provider?: string;
	/** Provider model id (defaults per provider on the backend). */
	model?: string;
	/** User-supplied API key from the in-app provider settings. */
	apiKey?: string;
	localModel?: string; // legacy alias for the ollama model
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
	provider = process.env.NEXT_PUBLIC_AI_PROVIDER || "ollama",
	model = process.env.NEXT_PUBLIC_AI_MODEL,
	apiKey,
	localModel = "qwen3.5:9b",
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
					local_model: localModel,
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
			// Carry tool_call_id + name so OpenAI/Grok/Gemini can correlate the
			// result with its call (Ollama ignores the extra fields).
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
