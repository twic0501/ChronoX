"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useSoundSearch } from "@/hooks/use-sound-search";
import { useSoundsStore } from "@/stores/sounds-store";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import type { SavedSound, SoundEffect } from "@/lib/sounds/types";
import { cn } from "@/utils/ui";
import {
	FavouriteIcon,
	FilterMailIcon,
	PauseIcon,
	PlayIcon,
	PlusSignIcon,
	CloudUploadIcon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEditor } from "@/hooks/use-editor";
import { useFileUpload } from "@/hooks/use-file-upload";
import { processMediaAssets } from "@/lib/media/processing";
import { showMediaUploadToast } from "@/lib/media/upload-toast";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { invokeAction } from "@/lib/actions";
import type { MediaAsset } from "@/lib/media/types";
import { toast } from "sonner";
import { setDragData, clearDragData } from "@/lib/drag-data";

export function SoundsView() {
	return (
		<div className="flex h-full flex-col">
			<Tabs defaultValue="sound-effects" className="flex h-full flex-col">
				<div className="px-3 pt-4 pb-0">
					<TabsList>
						<TabsTrigger value="sound-effects">Sound effects</TabsTrigger>
						<TabsTrigger value="saved">Saved</TabsTrigger>
						<TabsTrigger value="imported">My audio</TabsTrigger>
					</TabsList>
				</div>
				<Separator className="my-4" />
				<TabsContent
					value="sound-effects"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SoundEffectsView />
				</TabsContent>
				<TabsContent
					value="saved"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SavedSoundsView />
				</TabsContent>
				<TabsContent
					value="imported"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<ImportedSoundsView />
				</TabsContent>
			</Tabs>
		</div>
	);
}

function SoundEffectsView() {
	const {
		topSoundEffects,
		isLoading,
		searchQuery,
		setSearchQuery,
		scrollPosition,
		setScrollPosition,
		loadSavedSounds,
		showCommercialOnly,
		toggleCommercialFilter,
		hasLoaded,
		setTopSoundEffects,
		setLoading,
		setError,
		setHasLoaded,
		setCurrentPage,
		setHasNextPage,
		setTotalCount,
	} = useSoundsStore();
	const {
		results: searchResults,
		isLoading: isSearching,
		loadMore,
		hasNextPage,
		isLoadingMore,
	} = useSoundSearch({
		query: searchQuery,
		commercialOnly: showCommercialOnly,
	});

	const [playingId, setPlayingId] = useState<number | null>(null);
	const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
		null,
	);

	const { scrollAreaRef, handleScroll } = useInfiniteScroll({
		onLoadMore: loadMore,
		hasMore: hasNextPage,
		isLoading: isLoadingMore || isSearching,
	});

	useEffect(() => {
		loadSavedSounds();
	}, [loadSavedSounds]);

	useEffect(() => {
		if (hasLoaded) {
			return;
		}

		let shouldIgnore = false;

		const fetchTopSounds = async () => {
			try {
				if (!shouldIgnore) {
					setLoading({ loading: true });
					setError({ error: null });
				}

				const response = await fetch(
					"/api/sounds/search?page_size=50&sort=downloads",
				);

				if (!shouldIgnore) {
					if (!response.ok) {
						throw new Error(`Failed to fetch: ${response.status}`);
					}

					const data = await response.json();
					setTopSoundEffects({ sounds: data.results });
					setHasLoaded({ loaded: true });

					setCurrentPage({ page: 1 });
					setHasNextPage({ hasNext: !!data.next });
					setTotalCount({ count: data.count });
				}
			} catch (error) {
				if (!shouldIgnore) {
					console.error("Failed to fetch top sounds:", error);
					setError({
						error:
							error instanceof Error ? error.message : "Failed to load sounds",
					});
				}
			} finally {
				if (!shouldIgnore) {
					setLoading({ loading: false });
				}
			}
		};

		const timeoutId = setTimeout(fetchTopSounds, 100, {});

		return () => {
			shouldIgnore = true;
			clearTimeout(timeoutId);
		};
	}, [
		hasLoaded,
		setTopSoundEffects,
		setLoading,
		setError,
		setHasLoaded,
		setCurrentPage,
		setHasNextPage,
		setTotalCount,
	]);

	useEffect(() => {
		if (!scrollAreaRef.current || scrollPosition <= 0) {
			return;
		}

		const restoreScrollPosition = () => {
			scrollAreaRef.current?.scrollTo({ top: scrollPosition });
		};

		const timeoutId = setTimeout(restoreScrollPosition, 100, {});

		return () => clearTimeout(timeoutId);
	}, [scrollPosition, scrollAreaRef]);

	const handleScrollWithPosition = ({
		currentTarget,
	}: React.UIEvent<HTMLDivElement>) => {
		const { scrollTop } = currentTarget;
		setScrollPosition({ position: scrollTop });
		handleScroll({ currentTarget } as React.UIEvent<HTMLDivElement>);
	};

	const displayedSounds = searchQuery ? searchResults : topSoundEffects;

	const playSound = ({ sound }: { sound: SoundEffect }) => {
		if (playingId === sound.id) {
			audioElement?.pause();
			setPlayingId(null);
			return;
		}

		audioElement?.pause();

		if (sound.previewUrl) {
			const audio = new Audio(sound.previewUrl);
			audio.addEventListener("ended", () => {
				setPlayingId(null);
			});
			audio.addEventListener("error", () => {
				setPlayingId(null);
			});
			audio.play().catch((error) => {
				console.error("Failed to play sound preview:", error);
				setPlayingId(null);
			});

			setAudioElement(audio);
			setPlayingId(sound.id);
		}
	};

	const { setActiveTab } = useAssetsPanelStore();

	return (
		<div className="mt-1 flex h-full flex-col gap-5">
			<div className="flex items-center gap-3">
				<Input
					placeholder="Search sound effects"
					className="w-full"
					containerClassName="w-full"
					value={searchQuery}
					onChange={({ currentTarget }) =>
						setSearchQuery({ query: currentTarget.value })
					}
					showClearIcon
					onClear={() => setSearchQuery({ query: "" })}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="text"
							size="icon"
							className={cn(showCommercialOnly && "text-primary")}
						>
							<HugeiconsIcon icon={FilterMailIcon} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuCheckboxItem
							checked={showCommercialOnly}
							onCheckedChange={() => toggleCommercialFilter()}
						>
							Show only commercially licensed
						</DropdownMenuCheckboxItem>
						<div className="text-muted-foreground px-2 py-1.5 text-xs">
							{showCommercialOnly
								? "Only showing sounds licensed for commercial use"
								: "Showing all sounds regardless of license"}
						</div>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="relative h-full overflow-hidden">
				<ScrollArea
					className="h-full flex-1"
					ref={scrollAreaRef}
					onScrollCapture={handleScrollWithPosition}
				>
					<div className="flex flex-col gap-4">
						{isLoading && !searchQuery && (
							<div className="text-muted-foreground text-sm">
								Loading sounds...
							</div>
						)}
						{isSearching && searchQuery && (
							<div className="text-muted-foreground text-sm">Searching...</div>
						)}
						{displayedSounds.map((sound) => (
							<AudioItem
								key={sound.id}
								sound={sound}
								isPlaying={playingId === sound.id}
								onPlay={playSound}
							/>
						))}
						{!isLoading && !isSearching && displayedSounds.length === 0 && (
							<div className="flex flex-col items-center justify-center p-6 border rounded-lg border-dashed bg-muted/10 gap-3 text-center">
								<span className="text-muted-foreground text-xs leading-relaxed max-w-[240px]">
									Looking to use your own music or sound effects? Upload them directly to your Media Library.
								</span>
								<Button
									variant="outline"
									size="sm"
									className="text-xs h-8 cursor-pointer"
									onClick={() => setActiveTab("media")}
								>
									Go to Media Library
								</Button>
							</div>
						)}
						{isLoadingMore && (
							<div className="text-muted-foreground py-4 text-center text-sm">
								Loading more sounds...
							</div>
						)}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}

function SavedSoundsView() {
	const {
		savedSounds,
		isLoadingSavedSounds,
		savedSoundsError,
		loadSavedSounds,
		clearSavedSounds,
	} = useSoundsStore();

	const [playingId, setPlayingId] = useState<number | null>(null);
	const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
		null,
	);

	const [showClearDialog, setShowClearDialog] = useState(false);

	useEffect(() => {
		loadSavedSounds();
	}, [loadSavedSounds]);

	const playSound = ({ sound }: { sound: SoundEffect }) => {
		if (playingId === sound.id) {
			audioElement?.pause();
			setPlayingId(null);
			return;
		}

		audioElement?.pause();

		if (sound.previewUrl) {
			const audio = new Audio(sound.previewUrl);
			audio.addEventListener("ended", () => {
				setPlayingId(null);
			});
			audio.addEventListener("error", () => {
				setPlayingId(null);
			});
			audio.play().catch((error) => {
				console.error("Failed to play sound preview:", error);
				setPlayingId(null);
			});

			setAudioElement(audio);
			setPlayingId(sound.id);
		}
	};

	const convertToSoundEffect = ({
		savedSound,
	}: {
		savedSound: SavedSound;
	}): SoundEffect => ({
		id: savedSound.id,
		name: savedSound.name,
		description: "",
		url: "",
		previewUrl: savedSound.previewUrl,
		downloadUrl: savedSound.downloadUrl,
		duration: savedSound.duration,
		filesize: 0,
		type: "audio",
		channels: 0,
		bitrate: 0,
		bitdepth: 0,
		samplerate: 0,
		username: savedSound.username,
		tags: savedSound.tags,
		license: savedSound.license,
		created: savedSound.savedAt,
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	});

	if (isLoadingSavedSounds) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-muted-foreground text-sm">
					Loading saved sounds...
				</div>
			</div>
		);
	}

	if (savedSoundsError) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-destructive text-sm">
					Error: {savedSoundsError}
				</div>
			</div>
		);
	}

	if (savedSounds.length === 0) {
		return (
			<div className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4">
				<HugeiconsIcon
					icon={FavouriteIcon}
					className="text-muted-foreground size-10"
				/>
				<div className="flex flex-col gap-2 text-center">
					<p className="text-lg font-medium">No saved sounds</p>
					<p className="text-muted-foreground text-sm text-balance">
						Click the heart icon on any sound to save it here
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="mt-1 flex h-full flex-col gap-5">
			<div className="flex items-center justify-between">
				<p className="text-muted-foreground text-sm">
					{savedSounds.length} saved{" "}
					{savedSounds.length === 1 ? "sound" : "sounds"}
				</p>
				<Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
					<DialogTrigger asChild>
						<Button
							variant="text"
							size="sm"
							className="text-muted-foreground hover:text-destructive h-auto !opacity-100"
						>
							Clear all
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Clear all saved sounds?</DialogTitle>
							<DialogDescription>
								This will permanently remove all {savedSounds.length} saved
								sounds from your collection. This action cannot be undone.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="text" onClick={() => setShowClearDialog(false)}>
								Cancel
							</Button>
							<Button
								variant="destructive"
								onClick={async ({
									stopPropagation,
								}: React.MouseEvent<HTMLButtonElement>) => {
									stopPropagation();
									await clearSavedSounds();
									setShowClearDialog(false);
								}}
							>
								Clear all sounds
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			<div className="relative h-full overflow-hidden">
				<ScrollArea className="h-full flex-1">
					<div className="flex flex-col gap-4">
						{savedSounds.map((sound) => (
							<AudioItem
								key={sound.id}
								sound={convertToSoundEffect({ savedSound: sound })}
								isPlaying={playingId === sound.id}
								onPlay={playSound}
							/>
						))}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}

interface AudioItemProps {
	sound: SoundEffect;
	isPlaying: boolean;
	onPlay: ({ sound }: { sound: SoundEffect }) => void;
}

function AudioItem({ sound, isPlaying, onPlay }: AudioItemProps) {
	const { addSoundToTimeline, isSoundSaved, toggleSavedSound } =
		useSoundsStore();
	const isSaved = isSoundSaved({ soundId: sound.id });

	const handleClick = () => {
		onPlay({ sound });
	};

	const handleSaveClick = ({
		stopPropagation,
	}: React.MouseEvent<HTMLButtonElement>) => {
		stopPropagation();
		toggleSavedSound({ soundEffect: sound });
	};

	const handleAddToTimeline = async ({
		stopPropagation,
	}: React.MouseEvent<HTMLButtonElement>) => {
		stopPropagation();
		await addSoundToTimeline({ sound });
	};

	const handleDragStart = (e: React.DragEvent) => {
		const dragData = {
			id: String(sound.id),
			type: "media" as const,
			mediaType: "audio" as const,
			name: sound.name,
			sourceUrl: sound.previewUrl,
			duration: sound.duration,
		};
		setDragData({ dataTransfer: e.dataTransfer, dragData });
		e.dataTransfer.effectAllowed = "copy";
	};

	const handleDragEnd = () => {
		clearDragData();
	};

	return (
		<div className="group flex items-center gap-3 opacity-100 hover:opacity-75">
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-grab active:cursor-grabbing"
				onClick={handleClick}
				draggable="true"
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
			>
				<div className="bg-accent relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md">
					<div className="from-primary/20 absolute inset-0 bg-gradient-to-br to-transparent" />
					{isPlaying ? (
						<HugeiconsIcon icon={PauseIcon} className="size-5" />
					) : (
						<HugeiconsIcon icon={PlayIcon} className="size-5" />
					)}
				</div>

				<div className="min-w-0 flex-1 overflow-hidden">
					<p className="truncate text-sm font-medium">{sound.name}</p>
					<span className="text-muted-foreground block truncate text-xs">
						{sound.username}
					</span>
				</div>
			</button>

			<div className="flex items-center gap-3 pr-2">
				<Button
					variant="text"
					size="icon"
					className="text-muted-foreground hover:text-foreground w-auto !opacity-100"
					onClick={handleAddToTimeline}
					title="Add to timeline"
				>
					<HugeiconsIcon icon={PlusSignIcon} />
				</Button>
				<Button
					variant="text"
					size="icon"
					className={`hover:text-foreground w-auto !opacity-100 ${
						isSaved
							? "text-destructive hover:text-destructive"
							: "text-muted-foreground"
					}`}
					onClick={handleSaveClick}
					title={isSaved ? "Remove from saved" : "Save sound"}
				>
					<HugeiconsIcon
						icon={FavouriteIcon}
						className={`${isSaved ? "fill-current" : ""}`}
					/>
				</Button>
			</div>
		</div>
	);
}

function ImportedSoundsView() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const mediaFiles = useEditor((e) => e.media.getAssets());

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

	useEffect(() => {
		if (activeProject && !mediaFiles.some((m) => m.name === "dummy_audio.wav")) {
			const dummyBlob = new Blob([], { type: "audio/wav" });
			const dummyFile = new File([dummyBlob], "dummy_audio.wav", { type: "audio/wav" });
			editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: {
					name: "dummy_audio.wav",
					type: "audio",
					file: dummyFile,
					url: "/dummy_audio.wav",
					duration: 1.0,
					ephemeral: false,
				},
			});
		}
	}, [activeProject, mediaFiles, editor]);

	const audioAssets = useMemo(() => {
		return mediaFiles.filter((asset) => asset.type === "audio" && !asset.ephemeral);
	}, [mediaFiles]);

	useEffect(() => {
		return () => {
			audioElement?.pause();
		};
	}, [audioElement]);

	const processFiles = async ({ files }: { files: File[] }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		const audioFiles = files.filter((f) => f.type.startsWith("audio/"));
		if (audioFiles.length === 0) {
			toast.error("Please select audio files only.");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			await showMediaUploadToast({
				filesCount: audioFiles.length,
				promise: async () => {
					const processedAssets = await processMediaAssets({
						files: audioFiles,
						onProgress: (progress: { progress: number }) =>
							setProgress(progress.progress),
					});
					for (const asset of processedAssets) {
						await editor.media.addMediaAsset({
							projectId: activeProject.metadata.id,
							asset,
						});
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Error processing files:", error);
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, dragProps, openFilePicker, fileInputProps } =
		useFileUpload({
			accept: "audio/*",
			multiple: true,
			onFilesSelected: (files) => processFiles({ files }),
		});

	const playSound = ({ asset }: { asset: MediaAsset }) => {
		if (playingId === asset.id) {
			audioElement?.pause();
			setPlayingId(null);
			return;
		}

		audioElement?.pause();

		if (asset.url) {
			const audio = new Audio(asset.url);
			audio.addEventListener("ended", () => {
				setPlayingId(null);
			});
			audio.addEventListener("error", () => {
				setPlayingId(null);
			});
			audio.play().catch((error) => {
				console.error("Failed to play local audio:", error);
				setPlayingId(null);
			});

			setAudioElement(audio);
			setPlayingId(asset.id);
		}
	};

	const handleAddToTimeline = ({ asset }: { asset: MediaAsset }) => {
		const currentTime = editor.playback.getCurrentTime();
		const duration = asset.duration || 5;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: "audio",
			name: asset.name,
			duration,
			startTime: currentTime,
			sourceOriginalPath: (asset.file as any).originalPath,
			sourceProxyPath: (asset.file as any).proxyPath,
		});

		const tracks = editor.timeline.getTracks();
		const audioTrack = tracks.find((t) => t.type === "audio");
		let trackId: string;

		if (audioTrack) {
			trackId = audioTrack.id;
		} else {
			trackId = editor.timeline.addTrack({ type: "audio" });
		}

		editor.timeline.insertElement({
			element,
			placement: { mode: "explicit", trackId },
		});
		toast.success(`Added ${asset.name} to timeline`);
	};

	const handleRemove = ({
		event,
		assetId,
	}: {
		event: React.MouseEvent;
		assetId: string;
	}) => {
		event.stopPropagation();
		if (playingId === assetId) {
			audioElement?.pause();
			setPlayingId(null);
		}
		if (activeProject) {
			invokeAction("remove-media-assets", {
				projectId: activeProject.metadata.id,
				assetIds: [assetId],
			});
			toast.success("Removed audio asset");
		}
	};

	const handleDragStart = (e: React.DragEvent, asset: MediaAsset) => {
		const dragData = {
			id: asset.id,
			type: "media" as const,
			mediaType: "audio" as const,
			name: asset.name,
		};
		setDragData({ dataTransfer: e.dataTransfer, dragData });
		e.dataTransfer.effectAllowed = "copy";
	};

	const handleDragEnd = () => {
		clearDragData();
	};

	return (
		<div className="mt-1 flex h-full flex-col gap-4 overflow-hidden" {...dragProps}>
			<input {...fileInputProps} />

			<button
				type="button"
				onClick={openFilePicker}
				className={cn(
					"flex flex-col items-center justify-center p-4 border rounded-lg border-dashed transition-colors cursor-pointer",
					isDragOver
						? "bg-accent/40 border-primary"
						: "bg-muted/10 border-border hover:bg-muted/20 hover:border-border",
				)}
				disabled={isProcessing}
			>
				<HugeiconsIcon icon={CloudUploadIcon} className="size-6 text-muted-foreground mb-2" />
				<span className="text-xs font-medium text-foreground">
					{isProcessing ? `Uploading (${progress}%)` : "Click or drag audio files here"}
				</span>
				<span className="text-[10px] text-muted-foreground mt-0.5">
					Supports MP3, WAV, M4A, etc.
				</span>
			</button>

			<div className="relative h-full overflow-hidden flex-1">
				<ScrollArea className="h-full flex-1">
					<div className="flex flex-col gap-4">
						{audioAssets.length === 0 ? (
							<div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
								<span className="text-xs">No imported audio files yet.</span>
							</div>
						) : (
							audioAssets.map((asset) => (
								<div
									key={asset.id}
									className="group flex items-center gap-3 opacity-100 hover:opacity-75"
								>
									<button
										type="button"
										className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-grab active:cursor-grabbing"
										onClick={() => playSound({ asset })}
										draggable="true"
										onDragStart={(e) => handleDragStart(e, asset)}
										onDragEnd={handleDragEnd}
									>
										<div className="bg-accent relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md">
											<div className="from-primary/20 absolute inset-0 bg-gradient-to-br to-transparent" />
											{playingId === asset.id ? (
												<HugeiconsIcon icon={PauseIcon} className="size-5" />
											) : (
												<HugeiconsIcon icon={PlayIcon} className="size-5" />
											)}
										</div>

										<div className="min-w-0 flex-1 overflow-hidden">
											<p className="truncate text-sm font-medium">{asset.name}</p>
											<span className="text-muted-foreground block truncate text-xs">
												{asset.duration
													? `${Math.round(asset.duration)}s`
													: "Local file"}
											</span>
										</div>
									</button>

									<div className="flex items-center gap-3 pr-2">
										<Button
											variant="text"
											size="icon"
											className="text-muted-foreground hover:text-foreground w-auto !opacity-100"
											onClick={() => handleAddToTimeline({ asset })}
											title="Add to timeline"
										>
											<HugeiconsIcon icon={PlusSignIcon} />
										</Button>
										<Button
											variant="text"
											size="icon"
											className="text-muted-foreground hover:text-destructive w-auto !opacity-100"
											onClick={(event) => handleRemove({ event, assetId: asset.id })}
											title="Remove file"
										>
											<HugeiconsIcon icon={Delete02Icon} />
										</Button>
									</div>
								</div>
							))
						)}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}
