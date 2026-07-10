import type {
	Mask,
	MaskDefinition,
	MaskType,
	RectangleMaskParams,
} from "@/lib/masks/types";
import {
	BOX_LIKE_MASK_PARAMS,
	computeBoxMaskParamUpdate,
	getBoxLikeGeometry,
	getDefaultSquareMaskParams,
	getStrokeOffset,
	rotatePoint,
} from "./box-like";

/** Vertex in the unit box: x and y both in [-0.5, 0.5]. */
export interface PolygonVertex {
	x: number;
	y: number;
}

function buildPolygonPath({
	vertices,
	centerX,
	centerY,
	maskWidth,
	maskHeight,
	rotationRad,
}: {
	vertices: PolygonVertex[];
	centerX: number;
	centerY: number;
	maskWidth: number;
	maskHeight: number;
	rotationRad: number;
}): Path2D {
	const points = vertices.map((vertex) =>
		rotatePoint({
			x: centerX + vertex.x * maskWidth,
			y: centerY + vertex.y * maskHeight,
			centerX,
			centerY,
			rotationRad,
		}),
	);

	const path = new Path2D();
	path.moveTo(points[0].x, points[0].y);
	for (const point of points.slice(1)) {
		path.lineTo(point.x, point.y);
	}
	path.closePath();
	return path;
}

/**
 * Builds a box-like mask definition for any convex/star polygon expressed as
 * unit-box vertices. Reuses the rectangle mask's params, handles and drag math.
 */
export function buildPolygonMaskDefinition({
	type,
	name,
	vertices,
}: {
	type: MaskType;
	name: string;
	vertices: PolygonVertex[];
}): MaskDefinition<RectangleMaskParams> {
	return {
		type,
		name,
		overlayShape: "box",
		buildOverlayPath({ width, height }) {
			const commands = vertices.map((vertex, index) => {
				const x = (vertex.x + 0.5) * width;
				const y = (vertex.y + 0.5) * height;
				return `${index === 0 ? "M" : "L"} ${x},${y}`;
			});
			return `${commands.join(" ")} Z`;
		},
		features: {
			hasPosition: true,
			hasRotation: true,
			sizeMode: "width-height",
		},
		params: BOX_LIKE_MASK_PARAMS,
		buildDefault(context) {
			return {
				type,
				params: getDefaultSquareMaskParams(context),
			} as Omit<Mask, "id">;
		},
		computeParamUpdate: computeBoxMaskParamUpdate,
		renderer: {
			buildPath({ resolvedParams, width, height }) {
				const params = resolvedParams as RectangleMaskParams;
				const { centerX, centerY, maskWidth, maskHeight, rotationRad } =
					getBoxLikeGeometry({ params, width, height });
				return buildPolygonPath({
					vertices,
					centerX,
					centerY,
					maskWidth,
					maskHeight,
					rotationRad,
				});
			},
			buildStrokePath({ resolvedParams, width, height }) {
				const params = resolvedParams as RectangleMaskParams;
				const { centerX, centerY, maskWidth, maskHeight, rotationRad } =
					getBoxLikeGeometry({ params, width, height });
				const offset = getStrokeOffset({
					strokeAlign: params.strokeAlign,
					strokeWidth: params.strokeWidth,
				});
				return buildPolygonPath({
					vertices,
					centerX,
					centerY,
					maskWidth: Math.max(2, maskWidth + offset * 2),
					maskHeight: Math.max(2, maskHeight + offset * 2),
					rotationRad,
				});
			},
		},
	};
}

export const triangleMaskDefinition = buildPolygonMaskDefinition({
	type: "triangle",
	name: "Triangle",
	vertices: [
		{ x: 0, y: -0.5 },
		{ x: 0.5, y: 0.5 },
		{ x: -0.5, y: 0.5 },
	],
});

export const diamondMaskDefinition = buildPolygonMaskDefinition({
	type: "diamond",
	name: "Diamond",
	vertices: [
		{ x: 0, y: -0.5 },
		{ x: 0.5, y: 0 },
		{ x: 0, y: 0.5 },
		{ x: -0.5, y: 0 },
	],
});

function buildStarVertices({
	points,
	innerRatio,
}: {
	points: number;
	innerRatio: number;
}): PolygonVertex[] {
	const vertices: PolygonVertex[] = [];
	for (let i = 0; i < points * 2; i++) {
		const radius = i % 2 === 0 ? 0.5 : 0.5 * innerRatio;
		const angle = -Math.PI / 2 + (i * Math.PI) / points;
		vertices.push({
			x: Math.cos(angle) * radius,
			y: Math.sin(angle) * radius,
		});
	}
	return vertices;
}

export const starMaskDefinition = buildPolygonMaskDefinition({
	type: "star",
	name: "Star",
	vertices: buildStarVertices({ points: 5, innerRatio: 0.45 }),
});
