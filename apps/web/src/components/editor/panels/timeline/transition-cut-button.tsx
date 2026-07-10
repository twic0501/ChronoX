"use client";

import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useEditor } from "@/hooks/use-editor";
import {
	TRANSITION_TYPES,
	applyTimelineTransition,
} from "@/lib/ai/transitions";
import {
	cutKeyOf,
	useTransitionMarkersStore,
} from "@/stores/transition-markers-store";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import type { TimelineElement } from "@/lib/timeline";
import { toast } from "sonner";

/**
 * NLE-style transition handle sitting ON the cut between two adjacent clips
 * (like CapCut / Premiere): a small diamond you click to pick a transition
 * and its duration. Once applied it becomes a labeled box at the junction.
 */
export function TransitionCutButton({
	trackId,
	left,
	right,
	zoomLevel,
}: {
	trackId: string;
	left: TimelineElement;
	right: TimelineElement;
	zoomLevel: number;
}) {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const [duration, setDuration] = useState(0.5);
	const [applying, setApplying] = useState<string | null>(null);

	const cutKey = cutKeyOf(left.id, right.id);
	const marker = useTransitionMarkersStore((s) => s.markers[cutKey]);
	const setMarker = useTransitionMarkersStore((s) => s.setMarker);

	const x = right.startTime * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
	const boxWidth = marker
		? Math.max(
				18,
				marker.duration * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel,
			)
		: 14;

	const apply = async (type: string, name: string) => {
		setApplying(type);
		try {
			const message = await applyTimelineTransition(editor, {
				type,
				duration,
				clipId: right.id,
			});
			if (message.startsWith("Applied")) {
				setMarker(cutKey, { type, name, duration });
				toast.success(`${name} on the cut (${duration.toFixed(1)}s)`);
				setOpen(false);
			} else {
				toast.error(message);
			}
		} catch (err: any) {
			toast.error(err?.message || "Failed to apply the transition.");
		} finally {
			setApplying(null);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					title={
						marker
							? `${marker.name} · ${marker.duration.toFixed(1)}s — click to change`
							: "Add transition on this cut"
					}
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => e.stopPropagation()}
					className={
						marker
							? "absolute top-1/2 z-40 flex h-[60%] -translate-x-1/2 -translate-y-1/2 items-center justify-center overflow-hidden rounded-[4px] border border-primary/70 bg-primary/30 px-0.5 text-[8px] font-bold uppercase tracking-tight text-primary-foreground backdrop-blur-[1px] transition-colors hover:bg-primary/45"
							: "absolute top-1/2 z-40 flex size-[14px] -translate-x-1/2 -translate-y-1/2 rotate-45 items-center justify-center rounded-[3px] border border-border bg-background/90 opacity-0 transition-all hover:scale-125 hover:border-primary hover:opacity-100 group-hover/track:opacity-80"
					}
					style={{
						left: `${x}px`,
						...(marker ? { width: `${boxWidth}px` } : {}),
					}}
				>
					{marker ? (
						<span className="truncate">{marker.name}</span>
					) : (
						<span className="-rotate-45 text-[9px] font-bold leading-none text-muted-foreground">
							+
						</span>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="center"
				className="w-64 p-2"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
					<span className="font-semibold uppercase tracking-wider">
						Transition on cut
					</span>
					<span className="font-mono text-foreground">
						{duration.toFixed(1)}s
					</span>
				</div>
				<input
					type="range"
					min="0.2"
					max="1.5"
					step="0.1"
					value={duration}
					onChange={(e) => setDuration(Number(e.target.value))}
					className="mb-2 h-1 w-full cursor-pointer appearance-none rounded-lg bg-accent accent-primary"
				/>
				<div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto pr-0.5">
					{TRANSITION_TYPES.filter((t) => t.type !== "fade").map((t) => (
						<button
							key={t.type}
							type="button"
							disabled={applying !== null}
							onClick={() => apply(t.type, t.name)}
							className={`rounded-md border px-2 py-1.5 text-left text-[10px] font-medium transition-colors disabled:opacity-50 ${
								marker?.type === t.type
									? "border-primary/60 bg-primary/15 text-primary"
									: "border-border/60 bg-background text-foreground hover:border-primary/40 hover:bg-accent/30"
							}`}
						>
							{applying === t.type ? "Applying…" : t.name}
						</button>
					))}
				</div>
				<p className="mt-2 text-[9px] leading-relaxed text-muted-foreground/70">
					Applies real keyframes on both clips. Ctrl+Z removes it. Overlap types
					pull later clips left by the duration.
				</p>
			</PopoverContent>
		</Popover>
	);
}
