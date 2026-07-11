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
import { toast } from "sonner";

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
					const width = Math.max(
						2,
						(clip.end - clip.start) *
							TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
							zoomLevel,
					);

					const handleRemove = (e: React.MouseEvent) => {
						e.stopPropagation();
						e.preventDefault();
						const store = useEditorStore.getState();
						store.setGhostClips(store.ghostClips.filter((c) => c.id !== clip.id));
						toast.info(`Removed pending action: ${clip.label}`);
					};

					if (clip.isPendingSplit) {
						return (
							<div
								key={clip.id}
								onContextMenu={handleRemove}
								onClick={handleRemove}
								title="Proposed Cut (Click or Right-click to remove)"
								className="absolute top-0 bottom-0 w-[4px] bg-amber-500 hover:bg-amber-600 cursor-pointer z-30 border-l border-r border-dashed border-amber-600 flex items-center justify-center group"
								style={{
									left: `${left}px`,
								}}
							>
								<div className="hidden group-hover:block absolute bottom-full mb-1 bg-amber-600 text-white text-[8px] font-semibold py-0.5 px-1.5 rounded shadow-lg whitespace-nowrap z-50">
									Proposed Cut (Click to remove)
								</div>
							</div>
						);
					}

					if (clip.isPendingDelete) {
						return (
							<div
								key={clip.id}
								onContextMenu={handleRemove}
								className="absolute top-0.5 bottom-0.5 bg-destructive/5 hover:bg-destructive/10 border-2 border-dashed border-destructive/40 hover:border-destructive/60 rounded-sm z-30 flex items-center justify-center text-[9px] text-destructive font-bold select-none px-2 text-center group cursor-pointer"
								style={{
									left: `${left}px`,
									width: `${width}px`,
								}}
							>
								<span>{clip.label || "To be deleted"}</span>
								<button
									type="button"
									onClick={handleRemove}
									className="absolute top-0.5 right-0.5 size-3.5 bg-destructive/60 hover:bg-destructive text-white rounded-full items-center justify-center hidden group-hover:flex text-[8px] font-bold cursor-pointer"
								>
									✕
								</button>
							</div>
						);
					}

					return (
						<div
							key={clip.id}
							onContextMenu={handleRemove}
							className="absolute top-1 h-5 bg-card/95 hover:bg-card border border-agent/50 hover:border-agent text-agent rounded-full z-30 flex items-center justify-center text-[8px] font-bold select-none px-2.5 shadow-sm group cursor-pointer"
							style={{
								left: `${left}px`,
								width: `${width}px`,
							}}
						>
							<span className="truncate max-w-full">{clip.label}</span>
							<button
								type="button"
								onClick={handleRemove}
								className="ml-1.5 size-3 bg-agent/60 hover:bg-agent text-white rounded-full items-center justify-center hidden group-hover:flex text-[7px] font-bold cursor-pointer"
							>
								✕
							</button>
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
