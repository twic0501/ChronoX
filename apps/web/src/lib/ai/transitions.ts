/**
 * The timeline transition engine — REAL two-clip constructions built from
 * keyframes on opacity/transform/effect params, shared by the AI agent's
 * add_transition tool and the Transitions panel UI.
 */
import { videoTrackOf } from "./style-apply";

export interface TransitionInfo {
	type: string;
	name: string;
	description: string;
	/** Overlap transitions ripple later clips left so both share a window. */
	overlap: boolean;
}

export const TRANSITION_TYPES: TransitionInfo[] = [
	{
		type: "dissolve",
		name: "Cross Dissolve",
		description: "Incoming clip fades up over the outgoing tail",
		overlap: true,
	},
	{
		type: "blur_dissolve",
		name: "Blur Dissolve",
		description: "Defocus crossfade — both clips blur through the blend",
		overlap: true,
	},
	{
		type: "dip_black",
		name: "Dip to Black",
		description: "Fade out to black, then rise into the next clip",
		overlap: false,
	},
	{
		type: "flash_white",
		name: "Flash White",
		description: "White blowout peaking exactly on the cut",
		overlap: false,
	},
	{
		type: "whip",
		name: "Whip Pan",
		description: "Fast horizontal whip with motion blur",
		overlap: true,
	},
	{
		type: "slide",
		name: "Slide",
		description: "Incoming clip slides in over the outgoing",
		overlap: true,
	},
	{
		type: "push",
		name: "Push",
		description: "Outgoing pushed off-screen as the incoming slides in",
		overlap: true,
	},
	{
		type: "spin",
		name: "Spin",
		description: "Rotation whip with blur on both clips",
		overlap: true,
	},
	{
		type: "zoom",
		name: "Zoom Through",
		description: "Punch through the lens with radial blur",
		overlap: true,
	},
	{
		type: "glitch",
		name: "Glitch",
		description: "Digital corruption burst on the cut",
		overlap: false,
	},
	{
		type: "zoom_punch",
		name: "Zoom Punch",
		description: "Scale impact landing on the cut — beat drops",
		overlap: false,
	},
	{
		type: "fade",
		name: "Fade In/Out",
		description: "Fade in at the sequence start + fade out at the end",
		overlap: false,
	},
];

export interface ApplyTransitionArgs {
	type: string;
	/** Seconds; default 0.5. */
	duration?: number;
	/** Apply only on the cut BEFORE this clip; omit for every cut. */
	clipId?: string;
}

/** Apply a transition; returns a human-readable result message. */
export async function applyTimelineTransition(
	editor: any,
	args: ApplyTransitionArgs,
): Promise<string> {
	const track = videoTrackOf(editor);
	if (!track || track.elements.length === 0) return "No video clips.";
	const sorted = [...track.elements].sort(
		(a: any, b: any) => a.startTime - b.startTime,
	);
	const type = String(args.type || "dissolve").toLowerCase();
	const D = Math.max(
		0.1,
		Number(args.duration) > 0 ? Number(args.duration) : 0.5,
	);

	const { UpsertKeyframeCommand } = await import(
		"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
	);
	const { UpsertEffectParamKeyframeCommand } = await import(
		"@/lib/commands/timeline/element/keyframes/upsert-effect-param-keyframe"
	);
	const { UpdateElementStartTimeCommand } = await import(
		"@/lib/commands/timeline/element"
	);
	const { AddClipEffectCommand } = await import(
		"@/lib/commands/timeline/element/effects/add-effect"
	);
	const { BatchCommand } = await import("@/lib/commands/batch-command");

	const cmds: any[] = [];
	const kf = (el: any, path: string, time: number, value: any) =>
		cmds.push(
			new UpsertKeyframeCommand({
				trackId: track.id,
				elementId: el.id,
				propertyPath: path as any,
				time,
				value,
				interpolation: "linear",
			}),
		);

	// ── fade: sequence edges only ──────────────────────────
	if (type === "fade") {
		const first = sorted[0];
		const last = sorted[sorted.length - 1];
		const df = Math.min(D, first.duration * 0.5);
		kf(first, "opacity", 0, 0);
		kf(first, "opacity", df, 1);
		const dl = Math.min(D, last.duration * 0.5);
		kf(last, "opacity", last.duration - dl, 1);
		kf(last, "opacity", last.duration, 0);
		editor.command.execute({ command: new BatchCommand(cmds) });
		return `Added a ${D}s fade-in at the start and fade-out at the end.`;
	}

	// ── resolve target boundaries (i = cut between sorted[i], sorted[i+1]) ──
	let boundaries: number[];
	if (args.clipId) {
		const q = String(args.clipId).toLowerCase();
		const idx = sorted.findIndex(
			(c: any) => c.id === args.clipId || c.name?.toLowerCase().includes(q),
		);
		if (idx <= 0)
			return "That clip has no clip before it — a transition needs two adjacent clips.";
		boundaries = [idx - 1];
	} else {
		boundaries = sorted.slice(0, -1).map((_: any, i: number) => i);
	}
	if (boundaries.length === 0)
		return "Need at least two clips for a transition.";
	const boundarySet = new Set(boundaries);

	const overlapType =
		type === "dissolve" ||
		type === "whip" ||
		type === "slide" ||
		type === "push" ||
		type === "spin" ||
		type === "zoom" ||
		type === "blur_dissolve";
	const W = 900; // whip slide distance in canvas px

	// Overlap types ripple everything after each cut left by that cut's
	// transition length, so the two clips genuinely share a time window.
	const shiftById = new Map<string, number>();
	const dAtBoundary = new Map<number, number>();
	let cum = 0;
	for (let i = 0; i < sorted.length; i++) {
		shiftById.set(sorted[i].id, cum);
		if (i < sorted.length - 1 && boundarySet.has(i)) {
			const d = Math.min(
				D,
				sorted[i].duration * 0.5,
				sorted[i + 1].duration * 0.5,
			);
			dAtBoundary.set(i, d);
			if (overlapType) cum += d;
		}
	}
	if (overlapType) {
		for (const c of sorted) {
			const s = shiftById.get(c.id) ?? 0;
			if (s > 0.001) {
				cmds.push(
					new UpdateElementStartTimeCommand({
						elements: [{ trackId: track.id, elementId: c.id }],
						startTime: Math.max(0, c.startTime - s),
					}),
				);
			}
		}
	}

	// For whip/flash we need effect ids up front → add the effects
	// immediately (matches the mimic pattern), then keyframe them in the batch.
	const ensureEffect = (
		clipId: string,
		effectType: string,
		initialParams?: Record<string, unknown>,
	): string | undefined => {
		const el = (videoTrackOf(editor)?.elements ?? []).find(
			(e: any) => e.id === clipId,
		);
		const existing = (el?.effects ?? []).find(
			(ef: any) => ef.type === effectType,
		);
		if (existing) return existing.id;
		const cmd = new AddClipEffectCommand({
			trackId: track.id,
			elementId: clipId,
			effectType,
			initialParams,
		});
		editor.command.execute({ command: cmd });
		return cmd.getEffectId() ?? undefined;
	};
	const kfe = (
		clipId: string,
		effectId: string,
		paramKey: string,
		time: number,
		value: number,
	) =>
		cmds.push(
			new UpsertEffectParamKeyframeCommand({
				trackId: track.id,
				elementId: clipId,
				effectId,
				paramKey,
				time,
				value,
				interpolation: "linear",
			}),
		);

	let applied = 0;
	for (const i of boundaries) {
		const A = sorted[i];
		const B = sorted[i + 1];
		const d = dAtBoundary.get(i) ?? D;
		if (type === "dissolve") {
			// Incoming fades up over the overlap window; the outgoing tail
			// shows through underneath → a true cross-dissolve.
			kf(B, "opacity", 0, 0);
			kf(B, "opacity", d, 1);
		} else if (type === "dip_black") {
			// No overlap: outgoing dips to black, incoming rises from black.
			kf(A, "opacity", Math.max(0, A.duration - d / 2), 1);
			kf(A, "opacity", A.duration, 0);
			kf(B, "opacity", 0, 0);
			kf(B, "opacity", d / 2, 1);
		} else if (type === "flash_white") {
			// White blowout via a color-adjust gain spike on both sides of the cut.
			const eA = ensureEffect(A.id, "color-adjust");
			const eB = ensureEffect(B.id, "color-adjust");
			for (const g of ["gain_r", "gain_g", "gain_b"]) {
				if (eA) {
					kfe(A.id, eA, g, Math.max(0, A.duration - d / 2), 1);
					kfe(A.id, eA, g, A.duration, 3);
				}
				if (eB) {
					kfe(B.id, eB, g, 0, 3);
					kfe(B.id, eB, g, d / 2, 1);
				}
			}
		} else if (type === "whip") {
			// Overlap + horizontal slide + motion blur on both clips.
			kf(A, "transform.position", Math.max(0, A.duration - d), {
				x: 0,
				y: 0,
			});
			kf(A, "transform.position", A.duration, { x: W, y: 0 });
			kf(B, "transform.position", 0, { x: -W, y: 0 });
			kf(B, "transform.position", d, { x: 0, y: 0 });
			const bA = ensureEffect(A.id, "blur", { intensity: 0 });
			const bB = ensureEffect(B.id, "blur", { intensity: 0 });
			if (bA) {
				kfe(A.id, bA, "intensity", Math.max(0, A.duration - d), 0);
				kfe(A.id, bA, "intensity", A.duration, 0.8);
			}
			if (bB) {
				kfe(B.id, bB, "intensity", 0, 0.8);
				kfe(B.id, bB, "intensity", d, 0);
			}
		} else if (type === "zoom_punch") {
			// Hard cut kept, with a scale punch landing on it — both sides
			// spike to 1.18× and settle, reading as an impact on the beat.
			for (const p of ["transform.scaleX", "transform.scaleY"]) {
				kf(A, p, Math.max(0, A.duration - d / 2), 1.0);
				kf(A, p, A.duration, 1.18);
				kf(B, p, 0, 1.18);
				kf(B, p, d / 2, 1.0);
			}
		} else if (type === "slide") {
			// Incoming clip slides in over the outgoing tail (overlap window).
			kf(B, "transform.position", 0, { x: W, y: 0 });
			kf(B, "transform.position", d, { x: 0, y: 0 });
			kf(B, "opacity", 0, 1);
		} else if (type === "push") {
			// Outgoing is pushed off-screen left while the incoming slides in
			// from the right — both move together like a camera pan.
			kf(A, "transform.position", Math.max(0, A.duration - d), {
				x: 0,
				y: 0,
			});
			kf(A, "transform.position", A.duration, { x: -W, y: 0 });
			kf(B, "transform.position", 0, { x: W, y: 0 });
			kf(B, "transform.position", d, { x: 0, y: 0 });
			kf(B, "opacity", 0, 1);
		} else if (type === "spin") {
			// Rotation whip: outgoing spins out, incoming spins in, both blurred.
			kf(A, "transform.rotate", Math.max(0, A.duration - d), 0);
			kf(A, "transform.rotate", A.duration, 180);
			kf(B, "transform.rotate", 0, -180);
			kf(B, "transform.rotate", d, 0);
			kf(B, "opacity", 0, 0);
			kf(B, "opacity", d * 0.6, 1);
			const bA = ensureEffect(A.id, "blur", { intensity: 0 });
			const bB = ensureEffect(B.id, "blur", { intensity: 0 });
			if (bA) {
				kfe(A.id, bA, "intensity", Math.max(0, A.duration - d), 0);
				kfe(A.id, bA, "intensity", A.duration, 0.8);
			}
			if (bB) {
				kfe(B.id, bB, "intensity", 0, 0.8);
				kfe(B.id, bB, "intensity", d, 0);
			}
		} else if (type === "zoom") {
			// Zoom-through: outgoing scales up into a radial blur, incoming
			// starts zoomed + blurred and settles to 1× — a lens punch-through.
			for (const p of ["transform.scaleX", "transform.scaleY"]) {
				kf(A, p, Math.max(0, A.duration - d), 1.0);
				kf(A, p, A.duration, 1.6);
				kf(B, p, 0, 1.6);
				kf(B, p, d, 1.0);
			}
			kf(B, "opacity", 0, 0);
			kf(B, "opacity", d * 0.5, 1);
			const rA = ensureEffect(A.id, "radial_blur", { amount: 0 });
			const rB = ensureEffect(B.id, "radial_blur", { amount: 0 });
			if (rA) {
				kfe(A.id, rA, "amount", Math.max(0, A.duration - d), 0);
				kfe(A.id, rA, "amount", A.duration, 0.7);
			}
			if (rB) {
				kfe(B.id, rB, "amount", 0, 0.7);
				kfe(B.id, rB, "amount", d, 0);
			}
		} else if (type === "glitch") {
			// Digital corruption burst on both sides of a hard cut.
			const gA = ensureEffect(A.id, "glitch", { intensity: 0 });
			const gB = ensureEffect(B.id, "glitch", { intensity: 0 });
			if (gA) {
				kfe(A.id, gA, "intensity", Math.max(0, A.duration - d / 2), 0);
				kfe(A.id, gA, "intensity", A.duration, 0.9);
			}
			if (gB) {
				kfe(B.id, gB, "intensity", 0, 0.9);
				kfe(B.id, gB, "intensity", d / 2, 0);
			}
		} else if (type === "blur_dissolve") {
			// Defocus crossfade: both clips blur through the overlap while
			// the incoming one fades up.
			kf(B, "opacity", 0, 0);
			kf(B, "opacity", d, 1);
			const bA = ensureEffect(A.id, "blur", { intensity: 0 });
			const bB = ensureEffect(B.id, "blur", { intensity: 0 });
			if (bA) {
				kfe(A.id, bA, "intensity", Math.max(0, A.duration - d), 0);
				kfe(A.id, bA, "intensity", A.duration, 0.7);
			}
			if (bB) {
				kfe(B.id, bB, "intensity", 0, 0.7);
				kfe(B.id, bB, "intensity", d, 0);
			}
		} else {
			return `Unknown transition type "${type}". Use ${TRANSITION_TYPES.map((t) => t.type).join(", ")}.`;
		}
		applied++;
	}

	if (cmds.length === 0) return "No transition commands were produced.";
	editor.command.execute({ command: new BatchCommand(cmds) });
	return `Applied ${applied} ${type} transition(s) at the cut(s)${
		overlapType
			? `, overlapping clips by up to ${D}s (timeline tightened accordingly)`
			: ""
	}.`;
}
