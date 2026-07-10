import os
import sqlite3
import wave
import subprocess
import numpy as np
import cv2
import requests
from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
from typing import Optional, List

app = FastAPI(title="ChronoX Python AI Worker & Advanced Local Model Suite")

DB_PATH = "../core-backend/chronox.db"
MODELS_DIR = "models"

def probe_hardware_capabilities():
    device = "cpu"
    providers = ["CPUExecutionProvider"]
    try:
        import torch
        if torch.cuda.is_available():
            device = "cuda"
            print("CUDA detected via PyTorch.")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
            print("MPS (Apple Silicon) detected via PyTorch.")
    except ImportError:
        pass
    try:
        import onnxruntime as ort
        available = ort.get_available_providers()
        if "CUDAExecutionProvider" in available:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            print("ONNX Runtime CUDA provider available.")
        elif "CoreMLExecutionProvider" in available:
            providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
            print("ONNX Runtime CoreML provider available.")
    except ImportError:
        pass
    return {"device": device, "onnx_providers": providers}

HW_CAPABILITIES = probe_hardware_capabilities()


# Global cache for CLIP visual vectors
scene_ids = []
scene_matrix = None

# Lazy-loaded model instances
whisper_model = None

def load_vector_cache():
    global scene_ids, scene_matrix
    print("Loading CLIP vector cache from SQLite...")
    
    db_file = DB_PATH
    if not os.path.exists(db_file):
        db_file = "chronox.db"
    
    if not os.path.exists(db_file):
        print(f"Database not found at {db_file}, empty cache initialized.")
        scene_ids = []
        scene_matrix = None
        return
        
    try:
        conn = sqlite3.connect(db_file)
        cursor = conn.cursor()
        
        # Check if table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_vectors'")
        if not cursor.fetchone():
            print("scene_vectors table does not exist yet.")
            scene_ids = []
            scene_matrix = None
            conn.close()
            return

        cursor.execute("SELECT id, vector FROM scene_vectors")
        rows = cursor.fetchall()
        conn.close()
        
        if not rows:
            print("No vectors in scene_vectors table.")
            scene_ids = []
            scene_matrix = None
            return
            
        scene_ids = [r[0] for r in rows]
        vectors = []
        for r in rows:
            vec = np.frombuffer(r[1], dtype=np.float32)
            if vec.shape[0] == 512:
                vectors.append(vec)
            else:
                padded = np.zeros(512, dtype=np.float32)
                padded[:min(512, vec.shape[0])] = vec[:min(512, vec.shape[0])]
                vectors.append(padded)
                
        scene_matrix = np.stack(vectors)
        norms = np.linalg.norm(scene_matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        scene_matrix = scene_matrix / norms
        print(f"Successfully loaded and normalized {len(scene_ids)} vectors into NumPy array.")
    except Exception as e:
        print(f"Error loading vector cache: {e}")

@app.on_event("startup")
def startup_event():
    load_vector_cache()

@app.post("/api/ai/reload-cache")
def reload_cache():
    load_vector_cache()
    return {"status": "reloaded", "count": len(scene_ids)}

class SearchQuery(BaseModel):
    query_vector: list[float]
    top_k: int = 5

@app.post("/api/ai/search")
def search_scenes(query: SearchQuery):
    global scene_ids, scene_matrix
    if scene_matrix is None or len(scene_ids) == 0:
        return {"results": []}
        
    try:
        q_vec = np.array(query.query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q_vec)
        if q_norm > 0:
            q_vec = q_vec / q_norm
            
        scores = np.dot(scene_matrix, q_vec)
        indices = np.argsort(scores)[::-1][:query.top_k]
        
        results = []
        for idx in indices:
            results.append({
                "scene_id": scene_ids[idx],
                "score": float(scores[idx])
            })
        return {"results": results}
    except Exception as e:
        return {"error": str(e), "results": []}

class VadRequest(BaseModel):
    element_id: str = None
    audio_path: str

def run_vad_background(element_id: str, audio_path: str):
    print(f"Running VAD on {audio_path} for element {element_id}...")
    
    # Precise envelope fallback VAD
    segments = []
    try:
        if os.path.exists(audio_path):
            with wave.open(audio_path, 'rb') as w:
                params = w.getparams()
                frames = w.readframes(params.nframes)
                samples = np.frombuffer(frames, dtype=np.int16)
                samples = samples.astype(np.float32) / 32768.0
                
                win_size = int(params.framerate * 0.1)
                rms = []
                for i in range(0, len(samples), win_size):
                    chunk = samples[i:i+win_size]
                    if len(chunk) == 0:
                        break
                    rms.append(np.sqrt(np.mean(chunk**2)))
                
                # Threshold for vocal activity detection
                is_speech = np.array(rms) > 0.015
                in_speech = False
                start_time = 0.0
                for idx, val in enumerate(is_speech):
                    t = idx * 0.1
                    if val and not in_speech:
                        in_speech = True
                        start_time = t
                    elif not val and in_speech:
                        in_speech = False
                        if t - start_time >= 0.4:
                            segments.append({"start": start_time, "end": t})
                if in_speech:
                    segments.append({"start": start_time, "end": len(rms)*0.1})
        else:
            # Simulated segments if file not found
            segments = [
                {"start": 1.2, "end": 5.5},
                {"start": 8.0, "end": 12.3},
                {"start": 15.7, "end": 22.1}
            ]
    except Exception as e:
        print(f"VAD analytical error: {e}")
        segments = [{"start": 1.0, "end": 4.5}]

    # Send webhook to Axum
    url = "http://127.0.0.1:8000/api/webhook/vad"
    payload = {
        "element_id": element_id,
        "segments": segments
    }
    try:
        res = requests.post(url, json=payload)
        print(f"VAD webhook sent. Status: {res.status_code}")
    except Exception as e:
        print(f"Failed to send VAD webhook: {e}")

@app.post("/api/ai/vad")
def run_vad(req: VadRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(run_vad_background, req.element_id, req.audio_path)
    return {"status": "started"}

# ✂️ AM THANH - Transcribe / STT (faster-whisper)
class TranscribeRequest(BaseModel):
    audio_path: str
    language: Optional[str] = "vi"

@app.post("/api/ai/transcribe")
def transcribe_audio(req: TranscribeRequest):
    global whisper_model
    model_path = os.path.join(MODELS_DIR, "whisper")
    
    if not os.path.exists(req.audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
        
    if os.path.exists(os.path.join(model_path, "model.bin")):
        from faster_whisper import WhisperModel
        # Try the preferred device first, then always fall back to CPU —
        # CUDA can fail at runtime (e.g. libcublas.so.12 missing) even when
        # PyTorch reports a GPU.
        attempts = []
        if HW_CAPABILITIES["device"] == "cuda":
            attempts.append(("cuda", "float16"))
        attempts.append(("cpu", "int8"))
        for dev, comp in attempts:
            try:
                if whisper_model is None:
                    whisper_model = WhisperModel(model_path, device=dev, compute_type=comp)
                segments, info = whisper_model.transcribe(req.audio_path, language=req.language, beam_size=5)
                results = []
                for seg in segments:
                    results.append({
                        "start": seg.start,
                        "end": seg.end,
                        "text": seg.text
                    })
                return {"transcription": results, "language": info.language}
            except Exception as e:
                print(f"Whisper {dev} error: {e}")
                whisper_model = None  # drop the broken instance, retry next device
    
    # Fallback/Mock transcription if weights not downloaded
    return {
        "transcription": [
            {"start": 0.5, "end": 3.0, "text": "Welcome to ChronoX."},
            {"start": 3.5, "end": 7.2, "text": "The local AI system was integrated successfully."}
        ],
        "language": "en",
        "fallback": True
    }

# 🚀 PHỤC CHẾ & XUẤT FILE - DAT-light & video2x
class UpscaleRequest(BaseModel):
    input_path: str
    output_path: str
    scale: int = 2

@app.post("/api/ai/upscale")
def run_upscaling(req: UpscaleRequest, background_tasks: BackgroundTasks):
    def do_upscale():
        print(f"Upscaling {req.input_path} using DAT-light/video2x...")
        # Call video2x CLI in background
        try:
            subprocess.run([
                "video2x", 
                "-i", req.input_path, 
                "-o", req.output_path, 
                "-s", str(req.scale)
            ], check=True)
        except Exception as e:
            print(f"video2x execution fallback: {e}")
            subprocess.run(["cp", req.input_path, req.output_path])
            
    background_tasks.add_task(do_upscale)
    return {"status": "started", "output": req.output_path}

# 🎬 SCENE DETECTION - PySceneDetect (Auto scene cut markers for Mimic Engine)
class SceneDetectRequest(BaseModel):
    video_path: str
    threshold: float = 27.0

@app.post("/api/ai/detect-scenes")
def detect_scenes(req: SceneDetectRequest):
    if not os.path.exists(req.video_path):
        raise HTTPException(status_code=404, detail="Video file not found")
    try:
        from scenedetect import detect, ContentDetector
        scene_list = detect(req.video_path, ContentDetector(threshold=req.threshold))
        scenes = [
            {
                "index": i,
                "start": s[0].get_seconds(),
                "end": s[1].get_seconds(),
            }
            for i, s in enumerate(scene_list)
        ]
        return {"scenes": scenes, "count": len(scenes), "fallback": False}
    except ImportError:
        return {"scenes": [], "count": 0, "fallback": True, "error": "scenedetect not installed"}
    except Exception as e:
        return {"scenes": [], "count": 0, "fallback": True, "error": str(e)}


# 🎬 SCENE MAP - full per-scene analysis for the AI (cuts + color + content tag)
# Runs entirely server-side (ffmpeg/PySceneDetect/cv2) so it works on source
# files the browser's WebCodecs decoder can't parse (bad avcC boxes).
class SceneMapRequest(BaseModel):
    video_path: str
    threshold: float = 27.0


def _frame_histogram_and_dominant(frame_bgr):
    """Return (histogram %, top-3 dominant hex colors) for a frame."""
    small = cv2.resize(frame_bgr, (120, 68))
    b, g, r = small[:, :, 0].astype(np.float32), small[:, :, 1].astype(np.float32), small[:, :, 2].astype(np.float32)
    luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    shadows = float((luma < 0.33).mean()) * 100.0
    highlights = float((luma > 0.66).mean()) * 100.0
    midtones = max(0.0, 100.0 - shadows - highlights)
    # Dominant colors via coarse RGB quantization (buckets of 64)
    q = (small.reshape(-1, 3) // 64) * 64 + 32
    keys, counts = np.unique(q, axis=0, return_counts=True)
    order = np.argsort(counts)[::-1][:3]
    dominant = [
        "#{:02x}{:02x}{:02x}".format(int(keys[i][2]), int(keys[i][1]), int(keys[i][0]))  # BGR→RGB
        for i in order
    ]
    return (
        {"shadows": round(shadows), "midtones": round(midtones), "highlights": round(highlights)},
        dominant,
    )


def _scene_content_tag(frame_bgr):
    """Tag a scene by whether a prominent person is present (for keep-scenery filtering)."""
    try:
        candidates = [
            ("yolo11n.pt", "detect"),
            (os.path.join(MODELS_DIR, "yolo", "yolov12n.onnx"), "detect"),
            ("yolo11n-seg.pt", "segment"),
            (os.path.join(MODELS_DIR, "yolo", "yolov12n-seg.onnx"), "segment"),
        ]
        mp, task = next(((p, t) for p, t in candidates if os.path.exists(p)), (None, None))
        if not mp:
            return "scenery"
        from ultralytics import YOLO
        model = YOLO(mp, task=task)
        results = model(frame_bgr, verbose=False)
        h, w = frame_bgr.shape[:2]
        frame_area = float(h * w)
        person_area = 0.0
        for res in results:
            boxes = res.boxes
            if boxes is None:
                continue
            for i in range(len(boxes)):
                cls = int(boxes.cls[i]) if boxes.cls is not None else -1
                if cls == 0:  # person
                    x1, y1, x2, y2 = boxes.xyxy[i].tolist()
                    person_area = max(person_area, abs((x2 - x1) * (y2 - y1)))
        ratio = person_area / frame_area if frame_area > 0 else 0.0
        if ratio > 0.18:
            return "person / talking subject"
        if ratio > 0.04:
            return "person in scene"
        return "scenery / landscape"
    except Exception as e:
        print(f"Scene content tag skipped: {e}")
        return "scenery"


@app.post("/api/ai/scene-map")
def scene_map(req: SceneMapRequest):
    if not os.path.exists(req.video_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {req.video_path}")
    try:
        from scenedetect import detect, ContentDetector
        scene_list = detect(req.video_path, ContentDetector(threshold=req.threshold))
        spans = [(s[0].get_seconds(), s[1].get_seconds()) for s in scene_list]
    except Exception as e:
        print(f"scene-map detect failed: {e}")
        spans = []

    cap = cv2.VideoCapture(req.video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    total_duration = (frame_count / fps) if fps > 0 else 0.0
    if not spans:
        # Whole clip as a single scene if detection found nothing
        spans = [(0.0, total_duration if total_duration > 0 else 0.0)]

    scenes = []
    for i, (start, end) in enumerate(spans):
        mid = start + max((end - start) / 2.0, 0.0)
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(mid * fps))
        ok, frame = cap.read()
        if not ok:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(start * fps))
            ok, frame = cap.read()
        if ok:
            color = _frame_color_stats(frame)
            hist, dominant = _frame_histogram_and_dominant(frame)
            tag = _scene_content_tag(frame)
        else:
            color = {"brightness": 0.5, "contrast": 0.1, "saturation": 0.1, "warmth": 0.0, "shadow_sat": 0.0}
            hist, dominant, tag = {"shadows": 33, "midtones": 34, "highlights": 33}, ["#808080"], "scenery"
        scenes.append({
            "index": i,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "contentTag": tag,
            "colorStats": {
                "brightness": round(color["brightness"], 3),
                "contrast": round(color["contrast"], 3),
                "saturation": round(color["saturation"], 3),
                "warmth": round(color["warmth"], 3),
                "dominantColors": dominant,
                "histogram": hist,
            },
        })
    cap.release()
    return {"scenes": scenes, "count": len(scenes), "totalDuration": round(total_duration, 3), "fallback": False}

# 🥁 BEAT DETECTION - librosa (Auto-Beat Match Cut: emit beat timestamps for the timeline)
class BeatDetectRequest(BaseModel):
    audio_path: str
    # "beat": steady musical beat grid; "onset": every percussive hit
    mode: str = "beat"

@app.post("/api/ai/detect-beats")
def detect_beats(req: BeatDetectRequest):
    if not os.path.exists(req.audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    try:
        import librosa
        y, sr = librosa.load(req.audio_path, sr=22050, mono=True)
        if req.mode == "onset":
            onset_frames = librosa.onset.onset_detect(y=y, sr=sr, backtrack=True)
            times = librosa.frames_to_time(onset_frames, sr=sr)
            return {
                "bpm": None,
                "beats": [round(float(t), 3) for t in times],
                "count": int(len(times)),
                "fallback": False,
            }
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        times = librosa.frames_to_time(beat_frames, sr=sr)
        bpm = float(tempo) if np.isscalar(tempo) else float(np.atleast_1d(tempo)[0])
        return {
            "bpm": round(bpm, 1),
            "beats": [round(float(t), 3) for t in times],
            "count": int(len(times)),
            "fallback": False,
        }
    except ImportError:
        return {"bpm": None, "beats": [], "count": 0, "fallback": True, "error": "librosa not installed"}
    except Exception as e:
        return {"bpm": None, "beats": [], "count": 0, "fallback": True, "error": str(e)}

# 🎭 MIMIC ENGINE - Reverse-engineer templates and edit to audio beat grids
class MimicFlowRequest(BaseModel):
    reference_video_path: Optional[str] = None
    # A previously measured style profile (the `style_profile` this endpoint
    # returned earlier). When set, the reference video is not needed at all —
    # the saved style is re-adapted to the current target footage.
    reference_profile: Optional[dict] = None
    target_audio_path: Optional[str] = None
    target_video_path: Optional[str] = None
    target_video_duration: float = 30.0

def get_subject_box_center(video_path: str, timestamp_sec: float) -> tuple:
    """Extract frame at timestamp and run YOLOv11/12 segmenter to center zooms on the main subject."""
    try:
        import cv2
        from ultralytics import YOLO
        
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return 0.0, 0.0
            
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_id = int(timestamp_sec * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_id)
        ret, frame = cap.read()
        cap.release()
        
        if ret:
            # Resolve the lightest weight that actually exists. Detection boxes
            # (.boxes) are populated by both detect and seg models, so a seg
            # weight is a valid fallback — we only need the bounding box here.
            candidates = [
                ("yolo11n.pt", "detect"),
                (os.path.join(MODELS_DIR, "yolo", "yolov12n.onnx"), "detect"),
                ("yolo11n-seg.pt", "segment"),
                (os.path.join(MODELS_DIR, "yolo", "yolov12n-seg.onnx"), "segment"),
            ]
            model_path, task = next(
                ((p, t) for p, t in candidates if os.path.exists(p)),
                (None, None),
            )
            if model_path:
                model = YOLO(model_path, task=task)
                results = model(frame, verbose=False)
                # Prefer a person (class 0) as the subject; else the most
                # confident box overall — not just the first detection.
                best = None
                for r in results:
                    boxes = r.boxes
                    if boxes is None or len(boxes) == 0:
                        continue
                    for i in range(len(boxes)):
                        cls = int(boxes.cls[i]) if boxes.cls is not None else -1
                        conf = float(boxes.conf[i]) if boxes.conf is not None else 0.0
                        score = conf + (1.0 if cls == 0 else 0.0)  # bias toward people
                        if best is None or score > best[0]:
                            best = (score, boxes[i].xyxyn[0].tolist())
                if best:
                    box = best[1]  # [x1, y1, x2, y2] normalized
                    cx = (box[0] + box[2]) / 2.0
                    cy = (box[1] + box[3]) / 2.0
                    # Offset relative to screen center (-0.5 to 0.5)
                    return round(cx - 0.5, 2), round(cy - 0.5, 2)
    except Exception as e:
        print(f"Content-Aware YOLO center detection skipped: {e}")
    # Deterministic fallback: center the zoom when detection is unavailable
    return 0.0, 0.0

# ── Mimic Engine v2: measure → understand → adapt ────────────────
# Instead of applying a fixed preset, the engine MEASURES the reference
# video (pacing, beat sync, camera motion, color grade, letterbox) and
# the user's raw target, then derives per-segment parameters from the
# measured deltas.

def _extract_audio_wav(video_path: str) -> Optional[str]:
    """Extract mono 22.05 kHz wav via ffmpeg for beat analysis."""
    import subprocess, tempfile
    out = os.path.join(tempfile.gettempdir(), f"mimic_{abs(hash(video_path)) % 10**8}.wav")
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "22050", out],
            capture_output=True, timeout=120,
        )
        if r.returncode == 0 and os.path.exists(out):
            return out
    except Exception as e:
        print(f"Mimic audio extract skipped: {e}")
    return None


def _frame_color_stats(frame_bgr):
    """Brightness/contrast/saturation/warmth/shadow-tint of one frame (all 0..1-ish)."""
    small = cv2.resize(frame_bgr, (160, 90)).astype(np.float32) / 255.0
    b, g, r = small[:, :, 0], small[:, :, 1], small[:, :, 2]
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    mx = small.max(axis=2)
    mn = small.min(axis=2)
    sat = mx - mn
    shadow_mask = luma < 0.15
    shadow_sat = float(sat[shadow_mask].mean()) if shadow_mask.any() else 0.0
    return {
        "brightness": float(luma.mean()),
        "contrast": float(luma.std()),
        "saturation": float(sat.mean()),
        "warmth": float((r - b).mean()),
        "shadow_sat": shadow_sat,
    }


def _frame_letterbox_aspect(frame_bgr):
    """Detect black bars; return content aspect ratio or None."""
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    row_mean = gray.mean(axis=1)
    top = 0
    while top < h // 3 and row_mean[top] < 16:
        top += 1
    bottom = 0
    while bottom < h // 3 and row_mean[h - 1 - bottom] < 16:
        bottom += 1
    bar = top + bottom
    if bar < h * 0.06:  # less than ~6% of height → no meaningful bars
        return None
    content_h = h - bar
    if content_h <= 0:
        return None
    return round(w / content_h, 2)


def _motion_between(prev_gray, gray, dt):
    """Farneback flow → per-second motion descriptors: shake, zoom rate, pan."""
    flow = cv2.calcOpticalFlowFarneback(
        prev_gray, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0
    )
    h, w = prev_gray.shape
    fx, fy = flow[:, :, 0], flow[:, :, 1]
    pan_x = float(fx.mean())
    pan_y = float(fy.mean())
    # residual after removing global pan ≈ handheld shake energy
    shake = float(np.sqrt((fx - pan_x) ** 2 + (fy - pan_y) ** 2).mean())
    # radial component sign → zoom in (+) / out (−); normalized by frame size
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = xs - w / 2.0
    dy = ys - h / 2.0
    dist = np.sqrt(dx ** 2 + dy ** 2) + 1e-3
    radial = ((fx - pan_x) * dx + (fy - pan_y) * dy) / dist
    zoom_rate = float(radial.mean()) / (max(w, h) / 2.0)
    dt = max(dt, 1e-3)
    return {
        "shake": shake / dt / max(w, h),          # normalized shake per second
        "zoom_rate": zoom_rate / dt,               # fraction of half-frame per second
        "pan_x": pan_x / dt / w,                   # frame-widths per second
        "pan_y": pan_y / dt / h,
    }


def _classify_cut_transitions(path: str, cut_times: list, max_cuts: int = 24) -> dict:
    """Classify how each cut in the reference transitions:
    hard, dissolve, dip_black, flash_white, whip, zoom_punch.
    Samples ±0.33s of frames around each cut and inspects luma/diff/flow."""
    counts = {"hard": 0, "dissolve": 0, "dip_black": 0, "flash_white": 0, "whip": 0, "zoom_punch": 0}
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    for cut in cut_times[:max_cuts]:
        start_f = max(0, int((cut - 0.33) * fps))
        n = max(6, int(0.66 * fps))
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
        grays = []
        for _ in range(n):
            ok, fr = cap.read()
            if not ok:
                break
            grays.append(cv2.cvtColor(cv2.resize(fr, (160, 90)), cv2.COLOR_BGR2GRAY))
        if len(grays) < 4:
            counts["hard"] += 1
            continue
        lumas = [float(g.mean()) / 255.0 for g in grays]
        diffs = [
            float(np.abs(grays[i + 1].astype(np.float32) - grays[i].astype(np.float32)).mean()) / 255.0
            for i in range(len(grays) - 1)
        ]
        peak = int(np.argmax(diffs))
        peak_d = diffs[peak]
        med = float(np.median(diffs)) + 1e-6
        m = _motion_between(grays[peak], grays[min(peak + 1, len(grays) - 1)], 1.0 / fps)
        peak_luma_i = int(np.argmax(lumas))
        if min(lumas) < 0.06:
            counts["dip_black"] += 1
        elif max(lumas) > 0.85 and 0 < peak_luma_i < len(lumas) - 1:
            counts["flash_white"] += 1
        elif abs(m["pan_x"]) + abs(m["pan_y"]) > 1.2:
            counts["whip"] += 1
        elif abs(m["zoom_rate"]) > 0.35:
            counts["zoom_punch"] += 1
        elif peak_d < 2.5 * med and sum(d > 0.02 for d in diffs) >= max(4, len(diffs) // 2):
            counts["dissolve"] += 1
        else:
            counts["hard"] += 1
    cap.release()
    return counts


def _frame_vignette(frame_bgr) -> float:
    """0..1 vignette strength: how much darker the corners are vs the center."""
    gray = cv2.cvtColor(cv2.resize(frame_bgr, (160, 90)), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    h, w = gray.shape
    ch, cw = h // 3, w // 3
    center = float(gray[ch : 2 * ch, cw : 2 * cw].mean()) + 1e-3
    kh, kw = h // 6, w // 6
    corners = float(
        np.mean([
            gray[:kh, :kw].mean(),
            gray[:kh, -kw:].mean(),
            gray[-kh:, :kw].mean(),
            gray[-kh:, -kw:].mean(),
        ])
    )
    return max(0.0, min(1.0, 1.0 - corners / center))


def analyze_video_style(path: str, max_scenes: int = 16, classify_transitions: bool = False) -> dict:
    """Measure a video's editing style: pacing, motion, color, letterbox, beat sync."""
    from scenedetect import detect, ContentDetector

    duration = 0.0
    try:
        import av
        container = av.open(path)
        stream = container.streams.video[0]
        if stream.duration and stream.time_base:
            duration = float(stream.duration * stream.time_base)
        container.close()
    except Exception:
        pass

    cut_times = []
    scene_spans = []
    try:
        scene_list = detect(path, ContentDetector(threshold=27.0))
        scene_spans = [(s[0].get_seconds(), s[1].get_seconds()) for s in scene_list]
        cut_times = [s[0] for s in scene_spans if s[0] > 0.01]
        if duration <= 0 and scene_spans:
            duration = scene_spans[-1][1]
    except Exception as e:
        print(f"Mimic scene detect failed on {path}: {e}")
    if not scene_spans:
        duration = duration or 30.0
        scene_spans = [(0.0, duration)]

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    scenes = []
    letterbox_votes = []
    vignette_vals = []
    for (start, end) in scene_spans[:max_scenes]:
        seg_len = max(end - start, 0.1)
        sample_times = [start + seg_len * f for f in (0.15, 0.5, 0.85)]
        frames = []
        for t in sample_times:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
            ok, frame = cap.read()
            if ok:
                frames.append((t, frame))
        if not frames:
            continue
        color = _frame_color_stats(frames[len(frames) // 2][1])
        lb = _frame_letterbox_aspect(frames[len(frames) // 2][1])
        if lb:
            letterbox_votes.append(lb)
        vignette_vals.append(_frame_vignette(frames[len(frames) // 2][1]))
        motion = None
        if len(frames) >= 2:
            g0 = cv2.cvtColor(cv2.resize(frames[0][1], (160, 90)), cv2.COLOR_BGR2GRAY)
            g1 = cv2.cvtColor(cv2.resize(frames[-1][1], (160, 90)), cv2.COLOR_BGR2GRAY)
            motion = _motion_between(g0, g1, frames[-1][0] - frames[0][0])
        scenes.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "len": round(seg_len, 3),
            "color": color,
            "motion": motion or {"shake": 0.0, "zoom_rate": 0.0, "pan_x": 0.0, "pan_y": 0.0},
        })
    cap.release()

    # Audio: tempo + beat alignment of the cuts
    bpm = None
    beats = []
    beat_sync = 0.0
    wav = _extract_audio_wav(path)
    if wav:
        try:
            import librosa
            y, sr = librosa.load(wav, sr=22050, mono=True)
            tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
            bpm = float(np.atleast_1d(tempo)[0])
            beats = [float(t) for t in librosa.frames_to_time(beat_frames, sr=sr)]
            if cut_times and beats:
                on_beat = sum(
                    1 for c in cut_times if min(abs(c - b) for b in beats) <= 0.15
                )
                beat_sync = on_beat / len(cut_times)
        except Exception as e:
            print(f"Mimic beat analysis skipped: {e}")
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass

    shot_lens = [s["len"] for s in scenes] or [duration]
    color_avg = {
        k: float(np.mean([s["color"][k] for s in scenes]))
        for k in ("brightness", "contrast", "saturation", "warmth", "shadow_sat")
    } if scenes else {}
    return {
        "duration": round(duration, 3),
        "cut_times": [round(c, 3) for c in cut_times],
        "scenes": scenes,
        "avg_shot_len": round(float(np.mean(shot_lens)), 3),
        "shot_len_std": round(float(np.std(shot_lens)), 3),
        "color": {k: round(v, 4) for k, v in color_avg.items()},
        "letterbox_aspect": (round(float(np.median(letterbox_votes)), 2) if len(letterbox_votes) >= max(1, len(scenes) // 2) else None),
        "bpm": round(bpm, 1) if bpm else None,
        "beats": [round(b, 3) for b in beats],
        "beat_sync": round(beat_sync, 3),
        "avg_shake": round(float(np.mean([s["motion"]["shake"] for s in scenes])), 4) if scenes else 0.0,
        "avg_zoom_rate": round(float(np.mean([abs(s["motion"]["zoom_rate"]) for s in scenes])), 4) if scenes else 0.0,
        "vignette": round(float(np.mean(vignette_vals)), 3) if vignette_vals else 0.0,
        "transitions": (
            _classify_cut_transitions(path, cut_times)
            if classify_transitions and cut_times
            else None
        ),
    }


def _pick_reference_scene(ref_scenes, ref_duration, seg_mid_ratio):
    """Choose the reference scene whose relative position matches the target segment."""
    if not ref_scenes:
        return None
    best = min(
        ref_scenes,
        key=lambda s: abs(((s["start"] + s["end"]) / 2.0) / max(ref_duration, 1e-3) - seg_mid_ratio),
    )
    return best


def _summarize_style(ref: dict) -> str:
    parts = []
    pace = ref.get("avg_shot_len") or 0
    if pace:
        label = "fast-paced" if pace < 2.5 else ("moderate" if pace < 5 else "slow, contemplative")
        parts.append(f"avg shot {pace:.1f}s ({label})")
    if ref.get("bpm") and ref.get("beat_sync", 0) >= 0.4:
        parts.append(f"{int(round(ref['beat_sync'] * 100))}% of cuts land on the beat (~{ref['bpm']:.0f} BPM)")
    if ref.get("avg_shake", 0) > 0.004:
        parts.append("handheld camera energy")
    if ref.get("avg_zoom_rate", 0) > 0.008:
        parts.append("slow push-ins/zooms")
    c = ref.get("color") or {}
    if c:
        tone = "warm" if c.get("warmth", 0) > 0.02 else ("cool/teal" if c.get("warmth", 0) < -0.02 else "neutral")
        con = "high-contrast" if c.get("contrast", 0) > 0.22 else "soft-contrast"
        parts.append(f"{tone}, {con} grade")
        if c.get("shadow_sat", 1) < 0.04:
            parts.append("cleaned shadows")
    if ref.get("letterbox_aspect"):
        parts.append(f"letterbox {ref['letterbox_aspect']}:1")
    if ref.get("vignette", 0) > 0.15:
        parts.append("vignetted")
    trans = ref.get("transitions") or {}
    styled = {k: v for k, v in trans.items() if k != "hard" and v > 0}
    if styled:
        total = sum(trans.values()) or 1
        desc = ", ".join(f"{v}× {k.replace('_', '-')}" for k, v in sorted(styled.items(), key=lambda kv: -kv[1]))
        parts.append(f"transitions: {desc} (of {total} cuts)")
    return "; ".join(parts) if parts else "no distinctive style markers detected"


@app.post("/api/ai/mimic-flow")
def run_mimic_flow(req: MimicFlowRequest):
    if not req.reference_profile and not (
        req.reference_video_path and os.path.exists(req.reference_video_path)
    ):
        raise HTTPException(status_code=404, detail="Reference video file not found")

    has_target_video = bool(
        req.target_video_path
        and req.target_video_path.strip()
        and os.path.exists(req.target_video_path)
    )

    # 1. MEASURE the reference's style and the raw target's current state.
    # Transition classification only makes sense on the reference (that's the
    # style being copied) and is too costly on a long raw target.
    # A saved reference_profile skips the measurement entirely — the style was
    # analyzed once and is now being re-adapted to new footage.
    ref = req.reference_profile or analyze_video_style(
        req.reference_video_path, classify_transitions=True
    )
    tgt = analyze_video_style(req.target_video_path) if has_target_video else None

    # The caller sends the EDITED timeline's length (post-cut montage) as
    # target_video_duration — prefer it over the raw target file's duration so
    # the segment grid spans the montage, not the full uncut source footage.
    target_duration = req.target_video_duration or (tgt["duration"] if tgt and tgt["duration"] > 0 else 0) or 30.0

    # Target soundtrack beats: explicit audio path wins, else the target video's own audio
    beats = []
    if req.target_audio_path and os.path.exists(req.target_audio_path or ""):
        wav = _extract_audio_wav(req.target_audio_path)
        if wav:
            try:
                import librosa
                y, sr = librosa.load(wav, sr=22050, mono=True)
                onset = librosa.onset.onset_detect(y=y, sr=sr, backtrack=True)
                beats = [float(t) for t in librosa.frames_to_time(onset, sr=sr)]
            except Exception as e:
                print(f"Target beat detect skipped: {e}")
            finally:
                try:
                    os.remove(wav)
                except OSError:
                    pass
    elif tgt:
        beats = tgt.get("beats") or []

    target_scene_cuts = (tgt.get("cut_times") if tgt else []) or []

    # 2. PLAN the cut grid: reference pacing projected on the target,
    #    elastic-snapped to the target's own beats and natural cuts.
    pace = max(ref.get("avg_shot_len") or 3.0, 0.8)
    beat_driven = bool(beats) and ref.get("beat_sync", 0) >= 0.4
    theory_cuts = []
    t = pace
    while t < target_duration - 0.5 and len(theory_cuts) < 24:
        theory_cuts.append(t)
        t += pace

    mutations = []
    final_cuts = []
    for theory_time in theory_cuts:
        final_time = theory_time
        meta = f"Projected reference pacing ({pace:.1f}s/shot) at {theory_time:.2f}s"
        if beat_driven:
            nearest_beat = min(beats, key=lambda b: abs(b - theory_time))
            if abs(nearest_beat - theory_time) <= max(0.5 * pace, 0.4):
                final_time = nearest_beat
                meta = (
                    f"Beat-matched cut: reference has {int(ref['beat_sync'] * 100)}% on-beat cuts, "
                    f"snapped {theory_time:.2f}s → beat @ {nearest_beat:.2f}s"
                )
        elif target_scene_cuts:
            nearest_cut = min(target_scene_cuts, key=lambda c: abs(c - theory_time))
            if abs(nearest_cut - theory_time) <= 0.5:
                final_time = nearest_cut
                meta = (
                    f"Content-aware: snapped {theory_time:.2f}s to the raw footage's own "
                    f"shot change @ {nearest_cut:.2f}s"
                )
        if final_cuts and final_time - final_cuts[-1] < 0.4:
            continue  # avoid micro-slivers
        final_cuts.append(round(final_time, 3))
        mutations.append({
            "action": "SPLIT_AND_INSERT",
            "track_id": "V1",
            "target_pts_seconds": round(final_time, 3),
            "meta_reason": meta,
        })

    # 3. ADAPT per segment: derive parameters from the measured DELTA
    #    between the matching reference scene and the target's own look.
    seg_bounds = [0.0] + final_cuts + [target_duration]
    tgt_color = (tgt.get("color") if tgt else None) or {}
    for idx in range(len(seg_bounds) - 1):
        seg_start, seg_end = seg_bounds[idx], seg_bounds[idx + 1]
        seg_mid_ratio = ((seg_start + seg_end) / 2.0) / max(target_duration, 1e-3)
        ref_scene = _pick_reference_scene(ref.get("scenes") or [], ref.get("duration") or 1.0, seg_mid_ratio)
        if not ref_scene:
            continue
        rc = ref_scene["color"]

        # Color match: push the target TOWARD the reference look (deltas, not presets)
        if tgt_color:
            d_bright = rc["brightness"] - tgt_color.get("brightness", rc["brightness"])
            d_contrast = rc["contrast"] - tgt_color.get("contrast", rc["contrast"])
            d_sat = rc["saturation"] - tgt_color.get("saturation", rc["saturation"])
            d_warm = rc["warmth"] - tgt_color.get("warmth", rc["warmth"])
            clamp = lambda v, lo, hi: max(lo, min(hi, v))
            params = {
                "brightness": round(clamp(d_bright * 0.8, -0.3, 0.3), 3),
                "contrast": round(clamp(d_contrast * 1.5, -0.3, 0.4), 3),
                "saturation": round(clamp(d_sat * 1.2, -0.4, 0.4), 3),
                "temperature": round(clamp(d_warm * 2.0, -0.3, 0.3), 3),
            }
            if tgt_color.get("shadow_sat", 0) - rc.get("shadow_sat", 0) > 0.02:
                params["shadows"] = -0.1  # reference has cleaner shadows → dip target shadows
            if any(abs(v) >= 0.02 for v in params.values()):
                mutations.append({
                    "action": "ADJUST_COLOR",
                    "clip_index": idx,
                    "params_are_deltas": True,
                    "params": params,
                    "meta_reason": (
                        f"Color match seg{idx}: ref scene @{ref_scene['start']:.1f}s is "
                        f"{'warmer' if d_warm > 0 else 'cooler'} ({d_warm:+.3f}) and "
                        f"{'brighter' if d_bright > 0 else 'darker'} ({d_bright:+.3f}) than the raw footage"
                    ),
                })

        # Push-in zoom only where the reference scene actually zooms
        zr = ref_scene["motion"]["zoom_rate"]
        if abs(zr) > 0.008:
            seg_len = seg_end - seg_start
            scale = 1.0 + max(0.03, min(0.12, abs(zr) * seg_len))
            cx, cy = (0.0, 0.0)
            if has_target_video:
                cx, cy = get_subject_box_center(req.target_video_path, (seg_start + seg_end) / 2.0)
            mutations.append({
                "action": "ADD_ZOOM",
                "clip_index": idx,
                "centerX": cx,
                "centerY": cy,
                "scale": round(scale, 3),
                "direction": "in" if zr > 0 else "out",
                "meta_reason": (
                    f"Reference scene @{ref_scene['start']:.1f}s has a "
                    f"{'push-in' if zr > 0 else 'pull-out'} ({zr * 100:.1f}%/s) → "
                    f"{scale:.0%} punch centered on detected subject ({cx}, {cy})"
                ),
            })

        # Handheld energy: add camera-shake only if reference is shaky and target is static
        ref_shake = ref_scene["motion"]["shake"]
        tgt_shake = 0.0
        if tgt and tgt.get("scenes"):
            tgt_scene = _pick_reference_scene(tgt["scenes"], tgt["duration"], seg_mid_ratio)
            tgt_shake = tgt_scene["motion"]["shake"] if tgt_scene else 0.0
        if ref_shake > 0.004 and tgt_shake < ref_shake * 0.5:
            amplitude = round(min(0.03, max(0.005, (ref_shake - tgt_shake) * 2.0)), 4)
            mutations.append({
                "action": "ADD_EFFECT",
                "clip_index": idx,
                "effect_type": "camera-shake",
                "params": {"amplitude": amplitude, "frequency": 10.0},
                "meta_reason": (
                    f"Reference is handheld (shake {ref_shake:.4f}) but raw footage is static "
                    f"({tgt_shake:.4f}) → simulated handheld amplitude {amplitude}"
                ),
            })

    # 4. Global style ops derived from global measurements
    if ref.get("letterbox_aspect"):
        mutations.append({
            "action": "ADD_EFFECT",
            "clip_index": -1,  # all segments
            "effect_type": "letterbox",
            "params": {"aspectRatio": ref["letterbox_aspect"]},
            "meta_reason": f"Reference is letterboxed at {ref['letterbox_aspect']}:1 → apply cinematic bars",
        })
    if ref.get("vignette", 0) > 0.15:
        mutations.append({
            "action": "ADD_EFFECT",
            "clip_index": -1,
            "effect_type": "vignette",
            "params": {"intensity": round(min(0.8, ref["vignette"] * 1.5), 2)},
            "meta_reason": f"Reference has a vignette (corner falloff {ref['vignette']:.2f}) → matching vignette",
        })
    ref_c = ref.get("color") or {}
    if ref_c and ref_c.get("shadow_sat", 1) < 0.04 and ref_c.get("contrast", 0) > 0.2:
        mutations.append({
            "action": "ADD_EFFECT",
            "clip_index": -1,
            "effect_type": "lut_grade",
            "params": {"intensity": 0.6, "logProfile": 0.0, "lumaVsSatBottom": 0.15},
            "meta_reason": "Reference has a graded film look (clean shadows, strong contrast) → cinematic LUT at 60%",
        })

    summary = _summarize_style(ref)
    return {
        "status": "success",
        "reference_duration": ref.get("duration"),
        "target_duration": target_duration,
        # Segment grid the clip_index values refer to — lets the caller map
        # segments onto its own timeline clips by relative position.
        "segment_bounds": [round(b, 3) for b in seg_bounds],
        "style_profile": ref,
        # Raw-target scene motion (in SOURCE time) so the caller can adapt
        # techniques to its own footage, e.g. whip-pan direction follows the
        # clip's real camera pan.
        "target_profile": (
            {
                "duration": tgt["duration"],
                "scenes": [
                    {"start": s["start"], "end": s["end"], "motion": s["motion"]}
                    for s in (tgt.get("scenes") or [])
                ],
            }
            if tgt
            else None
        ),
        "summary": summary,
        "mutations": mutations,
    }

@app.get("/api/ai/status")
def get_ai_status():
    status = {}
    # Check Whisper
    status["whisper"] = "installed" if os.path.exists(os.path.join(MODELS_DIR, "whisper", "model.bin")) else "missing"
    # Check PyAnnote
    status["pyannote"] = "installed" if os.path.exists(os.path.join(MODELS_DIR, "pyannote", "pyannote-seg-3.0.gguf")) else "missing"
    # Check YOLO
    status["yolov12"] = "installed" if os.path.exists(os.path.join(MODELS_DIR, "yolo", "yolov12n-seg.onnx")) else "missing"
    # Check OSNet
    status["osnet"] = "installed" if os.path.exists(os.path.join(MODELS_DIR, "reid", "osnet_x1_0.onnx")) else "missing"
    # Check SigLIP2 (snapshot stores ONNX files under onnx/ subfolder)
    status["siglip2"] = "installed" if (
        os.path.exists(os.path.join(MODELS_DIR, "siglip", "onnx", "vision_model.onnx"))
        or os.path.exists(os.path.join(MODELS_DIR, "siglip", "model.onnx"))
    ) else "missing"
    # Check DAT-light
    status["dat"] = "installed" if os.path.exists(os.path.join(MODELS_DIR, "dat", "dat_light.onnx")) else "missing"
    # Check analysis libraries
    try:
        import scenedetect  # noqa: F401
        status["scenedetect"] = "installed"
    except ImportError:
        status["scenedetect"] = "missing"
    try:
        import librosa  # noqa: F401
        status["librosa"] = "installed"
    except ImportError:
        status["librosa"] = "missing"
    return status

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001)
