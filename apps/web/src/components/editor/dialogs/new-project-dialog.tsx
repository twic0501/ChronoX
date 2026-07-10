"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { FPS_PRESETS } from "@/constants/project-constants";
import type { TCanvasSize } from "@/lib/project/types";

type Aspect = {
	id: string;
	label: string;
	w: number;
	h: number;
};

const ASPECTS: Aspect[] = [
	{ id: "16:9", label: "16:9 Wide", w: 16, h: 9 },
	{ id: "2.39:1", label: "2.39:1 Ciné", w: 239, h: 100 },
	{ id: "9:16", label: "9:16 Vertical", w: 9, h: 16 },
	{ id: "1:1", label: "1:1 Square", w: 1, h: 1 },
];

const RESOLUTIONS = [
	{ id: "720", long: 1280, label: "HD · 720p" },
	{ id: "1080", long: 1920, label: "Full HD · 1080p" },
	{ id: "1440", long: 2560, label: "QHD · 1440p" },
	{ id: "2160", long: 3840, label: "4K · 2160p" },
];

const FPS_OPTIONS = FPS_PRESETS.filter((f) => f.value !== "120");

/** Quick-fill intents for the AI brief — the agent reads this as project context. */
const BRIEF_CHIPS = [
	"Cinematic vlog — teal & orange grade, tight pacing",
	"Travel montage — beat-synced cuts, warm golden look",
	"Product promo — clean, punchy, captions on key points",
	"Music video — high contrast, speed ramps on the drops",
];

function even(n: number): number {
	const r = Math.round(n);
	return r % 2 === 0 ? r : r - 1;
}

/** Anchors the long edge to the chosen resolution tier and derives the other side from the ratio. */
function computeCanvas(aspect: Aspect, long: number): TCanvasSize {
	const ratio = aspect.w / aspect.h;
	if (ratio === 1) {
		const side = even(long * (9 / 16));
		return { width: side, height: side };
	}
	if (ratio > 1) {
		return { width: even(long), height: even(long / ratio) };
	}
	return { width: even(long * ratio), height: even(long) };
}

export function NewProjectDialog({ children }: { children: React.ReactNode }) {
	const editor = useEditor();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("Untitled project");
	const [aspectId, setAspectId] = useState("16:9");
	const [resId, setResId] = useState("1080");
	const [fps, setFps] = useState(30);
	const [aiBrief, setAiBrief] = useState("");

	const aspect = ASPECTS.find((a) => a.id === aspectId) ?? ASPECTS[0];
	const res = RESOLUTIONS.find((r) => r.id === resId) ?? RESOLUTIONS[1];
	const canvasSize = computeCanvas(aspect, res.long);

	const handleCreate = async () => {
		if (creating) return;
		setCreating(true);
		try {
			const projectId = await editor.project.createNewProject({
				name: name.trim() || "Untitled project",
				fps,
				canvasSize,
				aiBrief,
			});
			router.push(`/editor/${projectId}`);
		} catch (error) {
			toast.error("Failed to create project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			setCreating(false);
		}
	};

	// Fit the aspect preview inside a fixed box.
	const previewRatio = canvasSize.width / canvasSize.height;
	const previewStyle =
		previewRatio >= 1
			? {
					width: "100%",
					aspectRatio: `${canvasSize.width} / ${canvasSize.height}`,
				}
			: {
					height: "220px",
					aspectRatio: `${canvasSize.width} / ${canvasSize.height}`,
				};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="flex w-[min(92vw,820px)] max-w-none flex-col gap-0 overflow-hidden p-0">
				<DialogTitle className="border-border/60 border-b px-6 py-4 text-lg font-semibold">
					New project
				</DialogTitle>

				<div className="grid grid-cols-1 gap-8 p-6 md:grid-cols-[1fr_300px]">
					{/* Left — aspect preview + AI brief */}
					<div className="flex flex-col gap-4">
						<div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/60 bg-muted/20 p-6">
							<div className="flex min-h-[180px] w-full items-center justify-center">
								<div
									className="relative flex items-center justify-center overflow-hidden rounded-md border border-border/70"
									style={{
										...previewStyle,
										maxWidth: "100%",
										maxHeight: "240px",
										background:
											"repeating-linear-gradient(135deg,var(--muted),var(--muted) 12px,var(--accent) 12px,var(--accent) 24px)",
									}}
								>
									<div
										className="absolute inset-0"
										style={{
											background:
												"radial-gradient(70% 90% at 50% 42%, color-mix(in srgb, var(--primary) 12%, transparent), transparent 60%)",
										}}
									/>
									<span className="relative rounded bg-black/55 px-2 py-1 font-mono text-[11px] text-primary">
										{aspect.id}
									</span>
								</div>
							</div>
							<p className="text-center font-mono text-xs text-muted-foreground">
								{canvasSize.width} × {canvasSize.height} · {fps} fps
							</p>
						</div>

						{/* AI brief — stored on the project and fed to ChronoX AI as context */}
						<div className="flex flex-col gap-2.5 rounded-lg border border-agent/25 bg-agent/[0.04] p-4">
							<div className="flex items-center gap-2">
								<span className="flex size-5 items-center justify-center rounded-md bg-gradient-to-br from-agent to-agent/70">
									<svg
										viewBox="0 0 24 24"
										fill="white"
										className="size-3"
										aria-hidden="true"
									>
										<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z" />
									</svg>
								</span>
								<span className="text-xs font-semibold text-agent">
									Brief ChronoX AI
								</span>
								<span className="text-[10px] text-muted-foreground">
									optional
								</span>
							</div>
							<textarea
								value={aiBrief}
								onChange={(e) => setAiBrief(e.target.value)}
								rows={2}
								maxLength={280}
								placeholder="What is this video? Style, mood, pacing… the AI will edit with this in mind."
								className="w-full resize-none rounded-lg border border-border/60 bg-input px-3 py-2 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-agent/50 focus:ring-1 focus:ring-agent/50"
							/>
							<div className="scrollbar-hidden -mx-1 flex gap-1.5 overflow-x-auto px-1">
								{BRIEF_CHIPS.map((chip) => (
									<button
										key={chip}
										type="button"
										onClick={() => setAiBrief(chip)}
										className="shrink-0 rounded-full border border-agent/20 bg-agent/[0.06] px-2.5 py-1 text-[10px] text-agent/90 transition-colors hover:bg-agent/[0.12]"
									>
										{chip.split(" — ")[0]}
									</button>
								))}
							</div>
						</div>
					</div>

					{/* Right — settings */}
					<div className="flex flex-col gap-5">
						<Field label="Project name">
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreate();
								}}
								// biome-ignore lint/a11y/noAutofocus: primary field of a create dialog
								autoFocus
								className="h-9 w-full rounded-lg border border-border/60 bg-input px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
								placeholder="Untitled project"
							/>
						</Field>

						<Field label="Aspect ratio">
							<div className="grid grid-cols-2 gap-2">
								{ASPECTS.map((a) => {
									const active = a.id === aspectId;
									return (
										<button
											key={a.id}
											type="button"
											onClick={() => setAspectId(a.id)}
											className={cn(
												"flex flex-col items-center gap-2 rounded-lg border px-2 py-3 transition-colors",
												active
													? "border-primary bg-primary/[0.07]"
													: "border-border/60 hover:border-border hover:bg-accent/40",
											)}
										>
											<AspectGlyph
												w={a.w}
												h={a.h}
												className={
													active ? "bg-primary" : "bg-muted-foreground/50"
												}
											/>
											<span
												className={cn(
													"text-[11px] font-medium",
													active ? "text-foreground" : "text-muted-foreground",
												)}
											>
												{a.label}
											</span>
										</button>
									);
								})}
							</div>
						</Field>

						<Field label="Resolution">
							<Select value={resId} onValueChange={setResId}>
								<SelectTrigger className="w-full">
									{RESOLUTIONS.find((r) => r.id === resId)?.label}
								</SelectTrigger>
								<SelectContent>
									{RESOLUTIONS.map((r) => (
										<SelectItem key={r.id} value={r.id}>
											{r.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>

						<Field label="Frame rate">
							<div className="grid grid-cols-4 gap-2">
								{FPS_OPTIONS.map((f) => {
									const value = Number(f.value);
									const active = value === fps;
									return (
										<button
											key={f.value}
											type="button"
											onClick={() => setFps(value)}
											className={cn(
												"rounded-lg border py-2 text-xs font-medium transition-colors",
												active
													? "border-primary bg-primary/[0.07] text-foreground"
													: "border-border/60 text-muted-foreground hover:border-border hover:bg-accent/40",
											)}
										>
											{f.value}
										</button>
									);
								})}
							</div>
						</Field>

						<Button
							onClick={handleCreate}
							disabled={creating}
							className="mt-1 h-11 gap-2"
						>
							{creating ? "Creating…" : "Create & edit"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function AspectGlyph({
	w,
	h,
	className,
}: {
	w: number;
	h: number;
	className?: string;
}) {
	const ratio = w / h;
	const boxW = ratio >= 1 ? 34 : Math.round(28 * ratio);
	const boxH = ratio >= 1 ? Math.round(34 / ratio) : 28;
	return (
		<span
			className={cn("block rounded-[3px]", className)}
			style={{ width: `${boxW}px`, height: `${boxH}px` }}
		/>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				{label}
			</span>
			{children}
		</div>
	);
}
