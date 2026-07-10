"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Send,
	Sparkles,
	Bot,
	ChevronDown,
	ChevronUp,
	Loader2,
	CheckCircle2,
	Scissors,
	Palette,
	Wand2,
	Film,
	Zap,
	X,
	Check,
	ArrowRight,
	CircleDot,
	Eye,
	Trash2,
	Sliders,
} from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import { toast } from "sonner";
import { useEditorStore } from "@/stores/editor-store";
import type { GhostClip, ActiveOperation } from "@/stores/editor-store";
import {
	DeleteElementsCommand,
	UpdateElementTrimCommand,
	SplitElementsCommand,
	InsertElementCommand,
	UpdateElementCommand,
	UpdateElementRetimeCommand,
} from "@/lib/commands/timeline/element";
import { AddTrackCommand } from "@/lib/commands/timeline/track";
import { buildDefaultMaskInstance } from "@/lib/masks";
import {
	AddClipEffectCommand,
	UpdateClipEffectParamsCommand,
} from "@/lib/commands/timeline/element/effects";
import { UpsertEffectParamKeyframeCommand } from "@/lib/commands/timeline/element";
import {
	getCachedSceneMap,
	formatSceneMapForPrompt,
} from "@/lib/ai/scene-analyzer";

import { storageService } from "@/services/storage/service";

// ─── Types ───────────────────────────────────────────────────

interface ApplyStep {
	id: string;
	label: string;
	state: "pending" | "running" | "done" | "failed";
	error?: string;
}

interface Message {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	thought?: string;
	operations?: any[];
	status?: "pending" | "applying" | "review" | "applied" | "discarded";
	/** Live per-step progress while the plan auto-applies, kept for review. */
	applySteps?: ApplyStep[];
	/** How many undoable commands this plan executed — powers "Undo all". */
	undoDepth?: number;
}

const ACTION_META: Record<string, { icon: any; label: string; color: string }> =
	{
		trim: { icon: Scissors, label: "Trim", color: "text-amber-500/80" },
		split: { icon: Scissors, label: "Split", color: "text-amber-500/80" },
		delete: { icon: X, label: "Delete", color: "text-destructive/80" },
		add_subtitle: { icon: Film, label: "Subtitle", color: "text-sky-500/70" },
		add_effect: { icon: Wand2, label: "Effect", color: "text-indigo-400/80" },
		adjust_color: { icon: Palette, label: "Color", color: "text-primary/80" },
		add_transition: {
			icon: ArrowRight,
			label: "Transition",
			color: "text-rose-400/70",
		},
		add_animation: {
			icon: Zap,
			label: "Animation",
			color: "text-orange-400/80",
		},
		color_grade_scenes: {
			icon: Palette,
			label: "Multi-Scene",
			color: "text-constructive/80",
		},
		demux_audio: { icon: Film, label: "Split Audio", color: "text-primary/80" },
		mux_audio: { icon: Film, label: "Mix Audio", color: "text-sky-400/80" },
		add_overlay: { icon: Film, label: "Overlay", color: "text-purple-400/80" },
		transform: {
			icon: Scissors,
			label: "Transform",
			color: "text-amber-400/80",
		},
		change_speed: { icon: Zap, label: "Speed", color: "text-yellow-400/80" },
		blend_mode: { icon: Wand2, label: "Blend", color: "text-blue-400/80" },
		chroma_key: {
			icon: Wand2,
			label: "Chroma Key",
			color: "text-green-400/80",
		},
		mask_inpainting: {
			icon: Wand2,
			label: "Mask",
			color: "text-constructive/80",
		},
	};

function getOperationSummary(op: any): string {
	const clipShort = op.clip_id ? op.clip_id.slice(0, 6) : "?";
	switch (op.action) {
		case "trim":
			return `${clipShort}… ${op.start}s→${op.end}s`;
		case "split":
			return `${clipShort}… @${op.time}s`;
		case "delete":
			return clipShort;
		case "add_subtitle":
			return `"${(op.text || "").slice(0, 20)}"`;
		case "add_effect":
			return `${op.effect_type} → ${clipShort}`;
		case "adjust_color":
			return `→ ${clipShort}`;
		case "add_transition":
			return `${op.transition_type} ${op.duration}s`;
		case "add_animation":
			return `${op.animation_type} ${op.duration}s`;
		case "color_grade_scenes":
			return `${op.grades?.length ?? 0} scenes → ${(op.clip_id || "").slice(0, 6)}`;
		case "demux_audio":
			return `Split Audio → ${clipShort}`;
		case "mux_audio":
			return `Mix music to timeline`;
		case "add_overlay":
			return `Overlay ${op.overlay_type} @${op.start}s`;
		case "transform":
			return `Transform → ${clipShort}`;
		case "change_speed":
			return `Speed ${op.speed}x → ${clipShort}`;
		case "blend_mode":
			return `Blend ${op.blend_mode} → ${clipShort}`;
		case "chroma_key":
			return `Chroma Key → ${clipShort}`;
		case "mask_inpainting":
			return `Mask ${op.mask_type} → ${clipShort}`;
		default:
			return op.action;
	}
}

// ─── Build timeline snapshot for AI context ──────────────────

function buildTimelineSnapshot(editor: any): string {
	// The creative brief captured at project creation always leads the
	// context, so every AI reply is steered by the user's stated intent.
	const brief = editor.project.getActiveOrNull?.()?.metadata?.aiBrief;
	const briefLine = brief
		? `PROJECT BRIEF (user's creative intent — honour this in every edit): ${brief}\n\n`
		: "";

	const tracks = editor.timeline.getTracks();
	if (!tracks || tracks.length === 0)
		return `${briefLine}Empty timeline — no clips added.`;

	const lines: string[] = [];
	let totalEnd = 0;

	tracks.forEach((track: any, index: number) => {
		const flags = [
			track.isMain ? "MAIN" : null,
			track.muted ? "muted" : null,
			track.hidden ? "hidden" : null,
		]
			.filter(Boolean)
			.join(", ");
		lines.push(
			`Track ${index + 1} — track_id="${track.id}" type=${track.type}${flags ? ` [${flags}]` : ""}:`,
		);

		if (!track.elements || track.elements.length === 0) {
			lines.push("  (empty track)");
			return;
		}

		for (const el of track.elements) {
			const dur = (el as any).duration ?? 0;
			const start = (el as any).startTime ?? 0;
			const end = start + dur;
			totalEnd = Math.max(totalEnd, end);
			const name = (el as any).name || el.type;
			const effectsList =
				(el as any).effects?.map((e: any) => e.type).join(", ") || "none";
			const rate = (el as any).retime?.rate;
			const volume = (el as any).volume;
			const isMuted = (el as any).muted === true;
			const extras = [
				typeof rate === "number" && rate !== 1 ? `speed=${rate}x` : null,
				// volume is a linear gain: 0 = mute, 1 = normal, 2 = double
				typeof volume === "number" && volume !== 1 ? `volume=${volume}` : null,
				isMuted ? "MUTED" : null,
			]
				.filter(Boolean)
				.join(" ");
			lines.push(
				`  - clip_id="${el.id}" type=${el.type} name="${name}" timeline=[${start.toFixed(1)}s → ${end.toFixed(1)}s] dur=${dur.toFixed(1)}s effects=[${effectsList}]${extras ? " " + extras : ""}`,
			);
		}
	});

	lines.push(`Total timeline duration: ${totalEnd.toFixed(1)}s.`);
	lines.push(
		`RULES: target clips ONLY by their exact clip_id string. Time values must lie inside the target clip's [start → end] timeline range.`,
	);
	return briefLine + lines.join("\n");
}

function getCanvasColorStats(): string {
	const sourceCanvas = document.querySelector("canvas");
	if (!sourceCanvas) return "No active canvas found for color analysis.";

	try {
		const tempCanvas = document.createElement("canvas");
		tempCanvas.width = 64;
		tempCanvas.height = 64;
		const ctx = tempCanvas.getContext("2d");
		if (!ctx) return "Failed to create 2D context for color analysis.";

		ctx.drawImage(sourceCanvas, 0, 0, 64, 64);
		const imgData = ctx.getImageData(0, 0, 64, 64);
		const data = imgData.data;

		let totalBrightness = 0;
		let totalSaturation = 0;
		let totalWarmth = 0;
		const brightnesses: number[] = [];

		for (let i = 0; i < data.length; i += 4) {
			const r = data[i] / 255;
			const g = data[i + 1] / 255;
			const b = data[i + 2] / 255;

			const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
			totalBrightness += brightness;
			brightnesses.push(brightness);

			const maxVal = Math.max(r, g, b);
			const minVal = Math.min(r, g, b);
			totalSaturation += maxVal - minVal;

			totalWarmth += r - b;
		}

		const avgBrightness = totalBrightness / (64 * 64);
		const avgSaturation = totalSaturation / (64 * 64);
		const avgWarmth = totalWarmth / (64 * 64);

		let sumSqDiff = 0;
		for (const b of brightnesses) {
			sumSqDiff += (b - avgBrightness) ** 2;
		}
		const stdDevBrightness = Math.sqrt(sumSqDiff / (64 * 64));
		const contrast = Math.min(stdDevBrightness * 2, 1);

		return `Brightness: ${avgBrightness.toFixed(2)} (0: dark, 1: bright)
  - Contrast: ${contrast.toFixed(2)} (0: low, 1: high)
  - Saturation: ${avgSaturation.toFixed(2)} (0: dull, 1: vivid)
  - Warmth: ${avgWarmth.toFixed(2)} (positive: warm/red, negative: cool/blue)`;
	} catch (e) {
		return "Failed to extract canvas color stats: " + String(e);
	}
}

// ─── Partial JSON parser ──────────────────────────────────────

export function parsePartialOperations(text: string): any[] {
	let jsonText = "";
	const jsonMatch = text.match(/```json\s*([\s\S]*)/);
	if (jsonMatch) {
		jsonText = jsonMatch[1];
	} else {
		const rawMatch = text.match(/\{[\s\S]*/);
		if (rawMatch) {
			jsonText = rawMatch[0];
		}
	}
	if (!jsonText) return [];

	const ops: any[] = [];
	const objRegex = /\{[^{}]*?"action"\s*:\s*"[^"]+?"[^{}]*?\}/g;
	let match;
	while ((match = objRegex.exec(jsonText)) !== null) {
		try {
			const parsed = JSON.parse(match[0]);
			ops.push(parsed);
		} catch (_) {
			try {
				const parsed = JSON.parse(match[0] + "}");
				ops.push(parsed);
			} catch (_) {}
		}
	}

	if (ops.length === 0) {
		for (let i = 0; i < 10; i++) {
			try {
				const closed = jsonText.trim();
				const parsed = JSON.parse(closed + "]".repeat(i) + "}".repeat(i));
				if (parsed.operations) return parsed.operations;
			} catch (_) {}
		}
	}

	return ops;
}

// ─── Component ───────────────────────────────────────────────

export function ChatSidebar() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());

	const setTimelineLocked = useEditorStore((e) => e.setTimelineLocked);
	const ghostClips = useEditorStore((e) => e.ghostClips);
	const activeOperations = useEditorStore((e) => e.activeOperations);
	const setGhostStateFromStream = useEditorStore(
		(e) => e.setGhostStateFromStream,
	);
	const toggleOperation = useEditorStore((e) => e.toggleOperation);
	const clearGhostState = useEditorStore((e) => e.clearGhostState);

	// ── Auto-apply: propose → apply (live, step by step) → review ──
	// Each op is compiled against the CURRENT timeline right before it runs
	// and executes as its own undoable command, so the review state can offer
	// an accurate "Undo all" (N history undos) instead of a fake toggle.
	const applyPlanSequentially = async (msgId: string) => {
		const { dryRunActions, validateOperations } = await import(
			"@/lib/ai/compiler"
		);
		const { BatchCommand } = await import("@/lib/commands/batch-command");

		const enabledOps = activeOperations.filter((o) => o.enabled);
		if (enabledOps.length === 0) return;

		// ── Accept-time re-validation ──
		// The user may have edited the timeline manually while the AI was
		// thinking, so never trust the stream-time dry-run. Conflicting ops
		// are skipped individually instead of failing the whole plan.
		const validations = validateOperations(
			enabledOps.map((o) => o.data),
			editor,
		);
		const conflicts = validations.filter((v) => !v.ok);
		const validPairs = enabledOps
			.map((ui, i) => ({ ui, v: validations[i] }))
			.filter((p) => p.v?.ok);

		for (const c of conflicts) {
			toast.warning(`Skipped "${c.op.action}": ${c.error}`);
		}
		if (validPairs.length === 0) {
			toast.error(
				"No operations can be applied — the timeline changed since the AI proposal.",
			);
			setMessages((prev) =>
				prev.map((m) => (m.id === msgId ? { ...m, status: "discarded" } : m)),
			);
			clearGhostState();
			return;
		}

		const steps: ApplyStep[] = validPairs.map((p) => ({
			id: p.ui.id,
			label: p.ui.label,
			state: "pending",
		}));
		setMessages((prev) =>
			prev.map((m) =>
				m.id === msgId
					? { ...m, status: "applying", applySteps: steps, undoDepth: 0 }
					: m,
			),
		);
		const setStep = (id: string, state: ApplyStep["state"], error?: string) =>
			setMessages((prev) =>
				prev.map((m) =>
					m.id === msgId
						? {
								...m,
								applySteps: m.applySteps?.map((st: ApplyStep) =>
									st.id === id ? { ...st, state, error } : st,
								),
							}
						: m,
				),
			);

		let undoDepth = 0;
		const activeProj = editor.project.getActive();
		for (const pair of validPairs) {
			setStep(pair.ui.id, "running");
			// Brief yield so the running state (spinner) is actually visible.
			await new Promise((r) => setTimeout(r, 220));

			const dry = dryRunActions([pair.v.op], editor, { strict: true });
			if (!dry.success || !dry.commands || dry.commands.length === 0) {
				setStep(pair.ui.id, "failed", dry.error || "validation failed");
				toast.warning(
					`Skipped "${pair.v.op.action}": ${dry.error || "validation failed"}`,
				);
				continue;
			}

			editor.command.execute({ command: new BatchCommand(dry.commands) });
			undoDepth += 1;
			if (dry.fixes && dry.fixes.length > 0) {
				toast.info(
					`Auto-corrected: ${dry.fixes[0]}${dry.fixes.length > 1 ? "…" : ""}`,
				);
			}
			if (activeProj) {
				void storageService.applyDelta(activeProj.metadata.id, {
					type: pair.v.op.action,
					payload: pair.v.op,
				});
			}
			setStep(pair.ui.id, "done");
		}

		setMessages((prev) =>
			prev.map((m) =>
				m.id === msgId ? { ...m, status: "review", undoDepth } : m,
			),
		);
		clearGhostState();
	};
	const aiMode = useEditorStore((e) => e.aiMode);
	const setAiStatus = useEditorStore((e) => e.setAiStatus);

	const [input, setInput] = useState("");
	const messages = useEditorStore((e) => e.chatMessages);
	const setMessages = useEditorStore((e) => e.setChatMessages);
	const [isThinking, setIsThinking] = useState(false);
	const [isThoughtOpen, setIsThoughtOpen] = useState(false);
	const [currentThought, setCurrentThought] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [backendConnected, setBackendConnected] = useState(false);
	const [localModel, setLocalModel] = useState<"qwen3.5:9b" | "gemma4:12b">(
		"qwen3.5:9b",
	);

	// ── AI provider config: paste an API key in-app, the backend detects the
	// vendor from the key format and returns that vendor's model list.
	const PROVIDER_LABELS: Record<string, string> = {
		ollama: "Local",
		gemini: "Gemini",
		openai: "OpenAI",
		grok: "Grok",
		anthropic: "Claude",
	};
	const [aiCfg, setAiCfg] = useState<{
		provider: string;
		model: string;
		apiKey: string;
		models: string[];
	}>(() => {
		if (typeof window !== "undefined") {
			try {
				const saved = localStorage.getItem("chronox.ai.cfg");
				if (saved) return JSON.parse(saved);
			} catch {}
		}
		return { provider: "ollama", model: "qwen3.5:9b", apiKey: "", models: [] };
	});
	const [showProviderPanel, setShowProviderPanel] = useState(false);
	const [providerKeyInput, setProviderKeyInput] = useState("");
	const [providerBusy, setProviderBusy] = useState(false);

	const saveAiCfg = (cfg: typeof aiCfg) => {
		setAiCfg(cfg);
		try {
			localStorage.setItem("chronox.ai.cfg", JSON.stringify(cfg));
		} catch {}
	};

	// Paste key → backend detects vendor + lists its models → pick the first.
	const connectProviderKey = async (rawKey: string) => {
		const key = rawKey.trim();
		setProviderBusy(true);
		try {
			const API_URL =
				process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
			const res = await fetch(`${API_URL}/api/ai/provider-models`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api_key: key }),
			});
			if (!res.ok) {
				toast.error(await res.text());
				return;
			}
			const data = await res.json();
			const models: string[] = data.models ?? [];
			if (models.length === 0) {
				toast.error(`No models returned from ${data.provider}`);
				return;
			}
			// Sensible default model per vendor (cheap + fast for agent loops).
			const preferred = [
				"gemini-2.5-flash",
				"gpt-5.4-mini",
				"claude-haiku-4-5",
				"grok-4-fast",
			];
			const model = models.find((m) => preferred.includes(m)) ?? models[0];
			saveAiCfg({ provider: data.provider, model, apiKey: key, models });
			setProviderKeyInput("");
			toast.success(
				`Connected to ${PROVIDER_LABELS[data.provider] ?? data.provider} — ${models.length} models`,
			);
		} catch (e: any) {
			toast.error(`Connection failed: ${e?.message ?? e}`);
		} finally {
			setProviderBusy(false);
		}
	};

	const [isDraggingLink, setIsDraggingLink] = useState(false);
	const [showMimicDropdown, setShowMimicDropdown] = useState(false);
	const mediaFiles = useEditor((e) => e.media.getAssets());

	const downloadAndAddAsset = async (downloadUrl: string) => {
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		const toastId = toast.loading(`Downloading asset from ${downloadUrl}...`);
		try {
			const API_URL =
				process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
			const res = await fetch(`${API_URL}/api/ai/download-asset`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: downloadUrl }),
			});

			if (!res.ok) {
				const errMsg = await res.text();
				throw new Error(errMsg || "Download failed");
			}

			const data = await res.json();

			// Guess MediaType based on file extension
			const ext = data.name.split(".").pop()?.toLowerCase() || "";
			let type: "video" | "audio" | "image" = "video";
			if (["mp3", "wav", "aac", "m4a"].includes(ext)) {
				type = "audio";
			} else if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
				type = "image";
			}

			// The backend serves the file at /static/... on its own origin —
			// an origin-relative URL would 404 against the Next dev server.
			const assetUrl = `${API_URL}${data.original_path}`;

			// Fetch the real bytes so thumbnails/decoding work like a normal upload
			const fileRes = await fetch(assetUrl);
			if (!fileRes.ok)
				throw new Error("Failed to fetch downloaded asset bytes");
			const blob = await fileRes.blob();
			const file = new File([blob], data.name, {
				type:
					blob.type ||
					(type === "video"
						? "video/mp4"
						: type === "audio"
							? "audio/wav"
							: "image/png"),
			});

			await editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: {
					name: data.name,
					type,
					file,
					url: assetUrl,
					duration: typeof data.duration === "number" ? data.duration : 10.0,
					ephemeral: false,
				},
			});

			toast.success(`Successfully downloaded and added ${data.name}!`, {
				id: toastId,
			});

			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "system",
					content: `📥 Video URL downloaded successfully. Asset "${data.name}" added to project!`,
				},
			]);
		} catch (err: any) {
			console.error("Download error:", err);
			toast.error(`Download failed: ${err.message}`, { id: toastId });
		}
	};

	// The Rust backend resolves paths starting with "/static/" to absolute
	// filesystem paths. Convert a full asset URL down to that shape.
	const toBackendPath = (url: string | undefined): string | undefined => {
		if (!url) return undefined;
		const i = url.indexOf("/static/");
		if (i !== -1) return url.slice(i);
		return url; // already a bare path or something the backend can stat
	};

	const handleMimicAsset = async (refAssetId: string) => {
		setShowMimicDropdown(false);
		const refAsset = mediaFiles.find((m) => m.id === refAssetId);
		if (!refAsset) return;

		const tracks = editor.timeline.getTracks();
		const videoTrack = tracks.find((t) => t.type === "video");
		const targetClip = videoTrack?.elements?.[0];
		if (!videoTrack || !targetClip) {
			toast.error(
				"Add a raw video clip to the timeline first — Mimic adapts the reference style onto it.",
			);
			return;
		}

		const toastId = toast.loading(`Analyzing the style of "${refAsset.name}"…`);
		try {
			const API_URL =
				process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

			// Resolve the raw target's source path and its soundtrack (if any)
			const assets = editor.media.getAssets();
			const targetAsset = assets.find(
				(a) => a.id === (targetClip as any).mediaId,
			);
			const targetVideoPath = toBackendPath(
				(targetClip as any).sourceOriginalPath ||
					(targetClip as any).sourceProxyPath ||
					targetAsset?.url,
			);
			const audioEl = tracks
				.filter((t) => t.type === "audio")
				.flatMap((t) => t.elements)[0] as any;
			const audioAsset = audioEl
				? assets.find((a) => a.id === audioEl.mediaId)
				: undefined;
			const targetAudioPath = toBackendPath(
				audioEl?.sourceOriginalPath ||
					audioEl?.sourceProxyPath ||
					audioAsset?.url,
			);

			const res = await fetch(`${API_URL}/api/ai/mimic-flow`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					reference_video_path: toBackendPath(refAsset.url),
					target_video_path: targetVideoPath,
					target_audio_path: targetAudioPath,
					target_video_duration: targetClip.duration || 10.0,
				}),
			});
			if (!res.ok)
				throw new Error(await res.text().catch(() => "Mimic Flow failed"));

			const data = await res.json();
			const mutations: any[] = data.mutations || [];
			const summary: string = data.summary || "no distinctive style detected";

			const { SplitElementsCommand } = await import(
				"@/lib/commands/timeline/element"
			);
			const { dryRunActions, validateOperations } = await import(
				"@/lib/ai/compiler"
			);
			const { BatchCommand } = await import("@/lib/commands/batch-command");

			const trackId = videoTrack.id;
			const origStart = targetClip.startTime;
			const origEnd = targetClip.startTime + targetClip.duration;

			// ── Phase 1: apply the cut grid on the target clip ──
			const cutTimes = mutations
				.filter((m) => m.action === "SPLIT_AND_INSERT")
				.map((m) => m.target_pts_seconds)
				.filter((t: number) => t > origStart + 0.2 && t < origEnd - 0.2)
				.sort((a: number, b: number) => a - b);

			let currentId = targetClip.id;
			let splitsApplied = 0;
			for (const t of cutTimes) {
				const cmd = new SplitElementsCommand({
					elements: [{ trackId, elementId: currentId }],
					splitTime: t,
				});
				editor.command.execute({ command: cmd });
				const right = cmd.getRightSideElements?.()[0];
				if (!right) break; // out of range — stop splitting
				currentId = right.elementId;
				splitsApplied++;
			}

			// ── Resolve the resulting segments (left→right) ──
			const freshTrack = editor.timeline
				.getTracks()
				.find((t) => t.id === trackId);
			const segments = (freshTrack?.elements ?? [])
				.filter(
					(el: any) =>
						el.startTime >= origStart - 0.05 && el.startTime < origEnd - 0.05,
				)
				.sort((a: any, b: any) => a.startTime - b.startTime);

			const segIdAt = (index: number): string | undefined =>
				segments[index]?.id;

			// ── Phase 2: map per-segment + global mutations to chat ops ──
			const ops: any[] = [];
			for (const m of mutations) {
				const targets: string[] =
					m.clip_index === -1
						? segments.map((s: any) => s.id)
						: m.clip_index >= 0
							? ([segIdAt(m.clip_index)].filter(Boolean) as string[])
							: [];

				for (const clip_id of targets) {
					if (m.action === "ADJUST_COLOR") {
						ops.push({ action: "adjust_color", clip_id, params: m.params });
					} else if (m.action === "ADD_ZOOM") {
						ops.push({
							action: "transform",
							clip_id,
							scale: m.scale ?? 1.05,
							position_x: -((m.centerX || 0) * 100),
							position_y: -((m.centerY || 0) * 100),
							rotation: 0,
						});
					} else if (m.action === "ADD_EFFECT") {
						ops.push({
							action: "add_effect",
							clip_id,
							effect_type: m.effect_type,
							params: m.params,
						});
					} else if (m.action === "APPLY_SPEED_RAMP") {
						ops.push({
							action: "change_speed",
							clip_id,
							speed: m.speed ?? 1.5,
							reverse: !!m.reverse,
							curve: m.curve,
						});
					}
				}
			}

			let appliedCount = 0;
			if (ops.length > 0) {
				const valid = validateOperations(ops, editor)
					.filter((v) => v.ok)
					.map((v) => v.op);
				const dry = dryRunActions(valid, editor, { strict: true });
				if (dry.success && dry.commands && dry.commands.length > 0) {
					editor.command.execute({ command: new BatchCommand(dry.commands) });
					appliedCount = dry.commands.length;
					const activeProj = editor.project.getActive();
					if (activeProj) {
						for (const op of valid) {
							void storageService.applyDelta(activeProj.metadata.id, {
								type: op.action,
								payload: op,
							});
						}
					}
				}
			}

			clearGhostState();

			// ── Report what the engine LEARNED and applied ──
			const applied: string[] = [];
			if (splitsApplied > 0)
				applied.push(
					`${splitsApplied} cut${splitsApplied > 1 ? "s" : ""} matched to the reference's pacing/beat`,
				);
			const colorN = mutations.filter(
				(m) => m.action === "ADJUST_COLOR",
			).length;
			if (colorN) applied.push(`${colorN} per-segment color match`);
			const zoomN = mutations.filter((m) => m.action === "ADD_ZOOM").length;
			if (zoomN) applied.push(`${zoomN} push-in zoom`);
			const fx = mutations.filter((m) => m.action === "ADD_EFFECT");
			if (fx.length)
				applied.push(
					`effects: ${[...new Set(fx.map((m) => m.effect_type))].join(", ")}`,
				);

			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "assistant",
					content:
						`🎬 **Mimic Engine** studied "${refAsset.name}" and read its style as:\n` +
						`*${summary}*\n\n` +
						(applied.length
							? `Adapted onto your raw footage (${appliedCount + splitsApplied} operations): ${applied.join("; ")}. ` +
								`Parameters were derived from the measured difference between the reference and your clip — not a fixed preset.`
							: `The reference had no strong style markers to transfer, so nothing was changed.`),
					status: "applied",
				},
			]);

			toast.success("Mimic style adapted to your footage!", { id: toastId });
		} catch (err: any) {
			console.error("Mimic error:", err);
			toast.error(`Mimic failed: ${err.message}`, { id: toastId });
		}
	};

	// Orange & Teal cinematic grade (matches the SYSTEM_PROMPT preset).
	const CINEMATIC_GRADE = {
		lift_b: 0.05,
		lift_g: 0.02,
		lift_r: -0.03,
		gain_r: 1.12,
		gain_g: 1.06,
		gain_b: 0.9,
		contrast: 0.15,
		saturation: 0.05,
	};

	// Expand a single auto_scene_cut op into a full batch using the cached
	// server-side scene map: split at every scene boundary, drop the scenes the
	// user doesn't want (e.g. keep only scenery), then grade + mute the rest.
	// Done programmatically because feeding 88 scenes through the LLM would blow
	// its context and asking it to emit hundreds of ops is unreliable.
	const applyAutoSceneCut = async (
		op: any,
	): Promise<{ applied: boolean; summary: string }> => {
		const tracks = editor.timeline.getTracks();
		const videoTrack = tracks.find((t) => t.type === "video");
		const clip: any = op.clip_id
			? (videoTrack?.elements.find((e: any) => e.id === op.clip_id) ??
				videoTrack?.elements[0])
			: videoTrack?.elements[0];
		if (!videoTrack || !clip)
			return { applied: false, summary: "no video clip on the timeline" };

		const asset = editor.media.getAssets().find((a) => a.id === clip.mediaId);
		const sceneMap = asset ? getCachedSceneMap(asset.id) : undefined;
		if (!sceneMap || sceneMap.scenes.length === 0)
			return {
				applied: false,
				summary: "scene analysis isn't ready yet — try again in a moment",
			};

		const { SplitElementsCommand, DeleteElementsCommand } = await import(
			"@/lib/commands/timeline/element"
		);
		const { BatchCommand } = await import("@/lib/commands/batch-command");
		const { dryRunActions } = await import("@/lib/ai/compiler");

		const trackId = videoTrack.id;
		const clipStart: number = clip.startTime;
		const clipEnd: number = clip.startTime + clip.duration;
		const trimStart: number = clip.trimStart ?? 0;
		const rate: number = clip.retime?.rate ?? 1;
		const toTimeline = (srcT: number) => clipStart + (srcT - trimStart) / rate;

		const inSpan = (seg: any) =>
			seg.startTime >= clipStart - 0.05 && seg.startTime < clipEnd - 0.05;
		const sceneForSeg = (seg: any) => {
			const midTl = seg.startTime + seg.duration / 2;
			const midSrc = trimStart + (midTl - clipStart) * rate;
			return sceneMap.scenes.reduce((best, s) => {
				const bm = (best.startTime + best.endTime) / 2;
				const sm = (s.startTime + s.endTime) / 2;
				return Math.abs(sm - midSrc) < Math.abs(bm - midSrc) ? s : best;
			}, sceneMap.scenes[0]);
		};

		// 1. Split at every scene boundary inside the clip
		const cutPoints = sceneMap.scenes
			.map((s) => toTimeline(s.startTime))
			.filter((t) => t > clipStart + 0.2 && t < clipEnd - 0.2)
			.sort((a, b) => a - b);
		let currentId = clip.id;
		for (const t of cutPoints) {
			const cmd = new SplitElementsCommand({
				elements: [{ trackId, elementId: currentId }],
				splitTime: t,
			});
			editor.command.execute({ command: cmd });
			const right = cmd.getRightSideElements?.()[0];
			if (!right) break;
			currentId = right.elementId;
		}

		// 2. Optionally drop non-scenery scenes (tagged with a prominent person)
		let deleted = 0;
		let segments = (
			editor.timeline.getTracks().find((t) => t.id === trackId)?.elements ?? []
		)
			.filter(inSpan)
			.sort((a: any, b: any) => a.startTime - b.startTime);
		const total = segments.length;
		if (op.keep_only_scenery) {
			const toDelete = segments.filter((seg: any) =>
				sceneForSeg(seg).contentTag.includes("person"),
			);
			if (toDelete.length > 0 && toDelete.length < segments.length) {
				editor.command.execute({
					command: new DeleteElementsCommand({
						elements: toDelete.map((s: any) => ({
							trackId,
							elementId: s.id,
						})),
					}),
				});
				deleted = toDelete.length;
			}
		}

		// 3. Grade + mute the remaining segments
		segments = (
			editor.timeline.getTracks().find((t) => t.id === trackId)?.elements ?? []
		).filter(inSpan);
		const followOps: any[] = [];
		for (const seg of segments) {
			if (op.mute !== false)
				followOps.push({ action: "adjust_volume", clip_id: seg.id, volume: 0 });
			if (op.color_preset !== "none")
				followOps.push({
					action: "adjust_color",
					clip_id: seg.id,
					params: CINEMATIC_GRADE,
				});
		}
		if (followOps.length > 0) {
			const dry = dryRunActions(followOps, editor, { strict: false });
			if (dry.commands && dry.commands.length > 0)
				editor.command.execute({ command: new BatchCommand(dry.commands) });
		}

		return {
			applied: true,
			summary: `split into ${total} scenes${op.keep_only_scenery ? `, removed ${deleted} non-scenery (person) shots` : ""}, applied cinematic grade${op.mute !== false ? " + muted audio" : ""}`,
		};
	};

	const lastUpdateRef = useRef(0);
	const pendingOpsRef = useRef<any[]>([]);
	const abortRef = useRef<AbortController | null>(null);

	// ── Interactive agent: mid-run questions (ask_user tool) ──
	// The agent loop awaits the resolver; option chips or a typed reply resolve
	// it and the run continues with the user's answer.
	const [pendingAsk, setPendingAsk] = useState<{
		question: string;
		options: string[];
	} | null>(null);
	const askResolveRef = useRef<((answer: string) => void) | null>(null);

	const answerAsk = (answer: string) => {
		const resolve = askResolveRef.current;
		askResolveRef.current = null;
		setPendingAsk(null);
		if (!resolve) return;
		setMessages((prev) => [
			...prev,
			{ id: crypto.randomUUID(), role: "user", content: answer },
		]);
		setAiStatus("running", "Continuing…");
		resolve(answer);
	};

	const stopGeneration = () => {
		// A pending question would leave the agent awaiting forever — release it
		// before aborting so the loop can observe the abort signal.
		askResolveRef.current?.("(cancelled — stop the run)");
		askResolveRef.current = null;
		setPendingAsk(null);
		abortRef.current?.abort();
		abortRef.current = null;
	};

	// ─── Load Chat History ────────────────────────────
	useEffect(() => {
		if (!activeProject?.metadata.id) {
			setMessages([
				{
					id: "welcome",
					role: "system",
					content: "ChronoX AI is ready. Send a command to start editing.",
				},
			]);
			return;
		}

		if (messages.length > 1) {
			return; // Skip loading if history has already been loaded for this session
		}

		storageService.getChatHistory(activeProject.metadata.id).then((history) => {
			if (history && history.length > 0) {
				setMessages(history);
			} else {
				setMessages([
					{
						id: "welcome",
						role: "system",
						content: "ChronoX AI is ready. Send a command to start editing.",
					},
				]);
			}
		});
	}, [activeProject?.metadata.id]);

	// ─── Save Chat History ────────────────────────────
	useEffect(() => {
		if (activeProject?.metadata.id && messages.length > 0) {
			storageService.saveChatHistory(activeProject.metadata.id, messages);
		}
	}, [messages, activeProject?.metadata.id]);

	// ─── WebSocket ────────────────────────────────────
	useEffect(() => {
		if (typeof window === "undefined") return;
		const projectId = activeProject?.metadata.id || "default";
		const ws = new WebSocket(`ws://localhost:8000/ws/${projectId}`);
		ws.onopen = () => setBackendConnected(true);
		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (
					data.type === "CONNECTION_STATUS" &&
					data.payload.status === "connected"
				) {
					const win = window as any;
					if (!win.__chronox_notified_connected) {
						win.__chronox_notified_connected = true;
					}
				}
			} catch (_) {}
		};
		ws.onclose = () => setBackendConnected(false);
		ws.onerror = () => setBackendConnected(false);
		return () => {
			ws.close();
		};
	}, [activeProject?.metadata.id]);

	// ─── Auto-scroll ──────────────────────────────────
	useEffect(() => {
		if (scrollRef.current) {
			const viewport = scrollRef.current.querySelector(
				"[data-radix-scroll-area-viewport]",
			);
			if (viewport) viewport.scrollTop = viewport.scrollHeight;
		}
	}, [messages, currentThought, isThinking]);

	// Mirror the local thinking flag to the global AI status so the header's
	// non-blocking activity pill clears on every exit path (success, abort,
	// error) without threading resets through each return.
	useEffect(() => {
		if (!isThinking) setAiStatus("idle");
	}, [isThinking, setAiStatus]);

	// ─── Quick actions: the edits cinematic-vlog creators reach for most.
	// `fill` chips only pre-fill the input (they need a detail from the user).
	const quickActions: Array<{ label: string; prompt: string; fill?: boolean }> =
		[
			{
				label: "🎬 Auto Montage",
				prompt:
					"Cut the main video into distinct scenes, keep only the scenic shots, ripple the remaining clips together, apply a cinematic grade, mute the video audio, add music, trim the music to the section before the vocals, then shrink the clips to fit the music on the beat.",
			},
			{
				label: "🎨 Grade + Letterbox",
				prompt:
					"Apply a cinematic color grade to every clip, then add a 2.39 letterbox and a subtle vignette to all clips.",
			},
			{
				label: "🎵 Beat-Sync Music",
				prompt:
					"Add music to the timeline, trim it to the section before the vocals, then shrink the video clips to fit the music length with cuts on the beat.",
			},
			{
				label: "🐢 Slow-motion 0.5x",
				prompt: "Slow every video clip to 0.5x with an ease_in_out speed ramp.",
			},
			{
				label: "🪞 Mimic Style from…",
				prompt: "Mimic the editing style from the video ",
				fill: true,
			},
			{
				label: "✂ Cut Scenes + Keep Scenery",
				prompt:
					"Cut the main video into separate scenes, delete every shot that is not scenery, then ripple the remaining clips together.",
			},
		];

	// ─── Submit handler ───────────────────────────────
	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = input.trim();
		if (!trimmed) return;

		// A typed reply while the agent is asking a question answers it instead
		// of starting a new run.
		if (pendingAsk) {
			setInput("");
			answerAsk(trimmed);
			return;
		}

		if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
			setInput("");
			await downloadAndAddAsset(trimmed);
			return;
		}

		if (isThinking) stopGeneration();
		await sendPrompt(trimmed);
	};

	const sendPrompt = async (userPrompt: string) => {
		setInput("");
		setIsThinking(true);
		setAiStatus("running", "Starting…");
		setCurrentThought("");
		setIsThoughtOpen(false);

		const newUserMsg: Message = {
			id: crypto.randomUUID(),
			role: "user",
			content: userPrompt,
		};
		setMessages((prev) => [...prev, newUserMsg]);

		// ─── Agentic path: the local model orchestrates editing tools itself ──
		let toolsExecuted = 0;
		try {
			const { runEditingAgent } = await import("@/lib/ai/agent");
			const controller = new AbortController();
			abortRef.current = controller;

			// Checkpoint the undo stack so the whole run can be reverted as one —
			// the AI never owns the user's timeline, it only proposes on top of it.
			const startDepth = editor.command.depth?.() ?? 0;

			let agentUsage: { input: number; output: number } | undefined;
			const summary = await runEditingAgent({
				editor,
				goal: userPrompt,
				provider: aiCfg.provider,
				model: aiCfg.provider === "ollama" ? localModel : aiCfg.model,
				apiKey: aiCfg.apiKey || undefined,
				localModel,
				signal: controller.signal,
				onAskUser: (question, options) =>
					new Promise<string>((resolve) => {
						askResolveRef.current = resolve;
						setPendingAsk({ question, options });
						setAiStatus("running", "Waiting for your answer");
					}),
				onEvent: (ev) => {
					if (ev.usage) agentUsage = ev.usage;
					if (ev.type === "tool" && ev.tool !== "retry") toolsExecuted++;
					if (ev.type === "tool") {
						setAiStatus("running", ev.tool);
						setCurrentThought(`${ev.tool}: ${ev.result ?? ""}`);
						setMessages((prev) => [
							...prev,
							{
								id: crypto.randomUUID(),
								role: "system",
								content: `🔧 ${ev.tool}(${
									ev.args && Object.keys(ev.args).length
										? Object.values(ev.args)
												.map((v) => String(v))
												.join(", ")
										: ""
								}) → ${ev.result ?? ""}`,
							},
						]);
					}
				},
			});

			const usageLine = agentUsage
				? `\n\n📊 Tokens: ${agentUsage.input.toLocaleString()} in / ${agentUsage.output.toLocaleString()} out (total ${(agentUsage.input + agentUsage.output).toLocaleString()})`
				: "";
			// Everything the agent executed sits above the checkpoint — surface it
			// as a review state with one-click "Undo all" instead of a fait accompli.
			const editsMade = Math.max(
				0,
				(editor.command.depth?.() ?? startDepth) - startDepth,
			);
			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "assistant",
					content: (summary || "Done.") + usageLine,
					status: editsMade > 0 ? "review" : "applied",
					undoDepth: editsMade,
				},
			]);
			clearGhostState();
			return;
		} catch (agentErr: any) {
			// Never leave a stale question card behind a failed/aborted run.
			askResolveRef.current = null;
			setPendingAsk(null);
			if (agentErr?.name === "AbortError") {
				setMessages((prev) => [
					...prev,
					{
						id: crypto.randomUUID(),
						role: "system",
						content: "Generation stopped.",
					},
				]);
				return;
			}
			console.error("Agent error:", agentErr);
			// If the agent already executed tools, the timeline is mid-edit —
			// falling back to the legacy single-shot path would double-apply or
			// corrupt state. Report honestly and stop; retry continues from here.
			if (toolsExecuted > 0) {
				setMessages((prev) => [
					...prev,
					{
						id: crypto.randomUUID(),
						role: "system",
						content: `⚠️ Agent stopped after ${toolsExecuted} step(s): ${agentErr?.message ?? agentErr}. The completed steps are kept — resend the request to continue with the rest.`,
					},
				]);
				return;
			}
			// No tools ran — safe to fall through to the legacy single-shot path,
			// but say so: a silent fallback looks like the agent ignoring the user.
			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "system",
					content: `⚠️ Agent mode failed (${agentErr?.message ?? agentErr}) — answering via quick chat instead. Tool-based editing is unavailable for this reply.`,
				},
			]);
			abortRef.current = null;
			setIsThinking(false);
			setCurrentThought("");
		}

		setIsThinking(true);
		try {
			const timelineState = buildTimelineSnapshot(editor);
			const colorStats = getCanvasColorStats();
			let sceneMap: string | undefined;
			const assets = editor.media.getAssets();
			if (assets && assets.length > 0) {
				const firstAsset = assets[0];
				const cachedSceneMap = getCachedSceneMap(firstAsset.id);
				if (cachedSceneMap) {
					sceneMap = formatSceneMapForPrompt(cachedSceneMap, firstAsset.name);
				}
			}

			const API_URL =
				process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
			const controller = new AbortController();
			abortRef.current = controller;
			const response = await fetch(`${API_URL}/api/ai/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					prompt: userPrompt,
					project_id: activeProject?.metadata.id || "default",
					mode: aiMode,
					local_model: localModel,
					timeline_state: timelineState,
					color_stats: colorStats,
					scene_map: sceneMap,
				}),
			});

			if (!response.ok) throw new Error("Backend unreachable");

			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let done = false;
			let assistantReply = "";
			let assistantThought = "";
			let inThoughtTag = false;
			let buffer = "";

			while (!done && reader) {
				const { value, done: readerDone } = await reader.read();
				done = readerDone;
				if (value) {
					buffer += decoder.decode(value, { stream: !done });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const parsed = JSON.parse(line);
							const content = parsed.message?.content || "";

							let i = 0;
							while (i < content.length) {
								if (content.slice(i, i + 9) === "<thought>") {
									inThoughtTag = true;
									setIsThoughtOpen(true);
									i += 9;
									continue;
								}
								if (content.slice(i, i + 10) === "</thought>") {
									inThoughtTag = false;
									i += 10;
									continue;
								}
								if (inThoughtTag) {
									assistantThought += content[i];
									setCurrentThought(assistantThought);
								} else {
									assistantReply += content[i];
								}
								i++;
							}

							// Throttle Zustand state updates
							const partialOps = parsePartialOperations(assistantReply);
							if (partialOps.length > 0) {
								const now = Date.now();
								if (now - lastUpdateRef.current > 100) {
									// Pass live tracks so ghost previews anchor to the real clips
									setGhostStateFromStream(
										partialOps,
										editor.timeline.getTracks(),
									);
									lastUpdateRef.current = now;
								}
							}
						} catch (e) {
							console.warn("Failed to parse stream line:", line, e);
						}
					}
				}
			}

			// Final unthrottled parsing pass
			assistantReply = assistantReply
				.replace(/<thought>[\s\S]*?<\/thought>/g, "")
				.replace(/<\/?thought>/g, "")
				.trim();

			// Extraction ladder: fenced JSON → balanced-brace scan → partial-op
			// recovery. The old single-regex approach silently produced 0 ops on
			// truncated/unfenced output, which then surfaced as a fake success.
			const extractOps = (text: string): any[] => {
				const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
				if (fence) {
					try {
						const parsed = JSON.parse(fence[1].trim());
						if (Array.isArray(parsed.operations)) return parsed.operations;
					} catch (_) {}
				}
				const keyIdx = text.indexOf('"operations"');
				if (keyIdx !== -1) {
					const start = text.lastIndexOf("{", keyIdx);
					if (start !== -1) {
						let depth = 0;
						let inStr = false;
						let esc = false;
						for (let i = start; i < text.length; i++) {
							const ch = text[i];
							if (inStr) {
								if (esc) esc = false;
								else if (ch === "\\") esc = true;
								else if (ch === '"') inStr = false;
								continue;
							}
							if (ch === '"') inStr = true;
							else if (ch === "{") depth++;
							else if (ch === "}") {
								depth--;
								if (depth === 0) {
									try {
										const parsed = JSON.parse(text.slice(start, i + 1));
										if (Array.isArray(parsed.operations))
											return parsed.operations;
									} catch (_) {}
									break;
								}
							}
						}
					}
				}
				// Truncated JSON (stream cut / token limit): salvage complete ops
				return parsePartialOperations(text);
			};

			let ops: any[] = extractOps(assistantReply);
			let opsFromThought = false;
			if (ops.length === 0 && assistantThought) {
				// Some models leave the JSON inside their <thought> block
				ops = extractOps(assistantThought);
				opsFromThought = ops.length > 0;
			}

			// auto_scene_cut is expanded programmatically from the cached scene
			// map (split all scenes + keep-scenery + grade + mute) — it can't go
			// through the normal per-op compiler.
			const sceneCutOp = ops.find((o) => o.action === "auto_scene_cut");
			if (sceneCutOp) {
				clearGhostState();
				const result = await applyAutoSceneCut(sceneCutOp);
				setMessages((prev) => [
					...prev,
					{
						id: crypto.randomUUID(),
						role: "assistant",
						content: result.applied
							? `🎬 Auto scene-cut applied: ${result.summary}.`
							: `⚠️ Could not run auto scene-cut: ${result.summary}.`,
						status: result.applied ? "applied" : "discarded",
					},
				]);
				if (result.applied) toast.success("Scene cut applied!");
				return;
			}

			setGhostStateFromStream(ops, editor.timeline.getTracks());

			// Run Dry-Run validation (preview only — re-validated again at Accept-time)
			let dryRunResult: { success: boolean; error?: string; fixes?: string[] } =
				{ success: true };
			if (ops.length > 0) {
				const { dryRunActions } = await import("@/lib/ai/compiler");
				dryRunResult = dryRunActions(ops, editor, { strict: true });
			}

			const cleanTextDisplay = assistantReply
				.replace(/```(?:json)?\s*[\s\S]*?```/g, "")
				.replace(/\{[\s\S]*"operations"[\s\S]*\}/g, "")
				.trim();

			let autoApplied = false;
			if (ops.length > 0 && dryRunResult.success) {
				const { validateOperations } = await import("@/lib/ai/compiler");
				const { BatchCommand } = await import("@/lib/commands/batch-command");

				const validations = validateOperations(ops, editor);
				const validOps = validations.filter((v) => v.ok).map((v) => v.op);

				if (validOps.length > 0) {
					const { dryRunActions } = await import("@/lib/ai/compiler");
					const dry = dryRunActions(validOps, editor, { strict: true });
					if (dry.success && dry.commands && dry.commands.length > 0) {
						editor.command.execute({ command: new BatchCommand(dry.commands) });
						autoApplied = true;

						const activeProj = editor.project.getActive();
						if (activeProj) {
							for (const op of validOps) {
								void storageService.applyDelta(activeProj.metadata.id, {
									type: op.action,
									payload: op,
								});
							}
						}
					}
				}
			}

			if (autoApplied) {
				clearGhostState();
			}

			// Honest status: never claim success when nothing was produced.
			let content = cleanTextDisplay;
			if (!content) {
				content =
					ops.length > 0
						? `Autonomously applied ${ops.length} edit operation${ops.length > 1 ? "s" : ""} directly to the timeline.`
						: "⚠️ No edit operations could be generated from this request — nothing was changed. Try being more specific (mention clip names, tracks, or timestamps).";
			} else if (ops.length > 0 && dryRunResult.success) {
				content += `\n\n✓ Autonomously applied ${ops.length} edit operation${ops.length > 1 ? "s" : ""} directly to the timeline.`;
			}

			if (opsFromThought) {
				content += "\n(operations were recovered from the model's reasoning)";
			}

			const newAiMsg: Message = {
				id: crypto.randomUUID(),
				role: "assistant",
				content,
				thought: assistantThought || undefined,
				operations: ops.length > 0 ? ops : undefined,
				status:
					ops.length > 0
						? dryRunResult.success
							? "applied"
							: "discarded"
						: undefined,
			};

			if (ops.length > 0 && !dryRunResult.success) {
				newAiMsg.content += `\n\n⚠️ Dry-Run Failure: ${dryRunResult.error}`;
			}

			setMessages((prev) => [...prev, newAiMsg]);
		} catch (error: any) {
			if (error?.name === "AbortError") {
				clearGhostState();
				setMessages((prev) => [
					...prev,
					{
						id: crypto.randomUUID(),
						role: "system",
						content: "Generation stopped.",
					},
				]);
			} else {
				console.error("AI Error:", error);
				setMessages((prev) => [
					...prev,
					{
						id: crypto.randomUUID(),
						role: "system",
						content:
							"Failed to connect to backend. Please ensure local services are running.",
					},
				]);
			}
		} finally {
			abortRef.current = null;
			setIsThinking(false);
			setCurrentThought("");
		}
	};

	// ─── Render ───────────────────────────────────────

	return (
		<div
			className={`flex h-full flex-col bg-card select-none font-mono transition-colors duration-200 ${isDraggingLink ? "bg-agent/10 border border-dashed border-agent/50" : ""}`}
			onDragOver={(e) => {
				e.preventDefault();
				setIsDraggingLink(true);
			}}
			onDragLeave={() => {
				setIsDraggingLink(false);
			}}
			onDrop={async (e) => {
				e.preventDefault();
				setIsDraggingLink(false);
				const text = e.dataTransfer.getData("text");
				if (
					text &&
					(text.startsWith("http://") || text.startsWith("https://"))
				) {
					await downloadAndAddAsset(text.trim());
				}
			}}
		>
			{/* ── Header ── */}
			<div className="flex items-center justify-between border-b border-border/60 px-3 py-2 shrink-0">
				<div className="flex items-center gap-2">
					<div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-agent to-agent/60">
						<Sparkles className="size-3.5 text-white" />
					</div>
					<div className="flex flex-col leading-tight font-sans">
						<span className="text-[11px] font-semibold text-foreground">
							ChronoX AI
						</span>
						<span className="flex items-center gap-1 text-[9px] text-muted-foreground">
							<span
								className={`size-1.5 rounded-full ${backendConnected ? "bg-constructive" : "bg-muted-foreground/50"}`}
							/>
							{backendConnected ? "Agent mode" : "Offline"}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={() => setShowProviderPanel(!showProviderPanel)}
						className={`text-[9px] px-2 py-0.5 rounded border bg-card cursor-pointer font-sans select-none transition-colors ${
							showProviderPanel
								? "border-primary/50 text-primary"
								: "border-border hover:border-border text-muted-foreground hover:text-foreground"
						}`}
						title="AI Provider — paste an API key to use a cloud model"
					>
						{PROVIDER_LABELS[aiCfg.provider] ?? aiCfg.provider} ·{" "}
						{aiCfg.provider === "ollama" ? localModel : aiCfg.model}
					</button>
					<button
						type="button"
						onClick={() => setShowMimicDropdown(!showMimicDropdown)}
						className={`p-1 rounded border border-border hover:border-border bg-card text-muted-foreground hover:text-agent transition-colors cursor-pointer select-none ${showMimicDropdown ? "text-agent border-agent/50" : ""}`}
						title="Mimic Reference Video Style Preset"
					>
						<Sparkles className="size-3" />
					</button>
					<button
						type="button"
						onClick={() => {
							if (activeProject?.metadata.id) {
								storageService.saveChatHistory(activeProject.metadata.id, []);
							}
							setMessages([
								{
									id: "welcome",
									role: "system",
									content:
										"ChronoX AI is ready. Send a command to start editing.",
								},
							]);
							clearGhostState();
							toast.success("Chat history cleared");
						}}
						className="p-1 rounded border border-border hover:border-border bg-card text-muted-foreground hover:text-destructive transition-colors cursor-pointer select-none"
						title="Clear Chat History"
					>
						<Trash2 className="size-3" />
					</button>
					{isThinking && (
						<Loader2 className="size-3 animate-spin text-muted-foreground" />
					)}
				</div>
			</div>

			{showProviderPanel && (
				<div className="bg-card border-b border-border p-2 text-[10px] space-y-2 shrink-0">
					<div className="flex items-center justify-between">
						<div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">
							AI Provider
						</div>
						{aiCfg.provider !== "ollama" && aiCfg.apiKey && (
							<span className="flex items-center gap-1 text-[9px] text-constructive">
								<span className="size-1.5 rounded-full bg-constructive" />
								Connected · key {aiCfg.apiKey.slice(0, 4)}…
								{aiCfg.apiKey.slice(-4)} (saved)
							</span>
						)}
					</div>
					<div className="flex gap-1.5">
						<input
							type="password"
							value={providerKeyInput}
							onChange={(e) => setProviderKeyInput(e.target.value)}
							onKeyDown={(e) => {
								if (
									e.key === "Enter" &&
									providerKeyInput.trim() &&
									!providerBusy
								)
									connectProviderKey(providerKeyInput);
							}}
							placeholder={
								aiCfg.apiKey
									? "Paste a new key to replace the saved one…"
									: "Paste API key (Gemini / OpenAI / Claude / Grok)…"
							}
							className="flex-1 bg-background border border-border rounded px-2 py-1 text-[10px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-primary/50"
						/>
						<button
							type="button"
							disabled={providerBusy || !providerKeyInput.trim()}
							onClick={() => connectProviderKey(providerKeyInput)}
							className="px-2 py-1 rounded border border-primary bg-primary/10 text-primary disabled:opacity-40 hover:bg-primary/20 transition-colors cursor-pointer"
						>
							{providerBusy ? "…" : "Connect"}
						</button>
					</div>
					{aiCfg.provider !== "ollama" && aiCfg.models.length > 0 && (
						<div className="flex items-center gap-1.5">
							<span className="text-muted-foreground shrink-0">
								{PROVIDER_LABELS[aiCfg.provider] ?? aiCfg.provider} · model:
							</span>
							<select
								value={aiCfg.model}
								onChange={(e) => saveAiCfg({ ...aiCfg, model: e.target.value })}
								className="flex-1 bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground focus:outline-none focus:border-primary/50 cursor-pointer"
							>
								{aiCfg.models.map((m) => (
									<option key={m} value={m}>
										{m}
									</option>
								))}
							</select>
							<button
								type="button"
								onClick={() => {
									saveAiCfg({
										provider: "ollama",
										model: localModel,
										apiKey: "",
										models: [],
									});
									toast.success("Switched to local AI (Ollama)");
								}}
								className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive transition-colors cursor-pointer shrink-0"
								title="Clear the key and return to local AI"
							>
								Local
							</button>
						</div>
					)}
					{aiCfg.provider === "ollama" && (
						<div className="flex items-center gap-1.5">
							<span className="text-muted-foreground shrink-0">
								Local · model:
							</span>
							<button
								type="button"
								onClick={() =>
									setLocalModel(
										localModel === "qwen3.5:9b" ? "gemma4:12b" : "qwen3.5:9b",
									)
								}
								className="px-2 py-1 rounded border border-border bg-background text-foreground hover:border-border transition-colors cursor-pointer"
							>
								{localModel === "qwen3.5:9b"
									? "Qwen 3.5 (9B)"
									: "Gemma 4 (12B)"}
							</button>
							<span className="text-muted-foreground/60 italic">
								Paste a key above to use a more powerful cloud model
							</span>
						</div>
					)}
				</div>
			)}

			{showMimicDropdown && (
				<div className="bg-card border-b border-border p-2 text-[10px] space-y-1.5 shrink-0 max-h-36 overflow-y-auto">
					<div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">
						Select Style Reference Video:
					</div>
					{mediaFiles.filter((m) => m.type === "video").length === 0 ? (
						<div className="text-muted-foreground/60 italic text-center py-1">
							No video assets found. Drag a video link or upload files first.
						</div>
					) : (
						<div className="grid gap-1">
							{mediaFiles
								.filter((m) => m.type === "video")
								.map((asset) => (
									<button
										key={asset.id}
										onClick={() => handleMimicAsset(asset.id)}
										className="text-left px-2 py-1.5 rounded bg-background border border-border/80 hover:border-agent/60 hover:text-agent transition-all truncate cursor-pointer"
									>
										🎬 {asset.name}
									</button>
								))}
						</div>
					)}
				</div>
			)}

			{/* ── Messages ── */}
			<ScrollArea ref={scrollRef} className="flex-1 min-h-0">
				<div className="p-2.5 space-y-2.5">
					{messages.length === 0 && !isThinking && (
						<div className="text-center py-8">
							<p className="text-[10px] text-muted-foreground/70 mb-3">
								Add video to timeline then send commands
							</p>
						</div>
					)}

					{messages.map((msg) => (
						<div key={msg.id}>
							{/* System */}
							{msg.role === "system" && (
								<div className="flex items-start gap-1.5 py-0.5">
									<CircleDot className="size-2.5 mt-0.5 text-muted-foreground/70 shrink-0" />
									<p className="text-[10px] text-muted-foreground/70 leading-relaxed">
										{msg.content}
									</p>
								</div>
							)}

							{/* User */}
							{msg.role === "user" && (
								<div className="flex justify-end">
									<div className="max-w-[85%] rounded-md rounded-br-none bg-accent border border-border px-2.5 py-1.5 text-[11px] text-foreground leading-relaxed">
										{msg.content}
									</div>
								</div>
							)}

							{/* Assistant */}
							{msg.role === "assistant" && (
								<div className="space-y-1">
									{/* Thought */}
									{msg.thought && (
										<>
											<button
												onClick={() => setIsThoughtOpen(!isThoughtOpen)}
												className="flex items-center gap-1 text-[9px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
											>
												<Eye className="size-2.5" />
												<span>reasoning</span>
												{isThoughtOpen ? (
													<ChevronUp className="size-2.5" />
												) : (
													<ChevronDown className="size-2.5" />
												)}
											</button>
											{isThoughtOpen && (
												<div className="rounded bg-card/50 border border-border/40 px-2 py-1.5 text-[9px] text-muted-foreground/70 italic leading-relaxed whitespace-pre-line max-h-24 overflow-y-auto">
													{msg.thought}
												</div>
											)}
										</>
									)}

									{/* Reply */}
									<div className="flex items-start gap-1.5">
										<div className="flex size-4 shrink-0 items-center justify-center rounded bg-agent/15 mt-0.5">
											<Bot className="size-2.5 text-agent" />
										</div>
										<div className="rounded-md rounded-bl-none bg-card/80 border border-border/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground max-w-[90%]">
											{msg.content}
										</div>
									</div>

									{/* Agent-run review: no op checklist, but real edits above the
									    checkpoint — offer keep / one-click revert of the whole run */}
									{(!msg.operations || msg.operations.length === 0) &&
										msg.status === "review" &&
										(msg.undoDepth ?? 0) > 0 && (
											<div className="ml-5 flex gap-1.5 pt-1 max-w-[90%]">
												<button
													type="button"
													onClick={() => {
														setMessages((prev) =>
															prev.map((m) =>
																m.id === msg.id
																	? { ...m, status: "applied" }
																	: m,
															),
														);
														toast.success("AI edits kept.");
													}}
													className="flex-1 py-1 h-6 rounded-md bg-constructive/15 hover:bg-constructive/25 border border-constructive/40 text-[9px] text-constructive gap-1 flex items-center justify-center cursor-pointer select-none font-semibold transition-colors"
												>
													<Check className="size-2.5" />
													<span>Keep AI edits</span>
												</button>
												<button
													type="button"
													onClick={() => {
														const depth = msg.undoDepth ?? 0;
														for (let i = 0; i < depth; i++) {
															editor.command.undo();
														}
														setMessages((prev) =>
															prev.map((m) =>
																m.id === msg.id
																	? { ...m, status: "discarded" }
																	: m,
															),
														);
														toast.info(
															`Reverted ${depth} AI edit${depth > 1 ? "s" : ""}.`,
														);
													}}
													className="py-1 h-6 px-2.5 rounded bg-card hover:bg-accent border border-border text-[9px] text-muted-foreground gap-1 flex items-center justify-center cursor-pointer select-none transition-colors"
												>
													<X className="size-2.5" />
													<span>Revert all ({msg.undoDepth})</span>
												</button>
											</div>
										)}

									{/* Proposed Checklist */}
									{msg.operations && msg.operations.length > 0 && (
										<div className="ml-5 mt-2 p-2.5 rounded-lg bg-agent/[0.05] border border-agent/25 max-w-[90%] space-y-2.5 select-none">
											<div className="flex items-center gap-1.5 text-[9px] font-bold text-agent uppercase tracking-wider">
												<Sparkles className="size-2.5" />
												Edit plan · {msg.operations.length} step
												{msg.operations.length > 1 ? "s" : ""}
											</div>
											{(!msg.applySteps || msg.status === "pending") && (
												<div className="space-y-1.5">
													{activeOperations.map((op) => {
														const meta = ACTION_META[op.type] || {
															icon: Scissors,
															label: op.type,
															color: "text-muted-foreground",
														};
														const Icon = meta.icon;
														return (
															<label
																key={op.id}
																className="flex items-center gap-2 cursor-pointer text-[10px] text-foreground py-0.5 hover:bg-accent/50 rounded px-1"
															>
																<input
																	type="checkbox"
																	disabled={msg.status !== "pending"}
																	checked={op.enabled}
																	onChange={(e) =>
																		toggleOperation(op.id, e.target.checked)
																	}
																	className="size-3 rounded border-border bg-card text-agent focus:ring-0 cursor-pointer disabled:opacity-50"
																/>
																<Icon
																	className={`size-3 shrink-0 ${meta.color}`}
																/>
																<span className="flex-1 truncate">
																	{op.label}
																</span>
															</label>
														);
													})}
												</div>
											)}

											{msg.applySteps && msg.status !== "pending" && (
												<div className="space-y-1.5">
													{msg.applySteps.map((step: ApplyStep) => (
														<div
															key={step.id}
															className="flex items-center gap-2 text-[10px] py-0.5 px-1"
														>
															{step.state === "done" && (
																<CheckCircle2 className="size-3 shrink-0 text-constructive" />
															)}
															{step.state === "running" && (
																<Loader2 className="size-3 shrink-0 text-agent animate-spin" />
															)}
															{step.state === "pending" && (
																<CircleDot className="size-3 shrink-0 text-muted-foreground/40" />
															)}
															{step.state === "failed" && (
																<X className="size-3 shrink-0 text-destructive/80" />
															)}
															<span
																className={`flex-1 truncate ${
																	step.state === "done"
																		? "text-muted-foreground line-through"
																		: step.state === "running"
																			? "text-agent font-medium"
																			: step.state === "failed"
																				? "text-destructive/80"
																				: "text-muted-foreground/60"
																}`}
															>
																{step.label}
															</span>
														</div>
													))}
												</div>
											)}

											{msg.status === "applying" &&
												msg.applySteps &&
												(() => {
													const settled = msg.applySteps.filter(
														(st: ApplyStep) =>
															st.state === "done" || st.state === "failed",
													).length;
													const total = msg.applySteps.length;
													const pct = Math.round((settled / total) * 100);
													return (
														<div className="space-y-1 pt-0.5">
															<div className="relative h-1 overflow-hidden rounded-full bg-agent-muted/60">
																<div
																	className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-agent/60 to-agent transition-all duration-300"
																	style={{ width: `${pct}%` }}
																/>
															</div>
															<div className="flex items-center justify-between text-[9px]">
																<span className="text-muted-foreground">
																	Applying {Math.min(settled + 1, total)} of{" "}
																	{total}
																</span>
																<span className="font-mono text-agent">
																	{pct}%
																</span>
															</div>
														</div>
													);
												})()}

											{msg.status === "review" && (
												<div className="flex gap-1.5 pt-1">
													<button
														type="button"
														onClick={() => {
															setMessages((prev) =>
																prev.map((m) =>
																	m.id === msg.id
																		? { ...m, status: "applied" }
																		: m,
																),
															);
															toast.success("Edits kept.");
														}}
														className="flex-1 py-1 h-6 rounded-md bg-constructive/15 hover:bg-constructive/25 border border-constructive/40 text-[9px] text-constructive gap-1 flex items-center justify-center cursor-pointer select-none font-semibold transition-colors"
													>
														<Check className="size-2.5" />
														<span>Keep all</span>
													</button>
													<button
														type="button"
														onClick={() => {
															const depth = msg.undoDepth ?? 0;
															for (let i = 0; i < depth; i++) {
																editor.command.undo();
															}
															setMessages((prev) =>
																prev.map((m) =>
																	m.id === msg.id
																		? { ...m, status: "discarded" }
																		: m,
																),
															);
															toast.info(
																depth > 0
																	? `Undid ${depth} step${depth > 1 ? "s" : ""}.`
																	: "Nothing to undo.",
															);
														}}
														className="py-1 h-6 px-2.5 rounded bg-card hover:bg-accent border border-border text-[9px] text-muted-foreground gap-1 flex items-center justify-center cursor-pointer select-none transition-colors"
													>
														<X className="size-2.5" />
														<span>Undo all</span>
													</button>
												</div>
											)}

											{msg.status === "pending" && (
												<div className="flex gap-1.5 pt-1">
													<button
														type="button"
														onClick={() => void applyPlanSequentially(msg.id)}
														className="flex-1 py-1 h-6 rounded-md bg-constructive/15 hover:bg-constructive/25 border border-constructive/40 text-[9px] text-constructive gap-1 flex items-center justify-center cursor-pointer select-none font-semibold transition-colors"
													>
														<Check className="size-2.5" />
														<span>Apply plan</span>
													</button>
													<button
														type="button"
														onClick={() => {
															setMessages((prev) =>
																prev.map((m) =>
																	m.id === msg.id
																		? { ...m, status: "discarded" }
																		: m,
																),
															);
															clearGhostState();
															toast.info("Proposed actions discarded.");
														}}
														className="py-1 h-6 px-2.5 rounded bg-card hover:bg-accent border border-border text-[9px] text-muted-foreground gap-1 flex items-center justify-center cursor-pointer select-none transition-colors"
													>
														<X className="size-2.5" />
														<span>Discard</span>
													</button>
												</div>
											)}

											{msg.status === "applied" && (
												<div className="text-[9px] text-constructive flex items-center gap-1 font-semibold pt-0.5">
													<CheckCircle2 className="size-3" />
													<span>Successfully applied</span>
												</div>
											)}

											{msg.status === "discarded" && (
												<div className="text-[9px] text-muted-foreground/60 flex items-center gap-1 italic pt-0.5">
													<X className="size-3" />
													<span>Discarded</span>
												</div>
											)}
										</div>
									)}
								</div>
							)}
						</div>
					))}

					{/* Agent question — the run is paused on the user's answer */}
					{pendingAsk && (
						<div className="ml-5 p-2.5 rounded-lg bg-agent/[0.07] border border-agent/30 space-y-2 max-w-[90%]">
							<div className="flex items-center gap-1.5 text-[9px] font-bold text-agent uppercase tracking-wider">
								<Sparkles className="size-2.5" />
								The AI needs your input
							</div>
							<p className="text-[11px] text-foreground leading-relaxed">
								{pendingAsk.question}
							</p>
							{pendingAsk.options.length > 0 && (
								<div className="flex flex-wrap gap-1">
									{pendingAsk.options.map((opt) => (
										<button
											key={opt}
											type="button"
											onClick={() => answerAsk(opt)}
											className="text-[10px] px-2 py-1 rounded-full border border-agent/30 bg-agent/10 hover:bg-agent/20 text-agent transition-colors cursor-pointer"
										>
											{opt}
										</button>
									))}
								</div>
							)}
							<p className="text-[9px] text-muted-foreground/60">
								…or type your own answer below
							</p>
						</div>
					)}

					{/* Thinking */}
					{isThinking && !pendingAsk && (
						<div className="space-y-1">
							{currentThought && (
								<div className="rounded bg-card/50 border border-border/40 px-2 py-1.5 text-[9px] text-muted-foreground/70 italic leading-relaxed whitespace-pre-line max-h-20 overflow-y-auto">
									{currentThought}
								</div>
							)}
							<div className="flex items-start gap-1.5">
								<div className="flex size-4 shrink-0 items-center justify-center rounded bg-agent/15 mt-0.5">
									<Bot className="size-2.5 text-agent" />
								</div>
								<div className="rounded-md rounded-bl-none bg-card/80 border border-border/40 px-2.5 py-2">
									<div className="flex gap-1">
										<span className="size-1 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
										<span className="size-1 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
										<span className="size-1 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
			</ScrollArea>

			{/* ── Quick actions ── */}
			{messages.length === 0 && !isThinking && (
				<div className="px-2 pb-1.5">
					<div className="text-[8px] uppercase tracking-wider text-muted-foreground/50 mb-1 px-0.5">
						Cinematic vlog — quick actions
					</div>
					<div className="grid grid-cols-2 gap-1">
						{quickActions.map((qa) => (
							<button
								key={qa.label}
								title={qa.prompt}
								onClick={() => {
									if (qa.fill) {
										setInput(qa.prompt);
										inputRef.current?.focus();
									} else {
										sendPrompt(qa.prompt);
									}
								}}
								className="text-[9px] text-left text-agent/90 hover:text-agent px-2 py-1 rounded-full border border-agent/20 bg-agent/[0.06] hover:bg-agent/15 transition-all cursor-pointer"
							>
								{qa.label}
							</button>
						))}
					</div>
				</div>
			)}

			{/* ── Input ── */}
			<form
				onSubmit={handleSubmit}
				className="border-t border-border/60 p-1.5 shrink-0"
			>
				<div className="flex gap-1">
					<input
						ref={inputRef}
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder={
							pendingAsk
								? "type your answer…"
								: isThinking
									? "AI is generating — type to queue a new command..."
									: "send command..."
						}
						className="flex-1 rounded bg-card/80 border border-border/50 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-border transition-colors font-mono"
					/>
					{isThinking && (
						<Button
							type="button"
							size="icon"
							onClick={stopGeneration}
							title="Stop generation"
							className="size-7 rounded bg-destructive/15 hover:bg-destructive/20 text-destructive border border-destructive/40"
						>
							<X className="size-3" />
						</Button>
					)}
					<Button
						type="submit"
						size="icon"
						disabled={!input.trim()}
						className="size-7 rounded-lg bg-gradient-to-br from-agent to-agent/70 hover:opacity-90 text-white border-0 disabled:opacity-20"
					>
						<Send className="size-3" />
					</Button>
				</div>
			</form>
		</div>
	);
}
