import { useState, useMemo } from "react";
import { usePreviewViewport } from "@/components/editor/panels/preview/preview-viewport";
import { usePreviewInteraction } from "@/hooks/use-preview-interaction";
import type { SnapLine } from "@/lib/preview/preview-snap";
import { TransformHandles } from "./transform-handles";
import { MaskHandles } from "./mask-handles";
import { SnapGuides } from "./snap-guides";
import { TextEditOverlay } from "./text-edit-overlay";
import { usePropertiesStore } from "../properties/stores/properties-store";
import { useEditor } from "@/hooks/use-editor";
import { getVisibleElementsWithBounds } from "@/lib/preview/element-bounds";
import { BrushDrawingOverlay } from "./brush-drawing-overlay";

export function PreviewInteractionOverlay() {
	const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const activeTabPerType = usePropertiesStore((s) => s.activeTabPerType);

	const tracks = useEditor((e) => e.timeline.getRenderTracks());
	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor(
		(e) => e.project.getActive().settings.canvasSize,
	);

	const selectedRef =
		selectedElements.length === 1 ? selectedElements[0] : null;
	const activeTrack = selectedRef
		? editor.timeline.getTrackById({ trackId: selectedRef.trackId })
		: null;
	const activeElement =
		activeTrack?.elements.find(
			(element) => element.id === selectedRef?.elementId,
		) ?? null;
	const isMaskMode = activeElement
		? activeTabPerType[activeElement.type] === "masks"
		: false;

	const mask = activeElement && "masks" in activeElement && Array.isArray((activeElement as any).masks) && (activeElement as any).masks.length > 0
		? (activeElement as any).masks[0]
		: null;
	const isBrushMask = mask?.type === "brush";

	const elementBounds = useMemo(() => {
		if (!selectedRef || !activeElement) return null;
		return (
			getVisibleElementsWithBounds({
				tracks,
				currentTime,
				canvasSize,
				mediaAssets,
			}).find(
				(item) => item.trackId === selectedRef.trackId && item.elementId === selectedRef.elementId,
			)?.bounds ?? null
		);
	}, [
		canvasSize,
		currentTime,
		activeElement,
		selectedRef,
		mediaAssets,
		tracks,
	]);

	const {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onDoubleClick,
		editingText,
		commitTextEdit,
	} = usePreviewInteraction({
		onSnapLinesChange: setSnapLines,
		isMaskMode: isMaskMode && !isBrushMask, // Capture standard pointer events if NOT in brush draw mode
	});

	const handlePointerDown = (event: React.PointerEvent) => {
		if (isBrushMask) return; // Delegate fully to BrushDrawingOverlay
		if (viewport.handlePanPointerDown({ event })) {
			return;
		}

		onPointerDown(event);
	};

	const handlePointerMove = (event: React.PointerEvent) => {
		if (isBrushMask) return; // Delegate fully to BrushDrawingOverlay
		if (viewport.handlePanPointerMove({ event })) {
			return;
		}

		onPointerMove(event);
	};

	const handlePointerUp = (event: React.PointerEvent) => {
		if (isBrushMask) return; // Delegate fully to BrushDrawingOverlay
		if (viewport.handlePanPointerUp({ event })) {
			return;
		}

		onPointerUp(event);
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		const x = e.nativeEvent.offsetX;
		const y = e.nativeEvent.offsetY;
		const outsideCanvas =
			x < viewport.sceneLeft ||
			x > viewport.sceneLeft + viewport.sceneWidth ||
			y < viewport.sceneTop ||
			y > viewport.sceneTop + viewport.sceneHeight;
		if (outsideCanvas) {
			e.stopPropagation();
		}
	};

	return (
		<div className="absolute inset-0">
			{!isBrushMask && (
				<div
					className="absolute inset-0 pointer-events-auto"
					role="application"
					aria-label="Preview canvas"
					style={{
						cursor: viewport.isPanning
							? "grabbing"
							: viewport.canPan
								? "default"
								: undefined,
					}}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerUp}
					onDoubleClick={onDoubleClick}
					onDragStart={(e) => e.preventDefault()}
					onContextMenu={handleContextMenu}
				/>
			)}
			{editingText ? (
				<TextEditOverlay
					trackId={editingText.trackId}
					elementId={editingText.elementId}
					element={editingText.element}
					onCommit={commitTextEdit}
				/>
			) : isMaskMode ? (
				isBrushMask && activeElement && elementBounds && mask ? (
					<BrushDrawingOverlay
						element={activeElement as any}
						trackId={selectedRef!.trackId}
						bounds={elementBounds}
						mask={mask}
					/>
				) : (
					<MaskHandles onSnapLinesChange={setSnapLines} />
				)
			) : (
				<TransformHandles onSnapLinesChange={setSnapLines} />
			)}
			<SnapGuides lines={snapLines} />
		</div>
	);
}
