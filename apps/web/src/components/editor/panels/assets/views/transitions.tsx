"use client";

import { useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import {
	TRANSITION_TYPES,
	applyTimelineTransition,
	type TransitionInfo,
} from "@/lib/ai/transitions";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRightDoubleIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";

/**
 * Transitions panel — the same engine the AI agent uses (12 real two-clip
 * transitions built from keyframes), driven manually. With a clip selected
 * the transition lands on the cut BEFORE that clip; otherwise on every cut.
 */
export function TransitionsView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const [duration, setDuration] = useState(0.5);
	const [applying, setApplying] = useState<string | null>(null);

	const selectedId = selectedElements[0]?.elementId;

	const apply = async (t: TransitionInfo) => {
		setApplying(t.type);
		try {
			const message = await applyTimelineTransition(editor, {
				type: t.type,
				duration,
				// fade always targets the sequence edges, never a single cut
				clipId: t.type === "fade" ? undefined : selectedId,
			});
			if (message.startsWith("Applied") || message.startsWith("Added")) {
				toast.success(message);
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
		<PanelView title="Transitions">
			<div className="flex flex-col gap-3 w-full px-1">
				<p className="text-xs text-muted-foreground leading-relaxed">
					{selectedId
						? "Applies on the cut before the selected clip."
						: "No clip selected — applies on every cut (montage mode)."}
				</p>

				<div className="space-y-1.5 bg-card/20 border border-border rounded-lg p-2">
					<div className="flex justify-between text-[10px] text-muted-foreground">
						<span>Duration</span>
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
						className="w-full h-1 bg-accent rounded-lg appearance-none cursor-pointer accent-primary"
					/>
				</div>

				<div className="grid grid-cols-2 gap-2.5 mt-1">
					{TRANSITION_TYPES.map((t) => (
						<TransitionCard
							key={t.type}
							transition={t}
							busy={applying !== null}
							active={applying === t.type}
							onClick={() => apply(t)}
						/>
					))}
				</div>

				<p className="text-[9px] text-muted-foreground/60 leading-relaxed">
					Overlap transitions (dissolve, whip, slide, push, spin, zoom) ripple
					later clips left so both clips genuinely share the blend window. Undo
					removes the whole transition in one step.
				</p>
			</div>
		</PanelView>
	);
}

function TransitionCard({
	transition,
	busy,
	active,
	onClick,
}: {
	transition: TransitionInfo;
	busy: boolean;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={busy}
			className="group flex flex-col items-start p-3 rounded-lg border border-border/50 bg-background text-left hover:border-primary/50 hover:bg-accent/20 transition-all duration-300 w-full disabled:opacity-60"
		>
			<div className="flex items-center gap-1.5 w-full mb-2">
				<div className="bg-accent size-8 rounded-md flex items-center justify-center group-hover:bg-primary/10 transition-colors">
					<HugeiconsIcon
						icon={ArrowRightDoubleIcon}
						className={`size-4 text-muted-foreground group-hover:text-primary transition-colors ${active ? "animate-pulse text-primary" : ""}`}
					/>
				</div>
				{transition.overlap && (
					<span className="ml-auto text-[8px] uppercase font-bold tracking-wider text-primary/70 bg-primary/10 rounded px-1 py-0.5">
						overlap
					</span>
				)}
			</div>
			<span className="text-xs font-semibold text-foreground">
				{transition.name}
			</span>
			<span className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
				{transition.description}
			</span>
		</button>
	);
}
