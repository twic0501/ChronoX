import { EditorCore } from "@/core";
import { Command } from "@/lib/commands/base-command";
import { BatchCommand } from "@/lib/commands/batch-command";
import {
        SplitElementsCommand,
        DeleteElementsCommand,
        UpdateElementTrimCommand,
        UpdateElementCommand,
        MoveElementCommand,
} from "@/lib/commands/timeline/element";
import {
        UpsertEffectParamKeyframeCommand,
        UpsertKeyframeCommand,
        RemoveKeyframeCommand,
} from "@/lib/commands/timeline/element/keyframes";
import { UpdateElementRetimeCommand } from "@/lib/commands/timeline/element/retime/update-element-retime";
import { AddClipEffectCommand } from "@/lib/commands/timeline/element/effects/add-effect";
import { UpdateClipEffectParamsCommand } from "@/lib/commands/timeline/element/effects/update-effect-params";
import { InsertElementCommand } from "@/lib/commands/timeline/element/insert-element";
import { buildDefaultMaskInstance } from "@/lib/masks";
import type { MaskType } from "@/lib/masks/types";
import type { TimelineTrack, TimelineElement } from "@/lib/timeline";

const VALID_MASK_TYPES: MaskType[] = [
	"split",
	"rectangle",
	"ellipse",
	"triangle",
	"diamond",
	"star",
	"brush",
];

/**
 * Effect types the renderer can actually resolve (effects registry). An
 * adjustment layer referencing anything outside this set would render nothing,
 * so we clamp to the closest supported look.
 */
const RENDERABLE_EFFECT_TYPES = [
	"color-adjust",
	"letterbox",
	"vignette",
	"halation",
	"camera-shake",
	"glitch",
	"blur",
	"grayscale",
	"invert",
	"sharpen",
	"film_grain",
	"duotone",
	"posterize",
	"pixelate",
	"chromatic_aberration",
	"lens_distortion",
	"radial_blur",
	"mirror",
];

/** Aliases the LLM commonly emits → real registry effect type. */
const EFFECT_TYPE_ALIASES: Record<string, string> = {
	grade: "color-adjust",
	color: "color-adjust",
	colorgrade: "color-adjust",
	color_grade: "color-adjust",
	cinematic: "color-adjust",
	bars: "letterbox",
	cinemascope: "letterbox",
	widescreen: "letterbox",
	crop: "letterbox",
	glow: "halation",
	bloom: "halation",
	shake: "camera-shake",
	handheld: "camera-shake",
	film: "halation",
	grain: "film_grain",
	noise: "film_grain",
	mosaic: "pixelate",
	censor: "pixelate",
	fisheye: "lens_distortion",
	barrel: "lens_distortion",
	"zoom-blur": "radial_blur",
	zoom_blur: "radial_blur",
	"rgb-split": "chromatic_aberration",
	rgb_split: "chromatic_aberration",
	fringe: "chromatic_aberration",
	"two-tone": "duotone",
	two_tone: "duotone",
};

function normalizeEffectType(raw: any, fixes: string[]): string {
	let t = String(raw || "color-adjust").toLowerCase().trim();
	if (EFFECT_TYPE_ALIASES[t]) {
		const mapped = EFFECT_TYPE_ALIASES[t];
		if (mapped !== t) fixes.push(`effect "${t}" → "${mapped}"`);
		t = mapped;
	}
	if (!RENDERABLE_EFFECT_TYPES.includes(t)) {
		fixes.push(`unknown effect "${t}" → "color-adjust"`);
		t = "color-adjust";
	}
	return t;
}

/** Total timeline duration = latest element end across all tracks. */
function getTimelineDuration(tracks: TimelineTrack[]): number {
	let end = 0;
	for (const t of tracks) {
		for (const el of t.elements) {
			end = Math.max(end, el.startTime + el.duration);
		}
	}
	return end;
}

/**
 * Builds a Mask in the real renderer shape ({ id, type, params: {...} }).
 * A flat { invert, feather } object would be silently ignored by the
 * mask pipeline, which reads params.inverted / params.feather.
 */
function buildMaskFromOp(op: any): { mask: ReturnType<typeof buildDefaultMaskInstance>; fixed?: string } {
        let maskType = (op.mask_type || "rectangle") as MaskType;
        let fixed: string | undefined;
        if (!VALID_MASK_TYPES.includes(maskType)) {
                fixed = `unknown mask_type "${maskType}" → rectangle`;
                maskType = "rectangle";
        }
        const mask = buildDefaultMaskInstance({ maskType });
        mask.params = {
                ...mask.params,
                inverted: !!op.invert,
                feather: typeof op.feather === "number" ? op.feather : 10,
        } as any;
        return { mask, fixed };
}

/**
 * Creates a shallow copy of the tracks and elements tree.
 * Retains original object references for deep nested properties (effects, animations, transforms)
 * to avoid expensive deep cloning on every AI command.
 */
export function createDryRunSnapshot(tracks: TimelineTrack[]): TimelineTrack[] {
        return tracks.map((track) => ({
                ...track,
                elements: track.elements.map((el) => ({ ...el })),
        })) as any as TimelineTrack[];
}

export interface CompileOptions {
        /**
         * strict = true: if the AI referenced a clip that cannot be found,
         * fail the operation instead of silently falling back to the first clip.
         * Used at Accept-time so manual edits during AI streaming never cause
         * an operation to land on the wrong clip.
         */
        strict?: boolean;
}

export interface CompileResult {
        command: Command | null;
        /** ID of the clip the operation actually resolved to */
        resolvedClipId?: string;
        /** How the target clip was found */
        resolvedBy?: "id" | "name" | "selection" | "first";
        /** Human-readable auto-corrections applied to AI-provided values */
        fixes: string[];
        /** Reason compilation failed (when command is null) */
        error?: string;
}

// ─── Target resolution ───────────────────────────────────────

function resolveTarget(
        op: any,
        tracks: TimelineTrack[],
        editor: EditorCore,
        strict: boolean
): { trackId: string; element?: TimelineElement; resolvedBy?: CompileResult["resolvedBy"]; error?: string } {
        const clipIdentifier = op.clip_id || op.clipId || op.clip_name || op.clipName || op.name || op.file;

        if (clipIdentifier) {
                const searchStr = String(clipIdentifier).toLowerCase();
                // 1. Exact UUID match
                for (const t of tracks) {
                        const found = t.elements.find((e) => e.id === clipIdentifier);
                        if (found) return { trackId: t.id, element: found, resolvedBy: "id" };
                }
                // 2. Partial name or media ID match
                for (const t of tracks) {
                        const found = t.elements.find(
                                (e) =>
                                        e.name?.toLowerCase().includes(searchStr) ||
                                        (e as any).mediaId?.toLowerCase().includes(searchStr)
                        );
                        if (found) return { trackId: t.id, element: found, resolvedBy: "name" };
                }
                // Identifier was given but nothing matched.
                if (strict) {
                        return {
                                trackId: "",
                                error: `Clip "${String(clipIdentifier).slice(0, 12)}" no longer exists on the timeline (it may have been edited or deleted manually).`,
                        };
                }
        }

        // 3. Fallback to active selection
        if (editor?.selection) {
                const selected = editor.selection.getSelectedElements();
                if (selected.length > 0) {
                        const selId = selected[0].elementId;
                        for (const t of tracks) {
                                const found = t.elements.find((e) => e.id === selId);
                                if (found) return { trackId: t.id, element: found, resolvedBy: "selection" };
                        }
                }
        }

        // 4. Ultimate fallback: first element (only when no identifier was given, or non-strict)
        for (const t of tracks) {
                if (t.elements.length > 0) {
                        return { trackId: t.id, element: t.elements[0], resolvedBy: "first" };
                }
        }

        return { trackId: "", error: "Timeline is empty — no clip available for this operation." };
}

// ─── Auto-fix helpers ────────────────────────────────────────

/** Estimate total usable source duration of an element (ignoring retime). */
function getSourceDuration(element: TimelineElement): number {
        const src = (element as any).sourceDuration;
        if (typeof src === "number" && src > 0) return src;
        return (element.trimStart || 0) + element.duration + (element.trimEnd || 0);
}

/**
 * Normalize the AI-provided split time to an absolute timeline time strictly
 * inside the element. Local LLMs often answer "split at second 4" meaning
 * 4 seconds INTO the clip, while SplitElementsCommand expects timeline time —
 * out-of-range values silently no-op, so we convert/clamp here.
 */
function normalizeSplitTime(
        rawTime: number,
        element: TimelineElement,
        fixes: string[]
): number {
        const start = element.startTime;
        const end = element.startTime + element.duration;
        const EPS = 0.05;

        if (rawTime > start + EPS && rawTime < end - EPS) {
                return rawTime; // already valid absolute time
        }
        // Interpret as clip-relative if it fits inside the clip's duration
        if (rawTime > EPS && rawTime < element.duration - EPS) {
                const abs = start + rawTime;
                fixes.push(`split time ${rawTime}s interpreted as clip-relative → ${abs.toFixed(2)}s on timeline`);
                return abs;
        }
        // Clamp into valid range as a last resort
        const clamped = Math.min(Math.max(rawTime, start + EPS), end - EPS);
        fixes.push(`split time ${rawTime}s out of clip range [${start.toFixed(2)}–${end.toFixed(2)}] → clamped to ${clamped.toFixed(2)}s`);
        return clamped;
}

/**
 * Translates JSON operation from AI into a corresponding Command class,
 * applying an auto-fix layer (clamp/swap/convert) so small numeric mistakes
 * from the LLM never produce invalid or silently-ignored commands.
 */
export function compileActionDetailed(
        op: any,
        tracks: TimelineTrack[],
        editor: EditorCore,
        opts: CompileOptions = {}
): CompileResult {
        const fixes: string[] = [];
        let action = (op.action || "").toLowerCase();
        // Normalize synonyms to prevent AI naming variations
        if (action === "speed") action = "change_speed";
        if (action === "volume") action = "adjust_volume";
        if (action === "filter" || action === "effect") action = "add_effect";
        if (action === "mask") action = "add_mask";
        if (action === "cut") action = "split";
        if (action === "remove") action = "delete";
        // Adjustment-layer synonyms → one canonical op. A "look" is a global
        // effect spanning the timeline (grade / letterbox / vignette), NOT a
        // per-clip stamp.
        if (
                action === "adjustment" ||
                action === "adjustment_layer" ||
                action === "add_look" ||
                action === "look" ||
                action === "cinematic_look" ||
                action === "grade" ||
                action === "color_grade"
        )
                action = "add_adjustment";

        // Operations that create new global elements don't need a target clip
        const NO_TARGET_ACTIONS = new Set([
                "add_subtitle",
                "add_overlay",
                "mux_audio",
                "add_adjustment",
        ]);
        const needsTarget = !NO_TARGET_ACTIONS.has(action);

        let trackId = "";
        let element: TimelineElement | undefined;
        let resolvedBy: CompileResult["resolvedBy"];

        if (needsTarget) {
                const target = resolveTarget(op, tracks, editor, !!opts.strict);
                if (target.error) {
                        return { command: null, fixes, error: target.error };
                }
                trackId = target.trackId;
                element = target.element;
                resolvedBy = target.resolvedBy;
        }

        const clipId = element?.id;

        const fail = (error: string): CompileResult => ({ command: null, fixes, error });
        const ok = (command: Command): CompileResult => ({
                command,
                resolvedClipId: clipId,
                resolvedBy,
                fixes,
        });

        switch (action) {
                case "split": {
                        if (!clipId || !trackId || !element) return fail("No target clip for split.");
                        let time = typeof op.time === "number" ? op.time : NaN;
                        if (Number.isNaN(time)) return fail("Split operation is missing a numeric 'time'.");
                        time = normalizeSplitTime(time, element, fixes);
                        return ok(
                                new SplitElementsCommand({
                                        elements: [{ trackId, elementId: clipId }],
                                        splitTime: time,
                                })
                        );
                }
                case "trim": {
                        if (!clipId || !trackId || !element) return fail("No target clip for trim.");
                        const sourceDur = getSourceDuration(element);
                        let start = typeof op.start === "number" ? op.start : 0;
                        let end = typeof op.end === "number" ? op.end : sourceDur;

                        // AI semantics: keep the range [start, end] of the source.
                        if (start > end) {
                                [start, end] = [end, start];
                                fixes.push(`trim start > end → swapped to [${start}, ${end}]`);
                        }
                        if (start < 0) {
                                fixes.push(`trim start ${start}s → clamped to 0`);
                                start = 0;
                        }
                        if (end > sourceDur) {
                                fixes.push(`trim end ${end}s beyond source (${sourceDur.toFixed(2)}s) → clamped`);
                                end = sourceDur;
                        }
                        if (end - start < 0.1) {
                                return fail(`Trim range [${start}, ${end}] would leave an empty clip.`);
                        }
                        // Convert "keep range" semantics into source-side trim amounts.
                        return ok(
                                new UpdateElementTrimCommand({
                                        elementId: clipId,
                                        trimStart: start,
                                        trimEnd: sourceDur - end,
                                        duration: end - start,
                                })
                        );
                }
                case "delete": {
                        if (!clipId || !trackId) return fail("No target clip for delete.");
                        return ok(
                                new DeleteElementsCommand({
                                        elements: [{ trackId, elementId: clipId }],
                                })
                        );
                }
                case "voice_isolation": {
                        if (!clipId || !trackId) return fail("No target clip for voice isolation.");
                        const enabled = op.enabled !== false;
                        return ok(
                                new UpdateElementCommand({
                                        trackId,
                                        elementId: clipId,
                                        updates: {
                                                voice_isolation: enabled,
                                        } as any,
                                })
                        );
                }
                case "stabilize": {
                        if (!clipId || !trackId) return fail("No target clip for stabilization.");
                        const enabled = op.enabled !== false;
                        return ok(
                                new UpdateElementCommand({
                                        trackId,
                                        elementId: clipId,
                                        updates: {
                                                stabilize: enabled,
                                        } as any,
                                })
                        );
                }
                case "transform": {
                        if (!clipId || !trackId || !element) return fail("No target clip for transform.");
                        let scale = typeof op.scale === "number" ? op.scale : 1.0;
                        if (scale <= 0 || scale > 10) {
                                fixes.push(`scale ${scale} out of range → clamped`);
                                scale = Math.min(Math.max(scale, 0.05), 10);
                        }
                        const rotation = typeof op.rotation === "number" ? op.rotation : 0;
                        const x = typeof op.position_x === "number" ? op.position_x : 0;
                        const y = typeof op.position_y === "number" ? op.position_y : 0;
                        // NOTE: the renderer's Transform shape is
                        // { scaleX, scaleY, position, rotate } — writing any other
                        // shape makes scaleX undefined → NaN canvas size → the
                        // render loop dies and playback freezes.
                        return ok(
                                new UpdateElementCommand({
                                        trackId,
                                        elementId: clipId,
                                        updates: {
                                                transform: {
                                                        scaleX: scale,
                                                        scaleY: scale,
                                                        position: { x, y },
                                                        rotate: rotation,
                                                } as any,
                                        },
                                })
                        );
                }
                case "adjust_color": {
                        // The renderer never reads element.params for video clips —
                        // color only renders through a "color-adjust" effect in
                        // element.effects (same path the Adjustment tab uses).
                        // Writing element.params here was a visual no-op.
                        if (!clipId || !trackId) return fail("No target clip for color adjustment.");
                        const params = { ...(op.params || {}) };
                        // The AI's adjust_color tool exposes `warmth`, but the
                        // color-adjust effect/shader key is `temperature`. Alias
                        // it so warm/cool per-scene grading is not dropped.
                        if (params.warmth !== undefined && params.temperature === undefined) {
                                params.temperature = params.warmth;
                                delete params.warmth;
                                fixes.push("mapped color param warmth → temperature");
                        }
                        const existing = ((element as any)?.effects ?? []).find(
                                (ef: any) => ef.type === "color-adjust"
                        );
                        if (existing) {
                                return ok(
                                        new UpdateClipEffectParamsCommand({
                                                trackId,
                                                elementId: clipId,
                                                effectId: existing.id,
                                                params,
                                        })
                                );
                        }
                        return ok(
                                new AddClipEffectCommand({
                                        trackId,
                                        elementId: clipId,
                                        effectType: "color-adjust",
                                        initialParams: params,
                                })
                        );
                }
                case "change_speed": {
                        if (!clipId || !trackId) return fail("No target clip for speed change.");
                        let rate = typeof op.speed === "number" ? op.speed : 1.0;
                        if (rate <= 0 || rate > 20) {
                                fixes.push(`speed ${rate}x out of range → clamped`);
                                rate = Math.min(Math.max(rate, 0.05), 20);
                        }
                        // Speed-ramp easing: accept named presets or explicit bezier points
                        const CURVE_PRESETS: Record<string, { p1x: number; p1y: number; p2x: number; p2y: number }> = {
                                ease_in: { p1x: 0.42, p1y: 0, p2x: 1, p2y: 1 },
                                ease_out: { p1x: 0, p1y: 0, p2x: 0.58, p2y: 1 },
                                ease_in_out: { p1x: 0.42, p1y: 0, p2x: 0.58, p2y: 1 },
                        };
                        let curve = op.curve;
                        if (typeof curve === "string") {
                                curve = CURVE_PRESETS[curve.toLowerCase()] ?? undefined;
                                if (!curve) fixes.push(`unknown speed curve "${op.curve}" → linear`);
                        }
                        return ok(
                                new UpdateElementRetimeCommand({
                                        trackId,
                                        elementId: clipId,
                                        retime: {
                                                rate,
                                                maintainPitch: op.maintain_pitch !== false,
                                                reverse: !!op.reverse,
                                                curve,
                                        },
                                })
                        );
                }
                case "adjust_volume":
                case "duck_audio": {
                        if (!clipId || !trackId) return fail("No target clip for volume adjustment.");
                        // element.volume is a LINEAR WebAudio gain (audio-manager sets
                        // clipGain.gain.value = clip.volume directly): 0 = mute, 1 = normal, 2 = +6dB.
                        let volume = typeof op.volume === "number" ? op.volume : 1.0;
                        if (volume < 0 || volume > 2) {
                                fixes.push(`volume ${volume} out of range → clamped to [0, 2]`);
                                volume = Math.min(Math.max(volume, 0), 2);
                        }
                        const updates: Record<string, unknown> = { volume };
                        // mute intent (volume 0): also flip the muted flag so the UI reflects it
                        if (volume === 0 || op.mute === true) {
                                updates.muted = true;
                                updates.volume = 0;
                        } else if (op.mute === false) {
                                updates.muted = false;
                        }
                        return ok(
                                new UpdateElementCommand({
                                        trackId,
                                        elementId: clipId,
                                        updates: updates as any,
                                })
                        );
                }
                case "add_effect": {
                        if (!clipId || !trackId) return fail("No target clip for effect.");
                        return ok(
                                new AddClipEffectCommand({
                                        trackId,
                                        elementId: clipId,
                                        effectType: op.effect_type || op.filter || op.effect || "grayscale",
                                        initialParams:
                                                op.params && typeof op.params === "object"
                                                        ? op.params
                                                        : undefined,
                                })
                        );
                }
                case "add_adjustment": {
                        // Professional adjustment layer: one EffectElement on an
                        // "effect" track, spanning a time range, applied by the
                        // renderer OVER everything beneath it (EffectLayerNode).
                        // This is the correct home for a GLOBAL look — never stamp
                        // the same grade/letterbox/vignette onto every clip.
                        const timelineDur = getTimelineDuration(tracks);
                        const start =
                                typeof op.start === "number" ? Math.max(0, op.start) : 0;
                        let duration =
                                typeof op.duration === "number"
                                        ? op.duration
                                        : typeof op.end === "number"
                                                ? op.end - start
                                                : timelineDur - start;
                        if (!(duration > 0)) duration = timelineDur > 0 ? timelineDur : 5;

                        // Accept either a single effect or a stack of effects. Each
                        // becomes its own adjustment element on the same effect track,
                        // so a "cinematic look" (grade + letterbox + vignette) is a
                        // clean stack the user can toggle individually.
                        const rawEffects: any[] = Array.isArray(op.effects)
                                ? op.effects
                                : [
                                                {
                                                        effect_type:
                                                                op.effect_type || op.effect || op.filter,
                                                        params: op.params,
                                                },
                                        ];

                        const inserts: Command[] = rawEffects.map((e) => {
                                const effectType = normalizeEffectType(
                                        e.effect_type || e.effect || e.type,
                                        fixes,
                                );
                                const params =
                                        e.params && typeof e.params === "object" ? e.params : {};
                                return new InsertElementCommand({
                                        element: {
                                                type: "effect",
                                                name: `Adjustment · ${effectType}`,
                                                effectType,
                                                params,
                                                startTime: start,
                                                duration,
                                                trimStart: 0,
                                                trimEnd: 0,
                                        } as any,
                                        placement: { mode: "auto", trackType: "effect" as any },
                                });
                        });

                        if (inserts.length === 0)
                                return fail("add_adjustment had no effects to apply.");
                        return ok(
                                inserts.length === 1
                                        ? inserts[0]
                                        : new BatchCommand(inserts),
                        );
                }
                case "add_mask": {
                        if (!clipId || !trackId || !element) return fail("No target clip for mask.");
                        const { mask, fixed } = buildMaskFromOp(op);
                        if (fixed) fixes.push(fixed);
                        // Append to any existing masks instead of clobbering them, so
                        // stacked reveals (e.g. split + ellipse) survive.
                        const existingMasks = ((element as any).masks ?? []) as any[];
                        return ok(
                                new UpdateElementCommand({
                                        trackId,
                                        elementId: clipId,
                                        updates: {
                                                masks: [...existingMasks, mask],
                                        } as any,
                                })
                        );
                }
                case "demux_audio": {
                        // J-Cut / L-Cut foundation: pull the clip's audio onto its own
                        // audio track (with optional lead/trail offset) and mute the video.
                        if (!clipId || !trackId || !element) return fail("No target clip for audio demux.");
                        const mediaId = (element as any).mediaId;
                        if (!mediaId) return fail("Target clip has no media source to demux.");
                        let offset = typeof op.offset === "number" ? op.offset : 0;
                        if (Math.abs(offset) > element.duration) {
                                fixes.push(`demux offset ${offset}s larger than clip → clamped`);
                                offset = Math.sign(offset) * Math.min(Math.abs(offset), element.duration / 2);
                        }
                        const audioInsert = new InsertElementCommand({
                                element: {
                                        type: "audio",
                                        name: `${element.name || "Clip"} (audio)`,
                                        mediaId,
                                        startTime: Math.max(0, element.startTime + offset),
                                        duration: element.duration,
                                        trimStart: element.trimStart,
                                        trimEnd: element.trimEnd,
                                } as any,
                                placement: { mode: "auto", trackType: "audio" as any },
                        });
                        const muteVideo = new UpdateElementCommand({
                                trackId,
                                elementId: clipId,
                                updates: { muted: true } as any,
                        });
                        return ok(new BatchCommand([audioInsert, muteVideo]));
                }
                case "duplicate_layer": {
                        // Layering foundation (Text Behind Subject / Color Pop):
                        // clone the clip onto a new overlay track above it.
                        if (!clipId || !trackId || !element) return fail("No target clip to duplicate.");
                        const clone: any = structuredClone
                                ? structuredClone({ ...element })
                                : JSON.parse(JSON.stringify(element));
                        delete clone.id;
                        clone.name = `${element.name || "Clip"} (layer)`;
                        if (op.with_mask) {
                                const { mask, fixed } = buildMaskFromOp(op);
                                if (fixed) fixes.push(fixed);
                                clone.masks = [mask];
                        }
                        return ok(
                                new InsertElementCommand({
                                        element: clone,
                                        placement: { mode: "auto", trackType: (element.type === "audio" ? "audio" : "video") as any, insertIndex: 0 },
                                })
                        );
                }
                case "mux_audio": {
                        const assetId = op.audio_asset_id || op.asset_id || op.media_id;
                        if (!assetId) return fail("mux_audio requires an audio_asset_id.");
                        return ok(
                                new InsertElementCommand({
                                        element: {
                                                type: "audio",
                                                name: op.audio_name || "Music",
                                                mediaId: assetId,
                                                startTime: typeof op.start === "number" ? Math.max(0, op.start) : 0,
                                                duration: typeof op.duration === "number" ? op.duration : 10.0,
                                                trimStart: 0,
                                                trimEnd: 0,
                                        } as any,
                                        placement: { mode: "auto", trackType: "audio" as any },
                                })
                        );
                }
                case "add_subtitle": {
                        const start = typeof op.start === "number" ? Math.max(0, op.start) : 0;
                        let duration = typeof op.duration === "number" ? op.duration : 3.0;
                        if (typeof op.end === "number" && typeof op.start === "number" && op.end > op.start) {
                                duration = op.end - op.start;
                        }
                        return ok(
                                new InsertElementCommand({
                                        element: {
                                                type: "text",
                                                name: "Subtitle",
                                                content: op.text || "New Subtitle",
                                                startTime: start,
                                                duration,
                                                trimStart: 0,
                                                trimEnd: 0,
                                                fontSize: 32,
                                                fontFamily: "Inter",
                                                color: "#ffffff",
                                                background: { enabled: false, color: "#000000" },
                                                textAlign: "center",
                                                fontWeight: "normal",
                                                fontStyle: "normal",
                                                textDecoration: "none",
                                                transform: { position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotate: 0 },
                                                opacity: 1,
                                        },
                                        // "auto" creates/finds a compatible text track — real track ids
                                        // are UUIDs, so a hardcoded explicit id would silently fail.
                                        placement: { mode: "auto", trackType: "text" as any },
                                })
                        );
                }
                case "add_overlay": {
                        return ok(
                                new InsertElementCommand({
                                        element: {
                                                type: op.overlay_type || "video",
                                                name: "Overlay Clip",
                                                mediaId: op.media_id || op.asset_id || "placeholder_media",
                                                startTime: typeof op.start === "number" ? Math.max(0, op.start) : 0,
                                                duration: typeof op.duration === "number" ? op.duration : 5.0,
                                                trimStart: 0,
                                                trimEnd: 0,
                                                transform: { position: { x: op.x || 0, y: op.y || 0 }, scaleX: op.scale || 0.5, scaleY: op.scale || 0.5, rotate: op.rotation || 0 },
                                                opacity: 0.8,
                                        } as any,
                                        placement: { mode: "auto", trackType: ((op.overlay_type === "audio" ? "audio" : "video")) as any, insertIndex: 0 },
                                })
                        );
                }
                case "blend_mode": {
                        if (!clipId || !trackId) return fail("No target clip for blend mode.");
                        const opacity = typeof op.opacity === "number" ? Math.min(Math.max(op.opacity, 0), 1) : 1.0;
                        const blendMode = op.blend_mode || "normal";
                        return ok(
                                new UpdateElementCommand({
                                        trackId,
                                        elementId: clipId,
                                        updates: {
                                                opacity,
                                                blendMode,
                                        } as any,
                                })
                        );
                }
                case "upsert_keyframe": {
                        if (!clipId || !trackId) return fail("No target clip for keyframe upsert.");
                        const prop = String(op.property || "").toLowerCase();
                        let propertyPath: any = prop;
                        if (prop === "scale") {
                                propertyPath = "transform.scaleX";
                        } else if (prop === "rotate" || prop === "rotation") {
                                propertyPath = "transform.rotate";
                        } else if (prop === "x" || prop === "position_x") {
                                propertyPath = "transform.position.x";
                        } else if (prop === "y" || prop === "position_y") {
                                propertyPath = "transform.position.y";
                        } else if (prop === "opacity") {
                                propertyPath = "opacity";
                        }
                        const keyframe = op.keyframe || {};
                        const kfId = keyframe.id || `kf-${Math.random().toString(36).substr(2, 9)}`;
                        const time = typeof keyframe.time === "number" ? keyframe.time : 0.0;
                        const value = typeof keyframe.value === "number" ? keyframe.value : 0.0;
                        const interpolation = keyframe.interpolation || "linear";

                        if (prop === "scale") {
                                return ok(
                                        new BatchCommand([
                                                new UpsertKeyframeCommand({
                                                        trackId,
                                                        elementId: clipId,
                                                        propertyPath: "transform.scaleX",
                                                        time,
                                                        value,
                                                        interpolation,
                                                        keyframeId: kfId + "-x",
                                                }),
                                                new UpsertKeyframeCommand({
                                                        trackId,
                                                        elementId: clipId,
                                                        propertyPath: "transform.scaleY",
                                                        time,
                                                        value,
                                                        interpolation,
                                                        keyframeId: kfId + "-y",
                                                }),
                                        ])
                                );
                        }

                        return ok(
                                new UpsertKeyframeCommand({
                                        trackId,
                                        elementId: clipId,
                                        propertyPath,
                                        time,
                                        value,
                                        interpolation,
                                        keyframeId: kfId,
                                })
                        );
                }
                case "delete_keyframe": {
                        if (!clipId || !trackId) return fail("No target clip for keyframe deletion.");
                        const prop = String(op.property || "").toLowerCase();
                        let propertyPath: any = prop;
                        if (prop === "scale") {
                                propertyPath = "transform.scaleX";
                        } else if (prop === "rotate" || prop === "rotation") {
                                propertyPath = "transform.rotate";
                        } else if (prop === "x" || prop === "position_x") {
                                propertyPath = "transform.position.x";
                        } else if (prop === "y" || prop === "position_y") {
                                propertyPath = "transform.position.y";
                        } else if (prop === "opacity") {
                                propertyPath = "opacity";
                        }
                        const kfId = op.keyframe_id || op.keyframeId || "";
                        if (prop === "scale") {
                                return ok(
                                        new BatchCommand([
                                                new RemoveKeyframeCommand({
                                                        trackId,
                                                        elementId: clipId,
                                                        propertyPath: "transform.scaleX",
                                                        keyframeId: kfId + "-x",
                                                }),
                                                new RemoveKeyframeCommand({
                                                        trackId,
                                                        elementId: clipId,
                                                        propertyPath: "transform.scaleY",
                                                        keyframeId: kfId + "-y",
                                                }),
                                        ])
                                );
                        }
                        return ok(
                                new RemoveKeyframeCommand({
                                        trackId,
                                        elementId: clipId,
                                        propertyPath,
                                        keyframeId: kfId,
                                })
                        );
                }
                default:
                        return fail(`Unknown action type "${action}".`);
        }
}

/**
 * Backward-compatible wrapper — returns just the Command (or null).
 */
export function compileAction(
        op: any,
        tracks: TimelineTrack[],
        editor: EditorCore,
        opts: CompileOptions = {}
): Command | null {
        const result = compileActionDetailed(op, tracks, editor, opts);
        if (!result.command) {
                console.warn(`AI Compiler: ${result.error}`);
        }
        return result.command;
}

// ─── Dry-run machinery ───────────────────────────────────────

/**
 * Temporarily swaps the editor's timeline/selection accessors to point at a
 * snapshot, runs `fn`, then always restores the real accessors.
 */
function withSnapshot<T>(editor: EditorCore, fn: (getSnapshotTracks: () => TimelineTrack[]) => T): T {
        const originalGetTracks = editor.timeline.getTracks.bind(editor.timeline);
        const originalUpdateTracks = editor.timeline.updateTracks.bind(editor.timeline);
        const originalGetSelected = editor.selection.getSelectedElements.bind(editor.selection);
        const originalSetSelected = editor.selection.setSelectedElements.bind(editor.selection);

        let snapshotTracks = createDryRunSnapshot(editor.timeline.getTracks());
        let snapshotSelection = [...editor.selection.getSelectedElements()];

        editor.timeline.getTracks = () => snapshotTracks;
        editor.timeline.updateTracks = (tracks) => {
                snapshotTracks = tracks;
        };
        editor.selection.getSelectedElements = () => snapshotSelection;
        editor.selection.setSelectedElements = (options) => {
                snapshotSelection = options.elements;
        };

        try {
                return fn(() => snapshotTracks);
        } finally {
                editor.timeline.getTracks = originalGetTracks;
                editor.timeline.updateTracks = originalUpdateTracks;
                editor.selection.getSelectedElements = originalGetSelected;
                editor.selection.setSelectedElements = originalSetSelected;
        }
}

/** Validate structural constraints on a snapshot after executing commands. */
function validateSnapshot(tracks: TimelineTrack[]): void {
        for (const track of tracks) {
                for (const el of track.elements) {
                        if (el.duration <= 0) {
                                throw new Error(`Invalid element duration: ${el.name} is ${el.duration}s`);
                        }
                        if (el.startTime < 0) {
                                throw new Error(`Invalid element start time: ${el.name} is at ${el.startTime}s`);
                        }
                        if (el.trimStart < 0 || el.trimEnd < 0) {
                                throw new Error(`Invalid element trim values on: ${el.name}`);
                        }
                }
        }
}

/**
 * Runs a list of AI operations on a snapshot of the CURRENT editor state.
 * Compiles sequentially (each op sees the result of the previous one).
 * Returns compiled commands plus any auto-fixes applied.
 *
 * NOTE: call this again right before applying (Accept-time), never trust a
 * result computed while the AI was still streaming — the user may have
 * edited the timeline manually in between.
 */
export function dryRunActions(
        ops: any[],
        editor: EditorCore,
        opts: CompileOptions = { strict: true }
): { success: boolean; error?: string; commands?: Command[]; fixes?: string[] } {
        try {
                return withSnapshot(editor, (getSnapshotTracks) => {
                        const compiledCommands: Command[] = [];
                        const allFixes: string[] = [];

                        for (const op of ops) {
                                const result = compileActionDetailed(op, getSnapshotTracks(), editor, opts);
                                if (!result.command) {
                                        throw new Error(result.error || `Failed to compile action: ${JSON.stringify(op)}`);
                                }
                                result.command.execute();
                                compiledCommands.push(result.command);
                                allFixes.push(...result.fixes);
                        }

                        validateSnapshot(getSnapshotTracks());
                        return { success: true, commands: compiledCommands, fixes: allFixes };
                });
        } catch (err: any) {
                console.error("Dry run failed:", err);
                return { success: false, error: err.message || "Logic constraint violated" };
        }
}

export interface OperationValidation {
        op: any;
        ok: boolean;
        error?: string;
        fixes: string[];
}

/**
 * Accept-time conflict detection: validates each operation INDIVIDUALLY and
 * sequentially against the current state. Operations that no longer apply
 * (e.g. their clip was deleted manually while the AI was thinking) are
 * reported as conflicts instead of failing the whole batch, so the user can
 * still apply the rest.
 */
export function validateOperations(
        ops: any[],
        editor: EditorCore
): OperationValidation[] {
        return withSnapshot(editor, (getSnapshotTracks) => {
                const results: OperationValidation[] = [];
                for (const op of ops) {
                        const result = compileActionDetailed(op, getSnapshotTracks(), editor, { strict: true });
                        if (!result.command) {
                                results.push({ op, ok: false, error: result.error, fixes: result.fixes });
                                continue;
                        }
                        try {
                                result.command.execute();
                                validateSnapshot(getSnapshotTracks());
                                results.push({ op, ok: true, fixes: result.fixes });
                        } catch (err: any) {
                                results.push({ op, ok: false, error: err.message, fixes: result.fixes });
                        }
                }
                return results;
        });
}
