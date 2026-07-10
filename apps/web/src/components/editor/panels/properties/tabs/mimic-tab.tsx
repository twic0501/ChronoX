"use client";

import { useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useMimicStore } from "@/stores/mimic-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { useEditorStore } from "@/stores/editor-store";
import { SplitElementsCommand } from "@/lib/commands/timeline";
import { buildDefaultMaskInstance } from "@/lib/masks";
import { buildDefaultEffectInstance } from "@/lib/effects";
import { toast } from "sonner";
import {
	listStyles,
	saveStyle,
	deleteStyle,
	type SavedStyle,
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
} from "lucide-react";

export function MimicTab() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const tracks = useEditor((e) => e.timeline.getTracks());

	// All mimic state lives in a zustand store so switching to another tab
	// (which unmounts this component) never loses an analysis or settings.
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

	// ── Style Library: persist extracted styles, re-apply anywhere ──
	const [styles, setStyles] = useState<SavedStyle[]>(() => listStyles());
	const [applyingStyleId, setApplyingStyleId] = useState<string | null>(null);

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

	// Get all audio elements in the project
	const audioElements = tracks
		.filter((t) => t.type === "audio")
		.flatMap((t) => t.elements);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) setReferenceFile(file);
	};

	const handleMimicFlow = async () => {
		if (!referenceFile) {
			toast.error("Please upload a reference video file first.");
			return;
		}

		// Find selected audio element path if not "none"
		let targetAudioPath: string | null = null;
		if (selectedAudioId !== "none") {
			const selectedAudio = audioElements.find((a) => a.id === selectedAudioId);
			if (selectedAudio) {
				targetAudioPath =
					(selectedAudio as any)?.sourceOriginalPath ||
					(selectedAudio as any)?.sourceProxyPath ||
					null;
			}
		}

		// Find selected target video element path (first video element on V1 track)
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
			// 1. Upload reference video using the existing upload API
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

			// 2. Call Mimic Flow API
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
					// Keep the measured profile so the user can persist it as a
					// reusable style in the library.
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

				// Display cuts as Ghost Clips on the timeline
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
				toast.success(
					"Mimic Analysis completed! Proposed cuts and styles are mapped.",
				);
			} else {
				throw new Error(mimicData.error || "Analysis failed.");
			}
		} catch (error: any) {
			console.error("Mimic Flow failed:", error);
			toast.error(
				error.message || "An error occurred during mimic processing.",
			);
			setMimic({ isUploading: false, isProcessing: false });
		}
	};

	const acceptCuts = () => {
		if (snappedCuts.length === 0) return;

		// Perform cuts sequentially
		let cutsApplied = 0;
		for (const cutTime of snappedCuts) {
			const currentTracks = editor.timeline.getTracks();
			const videoTrack = currentTracks.find((t) => t.type === "video");
			if (!videoTrack) break;

			// Find element that spans across cutTime
			const elementToSplit = videoTrack.elements.find(
				(el) => el.startTime < cutTime && el.startTime + el.duration > cutTime,
			);

			if (elementToSplit) {
				const cmd = new SplitElementsCommand({
					elements: [{ trackId: videoTrack.id, elementId: elementToSplit.id }],
					splitTime: cutTime,
				});
				editor.command.execute({ command: cmd });
				cutsApplied++;
			}
		}

		// Apply visual styles sequentially to the newly split segments
		const currentTracks = editor.timeline.getTracks();
		const videoTrack = currentTracks.find((t) => t.type === "video");
		if (videoTrack) {
			const sortedElements = [...videoTrack.elements].sort(
				(a, b) => a.startTime - b.startTime,
			);

			sortedElements.forEach((el, clipIdx) => {
				const clipMutations = apiMutations.filter(
					(m: any) => m.clip_index === clipIdx,
				);

				clipMutations.forEach((m: any) => {
					if (m.action === "APPLY_SPEED_RAMP") {
						editor.timeline.updateElementRetime({
							trackId: videoTrack.id,
							elementId: el.id,
							retime: {
								rate: m.speed || 1.5,
								maintainPitch: true,
								curve: m.curve,
							},
						});
					} else if (m.action === "ADJUST_COLOR") {
						try {
							const effectInstance = buildDefaultEffectInstance({
								effectType: "color-adjust",
							});
							effectInstance.params = {
								...effectInstance.params,
								brightness:
									m.params?.brightness !== undefined
										? m.params.brightness - 1.0
										: 0.05,
								contrast:
									m.params?.contrast !== undefined
										? m.params.contrast - 1.0
										: 0.15,
								saturation:
									m.params?.saturation !== undefined
										? m.params.saturation - 1.0
										: -0.05,
							};
							const currentEffects = el.effects || [];
							editor.timeline.updateElements({
								updates: [
									{
										trackId: videoTrack.id,
										elementId: el.id,
										updates: {
											effects: [...currentEffects, effectInstance],
										} as any,
									},
								],
							});
						} catch (err) {
							console.error("Failed to add color-adjust:", err);
						}
					} else if (m.action === "ADD_ZOOM") {
						// Apply subject-centered zoom transform
						editor.timeline.updateElements({
							updates: [
								{
									trackId: videoTrack.id,
									elementId: el.id,
									updates: {
										transform: {
											position: {
												x: -(m.centerX || 0.0) * 100,
												y: -(m.centerY || 0.0) * 100,
											},
											scaleX: m.scale || 1.5,
											scaleY: m.scale || 1.5,
											rotate: 0,
										},
									} as any,
								},
							],
						});
					} else if (m.action === "ADD_MASK") {
						// Build split screen mask
						try {
							const maskInstance = buildDefaultMaskInstance({
								maskType: "split",
							});
							const currentMasks = el.masks || [];
							editor.timeline.updateElements({
								updates: [
									{
										trackId: videoTrack.id,
										elementId: el.id,
										updates: {
											masks: [...currentMasks, maskInstance],
										} as any,
									},
								],
							});
						} catch (err) {
							console.error("Failed to add split mask:", err);
						}
					} else if (m.action === "ADD_EFFECT") {
						// Build vignette/blur/lut_grade effect
						try {
							const effectInstance = buildDefaultEffectInstance({
								effectType: m.effect_type || "vignette",
							});
							const currentEffects = el.effects || [];
							editor.timeline.updateElements({
								updates: [
									{
										trackId: videoTrack.id,
										elementId: el.id,
										updates: {
											effects: [...currentEffects, effectInstance],
										} as any,
									},
								],
							});
						} catch (err) {
							console.error("Failed to add effect:", err);
						}
					}
				});
			});
		}

		useEditorStore.getState().clearGhostClips();
		clearProposal();
		toast.success(
			`Successfully applied ${cutsApplied} snapped cuts and style match properties to the timeline!`,
		);
	};

	const discardCuts = () => {
		useEditorStore.getState().clearGhostClips();
		clearProposal();
		toast.info("Proposed cuts discarded.");
	};

	return (
		<div className="flex h-full flex-col bg-background text-foreground p-4 select-none">
			<div className="flex items-center gap-2 mb-4">
				<div className="p-1.5 rounded-lg bg-agent/10 text-agent">
					<Sparkles className="size-4" />
				</div>
				<div>
					<h2 className="text-sm font-semibold tracking-tight text-foreground">
						AI Mimic Engine
					</h2>
					<p className="text-[10px] text-muted-foreground">
						Reverse-engineer visual style & sync to beats
					</p>
				</div>
			</div>

			<ScrollArea className="flex-1 pr-1">
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
								<span className="font-mono text-foreground">
									{targetDuration}s
								</span>
							</div>
							<input
								type="range"
								min="5"
								max="60"
								step="1"
								value={targetDuration}
								onChange={(e) =>
									setMimic({ targetDuration: Number(e.target.value) })
								}
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
					{isUploading && (
						<Progress value={uploadProgress} className="h-1 bg-card" />
					)}

					{/* Mimic Result Statistics / Confirmation */}
					{mimicStats && snappedCuts.length > 0 && (
						<div className="mt-4 p-3 bg-agent/10 border border-agent/25 rounded-lg space-y-3">
							<div className="flex items-center gap-1.5 text-xs text-agent font-semibold">
								<Activity className="size-3.5" />
								<span>Mimic Solution Detected</span>
							</div>
							<div className="grid grid-cols-3 gap-2 text-center bg-background/40 p-2 rounded border border-border">
								<div>
									<div className="text-[9px] text-muted-foreground uppercase font-medium">
										BPM
									</div>
									<div className="text-xs font-mono font-bold text-foreground">
										{mimicStats.tempoBpm
											? Math.round(mimicStats.tempoBpm)
											: "--"}
									</div>
								</div>
								<div>
									<div className="text-[9px] text-muted-foreground uppercase font-medium">
										Beats
									</div>
									<div className="text-xs font-mono font-bold text-foreground">
										{mimicStats.totalBeats || "--"}
									</div>
								</div>
								<div>
									<div className="text-[9px] text-muted-foreground uppercase font-medium">
										Cuts
									</div>
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

					{/* Save extracted style to the library */}
					{lastAnalysis && (
						<div className="p-3 bg-card/20 border border-border rounded-lg space-y-2">
							<div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
								<Save className="size-3" />
								Save this style
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

					{/* Style Library */}
					<div className="space-y-2">
						<div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
							<Library className="size-3" />
							Style Library
							<span className="ml-auto font-mono normal-case text-muted-foreground/70">
								{styles.length}
							</span>
						</div>
						{styles.length === 0 ? (
							<p className="text-[10px] text-muted-foreground/60 italic">
								No saved styles yet — extract a style above, then save it to
								reuse on any project.
							</p>
						) : (
							<>
								<div className="space-y-1.5 bg-card/20 border border-border rounded-lg p-2">
									<div className="flex justify-between text-[10px] text-muted-foreground">
										<span>Apply intensity</span>
										<span className="font-mono text-foreground">
											{applyIntensity}%
										</span>
									</div>
									<input
										type="range"
										min="10"
										max="100"
										step="5"
										value={applyIntensity}
										onChange={(e) =>
											setMimic({ applyIntensity: Number(e.target.value) })
										}
										className="w-full h-1 bg-accent rounded-lg appearance-none cursor-pointer accent-agent"
									/>
									<p className="text-[9px] text-muted-foreground/60">
										Below 100% the style is blended in — parameters, grades and
										transition density scale down instead of copying exactly.
									</p>
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
												title="Delete style"
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
			</ScrollArea>
		</div>
	);
}
