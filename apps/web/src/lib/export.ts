import { EXPORT_MIME_TYPES } from "@/constants/export-constants";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: number;
	includeAudio?: boolean;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export async function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): Promise<void> {
	if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
		try {
			const ext = filename.endsWith(".webm") ? ".webm" : ".mp4";
			const options = {
				suggestedName: filename,
				types: [
					{
						description: mimeType.includes("webm") ? "WebM Video" : "MP4 Video",
						accept: {
							[mimeType]: [ext],
						},
					},
				],
			};
			// @ts-ignore
			const handle = await window.showSaveFilePicker(options);
			const writable = await handle.createWritable();
			await writable.write(buffer);
			await writable.close();
			return;
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				return;
			}
			console.warn("showSaveFilePicker failed, falling back to link download:", err);
		}
	}

	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
