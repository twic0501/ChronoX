import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "mediabunny";
import { toast } from "sonner";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { formatStorageBytes } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import type { MediaAsset } from "@/lib/media/types";
import { getVideoInfo } from "./mediabunny";
import { useTranscodeStore } from "@/stores/transcode-store";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;

const getStorageLimitDescription = ({
	fileSize,
	availableBytes,
}: {
	fileSize: number;
	availableBytes: number | null;
}): string => {
	const fileSizeLabel = formatStorageBytes({ bytes: fileSize });

	if (availableBytes === null) {
		return `File size is ${fileSizeLabel}.`;
	}

	return `File size is ${fileSizeLabel}, but only ${formatStorageBytes({
		bytes: availableBytes,
	})} is safely available in browser storage.`;
};

const getThumbnailSize = ({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } => {
	const aspectRatio = width / height;
	let targetWidth = width;
	let targetHeight = height;

	if (targetWidth > THUMBNAIL_MAX_WIDTH) {
		targetWidth = THUMBNAIL_MAX_WIDTH;
		targetHeight = Math.round(targetWidth / aspectRatio);
	}
	if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
		targetHeight = THUMBNAIL_MAX_HEIGHT;
		targetWidth = Math.round(targetHeight * aspectRatio);
	}

	return { width: targetWidth, height: targetHeight };
};

const renderToThumbnailDataUrl = ({
	width,
	height,
	draw,
}: {
	width: number;
	height: number;
	draw: ({
		context,
		width,
		height,
	}: {
		context: CanvasRenderingContext2D;
		width: number;
		height: number;
	}) => void;
}): { dataUrl: string; isBlack: boolean } => {
	const size = getThumbnailSize({ width, height });
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	draw({ context, width: size.width, height: size.height });

	// Check if canvas is completely black or transparent
	let isBlack = true;
	try {
		const imageData = context.getImageData(0, 0, size.width, size.height);
		const data = imageData.data;
		for (let i = 0; i < data.length; i += 16) {
			if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) {
				isBlack = false;
				break;
			}
		}
	} catch (e) {
		console.warn("Could not check if thumbnail is black:", e);
		isBlack = false;
	}

	return {
		dataUrl: canvas.toDataURL("image/jpeg", 0.8),
		isBlack,
	};
};

async function generateThumbnail({
	videoFile,
	timeInSeconds,
}: {
	videoFile: File;
	timeInSeconds: number;
}): Promise<{ thumbnailUrl: string; isBlack: boolean }> {
	const input = new Input({
		source: new BlobSource(videoFile),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		throw new Error("No video track found in the file");
	}

	const canDecode = await videoTrack.canDecode();
	if (!canDecode) {
		throw new Error("Video codec not supported for decoding");
	}

	const sink = new VideoSampleSink(videoTrack);
	const duration = (await input.computeDuration()) || 10;
	const checkTimes = [timeInSeconds, 2, 5, 10, duration / 2];

	for (const checkTime of checkTimes) {
		if (checkTime > duration) continue;
		try {
			const frame = await sink.getSample(checkTime);
			if (!frame) continue;

			try {
				const res = renderToThumbnailDataUrl({
					width: videoTrack.displayWidth,
					height: videoTrack.displayHeight,
					draw: ({ context, width, height }) => {
						frame.draw(context, 0, 0, width, height);
					},
				});

				if (!res.isBlack) {
					return {
						thumbnailUrl: res.dataUrl,
						isBlack: false,
					};
				}
			} finally {
				frame.close();
			}
		} catch (e) {
			console.warn(`Failed to get frame at ${checkTime}s:`, e);
		}
	}

	// Fallback to the first frame if all checked frames are black
	const fallbackFrame = await sink.getSample(timeInSeconds);
	if (!fallbackFrame) {
		throw new Error("Could not get frame at specified time");
	}
	try {
		const res = renderToThumbnailDataUrl({
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			draw: ({ context, width, height }) => {
				fallbackFrame.draw(context, 0, 0, width, height);
			},
		});
		return {
			thumbnailUrl: res.dataUrl,
			isBlack: res.isBlack,
		};
	} finally {
		fallbackFrame.close();
	}
}

async function generateImageThumbnail({
	imageFile,
}: {
	imageFile: File;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const objectUrl = URL.createObjectURL(imageFile);

		image.addEventListener("load", () => {
			try {
				const res = renderToThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve({
					thumbnailUrl: res.dataUrl,
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				URL.revokeObjectURL(objectUrl);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			URL.revokeObjectURL(objectUrl);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = objectUrl;
	});
}

export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	for (const file of fileArray) {
		const fileType = getMediaTypeFromFile({ file });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			continue;
		}

		const storageCheck = await storageService.canStoreFile({
			size: file.size,
		});

		if (!storageCheck.canStore) {
			toast.error(`Not enough browser storage for ${file.name}`, {
				description: getStorageLimitDescription({
					fileSize: file.size,
					availableBytes: storageCheck.availableBytes,
				}),
			});
			continue;
		}

		let activeFile = file;
		let url: string | undefined;
		let thumbnailUrl: string | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;
		let hasAudio: boolean | undefined;

		try {
			if (fileType === "image") {
				const result = await generateImageThumbnail({ imageFile: activeFile });
				thumbnailUrl = result.thumbnailUrl;
				width = result.width;
				height = result.height;
			} else if (fileType === "video") {
				try {
					let videoInfo = await getVideoInfo({ videoFile: activeFile });
					let thumbResult = await generateThumbnail({
						videoFile: activeFile,
						timeInSeconds: 1,
					});

					const isHEVC =
						activeFile.name.toLowerCase().includes("h265") ||
						activeFile.name.toLowerCase().includes("hevc") ||
						thumbResult.isBlack;

					if (isHEVC) {
						const resolvedFile = await useTranscodeStore
							.getState()
							.startTranscodeFlow(activeFile);

						if (!resolvedFile) {
							// User cancelled the import
							continue;
						}

						if (resolvedFile !== activeFile) {
							activeFile = resolvedFile;
							// Re-fetch info & thumb for the newly transcoded file
							videoInfo = await getVideoInfo({ videoFile: activeFile });
							thumbResult = await generateThumbnail({
								videoFile: activeFile,
								timeInSeconds: 1,
							});
						}
					}

					duration = videoInfo.duration;
					width = videoInfo.width;
					height = videoInfo.height;
					fps = Number.isFinite(videoInfo.fps)
						? Math.round(videoInfo.fps)
						: undefined;
					hasAudio = videoInfo.hasAudio;
					thumbnailUrl = thumbResult.thumbnailUrl;
				} catch (error) {
					console.warn("Video processing failed", error);
				}
			} else if (fileType === "audio") {
				duration = await getMediaDuration({ file: activeFile });
			}

			url = URL.createObjectURL(activeFile);

			processedAssets.push({
				name: activeFile.name,
				type: fileType,
				file: activeFile,
				url,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				hasAudio,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			if (onProgress) {
				const percent = Math.round((completed / total) * 100);
				onProgress({ progress: percent });
			}
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			if (url) URL.revokeObjectURL(url); // Clean up on error
		}
	}

	return processedAssets;
}

const getMediaDuration = ({ file }: { file: File }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement(
			file.type.startsWith("video/") ? "video" : "audio",
		) as HTMLVideoElement;
		const objectUrl = URL.createObjectURL(file);

		element.addEventListener("loadedmetadata", () => {
			resolve(element.duration);
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.addEventListener("error", () => {
			reject(new Error("Could not load media"));
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.src = objectUrl;
		element.load();
	});
};
