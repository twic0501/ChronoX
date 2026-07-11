"use client";

import { useState, useEffect } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useMimicStore } from "@/stores/mimic-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { useEditorStore } from "@/stores/editor-store";
import { toast } from "sonner";
import { buildTimelineSnapshot } from "../chat-sidebar";
import {
	listStyles,
	saveStyle,
	deleteStyle,
	type SavedStyle,
	listStyleCards,
	saveStyleCard,
	deleteStyleCard,
	type StyleCard,
} from "@/lib/ai/style-library";
import {
	listSources,
	saveSource,
	deleteSource,
	toggleSelectSource,
	clearSources,
	type SourceItem,
} from "@/lib/ai/source-hub";
import { applySavedStyle } from "@/lib/ai/style-apply";
import {
	Film,
	Music,
	Settings2,
	Sparkles,
	Check,
	X,
	UploadCloud,
	Video,
	Activity,
	Library,
	Trash2,
	Save,
	Wand2,
	Palette,
	Zap,
	Clock,
	Youtube,
	FileText,
	ChevronDown,
	ChevronUp,
	BookOpen,
	Plus,
	CheckSquare,
	Square,
	Search,
	Eye,
} from "lucide-react";

export function MimicTab() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const tracks = useEditor((e) => e.timeline.getTracks());
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const ghostClips = useEditorStore((s) => s.ghostClips);

	// Tab switcher: "presets" (new modular cards path) vs "source" (original video analysis path)
	const [activeTab, setActiveTab] = useState<"presets" | "source">("presets");

	// --- 1. Sources & NotebookLM States ---
	const [sources, setSources] = useState<SourceItem[]>([]);
	const [newUrl, setNewUrl] = useState("");
	const [newTextName, setNewTextName] = useState("");
	const [newTextContent, setNewTextContent] = useState("");
	const [isAddingSource, setIsAddingSource] = useState(false);
	const [showAddTextModal, setShowAddTextModal] = useState(false);

	// --- 2. Custom Presets & Synthesis States ---
	const [synthesisPrompt, setSynthesisPrompt] = useState("");
	const [isSynthesizing, setIsSynthesizing] = useState(false);
	const [synthesisExplanation, setSynthesisExplanation] = useState("");
	const [extractedCards, setExtractedCards] = useState<StyleCard[]>([]);
	const [savedCards, setSavedCards] = useState<StyleCard[]>([]);
	
	const [expandedCardIds, setExpandedCardIds] = useState<Record<string, boolean>>({});
	const [cardRecipes, setCardRecipes] = useState<Record<string, string>>({});
	const [cardNames, setCardNames] = useState<Record<string, string>>({});
	const [cardTargetTypes, setCardTargetTypes] = useState<Record<string, "timeline" | "selected" | "range">>({});
	const [cardCustomRanges, setCardCustomRanges] = useState<Record<string, { start: string; end: string }>>({});
	const [applyingCardId, setApplyingCardId] = useState<string | null>(null);

	// Load stored sources & saved presets on mount
	useEffect(() => {
		setSources(listSources());
		setSavedCards(listStyleCards());
	}, []);

	// --- 3. Original Upload & Mimic States ---
	const {
		referenceFile,
		isUploading,
		isProcessing,
		uploadProgress,
		targetDuration,
		selectedAudioId,
		snappedCuts,
		mimicStats,
		lastAnalysis,
		styleName,
		applyIntensity,
		set: setMimic,
		setReferenceFile,
		clearProposal,
	} = useMimicStore();

	const [styles, setStyles] = useState<SavedStyle[]>(() => listStyles());
	const [applyingStyleId, setApplyingStyleId] = useState<string | null>(null);

	// Get all audio elements in the project
	const audioElements = tracks
		.filter((t) => t.type === "audio")
		.flatMap((t) => t.elements);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) setReferenceFile(file);
	};

	const acceptCuts = () => {
		toast.success("Applied cutting tempo to timeline.");
		clearProposal();
		useEditorStore.getState().setGhostClips([]);
	};

	const discardCuts = () => {
		clearProposal();
		useEditorStore.getState().setGhostClips([]);
	};

	const handleSaveStyle = () => {
		if (!lastAnalysis) return;
		const name = styleName.trim() || lastAnalysis.referenceName;
		saveStyle({
			name,
			referenceName: lastAnalysis.referenceName,
			summary: lastAnalysis.summary,
			profile: lastAnalysis.profile,
		});
		setStyles(listStyles());
		setMimic({ styleName: "" });
		toast.success(`Style "${name}" saved to the library.`);
	};

	const handleApplyStyle = async (style: SavedStyle) => {
		setApplyingStyleId(style.id);
		try {
			const result = await applySavedStyle(editor, style, applyIntensity / 100);
			toast.success(`Applied "${style.name}": ${result.description}`);
		} catch (err: any) {
			toast.error(err?.message || "Failed to apply the style.");
		} finally {
			setApplyingStyleId(null);
		}
	};

	const handleDeleteStyle = (style: SavedStyle) => {
		deleteStyle(style.id);
		setStyles(listStyles());
		toast.info(`Style "${style.name}" removed.`);
	};

	const handleMimicFlow = async () => {
		if (!referenceFile) {
			toast.error("Please upload a reference video file first.");
			return;
		}

		let targetAudioPath: string | null = null;
		if (selectedAudioId !== "none") {
			const selectedAudio = audioElements.find((a) => a.id === selectedAudioId);
			if (selectedAudio) {
				targetAudioPath =
					(selectedAudio as any).sourceOriginalPath ||
					(selectedAudio as any).sourceProxyPath ||
					null;
			}
		}

		const videoElements = tracks
			.filter((t) => t.type === "video")
			.flatMap((t) => t.elements);
		const firstVideo = videoElements[0];
		const targetVideoPath =
			(firstVideo as any)?.sourceOriginalPath ||
			(firstVideo as any)?.sourceProxyPath ||
			null;

		setMimic({ isUploading: true, uploadProgress: 10 });

		try {
			const formData = new FormData();
			formData.append("file", referenceFile);

			setMimic({ uploadProgress: 30 });
			const uploadRes = await fetch("http://127.0.0.1:8000/api/upload", {
				method: "POST",
				body: formData,
			});

			if (!uploadRes.ok) {
				throw new Error("Failed to upload reference video to server.");
			}

			setMimic({ uploadProgress: 70 });
			const uploadData = await uploadRes.json();
			const referenceVideoPath = uploadData.original_path;

			setMimic({ uploadProgress: 90, isUploading: false, isProcessing: true });

			const mimicRes = await fetch("http://127.0.0.1:8000/api/ai/mimic-flow", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					reference_video_path: referenceVideoPath,
					target_audio_path: targetAudioPath,
					target_video_path: targetVideoPath,
					target_video_duration: targetDuration,
				}),
			});

			if (!mimicRes.ok) {
				throw new Error("Mimic analysis failed.");
			}

			const mimicData = await mimicRes.json();
			setMimic({ isProcessing: false });

			if (mimicData.status === "success") {
				const mutations = mimicData.mutations || [];
				const cuts = mutations
					.filter((m: any) => m.action === "SPLIT_AND_INSERT")
					.map((m: any) => m.target_pts_seconds);

				setMimic({
					apiMutations: mutations,
					snappedCuts: cuts,
					mimicStats: {
						tempoBpm: mimicData.tempo_bpm,
						totalBeats: mimicData.total_beats,
						scenesDetected: mimicData.scenes_detected,
					},
					...(mimicData.style_profile
						? {
								lastAnalysis: {
									referenceName: referenceFile.name,
									summary: mimicData.summary ?? "",
									profile: mimicData.style_profile,
								},
							}
						: {}),
				});

				const ghostClips = cuts.map((cut: number, idx: number) => ({
					id: `ghost_cut_${idx}`,
					trackId: tracks.find((t) => t.type === "video")?.id || "video_track",
					start: Math.max(0, cut - 0.1),
					end: cut + 0.1,
					type: "video",
					label: `Proposed Cut ${idx + 1}`,
					operationId: `mimic_cut_op_${idx}`,
					isInvalid: false,
				}));

				useEditorStore.getState().setGhostClips(ghostClips);
				toast.success("Analysis finished. Confirm or discard cuts below.");
			}
		} catch (err: any) {
			setMimic({ isUploading: false, isProcessing: false });
			toast.error(err?.message || "Failed to process reference video.");
		}
	};

	// --- 4. NotebookLM Source Hub Logic ---
	const getAiCfg = () => {
		if (typeof window !== "undefined") {
			try {
				const saved = localStorage.getItem("chronox.ai.cfg");
				if (saved) return JSON.parse(saved);
			} catch {}
		}
		return { provider: "ollama", model: "qwen3.5:9b", apiKey: "" };
	};

	const handleAddYoutubeSource = async () => {
		if (!newUrl.trim()) return;
		setIsAddingSource(true);
		const aiCfg = getAiCfg();
		const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

		try {
			// Query oembed for title, then extract outline
			const oembedRes = await fetch(
				`https://www.youtube.com/oembed?url=${encodeURIComponent(newUrl.trim())}&format=json`,
			);
			let title = "YouTube Video Source";
			if (oembedRes.ok) {
				const info = await oembedRes.json();
				title = info.title || title;
			}

			// Call backend to perform a simple recipe/transcript crawl
			const res = await fetch(`${API_URL}/api/ai/extract-recipe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: newUrl.trim(),
					provider: aiCfg.provider,
					api_key: aiCfg.apiKey || undefined,
					model: aiCfg.provider === "ollama" ? "qwen3.5:9b" : aiCfg.model,
				}),
			});

			if (!res.ok) {
				throw new Error("Failed to fetch YouTube details.");
			}

			const data = await res.json();
			const outlineMd = data.cards?.[0]?.recipe_md || "No transcript details available.";

			const item = saveSource({
				id: `source_yt_${Date.now()}`,
				type: "youtube",
				name: title,
				content: outlineMd,
				url: newUrl.trim(),
				selected: true,
				createdAt: Date.now(),
			});

			setSources(listSources());
			setNewUrl("");
			toast.success(`Source "${title}" added!`);
		} catch (err: any) {
			toast.error(err?.message || "Failed to add YouTube source.");
		} finally {
			setIsAddingSource(false);
		}
	};

	const handleAddTextSource = () => {
		if (!newTextName.trim() || !newTextContent.trim()) {
			toast.error("Please provide both name and content.");
			return;
		}

		saveSource({
			id: `source_txt_${Date.now()}`,
			type: "text",
			name: newTextName.trim(),
			content: newTextContent.trim(),
			selected: true,
			createdAt: Date.now(),
		});

		setSources(listSources());
		setNewTextName("");
		setNewTextContent("");
		setShowAddTextModal(false);
		toast.success("Text brief added to Source Hub.");
	};

	const handleToggleSource = (id: string) => {
		const updated = toggleSelectSource(id);
		setSources(updated);
	};

	const handleDeleteSource = (id: string) => {
		deleteSource(id);
		setSources(listSources());
		toast.info("Source removed.");
	};

	// --- 5. Custom Presets & Multi-Source Synthesis ---
	const handleSynthesizeSources = async () => {
		const activeSources = sources.filter((s) => s.selected);
		if (activeSources.length === 0) {
			toast.error("Please select at least one source document in the hub.");
			return;
		}
		if (!synthesisPrompt.trim()) {
			toast.error("Please enter a query or target style description.");
			return;
		}

		setIsSynthesizing(true);
		const aiCfg = getAiCfg();
		const timelineState = buildTimelineSnapshot(editor);
		const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

		try {
			const res = await fetch(`${API_URL}/api/ai/synthesize-sources`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: synthesisPrompt.trim(),
					sources: activeSources,
					timeline_state: timelineState,
					provider: aiCfg.provider,
					api_key: aiCfg.apiKey || undefined,
					model: aiCfg.provider === "ollama" ? "qwen3.5:9b" : aiCfg.model,
				}),
			});

			if (!res.ok) {
				throw new Error("Synthesis failed on the server.");
			}

			const data = await res.json();
			setSynthesisExplanation(data.explanation || "");
			
			const cardsList = data.cards || [];
			const formattedCards: StyleCard[] = cardsList.map((c: any, index: number) => ({
				id: `extracted_${Date.now()}_${index}`,
				category: c.category || "effects",
				name: c.name || `Preset ${index + 1}`,
				summary: c.summary || "",
				timeRange: c.time_range || null,
				recipeMd: c.recipe_md || "",
				saved: false,
			}));

			setExtractedCards(formattedCards);

			// Pre-fill names & recipes state
			const nameState: Record<string, string> = {};
			const recipeState: Record<string, string> = {};
			formattedCards.forEach((c) => {
				nameState[c.id] = c.name;
				recipeState[c.id] = c.recipeMd;
			});
			setCardNames((prev) => ({ ...prev, ...nameState }));
			setCardRecipes((prev) => ({ ...prev, ...recipeState }));

			toast.success("Synthesis completed! Presets generated below.");
		} catch (err: any) {
			toast.error(err?.message || "Synthesis failed.");
		} finally {
			setIsSynthesizing(false);
		}
	};

	const handleSaveCard = (card: StyleCard) => {
		const name = cardNames[card.id]?.trim() || card.name;
		const recipe = cardRecipes[card.id] || card.recipeMd;

		saveStyleCard({
			id: card.id.startsWith("extracted_") ? `saved_${Date.now()}_${Math.random()}` : card.id,
			category: card.category,
			name,
			summary: card.summary,
			timeRange: card.timeRange,
			recipeMd: recipe,
			saved: true,
		});

		setSavedCards(listStyleCards());
		setExtractedCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, saved: true } : c)));
		toast.success(`Preset "${name}" saved to library.`);
	};

	const handleDeleteCard = (card: StyleCard) => {
		deleteStyleCard(card.id);
		setSavedCards(listStyleCards());
		setExtractedCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, saved: false } : c)));
		toast.info(`Preset "${card.name}" removed.`);
	};

	// --- Interactive Review Mode (One-Shot Proposed Edits) ---
	const handleApplyCardReview = async (card: StyleCard) => {
		const aiCfg = getAiCfg();
		const timelineState = buildTimelineSnapshot(editor);
		const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

		const recipeText = cardRecipes[card.id] || card.recipeMd;
		const targetType = cardTargetTypes[card.id] || "timeline";

		let targetClipId: string | undefined = undefined;
		if (targetType === "selected") {
			if (selectedElements.length === 0) {
				toast.error("Please select a clip on the timeline first.");
				return;
			}
			targetClipId = selectedElements[0].id;
		}

		setApplyingCardId(card.id);
		toast.loading(`Analyzing style changes for review...`, { id: "apply-recipe" });

		try {
			const customRange = cardCustomRanges[card.id];
			let recipeWithRange = recipeText;
			if (targetType === "range" && customRange) {
				recipeWithRange = `[APPLY TARGET: Time Range ${customRange.start}s to ${customRange.end}s]\n\n${recipeText}`;
			} else if (card.timeRange && targetType === "timeline") {
				recipeWithRange = `[APPLY TARGET: Reference Video Time Range ${card.timeRange[0]}s to ${card.timeRange[1]}s]\n\n${recipeText}`;
			}

			const res = await fetch(`${API_URL}/api/ai/apply-recipe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					recipe: recipeWithRange,
					timeline_state: timelineState,
					target_clip_id: targetClipId,
					provider: aiCfg.provider,
					api_key: aiCfg.apiKey || undefined,
					model: aiCfg.provider === "ollama" ? "qwen3.5:9b" : aiCfg.model,
				}),
			});

			if (!res.ok) {
				throw new Error("Failed to compile operations.");
			}

			const data = await res.json();
			const ops = data.operations || [];
			if (ops.length === 0) {
				toast.dismiss("apply-recipe");
				toast.info("No timeline changes generated.");
				return;
			}

			// Resolve operations to visual timeline proposed cards (ghost clips)
			const videoTrack = tracks.find((t) => t.type === "video");
			const trackId = videoTrack?.id || "video_track";
			const clips = videoTrack?.elements || [];

			const proposedGhostClips: any[] = [];
			
			ops.forEach((op: any, index: number) => {
				const uuid = `proposed_${Date.now()}_${index}`;
				if (op.action === "split") {
					proposedGhostClips.push({
						id: uuid,
						trackId: op.track_id || trackId,
						start: op.time,
						end: op.time,
						type: "split",
						label: `Proposed Cut (${op.time.toFixed(1)}s)`,
						operationId: "split",
						isPendingSplit: true,
						isInvalid: false,
						operationData: op,
					});
				} else if (op.action === "delete") {
					const targetClip = clips.find((c) => c.id === op.clip_id);
					if (targetClip) {
						proposedGhostClips.push({
							id: uuid,
							trackId: trackId,
							start: targetClip.startTime,
							end: targetClip.startTime + targetClip.duration,
							type: "delete",
							label: `Remove Clip "${targetClip.name}"`,
							operationId: "delete",
							isPendingDelete: true,
							isInvalid: false,
							originalClipId: targetClip.id,
							operationData: op,
						});
					}
				} else if (op.action === "trim") {
					const targetClip = clips.find((c) => c.id === op.clip_id);
					if (targetClip) {
						const clipStart = targetClip.startTime;
						const clipEnd = clipStart + targetClip.duration;
						
						// trim keeps [start, end]. Faded red region for cut-outs:
						if (op.start > 0) {
							proposedGhostClips.push({
								id: `${uuid}_trim_l`,
								trackId: trackId,
								start: clipStart,
								end: clipStart + op.start,
								type: "trim_left",
								label: "Trim Out Left",
								operationId: "delete",
								isPendingDelete: true,
								isInvalid: false,
								operationData: { action: "trim_cut", clip_id: op.clip_id, start: 0, end: op.start },
							});
						}
						
						if (op.end < targetClip.duration) {
							proposedGhostClips.push({
								id: `${uuid}_trim_r`,
								trackId: trackId,
								start: clipStart + op.end,
								end: clipEnd,
								type: "trim_right",
								label: "Trim Out Right",
								operationId: "delete",
								isPendingDelete: true,
								isInvalid: false,
								operationData: { action: "trim_cut", clip_id: op.clip_id, start: op.end, end: targetClip.duration },
							});
						}
					}
				} else {
					// standard edits like adjust_color
					const targetClip = clips.find((c) => c.id === op.clip_id);
					proposedGhostClips.push({
						id: uuid,
						trackId: trackId,
						start: targetClip?.startTime ?? 0,
						end: targetClip ? targetClip.startTime + targetClip.duration : 5,
						type: op.action,
						label: `Change: ${op.action}`,
						operationId: op.action,
						isPendingDelete: false,
						isPendingSplit: false,
						isInvalid: false,
						operationData: op,
					});
				}
			});

			useEditorStore.getState().setGhostClips(proposedGhostClips);
			toast.success("Presets loaded as pending edits on the timeline. Hover/right-click to edit, or confirm below.", { id: "apply-recipe" });
		} catch (err: any) {
			toast.error(err?.message || "Failed to preview preset.", { id: "apply-recipe" });
		} finally {
			setApplyingCardId(null);
		}
	};

	const handleConfirmProposedEdits = async () => {
		const remainingOps = ghostClips
			.map((c) => c.operationData)
			.filter(Boolean);

		if (remainingOps.length === 0) {
			toast.info("No active edits left to apply.");
			useEditorStore.getState().clearGhostClips();
			return;
		}

		try {
			const { BatchCommand } = await import("@/lib/commands/batch-command");
			const { dryRunActions } = await import("@/lib/ai/compiler");

			// We need to resolve custom trim_cut back to valid timeline trim commands
			const normalizedOps = remainingOps.map((op) => {
				if (op.action === "trim_cut") {
					return {
						action: "trim",
						clip_id: op.clip_id,
						start: op.end, // keep from end onwards
						end: 9999, // default max
					};
				}
				return op;
			});

			const dry = dryRunActions(normalizedOps, editor, { strict: false });
			if (dry.success && dry.commands && dry.commands.length > 0) {
				editor.command.execute({ command: new BatchCommand(dry.commands) });
				toast.success(`Successfully applied ${dry.commands.length} edits.`);
			} else {
				throw new Error("Could not apply edits to the current clips.");
			}
		} catch (err: any) {
			toast.error(err?.message || "Failed to commit timeline edits.");
		} finally {
			useEditorStore.getState().clearGhostClips();
		}
	};

	const handleRejectProposedEdits = () => {
		useEditorStore.getState().clearGhostClips();
		toast.info("Proposed edits discarded.");
	};

	const toggleExpandCard = (id: string) => {
		setExpandedCardIds((prev) => ({ ...prev, [id]: !prev[id] }));
	};

	const getCategoryStyles = (category: string) => {
		switch (category) {
			case "color":
				return {
					badge: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
					icon: <Palette className="size-3.5 text-indigo-400" />,
					label: "Color Grading",
				};
			case "transitions":
				return {
					badge: "bg-amber-500/10 text-amber-400 border-amber-500/20",
					icon: <Zap className="size-3.5 text-amber-400" />,
					label: "Transitions",
				};
			case "pacing":
				return {
					badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
					icon: <Clock className="size-3.5 text-emerald-400" />,
					label: "Pacing & Cuts",
				};
			default:
				return {
					badge: "bg-rose-500/10 text-rose-400 border-rose-500/20",
					icon: <Sparkles className="size-3.5 text-rose-400" />,
					label: "Visual Effect",
				};
		}
	};

	return (
		<div className="flex h-full flex-col bg-background text-foreground p-4 select-none relative">
			{/* Segmented Header Controls */}
			<div className="flex items-center gap-2 mb-4 justify-between border-b border-border pb-3">
				<div className="flex items-center gap-2">
					<div className="p-1.5 rounded-lg bg-agent/10 text-agent">
						<Sparkles className="size-4" />
					</div>
					<div>
						<h2 className="text-sm font-semibold tracking-tight text-foreground">
							Preset Studio
						</h2>
						<p className="text-[10px] text-muted-foreground">
							Extract, save & apply modular styles
						</p>
					</div>
				</div>

				<div className="flex bg-card/60 p-0.5 rounded-lg border border-border">
					<button
						type="button"
						onClick={() => setActiveTab("presets")}
						className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors cursor-pointer ${
							activeTab === "presets"
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Presets Library
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("source")}
						className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors cursor-pointer ${
							activeTab === "source"
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Video Analysis
					</button>
				</div>
			</div>

			{/* Floating Timeline Review State Banner */}
			{ghostClips.length > 0 && (
				<div className="absolute bottom-4 left-4 right-4 bg-agent/10 border border-agent/30 rounded-xl p-3.5 space-y-2.5 shadow-2xl backdrop-blur-md z-50">
					<div className="flex items-center gap-2 text-xs font-semibold text-agent">
						<Activity className="size-4 animate-pulse" />
						<span>Timeline Proposed Edits ({ghostClips.length})</span>
					</div>
					<p className="text-[10px] text-muted-foreground leading-normal">
						Pending cuts and deleted clips are highlighted on the timeline. Hover/right-click elements to edit, or confirm:
					</p>
					<div className="flex gap-2">
						<Button
							onClick={handleConfirmProposedEdits}
							className="flex-1 bg-agent hover:bg-agent/90 text-agent-foreground h-8 text-[11px] font-semibold rounded-lg gap-1.5"
						>
							<Check className="size-3.5" />
							Apply Edits
						</Button>
						<Button
							onClick={handleRejectProposedEdits}
							variant="outline"
							className="flex-1 bg-transparent hover:bg-card border-border text-foreground h-8 text-[11px] font-semibold rounded-lg gap-1.5"
						>
							<X className="size-3.5" />
							Reject All
						</Button>
					</div>
				</div>
			)}

			<ScrollArea className="flex-1 pr-1">
				{activeTab === "presets" ? (
					// --- NOTEBOOKLM SOURCE HUB & PRESETS VIEW ---
					<div className="space-y-4 pb-24">
						{/* Source Ingestion (NotebookLM-style Source Hub) */}
						<div className="bg-card/30 border border-border rounded-xl p-4 space-y-3">
							<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
								<BookOpen className="size-4 text-agent" />
								<span>Source Hub (NotebookLM)</span>
							</div>

							{/* Add YouTube URL */}
							<div className="flex gap-2">
								<input
									type="text"
									value={newUrl}
									onChange={(e) => setNewUrl(e.target.value)}
									placeholder="Add Youtube video url..."
									className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-foreground focus:outline-none focus:border-agent transition-all placeholder:text-muted-foreground/60"
								/>
								<Button
									onClick={handleAddYoutubeSource}
									disabled={isAddingSource}
									className="bg-card border border-border text-foreground hover:bg-accent text-[11px] h-8 px-3 font-semibold rounded-lg"
								>
									{isAddingSource ? <Activity className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
								</Button>
							</div>

							{/* Add Text Note Button */}
							<Button
								onClick={() => setShowAddTextModal(true)}
								variant="outline"
								className="w-full border border-border hover:bg-accent text-foreground text-[10px] h-7 gap-1.5"
							>
								<Plus className="size-3.5" />
								Add Text Note / Brief Source
							</Button>

							{/* Add Text Brief Inline Panel */}
							{showAddTextModal && (
								<div className="bg-background/80 border border-border/80 rounded-lg p-3 space-y-2.5">
									<div className="flex items-center justify-between">
										<span className="text-[10px] font-bold text-muted-foreground">Add Document Source</span>
										<button
											type="button"
											onClick={() => setShowAddTextModal(false)}
											className="text-muted-foreground hover:text-foreground cursor-pointer"
										>
											<X className="size-3.5" />
										</button>
									</div>
									<input
										type="text"
										value={newTextName}
										onChange={(e) => setNewTextName(e.target.value)}
										placeholder="Document Name (e.g. Creative Brief)"
										className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] focus:outline-none focus:border-agent"
									/>
									<textarea
										value={newTextContent}
										onChange={(e) => setNewTextContent(e.target.value)}
										placeholder="Paste creative brief content, video outlines, or transcripts here..."
										rows={4}
										className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] focus:outline-none focus:border-agent resize-none"
									/>
									<Button
										onClick={handleAddTextSource}
										className="w-full bg-agent hover:bg-agent/90 text-agent-foreground text-[11px] h-7 font-semibold"
									>
										Save Source
									</Button>
								</div>
							)}

							{/* Ingested Sources List */}
							{sources.length > 0 && (
								<div className="space-y-2 pt-2 border-t border-border/60">
									<span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider block">
										Ingested Materials
									</span>
									<div className="space-y-2 max-h-48 overflow-y-auto pr-1">
										{sources.map((src) => (
											<div
												key={src.id}
												className="flex items-start gap-2 bg-background/50 border border-border/60 p-2.5 rounded-lg hover:bg-background/80 transition-colors"
											>
												<button
													type="button"
													onClick={() => handleToggleSource(src.id)}
													className="mt-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
												>
													{src.selected ? (
														<CheckSquare className="size-4 text-agent" />
													) : (
														<Square className="size-4" />
													)}
												</button>
												
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-1">
														{src.type === "youtube" ? (
															<Youtube className="size-3 text-destructive" />
														) : (
															<FileText className="size-3 text-agent" />
														)}
														<span className="text-[11px] font-semibold text-foreground truncate block max-w-[150px]">
															{src.name}
														</span>
													</div>
													<p className="text-[9px] text-muted-foreground line-clamp-2 mt-0.5">
														{src.content}
													</p>
												</div>

												<button
													type="button"
													onClick={() => handleDeleteSource(src.id)}
													className="text-muted-foreground hover:text-destructive cursor-pointer p-0.5"
												>
													<Trash2 className="size-3.5" />
												</button>
											</div>
										))}
									</div>
								</div>
							)}
						</div>

						{/* Synthesis Query Bar */}
						{sources.filter((s) => s.selected).length > 0 && (
							<div className="bg-card/30 border border-border rounded-xl p-4 space-y-3">
								<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
									<Search className="size-4 text-agent" />
									<span>Synthesize Sources (Copilot)</span>
								</div>
								
								<textarea
									value={synthesisPrompt}
									onChange={(e) => setSynthesisPrompt(e.target.value)}
									placeholder="Ask co-pilot to synthesize selected sources (e.g. 'Extract transitions from YT clip A and create a warm grading card based on brief B')..."
									rows={3}
									className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-agent transition-all resize-none placeholder:text-muted-foreground/60 leading-normal"
								/>

								<Button
									onClick={handleSynthesizeSources}
									disabled={isSynthesizing}
									className="w-full bg-agent hover:bg-agent/90 text-agent-foreground py-2 h-9 rounded-lg font-medium text-xs gap-2 transition-all shadow-lg shadow-agent/20"
								>
									{isSynthesizing ? (
										<>
											<Activity className="size-3.5 animate-spin" />
											<span>Synthesizing documents...</span>
										</>
									) : (
										<>
											<Sparkles className="size-3.5" />
											<span>Synthesize & Generate Cards</span>
										</>
									)}
								</Button>
							</div>
						)}

						{/* Synthesis Explanation Summary */}
						{synthesisExplanation && (
							<div className="bg-agent/5 border border-agent/20 p-3.5 rounded-xl space-y-2">
								<div className="flex items-center gap-1.5 text-xs font-bold text-agent">
									<FileText className="size-4" />
									<span>Copilot Findings</span>
								</div>
								<p className="text-[10px] text-muted-foreground leading-relaxed whitespace-pre-line">
									{synthesisExplanation}
								</p>
							</div>
						)}

						{/* Extracted Presets Board */}
						{extractedCards.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-1.5">
									<BookOpen className="size-3.5" />
									Generated Style Presets
								</h3>
								<div className="space-y-3">
									{extractedCards.map((card) => {
										const cat = getCategoryStyles(card.category);
										const isExpanded = expandedCardIds[card.id];
										const targetType = cardTargetTypes[card.id] || "timeline";

										return (
											<div
												key={card.id}
												className="bg-card/40 border border-border rounded-xl p-3.5 space-y-3 transition-all hover:bg-card/50"
											>
												<div className="flex items-start gap-2.5 justify-between">
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-1.5 flex-wrap mb-1">
															<span
																className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold flex items-center gap-1 ${cat.badge}`}
															>
																{cat.icon}
																{cat.label}
															</span>
															{card.timeRange && (
																<span className="bg-card border border-border px-1.5 py-0.5 rounded text-[9px] font-mono text-muted-foreground">
																	Range: {card.timeRange[0]}s - {card.timeRange[1]}s
																</span>
															)}
														</div>
														<input
															type="text"
															value={cardNames[card.id] ?? card.name}
															onChange={(e) =>
																setCardNames((prev) => ({
																	...prev,
																	[card.id]: e.target.value,
																}))
															}
															className="text-xs font-semibold text-foreground bg-transparent border-b border-transparent hover:border-border/40 focus:border-agent focus:outline-none w-full py-0.5"
														/>
														<p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
															{card.summary}
														</p>
													</div>

													<button
														type="button"
														onClick={() => handleSaveCard(card)}
														title="Save preset to library"
														className="p-1.5 rounded-lg border transition-all cursor-pointer bg-card hover:bg-accent border-border text-muted-foreground"
													>
														<Save className="size-3.5" />
													</button>
												</div>

												{/* Collapsible Recipe Code block */}
												<div className="border border-border/80 bg-background/50 rounded-lg overflow-hidden">
													<button
														type="button"
														onClick={() => toggleExpandCard(card.id)}
														className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-medium text-muted-foreground hover:bg-card/30 transition-colors cursor-pointer"
													>
														<span className="flex items-center gap-1.5">
															<FileText className="size-3.5" />
															Markdown Instructions (.md)
														</span>
														{isExpanded ? (
															<ChevronUp className="size-3.5" />
														) : (
															<ChevronDown className="size-3.5" />
														)}
													</button>

													{isExpanded && (
														<div className="p-2 border-t border-border/80 bg-background">
															<textarea
																value={cardRecipes[card.id] ?? card.recipeMd}
																onChange={(e) =>
																	setCardRecipes((prev) => ({
																		...prev,
																		[card.id]: e.target.value,
																	}))
																}
																rows={6}
																className="w-full bg-background border border-border/60 rounded px-2.5 py-1.5 text-[10px] font-mono text-foreground focus:outline-none focus:border-agent resize-y leading-normal"
															/>
														</div>
													)}
												</div>

												{/* Target Range Selector */}
												<div className="grid grid-cols-2 gap-2 bg-background/30 p-2.5 rounded-lg border border-border/60">
													<div className="space-y-1">
														<span className="text-[9px] uppercase font-bold text-muted-foreground">
															Apply Target
														</span>
														<select
															value={targetType}
															onChange={(e: any) =>
																setCardTargetTypes((prev) => ({
																	...prev,
																	[card.id]: e.target.value,
																}))
															}
															className="w-full bg-card border border-border rounded px-2 py-1 text-[10px] text-foreground focus:outline-none focus:border-agent"
														>
															<option value="timeline">Entire Timeline</option>
															<option value="selected">Selected Clip</option>
															<option value="range">Custom Range</option>
														</select>
													</div>

													<div className="space-y-1 flex flex-col justify-end">
														{targetType === "range" ? (
															<div className="flex gap-1.5 items-center">
																<input
																	type="number"
																	placeholder="Start"
																	value={cardCustomRanges[card.id]?.start ?? card.timeRange?.[0] ?? "0"}
																	onChange={(e) =>
																		setCardCustomRanges((prev) => ({
																			...prev,
																			[card.id]: {
																				start: e.target.value,
																				end:
																					prev[card.id]?.end ??
																					String(card.timeRange?.[1] ?? "10"),
																			},
																		}))
																	}
																	className="w-full bg-card border border-border rounded px-1.5 py-1 text-[10px] text-center focus:outline-none focus:border-agent font-mono"
																/>
																<span className="text-[10px] text-muted-foreground">to</span>
																<input
																	type="number"
																	placeholder="End"
																	value={cardCustomRanges[card.id]?.end ?? card.timeRange?.[1] ?? "10"}
																	onChange={(e) =>
																		setCardCustomRanges((prev) => ({
																			...prev,
																			[card.id]: {
																				start:
																					prev[card.id]?.start ??
																					String(card.timeRange?.[0] ?? "0"),
																				end: e.target.value,
																			},
																		}))
																	}
																	className="w-full bg-card border border-border rounded px-1.5 py-1 text-[10px] text-center focus:outline-none focus:border-agent font-mono"
																/>
															</div>
														) : targetType === "selected" ? (
															<span className="text-[10px] text-muted-foreground italic h-7 flex items-center leading-tight">
																{selectedElements.length > 0
																	? `Targeting clip "${selectedElements[0].name}"`
																	: "Select clip on timeline"}
															</span>
														) : (
															<span className="text-[10px] text-muted-foreground italic h-7 flex items-center">
																Global timeline target
															</span>
														)}
													</div>
												</div>

												{/* Apply Preset Action Button */}
												<Button
													onClick={() => handleApplyCardReview(card)}
													disabled={applyingCardId !== null}
													className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-8 text-[11px] font-semibold rounded-lg gap-1.5"
												>
													{applyingCardId === card.id ? (
														<>
															<Activity className="size-3.5 animate-spin" />
															Translating parameters…
														</>
													) : (
														<>
															<Wand2 className="size-3.5" />
															Apply Preset Card
														</>
													)}
												</Button>
											</div>
										);
									})}
								</div>
							</div>
						)}

						{/* Saved Presets Library */}
						<div className="space-y-2 pt-2">
							<div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider border-t border-border pt-3">
								<Library className="size-3.5" />
								<span>Saved Presets Library</span>
								<span className="ml-auto font-mono normal-case text-muted-foreground/70">
									{savedCards.length}
								</span>
							</div>

							{savedCards.length === 0 ? (
								<p className="text-[10px] text-muted-foreground/60 italic pt-1">
									No saved preset cards yet. Ingest sources & synthesize style presets above.
								</p>
							) : (
								<div className="space-y-3">
									{savedCards.map((card) => {
										const cat = getCategoryStyles(card.category);
										const isExpanded = expandedCardIds[card.id];
										const targetType = cardTargetTypes[card.id] || "timeline";

										return (
											<div
												key={card.id}
												className="p-3 bg-card/20 border border-border rounded-xl space-y-3"
											>
												<div className="flex items-start gap-2.5 justify-between">
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-1.5 flex-wrap mb-1">
															<span
																className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold flex items-center gap-1 ${cat.badge}`}
															>
																{cat.icon}
																{cat.label}
															</span>
															{card.timeRange && (
																<span className="bg-card border border-border px-1.5 py-0.5 rounded text-[9px] font-mono text-muted-foreground">
																	Range: {card.timeRange[0]}s - {card.timeRange[1]}s
																</span>
															)}
														</div>
														<input
															type="text"
															value={cardNames[card.id] ?? card.name}
															onChange={(e) => {
																const newName = e.target.value;
																setCardNames((prev) => ({ ...prev, [card.id]: newName }));
																saveStyleCard({ ...card, name: newName });
																setSavedCards(listStyleCards());
															}}
															className="text-xs font-semibold text-foreground bg-transparent border-b border-transparent hover:border-border/40 focus:border-agent focus:outline-none w-full py-0.5"
														/>
														<p className="text-[10px] text-muted-foreground leading-normal mt-0.5">
															{card.summary}
														</p>
													</div>

													<button
														type="button"
														onClick={() => handleDeleteCard(card)}
														title="Delete preset"
														className="p-1 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
													>
														<Trash2 className="size-3.5" />
													</button>
												</div>

												{/* Collapse Recipe view */}
												<div className="border border-border/60 bg-background/30 rounded-lg overflow-hidden">
													<button
														type="button"
														onClick={() => toggleExpandCard(card.id)}
														className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-medium text-muted-foreground hover:bg-card/20 transition-colors cursor-pointer"
													>
														<span className="flex items-center gap-1.5">
															<FileText className="size-3.5" />
															Markdown Instructions (.md)
														</span>
														{isExpanded ? (
															<ChevronUp className="size-3.5" />
														) : (
															<ChevronDown className="size-3.5" />
														)}
													</button>

													{isExpanded && (
														<div className="p-2 border-t border-border/60 bg-background">
															<textarea
																value={cardRecipes[card.id] ?? card.recipeMd}
																onChange={(e) => {
																	const newRecipe = e.target.value;
																	setCardRecipes((prev) => ({ ...prev, [card.id]: newRecipe }));
																	saveStyleCard({ ...card, recipeMd: newRecipe });
																	setSavedCards(listStyleCards());
																}}
																rows={6}
																className="w-full bg-background border border-border/60 rounded px-2.5 py-1.5 text-[10px] font-mono text-foreground focus:outline-none focus:border-agent resize-y leading-normal"
															/>
														</div>
													)}
												</div>

												{/* Target Range Selector */}
												<div className="grid grid-cols-2 gap-2 bg-background/20 p-2.5 rounded-lg border border-border/60">
													<div className="space-y-1">
														<span className="text-[9px] uppercase font-bold text-muted-foreground">
															Apply Target
														</span>
														<select
															value={targetType}
															onChange={(e: any) =>
																setCardTargetTypes((prev) => ({
																	...prev,
																	[card.id]: e.target.value,
																}))
															}
															className="w-full bg-card border border-border rounded px-2 py-1 text-[10px] text-foreground focus:outline-none focus:border-agent"
														>
															<option value="timeline">Entire Timeline</option>
															<option value="selected">Selected Clip</option>
															<option value="range">Custom Range</option>
														</select>
													</div>

													<div className="space-y-1 flex flex-col justify-end">
														{targetType === "range" ? (
															<div className="flex gap-1.5 items-center">
																<input
																	type="number"
																	placeholder="Start"
																	value={cardCustomRanges[card.id]?.start ?? card.timeRange?.[0] ?? "0"}
																	onChange={(e) =>
																		setCardCustomRanges((prev) => ({
																			...prev,
																			[card.id]: {
																				start: e.target.value,
																				end:
																					prev[card.id]?.end ??
																					String(card.timeRange?.[1] ?? "10"),
																			},
																		}))
																	}
																	className="w-full bg-card border border-border rounded px-1.5 py-1 text-[10px] text-center focus:outline-none focus:border-agent font-mono"
																/>
																<span className="text-[10px] text-muted-foreground">to</span>
																<input
																	type="number"
																	placeholder="End"
																	value={cardCustomRanges[card.id]?.end ?? card.timeRange?.[1] ?? "10"}
																	onChange={(e) =>
																		setCardCustomRanges((prev) => ({
																			...prev,
																			[card.id]: {
																				start:
																					prev[card.id]?.start ??
																					String(card.timeRange?.[0] ?? "0"),
																				end: e.target.value,
																			},
																		}))
																	}
																	className="w-full bg-card border border-border rounded px-1.5 py-1 text-[10px] text-center focus:outline-none focus:border-agent font-mono"
																/>
															</div>
														) : targetType === "selected" ? (
															<span className="text-[10px] text-muted-foreground italic h-7 flex items-center leading-tight">
																{selectedElements.length > 0
																	? `Targeting clip "${selectedElements[0].name}"`
																	: "Select clip on timeline"}
															</span>
														) : (
															<span className="text-[10px] text-muted-foreground italic h-7 flex items-center">
																Global timeline target
															</span>
														)}
													</div>
												</div>

												{/* Apply Preset Action Button */}
												<Button
													onClick={() => handleApplyCardReview(card)}
													disabled={applyingCardId !== null}
													className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-8 text-[11px] font-semibold rounded-lg gap-1.5"
												>
													{applyingCardId === card.id ? (
														<>
															<Activity className="size-3.5 animate-spin" />
															Translating parameters…
														</>
													) : (
														<>
															<Wand2 className="size-3.5" />
															Apply Preset Card
														</>
													)}
												</Button>
											</div>
										);
									})}
								</div>
							)}
						</div>
					</div>
				) : (
					// --- ORIGINAL LOCAL VIDEO ANALYSIS VIEW ---
					<div className="space-y-4">
						{/* Reference Video Upload */}
						<div className="space-y-2">
							<label className="text-xs font-medium text-foreground flex items-center gap-1.5">
								<Film className="size-3 text-agent" />
								Reference Video
							</label>
							<div className="border border-dashed border-border rounded-lg p-4 bg-card/40 hover:bg-card/60 transition-all flex flex-col items-center justify-center gap-2 text-center relative cursor-pointer group">
								<input
									type="file"
									accept="video/*"
									onChange={handleFileChange}
									className="absolute inset-0 opacity-0 cursor-pointer"
								/>
								{referenceFile ? (
									<>
										<Video className="size-8 text-agent group-hover:scale-110 transition-transform" />
										<span className="text-xs font-medium max-w-[200px] truncate">
											{referenceFile.name}
										</span>
										<span className="text-[10px] text-muted-foreground">
											{(referenceFile.size / (1024 * 1024)).toFixed(2)} MB
										</span>
									</>
								) : (
									<>
										<UploadCloud className="size-8 text-muted-foreground group-hover:scale-110 transition-transform" />
										<span className="text-xs text-muted-foreground">
											Drag & drop or click to upload
										</span>
										<span className="text-[9px] text-muted-foreground">
											MP4, MOV, MKV up to 100MB
										</span>
									</>
								)}
							</div>
						</div>

						{/* Target Audio Selector */}
						<div className="space-y-2">
							<label className="text-xs font-medium text-foreground flex items-center gap-1.5">
								<Music className="size-3 text-agent" />
								Target Soundtrack (Optional)
							</label>
							<select
								value={selectedAudioId}
								onChange={(e) => setMimic({ selectedAudioId: e.target.value })}
								className="w-full bg-card border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-agent"
							>
								<option value="none">None (Video Only - No Beat Snapping)</option>
								{audioElements.map((audio) => (
									<option key={audio.id} value={audio.id}>
										{audio.name}
									</option>
								))}
							</select>
						</div>

						{/* Options */}
						<div className="space-y-3 bg-card/20 border border-border rounded-lg p-3">
							<h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-1.5">
								<Settings2 className="size-3" />
								Sync Parameters
							</h3>

							<div className="space-y-1.5">
								<div className="flex justify-between text-xs text-muted-foreground">
									<span>Target Duration</span>
									<span className="font-mono text-foreground">{targetDuration}s</span>
								</div>
								<input
									type="range"
									min="5"
									max="60"
									step="1"
									value={targetDuration}
									onChange={(e) => setMimic({ targetDuration: Number(e.target.value) })}
									className="w-full h-1 bg-accent rounded-lg appearance-none cursor-pointer accent-agent"
								/>
							</div>
						</div>

						{/* Action Button */}
						<Button
							onClick={handleMimicFlow}
							disabled={isUploading || isProcessing}
							className="w-full bg-agent hover:bg-agent/90 text-agent-foreground py-2 h-9 rounded-lg font-medium text-xs gap-2 transition-all shadow-lg shadow-agent/20"
						>
							{isUploading ? (
								<>
									<Activity className="size-3.5 animate-pulse" />
									<span>Uploading Reference ({uploadProgress}%)</span>
								</>
							) : isProcessing ? (
								<>
									<Activity className="size-3.5 animate-spin" />
									<span>Analyzing & Snapping cuts...</span>
								</>
							) : (
								<>
									<Sparkles className="size-3.5" />
									<span>Extract & Mimic Style</span>
								</>
							)}
						</Button>

						{/* Progress bar during uploads */}
						{isUploading && <Progress value={uploadProgress} className="h-1 bg-card" />}

						{/* Mimic Result Statistics */}
						{mimicStats && snappedCuts.length > 0 && (
							<div className="p-3 bg-agent/10 border border-agent/25 rounded-lg space-y-3">
								<div className="flex items-center gap-1.5 text-xs text-agent font-semibold">
									<Activity className="size-3.5" />
									<span>Mimic Solution Detected</span>
								</div>
								<div className="grid grid-cols-3 gap-2 text-center bg-background/40 p-2 rounded border border-border">
									<div>
										<div className="text-[9px] text-muted-foreground uppercase font-medium">BPM</div>
										<div className="text-xs font-mono font-bold text-foreground">
											{mimicStats.tempoBpm ? Math.round(mimicStats.tempoBpm) : "--"}
										</div>
									</div>
									<div>
										<div className="text-[9px] text-muted-foreground uppercase font-medium">Beats</div>
										<div className="text-xs font-mono font-bold text-foreground">
											{mimicStats.totalBeats || "--"}
										</div>
									</div>
									<div>
										<div className="text-[9px] text-muted-foreground uppercase font-medium">Cuts</div>
										<div className="text-xs font-mono font-bold text-foreground">
											{snappedCuts.length}
										</div>
									</div>
								</div>

								<div className="flex gap-2">
									<Button
										onClick={acceptCuts}
										className="flex-1 bg-constructive hover:bg-constructive/90 text-constructive-foreground h-8 text-[11px] font-semibold rounded-lg gap-1.5"
									>
										<Check className="size-3.5" />
										Confirm Cuts
									</Button>
									<Button
										onClick={discardCuts}
										variant="outline"
										className="bg-transparent hover:bg-card border-border text-foreground h-8 text-[11px] font-semibold rounded-lg gap-1.5"
									>
										<X className="size-3.5" />
										Discard
									</Button>
								</div>
							</div>
						)}

						{/* Save style profile */}
						{lastAnalysis && (
							<div className="p-3 bg-card/20 border border-border rounded-lg space-y-2">
								<div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
									<Save className="size-3" />
									Save style profile
								</div>
								{lastAnalysis.summary && (
									<p className="text-[10px] text-muted-foreground leading-relaxed">
										{lastAnalysis.summary}
									</p>
								)}
								<div className="flex gap-1.5">
									<input
										type="text"
										value={styleName}
										onChange={(e) => setMimic({ styleName: e.target.value })}
										placeholder={lastAnalysis.referenceName}
										className="flex-1 bg-card border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-agent"
									/>
									<Button
										onClick={handleSaveStyle}
										className="bg-agent hover:bg-agent/90 text-agent-foreground h-8 px-3 text-[11px] font-semibold rounded-lg gap-1.5"
									>
										<Save className="size-3" />
										Save
									</Button>
								</div>
							</div>
						)}

						{/* Classic Style Library */}
						<div className="space-y-2">
							<div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider border-t border-border pt-3">
								<Library className="size-3" />
								Style Profiles
								<span className="ml-auto font-mono text-[9px] text-muted-foreground/70">
									{styles.length}
								</span>
							</div>
							{styles.length === 0 ? (
								<p className="text-[10px] text-muted-foreground/60 italic">
									No saved style profiles yet.
								</p>
							) : (
								<>
									<div className="space-y-1.5 bg-card/20 border border-border rounded-lg p-2">
										<div className="flex justify-between text-[10px] text-muted-foreground">
											<span>Apply intensity</span>
											<span className="font-mono text-foreground">{applyIntensity}%</span>
										</div>
										<input
											type="range"
											min="10"
											max="100"
											step="5"
											value={applyIntensity}
											onChange={(e) => setMimic({ applyIntensity: Number(e.target.value) })}
											className="w-full h-1 bg-accent rounded-lg appearance-none cursor-pointer accent-agent"
										/>
									</div>
									{styles.map((style) => (
										<div
											key={style.id}
											className="p-2.5 bg-card/30 border border-border rounded-lg space-y-1.5"
										>
											<div className="flex items-center gap-1.5">
												<span className="text-xs font-semibold text-foreground truncate">
													{style.name}
												</span>
												<button
													type="button"
													onClick={() => handleDeleteStyle(style)}
													className="ml-auto p-1 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
												>
													<Trash2 className="size-3" />
												</button>
											</div>
											<p className="text-[9px] text-muted-foreground leading-relaxed line-clamp-2">
												from {style.referenceName}
												{style.summary ? ` — ${style.summary}` : ""}
											</p>
											<Button
												onClick={() => handleApplyStyle(style)}
												disabled={applyingStyleId !== null}
												className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-7 text-[10px] font-semibold rounded-lg gap-1.5"
											>
												{applyingStyleId === style.id ? (
													<>
														<Activity className="size-3 animate-spin" />
														Adapting to your footage…
													</>
												) : (
													<>
														<Wand2 className="size-3" />
														Apply at {applyIntensity}%
													</>
												)}
											</Button>
										</div>
									))}
								</>
							)}
						</div>
					</div>
				)}
			</ScrollArea>
		</div>
	);
}
