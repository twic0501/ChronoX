import type { MaskDefinition } from "@/lib/masks/types";
import type { BrushMaskParams } from "../types";

interface TrackedBox {
	time: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export function getTrackedBoxAtTime(
	trackingPathStr: string | undefined,
	localTime: number,
): TrackedBox | null {
	if (!trackingPathStr) return null;
	try {
		const path = JSON.parse(trackingPathStr) as TrackedBox[];
		if (!Array.isArray(path) || path.length === 0) return null;

		let closest = path[0];
		let minDiff = Math.abs(closest.time - localTime);
		for (let i = 1; i < path.length; i++) {
			const diff = Math.abs(path[i].time - localTime);
			if (diff < minDiff) {
				minDiff = diff;
				closest = path[i];
			}
		}
		return closest;
	} catch (e) {
		console.warn("Failed to parse trackingPath:", e);
		return null;
	}
}

export const brushMaskDefinition: MaskDefinition<BrushMaskParams> = {
	type: "brush",
	name: "Brush",
	overlayShape: "box",
	features: {
		hasPosition: false,
		hasRotation: false,
		sizeMode: "none",
	},
	params: [
		{
			key: "brushSize",
			label: "Brush Size",
			type: "number",
			default: 40,
			min: 5,
			max: 200,
			step: 1,
		},
		{
			key: "points",
			label: "Points",
			type: "string",
			default: "[]",
		} as any,
		{
			key: "trackingPath",
			label: "Tracking Path",
			type: "string",
			default: "",
		} as any,
	],
	buildDefault(context) {
		return {
			type: "brush",
			params: {
				feather: 15, // Default to a soft blur feather
				inverted: false,
				strokeColor: "#ffffff",
				strokeWidth: 0,
				strokeAlign: "center",
				points: "[]",
				brushSize: 40,
				trackingPath: "",
			},
		};
	},
	computeParamUpdate() {
		return {};
	},
	renderer: {
		buildPath({ resolvedParams, width, height, localTime }) {
			const params = resolvedParams as BrushMaskParams;
			const path = new Path2D();

			// If tracking path exists, draw the tracked ellipse bounding box
			if (localTime !== undefined && params.trackingPath) {
				const box = getTrackedBoxAtTime(params.trackingPath, localTime);
				if (box) {
					const cx = box.x * width;
					const cy = box.y * height;
					const rx = Math.max(1, (box.w * width) / 2);
					const ry = Math.max(1, (box.h * height) / 2);
					path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
					return path;
				}
			}

			// Otherwise, draw the static scribble path
			const strokes = JSON.parse(params.points || "[]") as {
				x: number;
				y: number;
			}[][];
			const radius = (params.brushSize || 40) / 2;
			for (const stroke of strokes) {
				if (stroke.length === 0) continue;
				for (const p of stroke) {
					path.moveTo(p.x * width + radius, p.y * height);
					path.arc(p.x * width, p.y * height, radius, 0, Math.PI * 2);
				}
			}
			return path;
		},
		renderMask({ resolvedParams, ctx, width, height, localTime }) {
			const params = resolvedParams as BrushMaskParams;

			// If tracking path exists, render the tracked ellipse bounding box
			if (localTime !== undefined && params.trackingPath) {
				const box = getTrackedBoxAtTime(params.trackingPath, localTime);
				if (box) {
					const cx = box.x * width;
					const cy = box.y * height;
					const rx = Math.max(1, (box.w * width) / 2);
					const ry = Math.max(1, (box.h * height) / 2);
					ctx.save();
					ctx.fillStyle = "white";
					ctx.beginPath();
					ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
					ctx.fill();
					ctx.restore();
					return;
				}
			}

			// Otherwise, render the static scribble path
			const strokes = JSON.parse(params.points || "[]") as {
				x: number;
				y: number;
			}[][];
			if (strokes.length === 0) return;

			ctx.save();
			ctx.fillStyle = "white";
			ctx.strokeStyle = "white";
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.lineWidth = params.brushSize || 40;

			for (const stroke of strokes) {
				if (stroke.length === 0) continue;
				ctx.beginPath();
				ctx.moveTo(stroke[0].x * width, stroke[0].y * height);
				for (let i = 1; i < stroke.length; i++) {
					ctx.lineTo(stroke[i].x * width, stroke[i].y * height);
				}
				ctx.stroke();

				// Fill circles at ends/points
				for (const p of stroke) {
					ctx.beginPath();
					ctx.arc(
						p.x * width,
						p.y * height,
						(params.brushSize || 40) / 2,
						0,
						Math.PI * 2,
					);
					ctx.fill();
				}
			}
			ctx.restore();
		},
	},
};
