"use client";

import { useState, useEffect } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/lib/export";
import { Check, Copy, RotateCcw, FolderOpen, Upload } from "lucide-react";
import {
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/lib/export";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/constants/export-constants";

const FORMAT_META: Record<ExportFormat, { title: string; sub: string }> = {
	mp4: { title: "MP4", sub: "H.264 · universal" },
	webm: { title: "WebM", sub: "VP9 · web" },
};

/** Approximate video bitrates per quality — used for the size estimate + label. */
const QUALITY_META: Record<ExportQuality, { label: string; mbps: number }> = {
	low: { label: "Draft", mbps: 8 },
	medium: { label: "Standard", mbps: 16 },
	high: { label: "High", mbps: 40 },
	very_high: { label: "Max", mbps: 80 },
};

function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const hh = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

function aspectLabel(width: number, height: number): string {
	if (!width || !height) return "—";
	const d = gcd(width, height);
	const w = width / d;
	const h = height / d;
	// Collapse odd ratios to a decimal cinema style when the reduced form is ugly.
	if (w > 21 || h > 21) return `${(width / height).toFixed(2)}:1`;
	return `${w}:${h}`;
}

const SETTINGS_DB_NAME = "video-editor-settings";
const SETTINGS_STORE_NAME = "general";

async function getSavedDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
	if (typeof window === "undefined" || !("indexedDB" in window)) return null;
	return new Promise((resolve) => {
		const request = indexedDB.open(SETTINGS_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
				db.createObjectStore(SETTINGS_STORE_NAME);
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			try {
				const tx = db.transaction(SETTINGS_STORE_NAME, "readonly");
				const store = tx.objectStore(SETTINGS_STORE_NAME);
				const getReq = store.get("exportDirectoryHandle");
				getReq.onsuccess = () => {
					resolve(getReq.result || null);
				};
				getReq.onerror = () => resolve(null);
			} catch {
				resolve(null);
			}
		};
		request.onerror = () => resolve(null);
	});
}

async function saveDirectoryHandle(
	handle: FileSystemDirectoryHandle,
): Promise<void> {
	if (typeof window === "undefined" || !("indexedDB" in window)) return;
	return new Promise((resolve) => {
		const request = indexedDB.open(SETTINGS_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
				db.createObjectStore(SETTINGS_STORE_NAME);
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			try {
				const tx = db.transaction(SETTINGS_STORE_NAME, "readwrite");
				const store = tx.objectStore(SETTINGS_STORE_NAME);
				store.put(handle, "exportDirectoryHandle");
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
			} catch {
				resolve();
			}
		};
		request.onerror = () => resolve();
	});
}

export function ExportButton() {
	const [isOpen, setIsOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handleOpenChange = (open: boolean) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsOpen(open);
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-[0.8rem] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					disabled={!hasProject}
				>
					<HugeiconsIcon icon={TransitionTopIcon} className="size-4" />
					<span>Export</span>
				</button>
			</DialogTrigger>
			{hasProject && <ExportDialog onOpenChange={setIsOpen} />}
		</Dialog>
	);
}

function ExportDialog({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;

	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [exportFilename, setExportFilename] = useState<string>(
		activeProject?.metadata.name || "Untitled Project",
	);
	const [startInFolder] = useState<string>("downloads");
	// biome-ignore lint/suspicious/noExplicitAny: File System Access API handle
	const [directoryHandle, setDirectoryHandle] = useState<any>(null);
	const [directoryName, setDirectoryName] = useState<string>(
		"Downloads (Default)",
	);

	useEffect(() => {
		getSavedDirectoryHandle().then((handle) => {
			if (handle) {
				setDirectoryHandle(handle);
				setDirectoryName(handle.name);
			}
		});
	}, []);

	const { canvasSize, fps } = activeProject.settings;
	const qualityIndex = EXPORT_QUALITY_VALUES.indexOf(quality);
	const mbps = QUALITY_META[quality].mbps;
	const audioMbps = shouldIncludeAudio ? 0.16 : 0;
	const estimatedMb = ((mbps + audioMbps) * totalDuration) / 8;
	const estimatedLabel =
		estimatedMb >= 1024
			? `${(estimatedMb / 1024).toFixed(1)} GB`
			: `${Math.max(1, Math.round(estimatedMb))} MB`;

	const handleExport = async () => {
		if (!activeProject) return;

		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.buffer) {
			// biome-ignore lint/suspicious/noExplicitAny: File System Access API handle
			let fileHandle: any = null;
			if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
				try {
					const ext = getExportFileExtension({ format });
					const mimeType = getExportMimeType({ format });
					// biome-ignore lint/suspicious/noExplicitAny: File System Access API options
					const options: any = {
						suggestedName: `${exportFilename}${ext}`,
						types: [
							{
								description: format === "webm" ? "WebM Video" : "MP4 Video",
								accept: {
									[mimeType]: [ext],
								},
							},
						],
					};
					if (directoryHandle) {
						options.startIn = directoryHandle;
					} else if (startInFolder) {
						options.startIn = startInFolder;
					}
					// @ts-expect-error
					fileHandle = await window.showSaveFilePicker(options);
				} catch (err) {
					if (err instanceof Error && err.name === "AbortError") {
						editor.project.clearExportState();
						return;
					}
					console.warn(
						"showSaveFilePicker failed, will fallback to standard download later",
						err,
					);
				}
			}

			if (fileHandle) {
				try {
					const writable = await fileHandle.createWritable();
					await writable.write(result.buffer);
					await writable.close();
					editor.project.clearExportState();
					onOpenChange(false);
					return;
				} catch (writeErr) {
					console.error("Failed to write to file handle:", writeErr);
				}
			}

			await downloadBuffer({
				buffer: result.buffer,
				filename: `${exportFilename}${getExportFileExtension({ format })}`,
				mimeType: getExportMimeType({ format }),
			});

			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	const handleChooseDirectory = async () => {
		try {
			if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
				// @ts-expect-error
				const handle = await window.showDirectoryPicker();
				setDirectoryHandle(handle);
				setDirectoryName(handle.name);
				await saveDirectoryHandle(handle);
			} else {
				alert(
					"This browser does not support pre-selecting a folder directly.\n\nDon't worry: you can still choose any folder when the export finishes and you save the file (Save As)!",
				);
			}
		} catch (err) {
			console.warn("showDirectoryPicker cancelled or failed:", err);
		}
	};

	return (
		<DialogContent className="flex w-[min(92vw,860px)] max-w-none flex-col gap-0 overflow-hidden p-0">
			<DialogTitle className="border-border/60 border-b px-6 py-4 text-lg font-semibold">
				Export “{activeProject?.metadata.name || "Untitled Project"}”
			</DialogTitle>

			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="grid grid-cols-1 gap-8 p-6 md:grid-cols-[300px_1fr]">
						{/* Left — preview + stats */}
						<div className="flex flex-col gap-4">
							<div
								className="relative overflow-hidden rounded-lg border border-border/60"
								style={{
									aspectRatio: `${canvasSize.width} / ${canvasSize.height}`,
									background:
										"repeating-linear-gradient(135deg,var(--muted),var(--muted) 12px,var(--accent) 12px,var(--accent) 24px)",
								}}
							>
								<div
									className="absolute inset-0"
									style={{
										background:
											"radial-gradient(70% 90% at 50% 42%, color-mix(in srgb, var(--primary) 14%, transparent), transparent 58%)",
									}}
								/>
								<span className="absolute bottom-2 left-2 rounded bg-black/55 px-2 py-1 font-mono text-[10px] text-primary">
									{aspectLabel(canvasSize.width, canvasSize.height)} ·{" "}
									{FORMAT_META[format].title}
								</span>
							</div>

							<div className="flex flex-col text-sm">
								<StatRow
									label="Duration"
									value={formatDuration(totalDuration)}
									mono
								/>
								<StatRow
									label="Resolution"
									value={`${canvasSize.width} × ${canvasSize.height}`}
									mono
								/>
								<StatRow
									label="Estimated size"
									value={`≈ ${estimatedLabel}`}
									mono
									accent
									last
								/>
							</div>
						</div>

						{/* Right — controls */}
						<div className="flex flex-col gap-6">
							<Field label="Format">
								<div className="grid grid-cols-2 gap-3">
									{(Object.keys(FORMAT_META) as ExportFormat[]).map((key) => {
										const meta = FORMAT_META[key];
										const active = format === key;
										return (
											<button
												key={key}
												type="button"
												onClick={() => setFormat(key)}
												className={cn(
													"flex flex-col items-start gap-0.5 rounded-lg border px-4 py-3 text-left transition-colors",
													active
														? "border-primary bg-primary/[0.07]"
														: "border-border/60 hover:border-border hover:bg-accent/40",
												)}
											>
												<span className="text-sm font-semibold text-foreground">
													{meta.title}
												</span>
												<span className="text-xs text-muted-foreground">
													{meta.sub}
												</span>
											</button>
										);
									})}
								</div>
							</Field>

							<div className="grid grid-cols-2 gap-4">
								<Field label="Resolution">
									<ReadonlyField
										value={`${canvasSize.height}p · ${aspectLabel(canvasSize.width, canvasSize.height)}`}
									/>
								</Field>
								<Field label="Frame rate">
									<ReadonlyField value={`${fps} fps`} />
								</Field>
							</div>

							<Field
								label="Quality"
								trailing={
									<span className="font-mono text-xs text-foreground">
										{QUALITY_META[quality].label} ·{" "}
										<span className="text-primary">{mbps} Mbps</span>
									</span>
								}
							>
								<Slider
									min={0}
									max={EXPORT_QUALITY_VALUES.length - 1}
									step={1}
									value={[qualityIndex]}
									onValueChange={([v]) =>
										setQuality(EXPORT_QUALITY_VALUES[v ?? qualityIndex])
									}
								/>
								<div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
									<span>Smaller file</span>
									<span>Best quality</span>
								</div>
							</Field>

							<div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
								<div className="flex items-center gap-3 overflow-hidden">
									<FolderOpen className="size-4 shrink-0 text-primary" />
									<div className="flex min-w-0 flex-col">
										<span className="text-sm font-medium text-foreground">
											Destination
										</span>
										<span
											className="truncate text-xs text-muted-foreground"
											title={directoryName}
										>
											{directoryName}
										</span>
									</div>
								</div>
								<button
									type="button"
									onClick={handleChooseDirectory}
									className="shrink-0 text-xs font-medium text-primary hover:underline"
								>
									Change
								</button>
							</div>

							<Field label="File name">
								<input
									type="text"
									value={exportFilename}
									onChange={(e) => setExportFilename(e.target.value)}
									className="h-9 w-full rounded-lg border border-border/60 bg-input px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
									placeholder="Enter export filename..."
								/>
							</Field>

							<button
								type="button"
								onClick={() => setShouldIncludeAudio((v) => !v)}
								className="flex cursor-pointer items-center gap-2.5"
							>
								<Checkbox
									checked={shouldIncludeAudio}
									className="pointer-events-none"
									tabIndex={-1}
								/>
								<span className="text-sm text-muted-foreground">
									Include audio in export
								</span>
							</button>
						</div>
					</div>

					{/* Footer */}
					<div className="flex items-center justify-between border-t border-border/60 px-6 py-4">
						{isExporting ? (
							<div className="flex flex-1 items-center gap-4">
								<Progress value={progress * 100} className="h-1.5 flex-1" />
								<span className="font-mono text-xs text-muted-foreground">
									{Math.round(progress * 100)}%
								</span>
								<Button variant="outline" size="sm" onClick={handleCancel}>
									Cancel
								</Button>
							</div>
						) : (
							<>
								<div className="flex items-center gap-2.5">
									<span className="relative flex size-2.5">
										<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-constructive opacity-60" />
										<span className="relative inline-flex size-2.5 rounded-full bg-constructive" />
									</span>
									<div className="flex flex-col leading-tight">
										<span className="text-sm font-medium text-foreground">
											Ready to render
										</span>
										<span className="text-xs text-muted-foreground">
											{FORMAT_META[format].title} ·{" "}
											{QUALITY_META[quality].label} ·{" "}
											{formatDuration(totalDuration)}
										</span>
									</div>
								</div>
								<Button onClick={handleExport} className="h-10 gap-2 px-5">
									<Upload className="size-4" />
									Export video
								</Button>
							</>
						)}
					</div>
				</>
			)}
		</DialogContent>
	);
}

function Field({
	label,
	trailing,
	children,
}: {
	label: string;
	trailing?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					{label}
				</span>
				{trailing}
			</div>
			{children}
		</div>
	);
}

function ReadonlyField({ value }: { value: string }) {
	return (
		<div className="flex h-9 items-center rounded-lg border border-border/60 bg-input/50 px-3 text-sm text-foreground">
			{value}
		</div>
	);
}

function StatRow({
	label,
	value,
	mono,
	accent,
	last,
}: {
	label: string;
	value: string;
	mono?: boolean;
	accent?: boolean;
	last?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between py-3",
				!last && "border-b border-border/50",
			)}
		>
			<span className="text-muted-foreground">{label}</span>
			<span
				className={cn(
					mono && "font-mono text-xs",
					accent ? "text-constructive" : "text-foreground",
				)}
			>
				{value}
			</span>
		</div>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-6">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
