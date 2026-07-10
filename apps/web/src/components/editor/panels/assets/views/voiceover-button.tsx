"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Mic01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/hooks/use-editor";

export function VoiceoverButton() {
	const [isRecording, setIsRecording] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const editor = useEditor();

	const startRecording = useCallback(async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mediaRecorder = new MediaRecorder(stream, {
				mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
					? "audio/webm;codecs=opus"
					: "audio/webm",
			});

			chunksRef.current = [];
			mediaRecorderRef.current = mediaRecorder;

			mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) {
					chunksRef.current.push(e.data);
				}
			};

			mediaRecorder.onstop = async () => {
				const blob = new Blob(chunksRef.current, { type: "audio/webm" });
				const url = URL.createObjectURL(blob);
				const filename = `voiceover-${Date.now()}.webm`;

				const activeProject = editor.project.getActive();
				if (activeProject) {
					const file = new File([blob], filename, { type: "audio/webm" });
					await editor.media.addMediaAsset({
						projectId: activeProject.metadata.id,
						asset: {
							file,
							name: filename,
							type: "audio",
							url,
							hasAudio: true,
						},
					});
				}

				// Stop all tracks
				stream.getTracks().forEach((track) => track.stop());

				// Clear timer
				if (timerRef.current) {
					clearInterval(timerRef.current);
					timerRef.current = null;
				}
				setElapsed(0);
			};

			mediaRecorder.start(100); // Collect data every 100ms
			setIsRecording(true);

			// Start elapsed timer
			const startTime = Date.now();
			timerRef.current = setInterval(() => {
				setElapsed(Math.floor((Date.now() - startTime) / 1000));
			}, 1000);
		} catch (err) {
			console.error("Failed to access microphone:", err);
		}
	}, [editor]);

	const stopRecording = useCallback(() => {
		if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
			mediaRecorderRef.current.stop();
		}
		setIsRecording(false);
	}, []);

	const formatTime = (seconds: number) => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	return (
		<div className="flex items-center gap-2">
			{isRecording ? (
				<>
					<Button
						variant="destructive"
						size="sm"
						onClick={stopRecording}
						className="gap-1.5"
					>
						<HugeiconsIcon icon={StopIcon} className="size-4" />
						Stop
					</Button>
					<div className="flex items-center gap-1.5 text-xs text-destructive animate-pulse">
						<div className="size-2 rounded-full bg-destructive" />
						{formatTime(elapsed)}
					</div>
				</>
			) : (
				<Button
					variant="outline"
					size="sm"
					onClick={startRecording}
					className="gap-1.5"
				>
					<HugeiconsIcon icon={Mic01Icon} className="size-4" />
					Record Voiceover
				</Button>
			)}
		</div>
	);
}
