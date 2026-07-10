"use client";

import { useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import {
	TRANSFORM_PRESETS,
	applyClipTransform,
	type TransformPresetInfo,
} from "@/lib/ai/transforms";
import { HugeiconsIcon } from "@hugeicons/react";
import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";

/**
 * Motion panel — keyframed animation presets on one clip, powered by the
 * same engine as the AI agent's set_transform tool. Select a clip on the
 * timeline (falls back to the first video clip), then click a preset.
 */
export function MotionView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const [applying, setApplying] = useState<string | null>(null);
	const [slideFrom, setSlideFrom] = useState<"left" | "right">("left");

	const selectedId = selectedElements[0]?.elementId;

	const apply = async (p: TransformPresetInfo) => {
		setApplying(p.preset);
		try {
			const message = await applyClipTransform(editor, {
				clipId: selectedId,
				animate: p.preset,
				from: p.takesSide ? slideFrom : undefined,
			});
			if (message.startsWith("Transform on")) {
				toast.success(message);
			} else {
				toast.error(message);
			}
		} catch (err: any) {
			toast.error(err?.message || "Failed to apply the animation.");
		} finally {
			setApplying(null);
		}
	};

	return (
		<PanelView title="Motion">
			<div className="flex flex-col gap-3 w-full px-1">
				<p className="text-xs text-muted-foreground leading-relaxed">
					{selectedId
						? "Animates the selected clip with keyframes."
						: "No clip selected — animates the first video clip."}
				</p>

				<div className="flex items-center gap-2 bg-card/20 border border-border rounded-lg p-2">
					<span className="text-[10px] text-muted-foreground">
						Slide In direction
					</span>
					<div className="ml-auto flex gap-1">
						{(["left", "right"] as const).map((side) => (
							<button
								key={side}
								type="button"
								onClick={() => setSlideFrom(side)}
								className={`px-2 py-1 rounded text-[10px] font-semibold border transition-colors ${
									slideFrom === side
										? "bg-primary/15 border-primary/40 text-primary"
										: "bg-background border-border text-muted-foreground hover:text-foreground"
								}`}
							>
								{side}
							</button>
						))}
					</div>
				</div>

				<div className="grid grid-cols-2 gap-2.5">
					{TRANSFORM_PRESETS.map((p) => (
						<button
							key={p.preset}
							type="button"
							onClick={() => apply(p)}
							disabled={applying !== null}
							className="group flex flex-col items-start p-3 rounded-lg border border-border/50 bg-background text-left hover:border-primary/50 hover:bg-accent/20 transition-all duration-300 w-full disabled:opacity-60"
						>
							<div className="bg-accent size-8 rounded-md flex items-center justify-center mb-2 group-hover:bg-primary/10 transition-colors">
								<HugeiconsIcon
									icon={SlidersHorizontalIcon}
									className={`size-4 text-muted-foreground group-hover:text-primary transition-colors ${applying === p.preset ? "animate-pulse text-primary" : ""}`}
								/>
							</div>
							<span className="text-xs font-semibold text-foreground">
								{p.name}
							</span>
							<span className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
								{p.description}
							</span>
						</button>
					))}
				</div>

				<p className="text-[9px] text-muted-foreground/60 leading-relaxed">
					Presets add keyframes on transform/opacity — refine them anytime in
					the clip's keyframe editor. Undo removes a preset in one step. For
					precise values (position, scale, rotation) use the Properties panel or
					ask the AI: "scale clip 2 to 120% and shake it on the beat".
				</p>
			</div>
		</PanelView>
	);
}
