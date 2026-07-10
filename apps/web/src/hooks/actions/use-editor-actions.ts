"use client";

import { useEffect, useRef } from "react";
import { useTimelineStore } from "@/stores/timeline-store";
import { useActionHandler } from "@/hooks/actions/use-action-handler";
import { useEditor } from "../use-editor";
import { useElementSelection } from "../timeline/element/use-element-selection";
import { useKeyframeSelection } from "../timeline/element/use-keyframe-selection";
import { getElementsAtTime } from "@/lib/timeline";
import { cancelInteraction } from "@/lib/cancel-interaction";
import { invokeAction } from "@/lib/actions";
import {
	activateScope,
	clearActiveScope,
	type ScopeEntry,
} from "@/lib/selection/scope";
import { generateUUID } from "@/utils/id";
import { TracksSnapshotCommand } from "@/lib/commands/timeline/tracks-snapshot";
import { videoCache } from "@/services/video-cache/service";

export function useEditorActions() {
	const editor = useEditor();
	const { selectedElements, setElementSelection } = useElementSelection();
	const { selectedKeyframes, clearKeyframeSelection } = useKeyframeSelection();
	const clipboard = useTimelineStore((s) => s.clipboard);
	const setClipboard = useTimelineStore((s) => s.setClipboard);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);
	const hasTimelineSelectionRef = useRef(false);
	const clearTimelineSelectionRef = useRef(() => {});
	const timelineScopeRef = useRef<ScopeEntry | null>(null);
	const hasTimelineSelection =
		selectedElements.length > 0 || selectedKeyframes.length > 0;

	hasTimelineSelectionRef.current = hasTimelineSelection;
	clearTimelineSelectionRef.current = () => {
		setElementSelection({ elements: [] });
		clearKeyframeSelection();
	};

	if (!timelineScopeRef.current) {
		timelineScopeRef.current = {
			hasSelection: () => hasTimelineSelectionRef.current,
			clear: () => {
				clearTimelineSelectionRef.current();
			},
		};
	}

	useEffect(() => {
		if (!hasTimelineSelection) {
			return;
		}

		const timelineScope = timelineScopeRef.current;
		if (!timelineScope) {
			return;
		}

		return activateScope({ entry: timelineScope });
	}, [hasTimelineSelection]);

	useActionHandler(
		"toggle-play",
		() => {
			editor.playback.toggle();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			if (editor.playback.getIsPlaying()) {
				editor.playback.toggle();
			}
			editor.playback.seek({ time: 0 });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + seconds,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + 1 / fps,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - 1 / fps),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + seconds,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			editor.playback.seek({ time: 0 });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			editor.playback.seek({ time: editor.timeline.getTotalDuration() });
		},
		undefined,
	);

	useActionHandler(
		"split",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
			});
		},
		undefined,
	);

	useActionHandler(
		"split-left",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			const rightSideElements = editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				retainSide: "right",
				rippleEnabled: rippleEditingEnabled,
			});

			if (rippleEditingEnabled && rightSideElements.length > 0) {
				const firstRightElement = editor.timeline.getElementsWithTracks({
					elements: [rightSideElements[0]],
				})[0];
				if (firstRightElement) {
					editor.playback.seek({ time: firstRightElement.element.startTime });
				}
			}
		},
		undefined,
	);

	useActionHandler(
		"split-right",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				retainSide: "left",
			});
		},
		undefined,
	);

	useActionHandler(
		"delete-selected",
		() => {
			if (selectedKeyframes.length > 0) {
				editor.timeline.removeKeyframes({ keyframes: selectedKeyframes });
				clearKeyframeSelection();
				return;
			}
			if (selectedElements.length === 0) {
				return;
			}
			editor.timeline.deleteElements({
				elements: selectedElements,
				rippleEnabled: rippleEditingEnabled,
			});
			editor.selection.clearSelection();
		},
		undefined,
	);

	useActionHandler(
		"select-all",
		() => {
			const allElements = editor.timeline.getTracks().flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
			setElementSelection({ elements: allElements });
		},
		undefined,
	);

	useActionHandler(
		"cancel-interaction",
		() => {
			if (!cancelInteraction()) {
				invokeAction("deselect-all");
			}
		},
		undefined,
	);

	useActionHandler(
		"deselect-all",
		() => {
			if (!clearActiveScope()) {
				setElementSelection({ elements: [] });
				clearKeyframeSelection();
			}
		},
		undefined,
	);

	useActionHandler(
		"duplicate-selected",
		() => {
			editor.timeline.duplicateElements({
				elements: selectedElements,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-muted-selected",
		() => {
			editor.timeline.toggleElementsMuted({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-visibility-selected",
		() => {
			editor.timeline.toggleElementsVisibility({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-bookmark",
		() => {
			editor.scenes.toggleBookmark({ time: editor.playback.getCurrentTime() });
		},
		undefined,
	);

	useActionHandler(
		"copy-selected",
		() => {
			if (selectedElements.length === 0) return;

			const results = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			});
			const items = results.map(({ track, element }) => {
				const { id: _, ...elementWithoutId } = element;
				return {
					trackId: track.id,
					trackType: track.type,
					element: elementWithoutId,
				};
			});

			setClipboard({ items });
		},
		undefined,
	);

	useActionHandler(
		"paste-copied",
		() => {
			if (!clipboard?.items.length) return;

			editor.timeline.pasteAtTime({
				time: editor.playback.getCurrentTime(),
				clipboardItems: clipboard.items,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-snapping",
		() => {
			toggleSnapping();
		},
		undefined,
	);

	useActionHandler(
		"toggle-ripple-editing",
		() => {
			toggleRippleEditing();
		},
		undefined,
	);

	useActionHandler(
		"undo",
		() => {
			editor.command.undo();
		},
		undefined,
	);

	useActionHandler(
		"redo",
		() => {
			editor.command.redo();
		},
		undefined,
	);

	// todo: potnetially unify these two actions:
	useActionHandler(
		"remove-media-asset",
		(args) => {
			if (!args) return;
			editor.media.removeMediaAsset({
				projectId: args.projectId,
				id: args.assetId,
			});
		},
		undefined,
	);

	useActionHandler(
		"remove-media-assets",
		(args) => {
			if (!args) return;
			editor.media.removeMediaAssets({
				projectId: args.projectId,
				ids: args.assetIds,
			});
		},
		undefined,
	);

	useActionHandler(
		"separate-audio",
		() => {
			if (selectedElements.length === 0) return;
			const oldTracks = editor.timeline.getTracks();
			const selected = editor.timeline.getElementsWithTracks({ elements: selectedElements });
			const videoItem = selected.find(item => item.element.type === "video");
			if (!videoItem) return;

			const videoElement = videoItem.element as any;
			const videoTrack = videoItem.track;

			const newTracks = JSON.parse(JSON.stringify(oldTracks));

			const targetVideoTrack = newTracks.find((t: any) => t.id === videoTrack.id);
			if (!targetVideoTrack) return;
			const targetVideoEl = targetVideoTrack.elements.find((el: any) => el.id === videoElement.id);
			if (!targetVideoEl) return;
			targetVideoEl.muted = true;
			targetVideoEl.volume = 0;

			let targetAudioTrack = newTracks.find((t: any) => t.type === "audio");
			if (!targetAudioTrack) {
				const audioTrackId = generateUUID();
				targetAudioTrack = {
					id: audioTrackId,
					name: "Audio 1",
					type: "audio",
					elements: [],
					muted: false,
				};
				newTracks.push(targetAudioTrack);
			}

			const audioId = generateUUID();
			const newAudioElement = {
				id: audioId,
				name: videoElement.name.replace(/\.[^/.]+$/, "") + " (Audio)",
				type: "audio",
				sourceType: "upload",
				mediaId: videoElement.mediaId,
				startTime: videoElement.startTime,
				duration: videoElement.duration,
				trimStart: videoElement.trimStart,
				trimEnd: videoElement.trimEnd,
				volume: videoElement.volume ?? 1,
				muted: false,
			};
			targetAudioTrack.elements.push(newAudioElement);

			const command = new TracksSnapshotCommand(oldTracks, newTracks);
			editor.command.execute({ command });

			setElementSelection({
				elements: [{ trackId: targetAudioTrack.id, elementId: audioId }],
			});
		},
		undefined,
	);

	useActionHandler(
		"freeze-frame",
		async () => {
			if (selectedElements.length === 0) return;
			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			const selected = editor.timeline.getElementsWithTracks({ elements: selectedElements });
			const videoItem = selected.find(item => item.element.type === "video");
			if (!videoItem) return;

			const videoElement = videoItem.element as any;
			const videoTrack = videoItem.track;

			const mediaAssets = editor.media.getAssets();
			const mediaAsset = mediaAssets.find(asset => asset.id === videoElement.mediaId);
			if (!mediaAsset || !mediaAsset.file) return;

			const currentTime = editor.playback.getCurrentTime();
			if (currentTime < videoElement.startTime || currentTime > videoElement.startTime + videoElement.duration) {
				return;
			}

			const videoLocalTime = currentTime - videoElement.startTime + videoElement.trimStart;

			const frame = await videoCache.getFrameAt({
				mediaId: videoElement.mediaId,
				file: mediaAsset.file,
				time: videoLocalTime,
			});

			if (!frame) return;

			const blob = await new Promise<Blob | null>((resolve) => (frame.canvas as HTMLCanvasElement).toBlob(resolve, "image/jpeg", 0.95));
			if (!blob) return;

			const freezeFile = new File([blob], `freeze_${videoElement.name}_${currentTime.toFixed(2)}.jpg`, { type: "image/jpeg" });
			
			const freezeUrl = URL.createObjectURL(blob);
			const newAsset = await editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: {
					file: freezeFile,
					name: freezeFile.name,
					type: "image",
					url: freezeUrl,
					hasAudio: false,
				},
			});

			if (!newAsset) return;

			const oldTracks = editor.timeline.getTracks();
			const newTracks = JSON.parse(JSON.stringify(oldTracks));

			const targetVideoTrack = newTracks.find((t: any) => t.id === videoTrack.id);
			if (!targetVideoTrack) return;

			const targetVideoElIndex = targetVideoTrack.elements.findIndex((el: any) => el.id === videoElement.id);
			if (targetVideoElIndex === -1) return;

			const targetVideoEl = targetVideoTrack.elements[targetVideoElIndex];

			const leftDuration = currentTime - targetVideoEl.startTime;
			const rightDuration = targetVideoEl.duration - leftDuration;

			const leftElement = {
				...targetVideoEl,
				id: generateUUID(),
				duration: leftDuration,
				trimEnd: targetVideoEl.trimEnd + rightDuration,
			};

			const freezeElementId = generateUUID();
			const freezeElement = {
				id: freezeElementId,
				name: `Freeze Frame (${currentTime.toFixed(1)}s)`,
				type: "image",
				mediaId: newAsset.id,
				startTime: currentTime,
				duration: 3.0,
				trimStart: 0,
				trimEnd: 0,
				opacity: 1,
				transform: {
					position: { x: 0, y: 0 },
					scale: { x: 1, y: 1 },
					rotation: 0,
				},
			};

			const rightElement = {
				...targetVideoEl,
				id: generateUUID(),
				startTime: currentTime + 3.0,
				duration: rightDuration,
				trimStart: targetVideoEl.trimStart + leftDuration,
			};

			targetVideoTrack.elements.splice(targetVideoElIndex, 1);
			
			if (leftDuration > 0) {
				targetVideoTrack.elements.push(leftElement);
			}
			targetVideoTrack.elements.push(freezeElement);
			if (rightDuration > 0) {
				targetVideoTrack.elements.push(rightElement);
			}

			newTracks.forEach((t: any) => {
				t.elements.forEach((el: any) => {
					if (el.id !== leftElement.id && el.id !== freezeElement.id && el.id !== rightElement.id && el.startTime >= currentTime) {
						el.startTime += 3.0;
					}
				});
			});

			const command = new TracksSnapshotCommand(oldTracks, newTracks);
			editor.command.execute({ command });

			setElementSelection({
				elements: [{ trackId: videoTrack.id, elementId: freezeElementId }],
			});
		},
		undefined,
	);
}
