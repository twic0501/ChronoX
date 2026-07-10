import os
import sys
from huggingface_hub import snapshot_download, hf_hub_download

# Create directories
MODELS_DIR = "models"
os.makedirs(MODELS_DIR, exist_ok=True)

def download_whisper():
    print("--- Downloading faster-whisper (distil-large-v3) ---")
    whisper_dir = os.path.join(MODELS_DIR, "whisper")
    os.makedirs(whisper_dir, exist_ok=True)
    try:
        snapshot_download(
            repo_id="Systran/faster-distil-whisper-large-v3",
            local_dir=whisper_dir,
            ignore_patterns=["*.pth", "*.pt"] # only download CTranslate2 format
        )
        print("Faster-whisper download complete.\n")
    except Exception as e:
        print(f"⚠️ Warning: Failed to download faster-whisper: {e}")
        print("ChronoX will fall back to mock transcription when running offline.\n")

def download_pyannote():
    print("--- Downloading pyannote-v3-segmentation-GGUF ---")
    pyannote_dir = os.path.join(MODELS_DIR, "pyannote")
    os.makedirs(pyannote_dir, exist_ok=True)
    try:
        hf_hub_download(
            repo_id="cstr/pyannote-v3-segmentation-GGUF",
            filename="pyannote-seg-3.0.gguf",
            local_dir=pyannote_dir
        )
        print("PyAnnote GGUF download complete.\n")
    except Exception as e:
        print(f"⚠️ Warning: Failed to download PyAnnote GGUF: {e}")
        print("ChronoX will fall back to envelope-based VAD analysis when running offline.\n")

# YOLO download removed to keep only upscaling and analytical models

def download_siglip():
    print("--- Downloading siglip2-base-patch16-224-ONNX ---")
    siglip_dir = os.path.join(MODELS_DIR, "siglip")
    os.makedirs(siglip_dir, exist_ok=True)
    try:
        snapshot_download(
            repo_id="onnx-community/siglip2-base-patch16-224-ONNX",
            local_dir=siglip_dir
        )
        print("SigLIP2 download complete.\n")
    except Exception as e:
        print(f"⚠️ Warning: Failed to download SigLIP2: {e}")
        print("ChronoX will fall back to analytical embeddings.\n")

# ReID download removed to keep only upscaling and analytical models

def download_dat():
    print("--- Downloading DAT-light Model ---")
    dat_dir = os.path.join(MODELS_DIR, "dat")
    os.makedirs(dat_dir, exist_ok=True)
    try:
        hf_hub_download(
            repo_id="rotivrotiv/model-weights",
            filename="dat_light_x2.onnx",
            local_dir=dat_dir,
            local_dir_use_symlinks=False
        )
        # Rename to default
        src = os.path.join(dat_dir, "dat_light_x2.onnx")
        dst = os.path.join(dat_dir, "dat_light.onnx")
        if os.path.exists(src) and not os.path.exists(dst):
            os.rename(src, dst)
        print("DAT-light download complete.\n")
    except Exception as e:
        print(f"⚠️ Warning: Failed to download DAT-light: {e}")
        print("ChronoX will fall back to default upscaling preview.\n")

def main():
    print("Starting ChronoX Local AI Model Downloader...")
    download_whisper()
    download_pyannote()
    download_siglip()
    download_dat()
    print("All models setup completed!")

if __name__ == "__main__":
    main()
