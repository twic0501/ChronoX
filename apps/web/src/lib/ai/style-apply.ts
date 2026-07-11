/**
 * Style application engine — turns a mimic-flow analysis into live timeline
 * edits. Shared by the agent's mimic/apply_style tools and the Mimic tab.
 *
 * `intensity` (0–1, default 1) blends the style in instead of forcing an
 * exact copy: color deltas, zoom amounts, punch amplitudes and the number of
 * replicated transitions all scale down with it.
 */

import { dryRunActions } from "./compiler";
import type { SavedStyle } from "./style-library";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

/** Response of the worker's /api/ai/mimic-flow. */
export interface MimicFlowData {
	status: string;
	style_profile?: any;
	target_profile?: { duration: number; scenes: any[] } | null;
	mutations?: any[];
	segment_bounds?: number[];
	summary?: string;
	tempo_bpm?: number;
	total_beats?: number;
	scenes_detected?: number;
	error?: string;
}

// ─── Shared timeline helpers ─────────────────────────────────

export function videoTrackOf(editor: any) {
	return editor.timeline.getTracks().find((t: any) => t.type === "video");
}

export function findAudioClip(
	editor: any,
	clipId?: string,
): { track: any; clip: any } | null {
	for (const t of editor.timeline.getTracks()) {
		if (t.type !== "audio") continue;
		for (const el of t.elements) {
			if (!clipId || el.id === clipId) return { track: t, clip: el };
		}
	}
	return null;
}

/** Backend-visible path for a clip's source media (/static/… or abs path). */
export function backendPathOf(editor: any, clip: any): string | undefined {
	const direct = clip.sourceOriginalPath || clip.sourceProxyPath;
	if (direct) return direct;
	const asset = editor.media
		.getAssets()
		.find((a: any) => a.id === clip.mediaId);
	const fromFile =
		(asset?.file as any)?.originalPath || (asset?.file as any)?.proxyPath;
	if (fromFile) return fromFile;
	const url: string | undefined = asset?.url;
	if (url) {
		const i = url.indexOf("/static/");
		if (i !== -1) return url.slice(i);
	}
	return undefined;
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

// ─── Analysis fetch ──────────────────────────────────────────

/**
 * Run mimic-flow against the current timeline. Either `referenceVideoPath`
 * (fresh analysis) or `referenceProfile` (saved style, no reference file
 * needed) must be provided.
 */
export async function fetchMimicFlow(
	editor: any,
	source:
		| { referenceVideoPath: string }
		| { referenceProfile: Record<string, unknown> },
): Promise<MimicFlowData> {
	const track = videoTrackOf(editor);
	const clips = [...(track?.elements ?? [])].sort(
		(a: any, b: any) => a.startTime - b.startTime,
	);
	if (clips.length === 0) throw new Error("No video clips on the timeline.");
	const montageStart = clips[0].startTime;
	const last = clips[clips.length - 1];
	const montageLen = Math.max(
		last.startTime + last.duration - montageStart,
		0.1,
	);
	const targetPath = backendPathOf(editor, clips[0]);
	const audio = findAudioClip(editor);
	const audioPath = audio ? backendPathOf(editor, audio.clip) : undefined;

	const res = await fetch(`${API_URL}/api/ai/mimic-flow`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			reference_video_path:
				"referenceVideoPath" in source ? source.referenceVideoPath : undefined,
			reference_profile:
				"referenceProfile" in source ? source.referenceProfile : undefined,
			target_video_path: targetPath,
			target_audio_path: audioPath,
			target_video_duration: montageLen,
		}),
	});
	if (!res.ok) throw new Error(`Style analysis failed: ${await res.text()}`);
	return res.json();
}

// ─── Application ─────────────────────────────────────────────

export interface ApplyStyleResult {
	colorGrades: number;
	effects: number;
	pushIns: number;
	beatPunches: number;
	fades: number;
	transitions: Record<string, number>;
	beatDriven: boolean;
	description: string;
}

/**
 * Apply a mimic-flow analysis to the live timeline.
 * All edits go through the command stack, so one undo-run reverts them.
 */
export async function applyMimicToTimeline(
	editor: any,
	data: MimicFlowData,
	{ intensity = 1 }: { intensity?: number } = {},
): Promise<ApplyStyleResult> {
	const I = Math.max(0, Math.min(1, intensity));
	const profile = data.style_profile ?? {};
	const mutations: any[] = data.mutations ?? [];
	const segBounds: number[] = data.segment_bounds ?? [];

	const track = videoTrackOf(editor);
	const clips = [...(track?.elements ?? [])].sort(
		(a: any, b: any) => a.startTime - b.startTime,
	);
	if (clips.length === 0) throw new Error("No video clips to style.");
	const montageStart = clips[0].startTime;
	const lastClip = clips[clips.length - 1];
	const montageLen = Math.max(
		lastClip.startTime + lastClip.duration - montageStart,
		0.1,
	);
	const audio = findAudioClip(editor);
	const audioPath = audio ? backendPathOf(editor, audio.clip) : undefined;

	// Worker segments rarely match the timeline's clip count — map each
	// segment mutation to the clip at the same relative montage position.
	const clipAt = (idx: number): any | undefined => {
		if (idx < 0) return undefined;
		if (segBounds.length < 2) return clips[idx % clips.length];
		const lo = segBounds[Math.min(idx, segBounds.length - 2)];
		const hi = segBounds[Math.min(idx + 1, segBounds.length - 1)];
		const total = Math.max(segBounds[segBounds.length - 1], 1e-3);
		const ratio = (lo + hi) / 2 / total;
		let best: any;
		let bestD = Infinity;
		for (const c of clips) {
			const r = (c.startTime + c.duration / 2 - montageStart) / montageLen;
			const d = Math.abs(r - ratio);
			if (d < bestD) {
				bestD = d;
				best = c;
			}
		}
		return best;
	};

	const colorDelta = new Map<string, Record<string, number>>();
	const zoomPlan = new Map<
		string,
		{ scale: number; cx: number; cy: number; dir: string }
	>();
	const effectOps: any[] = [];
	// Global looks the reference used across the whole video (letterbox,
	// vignette, film glow) become ONE adjustment layer instead of the
	// same effect stamped onto every clip.
	const globalAdjust: Array<{ effect_type: string; params?: any }> = [];
	for (const m of mutations) {
		if (m.action === "ADJUST_COLOR") {
			const c = clipAt(m.clip_index);
			if (!c) continue;
			const cur = colorDelta.get(c.id) ?? {};
			// Intensity blends the color-match: deltas scale toward zero.
			for (const [k, v] of Object.entries(m.params ?? {}))
				if (typeof v === "number") cur[k] = (cur[k] ?? 0) + v * I;
			colorDelta.set(c.id, cur);
		} else if (m.action === "ADD_ZOOM") {
			const c = clipAt(m.clip_index);
			if (!c) continue;
			zoomPlan.set(c.id, {
				scale: 1 + ((m.scale ?? 1.06) - 1) * I,
				cx: (m.centerX || 0) * I,
				cy: (m.centerY || 0) * I,
				dir: m.direction === "out" ? "out" : "in",
			});
		} else if (m.action === "ADD_EFFECT" && m.effect_type) {
			// Effect strength follows intensity where the param supports it.
			const params =
				m.params && typeof m.params.intensity === "number"
					? { ...m.params, intensity: m.params.intensity * I }
					: m.params;
			if (m.clip_index === -1) {
				globalAdjust.push({ effect_type: m.effect_type, params });
			} else {
				const c = clipAt(m.clip_index);
				// idempotent: re-running mimic must not stack duplicate effects
				if (
					c &&
					!(c.effects ?? []).some((ef: any) => ef.type === m.effect_type)
				)
					effectOps.push({
						action: "add_effect",
						clip_id: c.id,
						effect_type: m.effect_type,
						params,
					});
			}
		}
	}

	// Color: worker params are DELTAS — merge them onto whatever grade the
	// clip already carries (its color-adjust effect) instead of replacing it.
	const colorOps: any[] = [];
	for (const [clipId, deltas] of colorDelta) {
		const c = clips.find((x: any) => x.id === clipId);
		const cur =
			(c?.effects ?? []).find((ef: any) => ef.type === "color-adjust")
				?.params ?? {};
		const merged: Record<string, number> = {};
		for (const [k, dv] of Object.entries(deltas)) {
			const isGain = k.startsWith("gain") || k.startsWith("gamma");
			const base = typeof cur[k] === "number" ? cur[k] : isGain ? 1 : 0;
			merged[k] = isGain
				? Math.max(0, Math.min(2, base + dv))
				: Math.max(-1, Math.min(1, base + dv));
		}
		colorOps.push({ action: "adjust_color", clip_id: clipId, params: merged });
	}
	const adjustOps = globalAdjust.length
		? [{ action: "add_adjustment", effects: globalAdjust }]
		: [];
	const nOps = await runOps(editor, [...adjustOps, ...colorOps, ...effectOps]);

	// Motion: recreate the reference's camera language with KEYFRAMES —
	// animated push-ins/pull-outs per scene, plus a scale "punch" on each
	// cut when the reference cuts on the beat. Hard cuts stay hard for
	// beat-driven styles; soft styles get a dip-to-black at each cut.
	const { UpsertKeyframeCommand } = await import(
		"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
	);
	const { BatchCommand } = await import("@/lib/commands/batch-command");
	const beatDriven = (profile.beat_sync ?? 0) >= 0.4 && !!audioPath;
	// Transition mix measured on the reference's own cuts — when present
	// it drives cut treatment; the generic dip-to-black fallback only
	// applies when the reference had no classifiable transitions.
	const trans: Record<string, number> = profile.transitions ?? {};
	const useTrans = Object.entries(trans).some(
		([k, v]) => k !== "hard" && (v as number) > 0,
	);
	const kfCmds: any[] = [];
	const kf = (el: any, path: string, time: number, value: any) =>
		kfCmds.push(
			new UpsertKeyframeCommand({
				trackId: track.id,
				elementId: el.id,
				propertyPath: path as any,
				time,
				value,
				interpolation: "linear",
			}),
		);
	let punched = 0;
	let pushed = 0;
	let faded = 0;
	const punchAmp = 1 + 0.07 * I;
	for (const c of clips) {
		const dur = c.duration;
		const zoom = zoomPlan.get(c.id);
		const punch = beatDriven && dur >= 0.35 && I > 0.15;
		const s0 = zoom ? (zoom.dir === "out" ? zoom.scale : 1.0) : 1.0;
		const s1 = zoom ? (zoom.dir === "out" ? 1.0 : zoom.scale) : 1.0;
		const scaleKfs: Array<[number, number]> = [];
		if (punch) {
			const win = Math.min(0.3, dur * 0.4);
			scaleKfs.push([0, s0 * punchAmp], [win, s0]);
			punched++;
			if (zoom) scaleKfs.push([dur, s1]);
		} else if (zoom) {
			scaleKfs.push([0, s0], [dur, s1]);
		}
		if (zoom) pushed++;
		for (const [t, v] of scaleKfs) {
			kf(c, "transform.scaleX", t, v);
			kf(c, "transform.scaleY", t, v);
		}
		if (zoom && (zoom.cx || zoom.cy)) {
			// drift toward the detected subject as the punch-in progresses
			kf(c, "transform.position", 0, { x: 0, y: 0 });
			kf(c, "transform.position", dur, {
				x: -zoom.cx * 100,
				y: -zoom.cy * 100,
			});
		}
		if (!beatDriven && !useTrans && dur >= 1.2 && I > 0.15) {
			const f = Math.min(0.35, dur * 0.18);
			kf(c, "opacity", 0, 0);
			kf(c, "opacity", f, 1);
			kf(c, "opacity", dur - f, 1);
			kf(c, "opacity", dur, 0);
			faded++;
		}
	}

	// Technique replication: recreate the reference's measured transition
	// mix on this timeline's cuts, adapted to the footage — a whip-pan's
	// direction follows the clip's own camera pan (from the raw-target
	// scene analysis, matched via the clip's source time).
	const transApplied: Record<string, number> = {};
	if (useTrans && I > 0.1) {
		const { AddClipEffectCommand } = await import(
			"@/lib/commands/timeline/element/effects/add-effect"
		);
		const { UpsertEffectParamKeyframeCommand } = await import(
			"@/lib/commands/timeline/element/keyframes/upsert-effect-param-keyframe"
		);
		const tgtScenes: any[] = data.target_profile?.scenes ?? [];
		const panDirOf = (c: any): number => {
			const srcMid = (c.trimStart ?? 0) + c.duration / 2;
			const s = tgtScenes.find((sc) => sc.start <= srcMid && srcMid <= sc.end);
			const p = s?.motion?.pan_x ?? 0;
			return Math.abs(p) < 0.05 ? 0 : Math.sign(p);
		};
		// runOps above replaced element objects — always read fresh state
		const freshEl = (id: string) =>
			(videoTrackOf(editor)?.elements ?? []).find((e: any) => e.id === id);
		const ensureEffect = (
			clipId: string,
			type: string,
			initialParams?: Record<string, unknown>,
		): string | undefined => {
			const el = freshEl(clipId);
			if (!el) return undefined;
			const existing = (el.effects ?? []).find((ef: any) => ef.type === type);
			if (existing) return existing.id;
			const cmd = new AddClipEffectCommand({
				trackId: track.id,
				elementId: clipId,
				effectType: type,
				initialParams,
			});
			editor.command.execute({ command: cmd });
			return cmd.getEffectId() ?? undefined;
		};
		const kfe = (
			clipId: string,
			effectId: string,
			key: string,
			time: number,
			value: number,
		) =>
			kfCmds.push(
				new UpsertEffectParamKeyframeCommand({
					trackId: track.id,
					elementId: clipId,
					effectId,
					paramKey: key,
					time,
					value,
					interpolation: "linear",
				}),
			);

		const boundaries: Array<[any, any]> = [];
		for (let i = 1; i < clips.length; i++)
			if (clips[i - 1].duration >= 0.5 && clips[i].duration >= 0.5)
				boundaries.push([clips[i - 1], clips[i]]);
		const totalCuts =
			Object.values(trans).reduce((s, v) => s + (v as number), 0) || 1;
		const taken = new Set<number>();
		let alt = 1;
		for (const type of [
			"whip",
			"zoom_punch",
			"flash_white",
			"dip_black",
			"dissolve",
		]) {
			// Intensity thins the transition density, keeping the same mix.
			const n = Math.round(
				((trans[type] ?? 0) / totalCuts) * boundaries.length * I,
			);
			for (let j = 0; j < n; j++) {
				let bi = Math.floor(((j + 0.5) * boundaries.length) / n);
				while (taken.has(bi) && bi < boundaries.length) bi++;
				if (bi >= boundaries.length) break;
				taken.add(bi);
				const [a, b] = boundaries[bi];
				const dA = a.duration;
				if (type === "whip") {
					let dir = panDirOf(a);
					if (dir === 0) {
						dir = alt;
						alt = -alt;
					}
					kf(a, "transform.position", Math.max(0, dA - 0.12), { x: 0, y: 0 });
					kf(a, "transform.position", dA, { x: dir * 600, y: 0 });
					kf(b, "transform.position", 0, { x: -dir * 600, y: 0 });
					kf(b, "transform.position", 0.12, { x: 0, y: 0 });
					const ba = ensureEffect(a.id, "blur", { intensity: 0 });
					const bb = ensureEffect(b.id, "blur", { intensity: 0 });
					if (ba) {
						kfe(a.id, ba, "intensity", Math.max(0, dA - 0.12), 0);
						kfe(a.id, ba, "intensity", dA, 0.6 * I);
					}
					if (bb) {
						kfe(b.id, bb, "intensity", 0, 0.6 * I);
						kfe(b.id, bb, "intensity", 0.12, 0);
					}
				} else if (type === "zoom_punch") {
					const amp = 1 + 0.18 * I;
					for (const p of ["transform.scaleX", "transform.scaleY"]) {
						kf(a, p, Math.max(0, dA - 0.1), 1.0);
						kf(a, p, dA, amp);
						kf(b, p, 0, amp);
						kf(b, p, 0.1, 1.0);
					}
				} else if (type === "flash_white") {
					const cb = ensureEffect(b.id, "color-adjust");
					if (cb) {
						kfe(b.id, cb, "exposure", 0, 1.6 * I);
						kfe(b.id, cb, "exposure", 0.1, 0);
					}
				} else if (type === "dip_black") {
					kf(a, "opacity", Math.max(0, dA - 0.15), 1);
					kf(a, "opacity", dA, 0);
					kf(b, "opacity", 0, 0);
					kf(b, "opacity", 0.15, 1);
				} else if (type === "dissolve") {
					kf(b, "opacity", 0, 0);
					kf(b, "opacity", 0.18, 1);
				}
				transApplied[type] = (transApplied[type] ?? 0) + 1;
			}
		}
	}
	if (kfCmds.length > 0)
		editor.command.execute({ command: new BatchCommand(kfCmds) });

	const transBits = Object.entries(transApplied)
		.map(([k, v]) => `${v}× ${k.replace("_", "-")}`)
		.join(", ");
	const motionBits = [
		pushed > 0 &&
			`${pushed} animated push-in/pull-out (keyframed, subject-centered)`,
		punched > 0 && `${punched} beat punches on cuts`,
		faded > 0 && `${faded} dip-to-black transitions`,
		transBits && `transitions replicated from reference: ${transBits}`,
	]
		.filter(Boolean)
		.join("; ");

	return {
		colorGrades: colorOps.length,
		effects: nOps - colorOps.length,
		pushIns: pushed,
		beatPunches: punched,
		fades: faded,
		transitions: transApplied,
		beatDriven,
		description: `Applied ${colorOps.length} color-match grades + ${
			nOps - colorOps.length
		} effects at ${Math.round(I * 100)}% intensity; motion: ${
			motionBits || "none needed"
		}${beatDriven ? " (beat-driven style — hard cuts kept)" : ""}.`,
	};
}

/** One-call path for saved styles: re-adapt to the current timeline + apply. */
export async function applySavedStyle(
	editor: any,
	style: SavedStyle,
	intensity = 1,
): Promise<ApplyStyleResult> {
	const data = await fetchMimicFlow(editor, {
		referenceProfile: style.profile as any,
	});
	if (data.status !== "success")
		throw new Error(data.error || "Style adaptation failed.");
	return applyMimicToTimeline(editor, data, { intensity });
}
