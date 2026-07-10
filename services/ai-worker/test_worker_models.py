import os
import sys

MODELS_DIR = "models"

def test_whisper_loading():
    print("Testing faster-whisper model loading...")
    model_path = os.path.join(MODELS_DIR, "whisper")
    model_bin = os.path.join(model_path, "model.bin")
    
    if not os.path.exists(model_bin):
        print(f"❌ Error: model.bin not found at {model_bin}")
        return False
        
    try:
        from faster_whisper import WhisperModel
        print("Imported faster-whisper. Initializing WhisperModel on CPU...")
        model = WhisperModel(model_path, device="cpu", compute_type="int8")
        print("✅ Success: WhisperModel loaded successfully!")
        return True
    except Exception as e:
        print(f"❌ Failed to load WhisperModel: {e}")
        return False

def test_pyannote_check():
    print("Testing pyannote model presence...")
    pyannote_file = os.path.join(MODELS_DIR, "pyannote", "pyannote-seg-3.0.gguf")
    if os.path.exists(pyannote_file):
        print(f"✅ Success: pyannote-seg-3.0.gguf is present at {pyannote_file} ({os.path.getsize(pyannote_file)} bytes)")
        return True
    else:
        print(f"❌ Error: pyannote-seg-3.0.gguf not found at {pyannote_file}")
        return False

if __name__ == "__main__":
    print("=== Verification of Imported Models ===")
    whisper_ok = test_whisper_loading()
    pyannote_ok = test_pyannote_check()
    
    if whisper_ok and pyannote_ok:
        print("\n🎉 ALL MODEL TESTS PASSED SUCCESSFULLY!")
        sys.exit(0)
    else:
        print("\n❌ SOME TESTS FAILED.")
        sys.exit(1)
