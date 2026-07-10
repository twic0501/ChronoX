"use client";

import { useState } from "react";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULTS } from "@/lib/timeline/defaults";
import { buildTextElement } from "@/lib/timeline/element-utils";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";

export function TextView() {
	const editor = useEditor();
	const [ttsText, setTtsText] = useState("");
	const [lang, setLang] = useState("vi");
	const [isGenerating, setIsGenerating] = useState(false);

	const handleAddToTimeline = ({ currentTime }: { currentTime: number }) => {
		const activeScene = editor.scenes.getActiveScene();
		if (!activeScene) return;

		const element = buildTextElement({
			raw: DEFAULTS.text.element,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	const handleGenerateTTS = async () => {
		if (!ttsText.trim()) {
			toast.error("Please enter some text");
			return;
		}

		if (typeof window === "undefined" || !window.speechSynthesis) {
			toast.error("Text-to-Speech is not supported in this browser");
			return;
		}

		setIsGenerating(true);
		try {
			// Cancel any ongoing speech
			window.speechSynthesis.cancel();

			const utterance = new SpeechSynthesisUtterance(ttsText.trim());
			utterance.lang = lang;
			utterance.rate = 1;
			utterance.pitch = 1;

			// Try to find a matching voice
			const voices = window.speechSynthesis.getVoices();
			const langMatch = voices.find((v) => v.lang.startsWith(lang));
			if (langMatch) utterance.voice = langMatch;

			// Speak and measure duration
			const startTime = Date.now();
			await new Promise<void>((resolve, reject) => {
				utterance.onend = () => resolve();
				utterance.onerror = (e) => reject(new Error(`TTS error: ${e.error}`));
				window.speechSynthesis.speak(utterance);
			});

			const durationMs = Date.now() - startTime;
			const durationSec = durationMs / 1000;

			// Create a silent WAV file as timeline placeholder
			const sampleRate = 44100;
			const numSamples = Math.ceil(durationSec * sampleRate);
			const audioCtx = new AudioContext();
			const buffer = audioCtx.createBuffer(1, Math.max(numSamples, 1), sampleRate);

			// Encode as WAV
			const wavBlob = audioBufferToWav(buffer);
			const localUrl = URL.createObjectURL(wavBlob);
			const filename = `tts-${lang}-${Date.now()}.wav`;

			audioCtx.close();

			const activeProject = editor.project.getActive();
			if (activeProject) {
				const file = new File([wavBlob], filename, { type: "audio/wav" });
				await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: {
						file,
						name: filename,
						type: "audio",
						url: localUrl,
						hasAudio: true,
						duration: durationSec,
					},
				});
			}

			toast.success("Text-to-Speech audio added to Assets library!");
			setTtsText("");
		} catch (error) {
			console.error("TTS generation error:", error);
			toast.error("Failed to generate speech. Please try again.");
		} finally {
			setIsGenerating(false);
		}
	};

	return (
		<PanelView title="Text">
			<div className="flex flex-col gap-6 w-full px-1">
				{/* Section 1: Standard Text Overlay */}
				<div className="flex flex-col gap-2">
					<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
						Text Overlays
					</h4>
					<DraggableItem
						name="Default text"
						preview={
							<div className="bg-accent flex size-full items-center justify-center rounded border border-border/40 hover:border-primary/50 transition-all duration-300">
								<span className="text-xs select-none font-medium">Default text</span>
							</div>
						}
						dragData={{
							id: "temp-text-id",
							type: DEFAULTS.text.element.type,
							name: DEFAULTS.text.element.name,
							content: DEFAULTS.text.element.content,
						}}
						aspectRatio={2.5}
						onAddToTimeline={handleAddToTimeline}
						shouldShowLabel={false}
					/>
				</div>

				{/* Section 2: Text-To-Speech (TTS) */}
				<div className="flex flex-col gap-3.5 border-t pt-5">
					<div className="flex flex-col gap-1">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
							Text to Speech (TTS)
						</h4>
						<p className="text-[11px] text-muted-foreground">
							Type a sentence to generate an AI voiceover reading.
						</p>
					</div>

					<div className="flex flex-col gap-2">
						<textarea
							placeholder="Enter the text to narrate..."
							value={ttsText}
							onChange={(e) => setTtsText(e.target.value)}
							className="flex min-h-[70px] w-full rounded border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
						/>

						<div className="flex gap-2">
							<select
								value={lang}
								onChange={(e) => setLang(e.target.value)}
								className="h-8 rounded border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring flex-1"
							>
								<option value="vi">Vietnamese</option>
								<option value="en">English</option>
								<option value="ja">Japanese</option>
								<option value="ko">Korean</option>
							</select>

							<Button
								size="sm"
								onClick={handleGenerateTTS}
								disabled={isGenerating}
								className="h-8 gap-1.5 px-3"
							>
								<HugeiconsIcon icon={VolumeHighIcon} className="size-3.5" />
								{isGenerating ? "Generating..." : "Generate"}
							</Button>
						</div>
					</div>
				</div>
			</div>
		</PanelView>
	);
}

/** Encode an AudioBuffer to a WAV Blob */
function audioBufferToWav(buffer: AudioBuffer): Blob {
	const numChannels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const bitsPerSample = 16;

	const channelData: Float32Array[] = [];
	for (let i = 0; i < numChannels; i++) {
		channelData.push(buffer.getChannelData(i));
	}

	const numSamples = buffer.length;
	const blockAlign = numChannels * (bitsPerSample / 8);
	const byteRate = sampleRate * blockAlign;
	const dataSize = numSamples * blockAlign;
	const headerSize = 44;
	const totalSize = headerSize + dataSize;

	const arrayBuffer = new ArrayBuffer(totalSize);
	const view = new DataView(arrayBuffer);

	writeWavString(view, 0, "RIFF");
	view.setUint32(4, totalSize - 8, true);
	writeWavString(view, 8, "WAVE");
	writeWavString(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	writeWavString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < numSamples; i++) {
		for (let ch = 0; ch < numChannels; ch++) {
			const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			offset += 2;
		}
	}

	return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeWavString(view: DataView, offset: number, str: string) {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
