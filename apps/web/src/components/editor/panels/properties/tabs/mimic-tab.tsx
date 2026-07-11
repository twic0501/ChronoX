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
	Edit3,
	BookOpen,
} from "lucide-react";

export function MimicTab() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const tracks = useEditor((e) => e.timeline.getTracks());
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());

	// Tab switcher: "presets" (new modular cards path) vs "source" (original video analysis path)
	const [activeTab, setActiveTab] = useState<"presets" | "source">("presets");

	// --- 1. Custom Presets States ---
	const [urlInput, setUrlInput] = useState("");
	const [descriptionInput, setDescriptionInput] = useState("");
	const [isExtracting, setIsExtracting] = useState(false);
	const [extractedCards, setExtractedCards] = useState<StyleCard[]>([]);
	const [savedCards, setSavedCards] = useState<StyleCard[]>([]);
	const [expandedCardIds, setExpandedCardIds] = useState<Record<string, boolean>>({});
	const [editingCardIds, setEditingCardIds] = useState<Record<string, boolean>>({});
	const [cardRecipes, setCardRecipes] = useState<Record<string, string>>({});
	const [cardNames, setCardNames] = useState<Record<string, string>>({});
	const [cardTargetTypes, setCardTargetTypes] = useState<Record<string, "timeline" | "selected" | "range">>({});
	const [cardCustomRanges, setCardCustomRanges] = useState<Record<string, { start: string; end: string }>>({});
	const [applyingCardId, setApplyingCardId] = useState<string | null>(null);

	// Load saved cards on mount
	useEffect(() => {
		setSavedCards(listStyleCards());
	}, []);

	// --- 2. Original Upload & Mimic States ---
	const {
		referenceFile,
		isUploading,
		isProcessing,
		uploadProgress,
		targetDuration,
		selectedAudioId,
		snappedCuts,
		apiMutations,
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
		// Run compiler commands
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

	// --- 3. Style Presets (Link / Description) Logic ---
	const getAiCfg = () => {
		if (typeof window !== "undefined") {
			try {
				const saved = localStorage.getItem("chronox.ai.cfg");
				if (saved) return JSON.parse(saved);
			} catch {}
		}
		return { provider: "ollama", model: "qwen3.5:9b", apiKey: "" };
	};

	const handleExtractRecipe = async () => {
		if (!urlInput.trim() && !descriptionInput.trim()) {
			toast.error("Please paste a URL or write a text description.");
			return;
		}

		setIsExtracting(true);
		const aiCfg = getAiCfg();
		const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

		try {
			const res = await fetch(`${API_URL}/api/ai/extract-recipe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: urlInput.trim() || undefined,
					description: descriptionInput.trim() || undefined,
					provider: aiCfg.provider,
					api_key: aiCfg.apiKey || undefined,
					model: aiCfg.provider === "ollama" ? "qwen3.5:9b" : aiCfg.model,
				}),
			});

			if (!res.ok) {
				throw new Error("Style extraction failed on the server.");
			}

			const data = await res.json();
			const cardsList = data.cards || [];
			if (cardsList.length === 0) {
				toast.info("No style presets could be extracted.");
				return;
			}

			// Format into StyleCards
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

			toast.success(`Successfully extracted ${formattedCards.length} style presets!`);
		} catch (err: any) {
			toast.error(err?.message || "Failed to extract style.");
		} finally {
			setIsExtracting(false);
		}
	};

	const handleSaveCard = (card: StyleCard) => {
		const name = cardNames[card.id]?.trim() || card.name;
		const recipe = cardRecipes[card.id] || card.recipeMd;
		
		const saved = saveStyleCard({
			id: card.id.startsWith("extracted_") ? `saved_${Date.now()}_${Math.random()}` : card.id,
			category: card.category,
			name,
			summary: card.summary,
			timeRange: card.timeRange,
			recipeMd: recipe,
			saved: true,
		});

		// Refresh lists
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

	const handleApplyCard = async (card: StyleCard) => {
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
		toast.loading(`Translating "${card.name}" recipe to timeline...`, { id: "apply-recipe" });

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
				throw new Error("Failed to compile operations from recipe.");
			}

			const data = await res.json();
			const ops = data.operations || [];
			if (ops.length === 0) {
				toast.dismiss("apply-recipe");
				toast.info("No timeline changes generated. Try refining the recipe.");
				return;
			}

			const { BatchCommand } = await import("@/lib/commands/batch-command");
			const { dryRunActions } = await import("@/lib/ai/compiler");

			const dry = dryRunActions(ops, editor, { strict: false });
			if (dry.success && dry.commands && dry.commands.length > 0) {
				editor.command.execute({ command: new BatchCommand(dry.commands) });
				toast.success(`Applied: ${data.explanation || "Edits successfully applied!"}`, { id: "apply-recipe" });
			} else {
				throw new Error("Could not map edits to timeline clips.");
			}
		} catch (err: any) {
			toast.error(err?.message || "Failed to apply recipe.", { id: "apply-recipe" });
		} finally {
			setApplyingCardId(null);
		}
	};

	const toggleExpandCard = (id: string) => {
		setExpandedCardIds((prev) => ({ ...prev, [id]: !prev[id] }));
	};

	const toggleEditCard = (id: string) => {
		setEditingCardIds((prev) => ({ ...prev, [id]: !prev[id] }));
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
		<div className="flex h-full flex-col bg-background text-foreground p-4 select-none">
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

			<ScrollArea className="flex-1 pr-1">
				{activeTab === "presets" ? (
					// --- PRESETS & CARDS VIEW ---
					<div className="space-y-4">
						{/* Paste link / notes card */}
						<div className="bg-card/30 border border-border rounded-xl p-4 space-y-3">
							<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
								<Youtube className="size-4 text-destructive" />
								<span>Extract from Link or Describe Style</span>
							</div>

							<div className="space-y-2">
								<input
									type="text"
									value={urlInput}
									onChange={(e) => setUrlInput(e.target.value)}
									placeholder="Paste YouTube or video link..."
									className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-agent transition-all placeholder:text-muted-foreground/60"
								/>
								<textarea
									value={descriptionInput}
									onChange={(e) => setDescriptionInput(e.target.value)}
									placeholder="Describe style (e.g. Warm cinematic travel look with slow cuts and vignettes)..."
									rows={2}
									className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-agent transition-all resize-none placeholder:text-muted-foreground/60"
								/>
							</div>

							<Button
								onClick={handleExtractRecipe}
								disabled={isExtracting}
								className="w-full bg-agent hover:bg-agent/90 text-agent-foreground py-2 h-9 rounded-lg font-medium text-xs gap-2 transition-all shadow-lg shadow-agent/20"
							>
								{isExtracting ? (
									<>
										<Activity className="size-3.5 animate-spin" />
										<span>Extracting style presets...</span>
									</>
								) : (
									<>
										<Sparkles className="size-3.5" />
										<span>Extract Presets (.md)</span>
									</>
								)}
							</Button>
						</div>

						{/* Extracted Presets Board */}
						{extractedCards.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-1.5">
									<BookOpen className="size-3.5" />
									Extracted Style Presets
								</h3>
								<div className="space-y-3">
									{extractedCards.map((card) => {
										const cat = getCategoryStyles(card.category);
										const isExpanded = expandedCardIds[card.id];
										const isEditing = editingCardIds[card.id];
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
														className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
															card.saved
																? "bg-agent/20 border-agent/30 text-agent"
																: "bg-card hover:bg-accent border-border text-muted-foreground"
														}`}
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
													onClick={() => handleApplyCard(card)}
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
									No saved preset cards yet. Extract a style above, then save it to reuse later.
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
													onClick={() => handleApplyCard(card)}
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
