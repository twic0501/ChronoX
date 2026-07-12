"use client";

import { useState, useEffect, useRef } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useMimicStore } from "@/stores/mimic-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { useEditorStore } from "@/stores/editor-store";
import { toast } from "sonner";
import { buildTimelineSnapshot } from "../chat-sidebar";
import {
	listStyleCards,
	saveStyleCard,
	deleteStyleCard,
	searchStyleCards,
	type StyleCard,
} from "@/lib/ai/style-library";
import {
	Film,
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
	Image,
	Settings,
} from "lucide-react";

// Grab one downscaled frame (base64 JPEG, no data-URL prefix) from a media
// source URL at `timeSec`, for the vision match-up when a card is dropped.
async function grabOneFrame(
	src: string,
	timeSec: number,
	maxW = 512,
): Promise<string | null> {
	return new Promise((resolve) => {
		const v = document.createElement("video");
		v.muted = true;
		v.crossOrigin = "anonymous";
		v.preload = "auto";
		let done = false;
		const fin = (x: string | null) => {
			if (done) return;
			done = true;
			v.removeAttribute("src");
			v.load();
			resolve(x);
		};
		v.onerror = () => fin(null);
		setTimeout(() => fin(null), 8000);
		v.onloadedmetadata = () => {
			const dur = v.duration || timeSec + 1;
			v.onseeked = () => {
				try {
					const s = Math.min(1, maxW / (v.videoWidth || maxW));
					const c = document.createElement("canvas");
					c.width = Math.max(1, Math.round((v.videoWidth || maxW) * s));
					c.height = Math.max(1, Math.round((v.videoHeight || maxW) * s));
					c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
					fin(c.toDataURL("image/jpeg", 0.8).split(",")[1] || null);
				} catch {
					fin(null);
				}
			};
			v.currentTime = Math.max(0, Math.min(timeSec, dur - 0.05));
		};
		v.src = src;
	});
}

export function MimicTab() {
	const editor = useEditor();
	const tracks = useEditor((e) => e.timeline.getTracks());
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const ghostClips = useEditorStore((s) => s.ghostClips);
	const selectedElementName = selectedElements.length > 0
		? (tracks.find(t => t.id === selectedElements[0].trackId)?.elements.find(e => e.id === selectedElements[0].elementId)?.name || "Selected Clip")
		: "";

	// --- 1. Style Reference Input States ---
	const [urlInput, setUrlInput] = useState("");
	const [uploadedFile, setUploadedFile] = useState<File | null>(null);
	const [isExtracting, setIsExtracting] = useState(false);
	const [uploadProgress, setUploadProgress] = useState(0);

	// --- 2. Extracted & Saved Presets States ---
	const [extractedCards, setExtractedCards] = useState<StyleCard[]>([]);
	const [savedCards, setSavedCards] = useState<StyleCard[]>([]);
	const [expandedCardIds, setExpandedCardIds] = useState<Record<string, boolean>>({});
	const [cardRecipes, setCardRecipes] = useState<Record<string, string>>({});
	const [cardNames, setCardNames] = useState<Record<string, string>>({});
	const [cardTargetTypes, setCardTargetTypes] = useState<Record<string, "timeline" | "selected" | "range">>({});
	const [cardCustomRanges, setCardCustomRanges] = useState<Record<string, { start: string; end: string }>>({});
	const [applyingCardId, setApplyingCardId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const lastProposedOpsRef = useRef<any[]>([]);

	// Load saved presets on mount
	useEffect(() => {
		setSavedCards(listStyleCards());
	}, []);

	// Handle Drag & Drop Preset Application Events
	useEffect(() => {
		const handleApplyTargetEvent = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail && detail.recipeMd && detail.cardId) {
				const card = listStyleCards().find((c) => c.id === detail.cardId) || 
				             extractedCards.find((c) => c.id === detail.cardId);
				if (card) {
					handleApplyCardReview(card, detail.targetType, detail.targetClipId);
				}
			}
		};
		window.addEventListener("apply-preset-to-target", handleApplyTargetEvent);
		return () => {
			window.removeEventListener("apply-preset-to-target", handleApplyTargetEvent);
		};
	}, [extractedCards]);

	// Auto-update backend timeline cache when tracks change
	useEffect(() => {
		if (editor && editor.websocket) {
			try {
				const snapshot = buildTimelineSnapshot(editor);
				editor.websocket.sendMessage("UPDATE_TIMELINE_SNAPSHOT", { snapshot });
			} catch (e) {
				console.error("Failed to push timeline snapshot to backend:", e);
			}
		}
	}, [tracks, editor]);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) {
			setUploadedFile(file);
			setUrlInput(""); // Clear URL input if file is chosen
		}
	};

	const getAiCfg = () => {
		if (typeof window !== "undefined") {
			try {
				const saved = localStorage.getItem("chronox.ai.cfg");
				if (saved) return JSON.parse(saved);
			} catch {}
		}
		return { provider: "gemini", model: "gemini-2.5-flash", apiKey: "" };
	};

	// --- 3. Style Preset Extraction Flow ---
	const handleExtractRecipe = async () => {
		if (!urlInput.trim() && !uploadedFile) {
			toast.error("Please paste a link or upload a video/image file.");
			return;
		}

		setIsExtracting(true);
		setUploadProgress(10);
		const aiCfg = getAiCfg();
		const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

		try {
			let targetUrl: string | undefined = urlInput.trim() || undefined;
			let description: string | undefined = undefined;

			// If local file is uploaded, upload it to the backend first
			if (uploadedFile) {
				setUploadProgress(30);
				const formData = new FormData();
				formData.append("file", uploadedFile);

				const uploadRes = await fetch(`${API_URL}/api/upload`, {
					method: "POST",
					body: formData,
				});

				if (!uploadRes.ok) {
					throw new Error("Failed to upload file to backend.");
				}

				const uploadData = await uploadRes.json();
				targetUrl = uploadData.original_path;
				description = `Local reference file: ${uploadedFile.name}`;
				setUploadProgress(70);
			}

			setUploadProgress(90);
			const res = await fetch(`${API_URL}/api/ai/extract-recipe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: targetUrl,
					description: description,
					provider: aiCfg.provider,
					api_key: aiCfg.apiKey || undefined,
					model: aiCfg.model,
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
			setUploadProgress(0);
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

	// --- 4. Interactive Review Mode Application ---
	const handleApplyCardReview = async (
		card: StyleCard,
		overrideTargetType?: "timeline" | "selected" | "range",
		overrideClipId?: string
	) => {
		const aiCfg = getAiCfg();
		const timelineState = buildTimelineSnapshot(editor);
		const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

		const recipeText = cardRecipes[card.id] || card.recipeMd;
		const targetType = overrideTargetType || cardTargetTypes[card.id] || "timeline";
		
		let targetClipId: string | undefined = overrideClipId;
		if (targetType === "selected" && !targetClipId) {
			if (selectedElements.length === 0) {
				toast.error("Please select a clip on the timeline first.");
				return;
			}
			targetClipId = selectedElements[0].elementId;
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

			// Vision match-up: grab a frame of the target source clip so the
			// backend can adapt the technique to THIS footage, not copy blindly.
			let targetFrame: string | null = null;
			try {
				const allTracks = editor.timeline.getTracks();
				let clip: any = null;
				if (targetClipId) {
					for (const t of allTracks) {
						const f = t.elements.find((e: any) => e.id === targetClipId);
						if (f) {
							clip = f;
							break;
						}
					}
				}
				if (!clip) {
					const vt = allTracks.find((t: any) => t.type === "video");
					clip = vt?.elements?.[0];
				}
				if (clip) {
					const asset = editor.media
						.getAssets()
						.find((a: any) => a.id === clip.mediaId);
					const src =
						asset?.url ||
						(asset?.file ? URL.createObjectURL(asset.file) : null);
					if (src) {
						const rate = clip.retime?.rate ?? 1;
						const mid =
							(clip.trimStart ?? 0) + ((clip.duration ?? 0) * rate) / 2;
						targetFrame = await grabOneFrame(src, mid);
					}
				}
			} catch {}

			// RAG-ground: pull the editor's skill recipe(s) for this card's
			// technique so keyframed builds (zoom/bounce/punch, transitions)
			// follow the documented property paths/presets, not improvisation.
			let skillsContext = "";
			try {
				const { SKILLS } = await import("@/lib/ai/skills");
				const want = new Set<string>();
				if (card.category === "color") want.add("color-grading");
				else if (card.category === "transitions") {
					want.add("transitions");
					want.add("cut-types");
				} else if (card.category === "pacing") {
					want.add("pacing-montage");
					want.add("beat-sync");
				} else if (card.category === "effects") want.add("transform-animation");
				const text = `${card.name} ${card.summary} ${recipeText}`.toLowerCase();
				if (/zoom|bounce|punch|push.?in|ken.?burns|parallax|pop.?in|shake|scale|transform|slide|spin/.test(text))
					want.add("transform-animation");
				if (/whip|dissolve|dip|crossfade|transition|wipe|fade/.test(text))
					want.add("transitions");
				if (/grid|split.?screen|mask|collage/.test(text)) want.add("masks-grid");
				if (/beat|bpm|sync|rhythm|tempo/.test(text)) want.add("beat-sync");
				const parts: string[] = [];
				for (const n of [...want].slice(0, 3)) {
					const s = (SKILLS as any[]).find((x) => x.name === n);
					if (s?.content) parts.push(`## Skill: ${n}\n${s.content}`);
				}
				skillsContext = parts.join("\n\n---\n\n");
			} catch {}

			const res = await fetch(`${API_URL}/api/ai/apply-recipe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					recipe: recipeWithRange,
					timeline_state: timelineState,
					target_clip_id: targetClipId,
					target_frame: targetFrame || undefined,
					skills_context: skillsContext || undefined,
					provider: aiCfg.provider,
					api_key: aiCfg.apiKey || undefined,
					model: aiCfg.model,
				}),
			});

			if (!res.ok) {
				throw new Error("Failed to compile operations.");
			}

			const data = await res.json();
			const ops = data.operations || [];
			lastProposedOpsRef.current = ops;
			if (ops.length === 0) {
				toast.dismiss("apply-recipe");
				toast.info("No timeline changes generated.");
				return;
			}

			// Map operations to visual timeline proposed cards (ghost clips)
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
			toast.success("Edits loaded on timeline. Hover/right-click to edit, or confirm.", { id: "apply-recipe" });
		} catch (err: any) {
			toast.error(err?.message || "Failed to preview preset.", { id: "apply-recipe" });
		} finally {
			setApplyingCardId(null);
		}
	};

	const saveEpisodicDecision = async (op: any, decision: "KEEP" | "REJECT", reason: string) => {
		try {
			const searchable = `${op.action} operation on clip ${op.clip_id || "timeline"}${op.time ? ` at ${op.time.toFixed(1)}s` : ""}`;
			const situation = {
				genre: "general",
				decision_type: op.action === "delete" || op.action === "split" ? "cut_or_keep" : "apply_effect",
			};

			const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
			await fetch(`${API_URL}/api/ai/write-back`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					searchable,
					situation,
					decision,
					reason,
					confidence: 1.0,
					source: "user_timeline_feedback",
					status: "active",
				}),
			});
		} catch (e) {
			console.error("Failed to write back episodic memory:", e);
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

		// Write-back: Compare proposed vs remaining
		lastProposedOpsRef.current.forEach((op) => {
			const isKept = remainingOps.some((rem) => 
				rem.action === op.action && 
				rem.clip_id === op.clip_id && 
				(rem.time === op.time || rem.start === op.start)
			);
			if (isKept) {
				saveEpisodicDecision(op, "KEEP", "User confirmed proposed timeline edit");
			} else {
				saveEpisodicDecision(op, "REJECT", "User discarded proposed timeline edit");
			}
		});

		try {
			const { BatchCommand } = await import("@/lib/commands/batch-command");
			const { dryRunActions } = await import("@/lib/ai/compiler");

			const normalizedOps = remainingOps.map((op) => {
				if (op.action === "trim_cut") {
					return {
						action: "trim",
						clip_id: op.clip_id,
						start: op.end,
						end: 9999,
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
		lastProposedOpsRef.current.forEach((op) => {
			saveEpisodicDecision(op, "REJECT", "User rejected all proposed edits");
		});
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
					cardClass: "border-indigo-500/30 bg-indigo-500/5 hover:bg-indigo-500/10",
					icon: <Palette className="size-3.5 text-indigo-400" />,
					label: "Color Grading",
				};
			case "transitions":
				return {
					badge: "bg-amber-500/10 text-amber-400 border-amber-500/20",
					cardClass: "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10",
					icon: <Zap className="size-3.5 text-amber-400" />,
					label: "Transitions",
				};
			case "pacing":
				return {
					badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
					cardClass: "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10",
					icon: <Clock className="size-3.5 text-emerald-400" />,
					label: "Pacing & Cuts",
				};
			default:
				return {
					badge: "bg-rose-500/10 text-rose-400 border-rose-500/20",
					cardClass: "border-rose-500/30 bg-rose-500/5 hover:bg-rose-500/10",
					icon: <Sparkles className="size-3.5 text-rose-400" />,
					label: "Visual Effect",
				};
		}
	};

	return (
		<div className="flex h-full flex-col bg-background text-foreground p-4 select-none relative">
			{/* Header Controls */}
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
				<div className="space-y-4 pb-24">
					{/* Style Reference Input Panel */}
					<div className="bg-card/30 border border-border rounded-xl p-4 space-y-3">
						<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
							<Film className="size-4 text-agent" />
							<span>Ingest Video or Image Reference</span>
						</div>

						{/* Drag-and-drop file picker */}
						<div className="border border-dashed border-border rounded-lg p-3 bg-card/40 hover:bg-card/60 transition-all flex flex-col items-center justify-center gap-1.5 text-center relative cursor-pointer group">
							<input
								type="file"
								accept="video/*,image/*"
								onChange={handleFileChange}
								className="absolute inset-0 opacity-0 cursor-pointer"
							/>
							{uploadedFile ? (
								<>
									{uploadedFile.type.startsWith("image/") ? (
										<Image className="size-6 text-agent group-hover:scale-110 transition-transform" />
									) : (
										<Video className="size-6 text-agent group-hover:scale-110 transition-transform" />
									)}
									<span className="text-[11px] font-medium max-w-[200px] truncate">
										{uploadedFile.name}
									</span>
								</>
							) : (
								<>
									<UploadCloud className="size-6 text-muted-foreground group-hover:scale-110 transition-transform" />
									<span className="text-[10px] text-muted-foreground">
										Upload local video / image file
									</span>
								</>
							)}
						</div>

						<div className="text-[10px] text-muted-foreground/60 text-center uppercase font-bold">OR</div>

						{/* Paste link input */}
						<div className="space-y-2">
							<input
								type="text"
								value={urlInput}
								onChange={(e) => {
									setUrlInput(e.target.value);
									setUploadedFile(null); // Clear file if URL is typed
								}}
								placeholder="Paste YouTube or video reference link..."
								className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-agent transition-all placeholder:text-muted-foreground/60"
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
									<span>Extracting style presets ({uploadProgress}%)</span>
								</>
							) : (
								<>
									<Sparkles className="size-3.5" />
									<span>Extract Presets (.md)</span>
								</>
							)}
						</Button>
					</div>

					{/* Progress bar during uploads */}
					{isExtracting && uploadProgress > 0 && (
						<Progress value={uploadProgress} className="h-1 bg-card" />
					)}

					{/* Extracted Presets Board */}
					{extractedCards.length > 0 && (
						<div className="space-y-3">
							<h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-1.5">
								<BookOpen className="size-3.5" />
								Extracted Skill Cards
							</h3>
							<div className="space-y-3">
								{extractedCards.map((card) => {
									const cat = getCategoryStyles(card.category);
									const isExpanded = expandedCardIds[card.id];
									const targetType = cardTargetTypes[card.id] || "timeline";

									return (
										<div
											key={card.id}
											draggable
											onDragStart={(e) => {
												e.dataTransfer.setData("text/plain", JSON.stringify({ cardId: card.id, recipeMd: card.recipeMd, targetType: "selected" }));
												e.dataTransfer.effectAllowed = "copy";
											}}
											className={`flex flex-col border rounded-lg p-2.5 transition-all cursor-grab active:cursor-grabbing ${cat.cardClass} relative group hover:border-agent/60 shadow-sm`}
										>
											<div className="flex items-center gap-2 justify-between">
												<div className="flex items-center gap-1.5 min-w-0 flex-1">
													<div className={`p-1 rounded text-xs shrink-0 ${cat.badge}`}>
														{cat.icon}
													</div>
													<div className="min-w-0 flex-1">
														<span className="text-[11px] font-bold text-foreground truncate block">
															{cardNames[card.id] ?? card.name}
														</span>
														<span className="text-[9px] text-muted-foreground truncate block">
															{card.summary || "Drag to clip to apply"}
														</span>
													</div>
												</div>
												
												<div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
													<button
														type="button"
														onClick={() => toggleExpandCard(card.id)}
														className="p-1 rounded hover:bg-card text-muted-foreground hover:text-foreground"
														title="Configure preset"
													>
														<Settings className="size-3" />
													</button>
													<button
														type="button"
														onClick={() => handleSaveCard(card)}
														className="p-1 rounded hover:bg-primary/15 text-muted-foreground hover:text-primary"
														title="Save preset"
													>
														<Save className="size-3" />
													</button>
												</div>
											</div>

											<div className="hidden group-hover:flex absolute -top-2.5 left-1/2 -translate-x-1/2 bg-agent text-white text-[8px] px-1.5 py-0.5 rounded-full font-semibold pointer-events-none shadow z-50">
												Drag to Timeline
											</div>

											{isExpanded && (
												<div className="mt-2 pt-2 border-t border-border/40 space-y-2 text-[10px]">
													<div className="space-y-1">
														<label className="text-[9px] uppercase font-bold text-muted-foreground block">Preset Name</label>
														<input
															type="text"
															value={cardNames[card.id] ?? card.name}
															onChange={(e) => {
																const newName = e.target.value;
																setCardNames((prev) => ({ ...prev, [card.id]: newName }));
															}}
															className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] focus:outline-none focus:border-agent"
														/>
													</div>

													<div className="space-y-1">
														<label className="text-[9px] uppercase font-bold text-muted-foreground block">Recipe Markdown</label>
														<textarea
															value={cardRecipes[card.id] ?? card.recipeMd}
															onChange={(e) => {
																const newRecipe = e.target.value;
																setCardRecipes((prev) => ({ ...prev, [card.id]: newRecipe }));
															}}
															rows={4}
															className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-[9px] focus:outline-none focus:border-agent resize-y"
														/>
													</div>

													<div className="grid grid-cols-2 gap-2 bg-background/20 p-2 rounded-lg border border-border/40">
														<div className="space-y-1">
															<label className="text-[9px] uppercase font-bold text-muted-foreground block">Apply Target</label>
															<select
																value={targetType}
																onChange={(e: any) =>
																	setCardTargetTypes((prev) => ({
																		...prev,
																		[card.id]: e.target.value,
																	}))
																}
																className="w-full bg-card border border-border rounded px-1.5 py-0.5 text-[9px] text-foreground focus:outline-none focus:border-agent"
															>
																<option value="timeline">Entire Timeline</option>
																<option value="selected">Selected Clip</option>
																<option value="range">Custom Range</option>
															</select>
														</div>

														<div className="space-y-1 flex flex-col justify-end">
															{targetType === "range" ? (
																<div className="flex gap-1 items-center">
																	<input
																		type="number"
																		placeholder="Start"
																		value={cardCustomRanges[card.id]?.start ?? card.timeRange?.[0] ?? "0"}
																		onChange={(e) =>
																			setCardCustomRanges((prev) => ({
																				...prev,
																				[card.id]: {
																					start: e.target.value,
																					end: prev[card.id]?.end ?? String(card.timeRange?.[1] ?? "10"),
																				},
																			}))
																		}
																		className="w-full bg-card border border-border rounded px-1 py-0.5 text-[9px] text-center font-mono"
																	/>
																	<span className="text-[9px] text-muted-foreground">to</span>
																	<input
																		type="number"
																		placeholder="End"
																		value={cardCustomRanges[card.id]?.end ?? card.timeRange?.[1] ?? "10"}
																		onChange={(e) =>
																			setCardCustomRanges((prev) => ({
																				...prev,
																				[card.id]: {
																					start: prev[card.id]?.start ?? String(card.timeRange?.[0] ?? "0"),
																					end: e.target.value,
																				},
																			}))
																		}
																		className="w-full bg-card border border-border rounded px-1 py-0.5 text-[9px] text-center font-mono"
																	/>
																</div>
															) : (
																<button
																	onClick={() => handleApplyCardReview(card)}
																	disabled={applyingCardId !== null}
																	className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-6 text-[9px] font-semibold rounded gap-1 flex items-center justify-center"
																>
																	<Wand2 className="size-2.5" /> Apply
																</button>
															)}
														</div>
													</div>
													{targetType === "range" && (
														<button
															onClick={() => handleApplyCardReview(card)}
															disabled={applyingCardId !== null}
															className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-6 text-[9px] font-semibold rounded gap-1 flex items-center justify-center mt-1"
														>
															<Wand2 className="size-2.5" /> Apply to Custom Range
														</button>
													)}
												</div>
											)}
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

						{savedCards.length > 0 && (
							<div className="relative mt-1 mb-2">
								<input
									type="text"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder="Search presets (e.g. 'cinematic', '#color')..."
									className="w-full bg-background border border-border rounded-lg pl-8 pr-8 py-1.5 text-xs text-foreground focus:outline-none focus:border-agent transition-all placeholder:text-muted-foreground/60"
								/>
								<div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
									<Wand2 className="size-3.5" />
								</div>
								{searchQuery && (
									<button
										onClick={() => setSearchQuery("")}
										className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
									>
										<X className="size-3.5" />
									</button>
								)}
							</div>
						)}

						{savedCards.length === 0 ? (
							<p className="text-[10px] text-muted-foreground/60 italic pt-1">
								No saved preset cards yet. Extract a style reference above to generate and save cards.
							</p>
						) : (() => {
							const displayedSavedCards = searchQuery.trim()
								? searchStyleCards(searchQuery)
								: savedCards;

							if (displayedSavedCards.length === 0) {
								return (
									<p className="text-[10px] text-muted-foreground/60 italic pt-2 text-center">
										No matching presets found for "{searchQuery}".
									</p>
								);
							}

							return (
								<div className="space-y-3">
									{displayedSavedCards.map((card) => {
										const cat = getCategoryStyles(card.category);
										const isExpanded = expandedCardIds[card.id];
										const targetType = cardTargetTypes[card.id] || "timeline";

										return (
											<div
												key={card.id}
												draggable
												onDragStart={(e) => {
													e.dataTransfer.setData("text/plain", JSON.stringify({ cardId: card.id, recipeMd: card.recipeMd, targetType: "selected" }));
													e.dataTransfer.effectAllowed = "copy";
												}}
												className={`flex flex-col border rounded-lg p-2.5 transition-all cursor-grab active:cursor-grabbing ${cat.cardClass} relative group hover:border-agent/60 shadow-sm`}
											>
												<div className="flex items-center gap-2 justify-between">
													<div className="flex items-center gap-1.5 min-w-0 flex-1">
														<div className={`p-1 rounded text-xs shrink-0 ${cat.badge}`}>
															{cat.icon}
														</div>
														<div className="min-w-0 flex-1">
															<span className="text-[11px] font-bold text-foreground truncate block">
																{cardNames[card.id] ?? card.name}
															</span>
															<span className="text-[9px] text-muted-foreground truncate block">
																{card.summary || "Drag to clip to apply"}
															</span>
														</div>
													</div>
													
													<div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
														<button
															type="button"
															onClick={() => toggleExpandCard(card.id)}
															className="p-1 rounded hover:bg-card text-muted-foreground hover:text-foreground"
															title="Configure preset"
														>
															<Settings className="size-3" />
														</button>
														<button
															type="button"
															onClick={() => handleDeleteCard(card)}
															className="p-1 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive"
															title="Delete preset"
														>
															<Trash2 className="size-3" />
														</button>
													</div>
												</div>

												<div className="hidden group-hover:flex absolute -top-2.5 left-1/2 -translate-x-1/2 bg-agent text-white text-[8px] px-1.5 py-0.5 rounded-full font-semibold pointer-events-none shadow z-50">
													Drag to Timeline
												</div>

												{isExpanded && (
													<div className="mt-2 pt-2 border-t border-border/40 space-y-2 text-[10px]">
														<div className="space-y-1">
															<label className="text-[9px] uppercase font-bold text-muted-foreground block">Preset Name</label>
															<input
																type="text"
																value={cardNames[card.id] ?? card.name}
																onChange={(e) => {
																	const newName = e.target.value;
																	setCardNames((prev) => ({ ...prev, [card.id]: newName }));
																	saveStyleCard({ ...card, name: newName });
																	setSavedCards(listStyleCards());
																}}
																className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] focus:outline-none focus:border-agent"
															/>
														</div>

														<div className="space-y-1">
															<label className="text-[9px] uppercase font-bold text-muted-foreground block">Recipe Markdown</label>
															<textarea
																value={cardRecipes[card.id] ?? card.recipeMd}
																onChange={(e) => {
																	const newRecipe = e.target.value;
																	setCardRecipes((prev) => ({ ...prev, [card.id]: newRecipe }));
																	saveStyleCard({ ...card, recipeMd: newRecipe });
																	setSavedCards(listStyleCards());
																}}
																rows={4}
																className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-[9px] focus:outline-none focus:border-agent resize-y"
															/>
														</div>

														<div className="grid grid-cols-2 gap-2 bg-background/20 p-2 rounded-lg border border-border/40">
															<div className="space-y-1">
																<label className="text-[9px] uppercase font-bold text-muted-foreground block">Apply Target</label>
																<select
																	value={targetType}
																	onChange={(e: any) =>
																		setCardTargetTypes((prev) => ({
																			...prev,
																			[card.id]: e.target.value,
																			}))
																	}
																	className="w-full bg-card border border-border rounded px-1.5 py-0.5 text-[9px] text-foreground focus:outline-none focus:border-agent"
																>
																	<option value="timeline">Entire Timeline</option>
																	<option value="selected">Selected Clip</option>
																	<option value="range">Custom Range</option>
																</select>
															</div>

															<div className="space-y-1 flex flex-col justify-end">
																{targetType === "range" ? (
																	<div className="flex gap-1 items-center">
																		<input
																			type="number"
																			placeholder="Start"
																			value={cardCustomRanges[card.id]?.start ?? card.timeRange?.[0] ?? "0"}
																			onChange={(e) =>
																				setCardCustomRanges((prev) => ({
																					...prev,
																					[card.id]: {
																						start: e.target.value,
																						end: prev[card.id]?.end ?? String(card.timeRange?.[1] ?? "10"),
																					},
																				}))
																			}
																			className="w-full bg-card border border-border rounded px-1 py-0.5 text-[9px] text-center font-mono"
																		/>
																		<span className="text-[9px] text-muted-foreground">to</span>
																		<input
																			type="number"
																			placeholder="End"
																			value={cardCustomRanges[card.id]?.end ?? card.timeRange?.[1] ?? "10"}
																			onChange={(e) =>
																				setCardCustomRanges((prev) => ({
																					...prev,
																					[card.id]: {
																						start: prev[card.id]?.start ?? String(card.timeRange?.[0] ?? "0"),
																						end: e.target.value,
																					},
																				}))
																			}
																			className="w-full bg-card border border-border rounded px-1 py-0.5 text-[9px] text-center font-mono"
																		/>
																	</div>
																) : (
																	<button
																		onClick={() => handleApplyCardReview(card)}
																		disabled={applyingCardId !== null}
																		className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-6 text-[9px] font-semibold rounded gap-1 flex items-center justify-center"
																	>
																		<Wand2 className="size-2.5" /> Apply
																	</button>
																)}
															</div>
														</div>
														{targetType === "range" && (
															<button
																onClick={() => handleApplyCardReview(card)}
																disabled={applyingCardId !== null}
																className="w-full bg-agent/15 hover:bg-agent/25 text-agent border border-agent/30 h-6 text-[9px] font-semibold rounded gap-1 flex items-center justify-center mt-1"
															>
																<Wand2 className="size-2.5" /> Apply to Custom Range
															</button>
														)}
													</div>
												)}
											</div>
									);
								})}
							</div>
						);
					})()}
				</div>
				</div>
			</ScrollArea>
		</div>
	);
}
