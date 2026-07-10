export class TranscodeService {
        async transcodeToH264({
                file,
                onProgress,
        }: {
                file: File;
                onProgress?: (progress: number) => void;
        }): Promise<File> {
                if (onProgress) {
                        onProgress(10); // Start progress
                }

                const formData = new FormData();
                formData.append("file", file);

                if (onProgress) {
                        onProgress(30);
                }

                const response = await fetch("http://127.0.0.1:8000/api/upload", {
                        method: "POST",
                        body: formData,
                });

                if (onProgress) {
                        onProgress(70);
                }

                if (!response.ok) {
                        throw new Error(`Upload/transcode failed: ${response.statusText}`);
                }

                const data = await response.json();
                
                if (onProgress) {
                        onProgress(85);
                }

                // Fetch the proxy file from server to keep backward-compatible File object
                const proxyResponse = await fetch(`http://127.0.0.1:8000${data.proxy_path}`);
                const blob = await proxyResponse.blob();

                const newFileName = file.name.replace(/\.[^/.]+$/, "") + "_h264.mp4";
                
                const augmentedFile = new File([blob], newFileName, { type: "video/mp4" }) as any;
                augmentedFile.originalPath = data.original_path;
                augmentedFile.proxyPath = data.proxy_path;
                augmentedFile.audioPath = data.audio_path;
                augmentedFile.assetId = data.asset_id;

                if (onProgress) {
                        onProgress(100);
                }

                return augmentedFile;
        }
}

export const transcodeService = new TranscodeService();
