# 🎬 ChronoX AI Editor

**ChronoX** is a professional-grade, AI-powered non-linear editing (NLE) ecosystem designed to bridge the gap between complex professional editing techniques and intuitive AI automation.

## 🚀 Architecture Overview

ChronoX employs a hybrid high-performance architecture:
- **Frontend**: Next.js 16+ with a high-performance WebGL rendering pipeline for real-time video preview and masking.
- **Core Backend**: A lightning-fast Rust server (Axum) managing project state, timeline deltas, and WebSocket synchronization via SQLite.
- **AI Worker**: A Python-based AI orchestration layer utilizing state-of-the-art local models:
  - **faster-whisper**: High-fidelity speech-to-text.
  - **pyannote-v3**: Voice Activity Detection (VAD) and speaker diarization.
  - **YOLOv12 & OSNet**: Advanced object segmentation and re-identification tracking.
  - **SigLIP2**: Semantic visual search for B-roll matching.
  - **Ollama (Qwen 3.5)**: The central "brain" interpreting natural language commands into NLE operations.

## 🛠️ The 12 Hard Skills Playbook

ChronoX isn't just an editor; it's an AI that masters professional editing patterns:
1. **Chunky-Step Speed Ramping** - Dramatic speed variations.
2. **Manual J-Cut & L-Cut** - Professional audio-visual phase shifting.
3. **Dynamic Audio Ducking** - Automatic BGM attenuation during speech.
4. **Split-Screen Masking** - Precise canvas segmentation for comparisons.
5. **Overshoot Punch-In Zoom** - Focal point emphasis.
6. **Dynamic Captions Bounce** - Rhythmic, animated subtitles.
7. **Chroma Key Spill Eraser** - Professional green-screen cleanup.
8. **AI Auto-Beat Match Cut** - Synchronizing cuts to musical transients.
9. **AI Deflicker & Denoise** - Low-light noise and flicker reduction.
10. **Freeze Frame Transition** - Temporal freezing with background cutout.
11. **AI Color Match Studio** - Histogram-based color synchronization.
12. **Masking Linear Transition** - Soft-edge linear wipes.

## 📦 Installation & Setup

### 1. Core Backend (Rust)
```bash
cd services/core-backend
cargo run --release
```

### 2. AI Worker (Python)
```bash
cd services/ai-worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python worker.py
```

### 3. Web Frontend
```bash
# From the repository root (turborepo workspace)
bun install
bun dev:web
```

### 🔥 One-command dev environment
```bash
./run.sh   # starts Rust backend (8000) + AI worker (8001) + Next.js (3000)
```

## 📂 Project Structure
- `apps/web`: The Next.js user interface and WebGL renderer.
- `apps/desktop`: The desktop shell (Rust).
- `packages/`: Shared UI, env, and WASM packages.
- `services/core-backend`: High-performance state management (Rust/Axum, port 8000).
- `services/ai-worker`: Local AI model suite and inference (Python/FastAPI, port 8001).
- `docs`: Detailed implementation blueprints and skill playbooks (`docs/frontend/` chứa tài liệu riêng của frontend).
