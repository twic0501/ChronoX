/**
 * Clip transform engine — static transform + keyframed animation presets,
 * shared by the AI agent's set_transform tool and the Motion panel UI.
 */
import { videoTrackOf } from "./style-apply";

export interface TransformPresetInfo {
	preset: string;
	name: string;
	description: string;
	/** Preset takes a `from` side (slide_in). */
	takesSide?: boolean;
	/** Preset takes an `at` time in seconds into the clip (shake, punch). */
	takesTime?: boolean;
}

export const TRANSFORM_PRESETS: TransformPresetInfo[] = [
	{
		preset: "pop_in",
		name: "Pop In",
		description: "Scale 0.6 → 1 with a small overshoot + fade in",
	},
	{
		preset: "slide_in",
		name: "Slide In",
		description: "Slides in from the left or right edge",
		takesSide: true,
	},
	{
		preset: "spin_in",
		name: "Spin In",
		description: "Rotates −25° → 0 while scaling up + fade in",
	},
	{
		preset: "ken_burns",
		name: "Ken Burns",
		description: "Slow push-in 1.0 → 1.12 across the whole clip",
	},
	{
		preset: "shake",
		name: "Shake",
		description: "0.5s impact jitter — bass hits, collisions",
		takesTime: true,
	},
	{
		preset: "punch",
		name: "Punch",
		description: "Quick 1.15× scale hit — beat accents",
		takesTime: true,
	},
];

export interface ApplyTransformArgs {
	/** Element id; falls back to the first video clip. */
	clipId?: string;
	x?: number;
	y?: number;
	scale?: number;
	rotate?: number;
	opacity?: number;
	/** Animation preset name from TRANSFORM_PRESETS. */
	animate?: string;
	/** slide_in only: "left" (default) | "right". */
	from?: string;
	/** shake/punch only: seconds into the clip. */
	at?: number;
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

/** Apply static transform values and/or an animation preset to one clip. */
export async function applyClipTransform(
	editor: any,
	args: ApplyTransformArgs,
): Promise<string> {
	const { track, clip } = resolveClip(editor, args.clipId);
	if (!track || !clip) return "No video clip found.";

	const { UpsertKeyframeCommand } = await import(
		"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
	);
	const { BatchCommand } = await import("@/lib/commands/batch-command");
	const cmds: any[] = [];
	const kf = (path: string, time: number, value: any) =>
		cmds.push(
			new UpsertKeyframeCommand({
				trackId: track.id,
				elementId: clip.id,
				propertyPath: path as any,
				time,
				value,
				interpolation: "linear",
			}),
		);

	const done: string[] = [];

	// Static transform: merge over the clip's current values.
	if (
		args.x !== undefined ||
		args.y !== undefined ||
		args.scale !== undefined ||
		args.rotate !== undefined ||
		args.opacity !== undefined
	) {
		const cur = clip.transform ?? {};
		const updates: any = {
			transform: {
				position: {
					x: args.x ?? cur.position?.x ?? 0,
					y: args.y ?? cur.position?.y ?? 0,
				},
				scaleX: args.scale ?? cur.scaleX ?? 1,
				scaleY: args.scale ?? cur.scaleY ?? 1,
				rotate: args.rotate ?? cur.rotate ?? 0,
			},
		};
		if (args.opacity !== undefined)
			updates.opacity = Math.max(0, Math.min(1, Number(args.opacity)));
		editor.timeline.updateElements({
			updates: [{ trackId: track.id, elementId: clip.id, updates }],
		});
		done.push("set static transform");
	}

	const preset = args.animate ? String(args.animate).toLowerCase() : "";
	if (preset) {
		const dur = clip.duration ?? 1;
		const W = 900;
		if (preset === "pop_in") {
			for (const p of ["transform.scaleX", "transform.scaleY"]) {
				kf(p, 0, 0.6);
				kf(p, 0.22, 1.04);
				kf(p, 0.35, 1.0);
			}
			kf("opacity", 0, 0);
			kf("opacity", 0.2, 1);
		} else if (preset === "slide_in") {
			const sx = String(args.from).toLowerCase() === "right" ? W : -W;
			kf("transform.position", 0, { x: sx, y: 0 });
			kf("transform.position", 0.4, { x: 0, y: 0 });
		} else if (preset === "spin_in") {
			kf("transform.rotate", 0, -25);
			kf("transform.rotate", 0.45, 0);
			for (const p of ["transform.scaleX", "transform.scaleY"]) {
				kf(p, 0, 0.8);
				kf(p, 0.45, 1.0);
			}
			kf("opacity", 0, 0);
			kf("opacity", 0.3, 1);
		} else if (preset === "ken_burns") {
			for (const p of ["transform.scaleX", "transform.scaleY"]) {
				kf(p, 0, 1.0);
				kf(p, dur, 1.12);
			}
		} else if (preset === "shake") {
			const start = Math.max(0, Math.min(Number(args.at) || 0, dur - 0.5));
			const jolts = [14, -11, 8, -5, 2, 0];
			jolts.forEach((x, i) => {
				kf("transform.position", start + i * 0.08, {
					x,
					y: i % 2 ? -x / 2 : x / 2,
				});
			});
		} else if (preset === "punch") {
			const at = Math.max(0.13, Math.min(Number(args.at) || 0.13, dur - 0.13));
			for (const p of ["transform.scaleX", "transform.scaleY"]) {
				kf(p, at - 0.13, 1.0);
				kf(p, at, 1.15);
				kf(p, at + 0.13, 1.0);
			}
		} else {
			return `Unknown animate preset "${preset}". Use ${TRANSFORM_PRESETS.map((p) => p.preset).join(", ")}.`;
		}
		done.push(`animated ${preset}`);
	}

	if (cmds.length > 0)
		editor.command.execute({ command: new BatchCommand(cmds) });
	if (done.length === 0)
		return "Nothing to do — pass static transform values and/or an animate preset.";
	return `Transform on "${clip.name ?? clip.id}": ${done.join(", ")}.`;
}
