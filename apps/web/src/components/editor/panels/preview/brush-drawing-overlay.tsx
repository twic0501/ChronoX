"use client";

import { useState, useRef } from "react";
import { usePreviewViewport } from "@/components/editor/panels/preview/preview-viewport";
import { useEditor } from "@/hooks/use-editor";
import type { MaskableElement } from "@/lib/timeline";
import type { ElementBounds } from "@/lib/preview/element-bounds";
import type { BrushMask } from "@/lib/masks/types";

interface BrushDrawingOverlayProps {
	element: MaskableElement;
	trackId: string;
	bounds: ElementBounds;
	mask: BrushMask;
}

export function BrushDrawingOverlay({
	element,
	trackId,
	bounds,
	mask,
}: BrushDrawingOverlayProps) {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const containerRef = useRef<SVGSVGElement | null>(null);
	const [activeStroke, setActiveStroke] = useState<{ x: number; y: number }[]>([]);

	const brushSize = mask.params.brushSize || 40;
	const existingStrokes = JSON.parse(mask.params.points || "[]") as {
		x: number;
		y: number;
	}[][];

	// Helper: Canvas to Normalized
	const canvasToNormalized = (canvasX: number, canvasY: number) => {
		const dx = canvasX - bounds.cx;
		const dy = canvasY - bounds.cy;
		const angleRad = (bounds.rotation * Math.PI) / 180;
		// Rotate back by -rotation
		const cos = Math.cos(-angleRad);
		const sin = Math.sin(-angleRad);
		const localX = dx * cos - dy * sin;
		const localY = dx * sin + dy * cos;

		return {
			x: (localX + bounds.width / 2) / bounds.width,
			y: (localY + bounds.height / 2) / bounds.height,
		};
	};

	// Helper: Normalized to Screen (Overlay)
	const normalizedToScreen = (nx: number, ny: number) => {
		const localX = nx * bounds.width - bounds.width / 2;
		const localY = ny * bounds.height - bounds.height / 2;
		const angleRad = (bounds.rotation * Math.PI) / 180;
		const cos = Math.cos(angleRad);
		const sin = Math.sin(angleRad);
		const dx = localX * cos - localY * sin;
		const dy = localX * sin + localY * cos;

		const canvasX = bounds.cx + dx;
		const canvasY = bounds.cy + dy;

		return viewport.canvasToOverlay({ canvasX, canvasY });
	};

	const getEventNormalizedCoords = (event: React.PointerEvent) => {
		const canvasPos = viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!canvasPos) return null;
		return canvasToNormalized(canvasPos.x, canvasPos.y);
	};

	const handlePointerDown = (event: React.PointerEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();

		const p = getEventNormalizedCoords(event);
		if (!p) return;

		setActiveStroke([p]);
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handlePointerMove = (event: React.PointerEvent) => {
		if (activeStroke.length === 0) return;
		event.preventDefault();
		event.stopPropagation();

		const p = getEventNormalizedCoords(event);
		if (!p) return;

		setActiveStroke((prev) => [...prev, p]);
	};

	const handlePointerUp = (event: React.PointerEvent) => {
		if (activeStroke.length === 0) return;
		event.preventDefault();
		event.stopPropagation();

		event.currentTarget.releasePointerCapture(event.pointerId);

		const updatedStrokes = [...existingStrokes, activeStroke];
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						masks: [
							{
								...mask,
								params: {
									...mask.params,
									points: JSON.stringify(updatedStrokes),
								},
							},
						],
					} as Partial<MaskableElement>,
				},
			],
		});

		setActiveStroke([]);
	};

	// Convert strokes to SVG path strings
	const renderStrokePath = (stroke: { x: number; y: number }[]) => {
		if (stroke.length === 0) return "";
		const first = normalizedToScreen(stroke[0].x, stroke[0].y);
		let d = `M ${first.x} ${first.y}`;
		for (let i = 1; i < stroke.length; i++) {
			const p = normalizedToScreen(stroke[i].x, stroke[i].y);
			d += ` L ${p.x} ${p.y}`;
		}
		return d;
	};

	return (
		<svg
			ref={containerRef}
			className="absolute inset-0 pointer-events-auto cursor-crosshair w-full h-full"
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			style={{ touchAction: "none" }}
		>
			{/* Existing strokes */}
			{existingStrokes.map((stroke, index) => {
				const d = renderStrokePath(stroke);
				if (!d) return null;
				return (
					<path
						key={index}
						d={d}
						fill="none"
						stroke="rgba(255, 255, 255, 0.45)"
						strokeWidth={brushSize * viewport.getDisplayScale().x}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				);
			})}

			{/* Active stroke */}
			{activeStroke.length > 0 && (
				<path
					d={renderStrokePath(activeStroke)}
					fill="none"
					stroke="rgba(255, 255, 255, 0.7)"
					strokeWidth={brushSize * viewport.getDisplayScale().x}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			)}
		</svg>
	);
}
