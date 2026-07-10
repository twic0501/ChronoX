"use client";

import * as React from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogBody,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranscodeStore } from "@/stores/transcode-store";
import { transcodeService } from "@/services/transcode/service";
import { Loader2, AlertTriangle, FileVideo, CheckCircle2 } from "lucide-react";

export function TranscodeModal() {
	const {
		isOpen,
		fileName,
		progress,
		status,
		error,
		fileToTranscode,
		resolveFlow,
		setProgress,
		setStatus,
		setError,
	} = useTranscodeStore();

	const handleTranscode = async () => {
		if (!fileToTranscode) return;

		setStatus("transcoding");
		setProgress(0);

		try {
			const transcodedFile = await transcodeService.transcodeToH264({
				file: fileToTranscode,
				onProgress: (p) => setProgress(p),
			});
			setStatus("success");
			// Short delay to let the user see the success state
			setTimeout(() => {
				resolveFlow(transcodedFile);
			}, 800);
		} catch (err: any) {
			console.error("Transcoding failed:", err);
			setError(err?.message || "An unknown error occurred during conversion.");
		}
	};

	const handleImportAnyway = () => {
		if (fileToTranscode) {
			resolveFlow(fileToTranscode);
		}
	};

	const handleCancel = () => {
		resolveFlow(null);
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => {
			if (!open) handleCancel();
		}}>
			<DialogContent className="sm:max-w-[480px] bg-background border-border text-foreground">
				<DialogHeader className="border-border pb-4">
					<DialogTitle className="flex items-center gap-2 text-primary font-semibold">
						<AlertTriangle className="size-5" />
						Unsupported Codec
					</DialogTitle>
					<DialogDescription className="text-muted-foreground mt-1">
						Your browser does not fully support hardware decoding for this format.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="py-4 space-y-4">
					<div className="flex items-start gap-3 bg-card/50 border border-border/80 p-3 rounded-lg">
						<FileVideo className="size-8 text-muted-foreground shrink-0 mt-0.5" />
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium truncate text-foreground">
								{fileName}
							</p>
							<p className="text-xs text-muted-foreground mt-0.5">
								Codec: H.265 / HEVC 10-bit
							</p>
						</div>
					</div>

					{status === "idle" && (
						<p className="text-xs leading-relaxed text-muted-foreground">
							This video uses the high-end HEVC codec. On your OS (e.g. Linux), Chrome may show a black screen even though audio plays. We recommend transcoding it to the widely-supported H.264 codec right in the browser for smooth playback.
						</p>
					)}

					{status === "transcoding" && (
						<div className="space-y-2">
							<div className="flex justify-between text-xs font-medium">
								<span className="text-muted-foreground flex items-center gap-1.5">
									<Loader2 className="size-3.5 animate-spin text-foreground" />
									Optimizing & transcoding video...
								</span>
								<span className="text-foreground">{progress}%</span>
							</div>
							<div className="h-1.5 w-full bg-accent rounded-full overflow-hidden">
								<div 
									className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
									style={{ width: `${progress}%` }}
								/>
							</div>
							<p className="text-[10px] text-muted-foreground text-center italic">
								Please keep this tab active. This can take a few minutes depending on file size.
							</p>
						</div>
					)}

					{status === "success" && (
						<div className="flex items-center justify-center gap-2 py-2 text-constructive text-sm font-medium">
							<CheckCircle2 className="size-5" />
							Transcode complete! Importing...
						</div>
					)}

					{status === "error" && (
						<div className="space-y-2 bg-destructive/15 border border-destructive/50 p-3 rounded-lg">
							<p className="text-xs font-semibold text-destructive">Transcode error:</p>
							<p className="text-[11px] text-destructive/80 leading-normal">{error}</p>
						</div>
					)}
				</DialogBody>

				<DialogFooter className="border-border pt-4">
					{status === "idle" && (
						<>
							<Button 
								variant="outline" 
								onClick={handleCancel}
								className="border-border text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer"
							>
								Cancel
							</Button>
							<Button 
								variant="outline" 
								onClick={handleImportAnyway}
								className="border-border text-foreground hover:text-foreground hover:bg-card cursor-pointer"
							>
								Import anyway
							</Button>
							<Button 
								onClick={handleTranscode}
								className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium cursor-pointer"
							>
								Optimize now (recommended)
							</Button>
						</>
					)}

					{status === "transcoding" && (
						<Button 
							variant="outline" 
							onClick={handleCancel}
							className="border-border text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer"
						>
							Cancel
						</Button>
					)}

					{status === "error" && (
						<>
							<Button 
								variant="outline" 
								onClick={handleCancel}
								className="border-border text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer"
							>
								Close
							</Button>
							<Button 
								variant="outline" 
								onClick={handleImportAnyway}
								className="border-border text-foreground hover:text-foreground hover:bg-card cursor-pointer"
							>
								Import anyway
							</Button>
							<Button 
								onClick={handleTranscode}
								className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium cursor-pointer"
							>
								Retry
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
