"use client";

import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/lib/timeline";
import type { TimelineElement as TimelineElementType } from "@/lib/timeline";
import type { SnapPoint } from "@/lib/timeline/snap-utils";
import {
	TIMELINE_CONSTANTS,
	TIMELINE_LAYERS,
} from "@/constants/timeline-constants";
import { useEdgeAutoScroll } from "@/hooks/timeline/use-edge-auto-scroll";
import type { ElementDragState } from "@/lib/timeline";
import { useEditor } from "@/hooks/use-editor";
import { useEditorStore } from "@/stores/editor-store";
import { TransitionCutButton } from "./transition-cut-button";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	dragState: ElementDragState;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	lastMouseXRef: React.RefObject<number>;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	onResizeStateChange?: (params: { isResizing: boolean }) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
}

export function TimelineTrackContent({
	track,
	zoomLevel,
	dragState,
	rulerScrollRef,
	tracksScrollRef,
	lastMouseXRef,
	onSnapPointChange,
	onResizeStateChange,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
}: TimelineTrackContentProps) {
	const { isElementSelected } = useElementSelection();
	const duration = useEditor((e) => e.timeline.getTotalDuration());

	// Adjacent clip pairs on video tracks — each cut gets an NLE-style
	// transition handle (clips touching or overlapping within tolerance).
	const cutPairs: [TimelineElementType, TimelineElementType][] = [];
	if (track.type === "video") {
		const sorted = [...track.elements].sort(
			(a, b) => a.startTime - b.startTime,
		);
		for (let i = 0; i < sorted.length - 1; i++) {
			const a = sorted[i];
			const b = sorted[i + 1];
			if (b.startTime - (a.startTime + a.duration) < 0.1) {
				cutPairs.push([a, b]);
			}
		}
	}
	const ghostClips = useEditorStore((s) => s.ghostClips).filter(
		(clip) => clip.trackId === track.id,
	);

	useEdgeAutoScroll({
		isActive: dragState.isDragging,
		getMouseClientX: () => lastMouseXRef.current ?? 0,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: duration * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel,
	});

	return (
		<div className="group/track relative size-full">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: empty track area is a pointer-only seek surface */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{ghostClips.map((clip) => {
					if (clip.isInvalid) return null;
					const left =
						clip.start * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
					const width =
						(clip.end - clip.start) *
						TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
						zoomLevel;
					return (
						<div
							key={clip.id}
							className="absolute top-0.5 bottom-0.5 bg-agent/10 border border-dashed border-agent/70 rounded-sm z-30 pointer-events-none flex items-center justify-center text-[9px] text-agent font-medium select-none px-2 text-center"
							style={{
								left: `${left}px`,
								width: `${width}px`,
							}}
						>
							{clip.label}
						</div>
					);
				})}

				{track.elements.length === 0 && ghostClips.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					track.elements.map((element) => {
						const isSelected = isElementSelected({
							trackId: track.id,
							elementId: element.id,
						});

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onSnapPointChange={onSnapPointChange}
								onResizeStateChange={onResizeStateChange}
								onElementMouseDown={(event, element) =>
									onElementMouseDown({ event, element, track })
								}
								onElementClick={(event, element) =>
									onElementClick({ event, element, track })
								}
								dragState={dragState}
								isDropTarget={element.id === targetElementId}
							/>
						);
					})
				)}

				{cutPairs.map(([a, b]) => (
					<TransitionCutButton
						key={`${a.id}->${b.id}`}
						trackId={track.id}
						left={a}
						right={b}
						zoomLevel={zoomLevel}
					/>
				))}
			</div>
		</div>
	);
}
