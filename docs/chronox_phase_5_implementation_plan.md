# Phase 5 Implementation Plan: AI-Driven Video Editing Integration

This plan implements the AI Integration layer (**Phase 5**) for ChronoX. It connects Next.js with our Axum Rust backend, running 100% offline local models (Qwythos 9B, nomic-embed-text) via Ollama, along with a Cloud API fallback.

---

## User Review Required

> [!IMPORTANT]
> **Ollama Setup**: To run this phase locally, you must ensure Ollama is running and download the embedding model by running:
> ```bash
> ollama pull nomic-embed-text
> ```
> The core and vision models will run on the pre-installed `qwythos:latest` model.

> [!NOTE]
> **Hybrid Visual Editing**: Since compiling heavy CUDA binaries for SAM2, LaMa, and SPAN in a sandboxed sandbox environment is resource-restrictive, we implement them as high-performance client-side WebGL filter shaders (Chroma key / Inpaint emulation) and viewport CSS sharpening kernels. A toggle is provided to connect to actual Cloud APIs for production.

> [!WARNING]
> **Vietnamese Whisper Fallback**: Whisper-Tiny can have high Word Error Rates (WER) for Vietnamese speech. We implement two fallback strategies:
> 1. **Client-side fallback**: Option to load the larger `onnx-community/whisper-base` model.
> 2. **Server-side fallback**: A REST endpoint `/api/transcribe` on Axum to process audio server-side if local CPU/GPU performance allows.

---

## Open Questions

> [!WARNING]
> **Gemini Cloud API Keys**: Should we configure the Cloud API connector using an environment variable `GEMINI_API_KEY` in `apps/web/.env`? Or allow inputting the API key directly in the editor UI settings panel? 
> *Recommendation*: We will support both, reading from the `.env` file first and falling back to a settings text input.

---

## Proposed Changes

### 1. Backend Layer (Rust Axum)

#### [MODIFY] [Cargo.toml](file:///home/twictrn/Projects/chronox-frontend/backend/Cargo.toml)
- Add `reqwest` (with `json` and `stream` features) to handle Ollama API calls.
- Add `futures-util` to process streaming response bodies.

#### [MODIFY] [main.rs](file:///home/twictrn/Projects/chronox-frontend/backend/src/main.rs)
- Implement `/api/chat` route:
  - Receives prompt and project state.
  - Generates Ollama payload with system instructions guiding Qwythos to output thoughts in `<thought>` tags and layout operations in JSON format.
  - Streams the response back to Next.js.
- Implement `/api/ai/index-chunks` route:
  - Accepts transcribed audio segments from Next.js.
  - Chunks text into 30s blocks.
  - Vectorizes each chunk using Ollama `/api/embeddings` (nomic-embed-text).
  - Appends chunk metadata to an in-memory `Mutex<Vec<VideoChunk>>` array.
- Implement `/api/ai/search` route:
  - Receives semantic query string.
  - Vectorizes query, computes **Cosine Similarity** against memory chunks, and returns the timestamp of the best matching clip.
- Implement `/api/ai/vision-check` route:
  - Accepts base64 image data.
  - Forwards to Ollama multimodal vision model asynchronously to inspect rendering quality.
- Implement `/api/ai/transcribe-fallback` route:
  - Receives audio file upload and performs server-side transcription fallback.

---

### 2. Frontend Layer (Next.js & Zustand)

#### [MODIFY] [chat-sidebar.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/properties/chat-sidebar.tsx)
- Connect input form to call Axum's streaming `/api/chat` route.
- **Timeline Lock Integration**: Disable timeline edits and playhead movement when AI is thinking or streaming to prevent state synchronization conflicts.
- Parse streamed `<thought>` blocks and JSON actions dynamically.
- When AI layout edits are received, render them as **Ghost Clips** (red/dashed blocks) on the timeline.
- Add "Confirm Edits" / "Discard Edits" UI buttons.

#### [NEW] [ai-search-bar.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/ai-search-bar.tsx)
- Implement a semantic search search input (similar to NotebookLM) in the editor header.
- Upon submitting a search query, POST to Axum's `/api/ai/search` and trigger `editor.playback.seek(timestamp)` to jump playhead.

#### [MODIFY] [chroma_key.frag.glsl](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/chroma_key.frag.glsl) & [chroma_key.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/chroma_key.ts)
- Connect WebGL Chroma Key shader and canvas-mask logic to emulate SAM2 object segmentation / background replacement.
- **Asynchronous Vision QA**: When rendering a keyframe, downscale it to **256x256** inside the canvas before encoding to base64, and trigger an out-of-band vision quality check to `/api/ai/vision-check` without blocking client interaction. If a warning is returned, show a non-blocking toast.

#### [NEW] [cloud-toggle.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/cloud-toggle.tsx)
- Create a setting widget to easily switch between "100% Local AI (Ollama)" and "Cloud AI (Gemini / Replicate)".

---

## Verification Plan

### Automated / Integration Tests
- Run `cargo run` and verify:
  - Indexing segments returns `200 OK` and populates the RAM Vector store.
  - Vector search returns correct timestamps.
  - Streaming `/api/chat` pipes tokens without buffering.

### Manual Verification
1. Run `./run.sh`.
2. Open `http://localhost:3000`.
3. Import a video and generate a transcript via Whisper.
4. Verify transcript indexing success on console.
5. In the Chat Sidebar, type: *"Cắt clip này từ giây số 3 đến giây số 8"* and confirm proposed ghost clips on timeline.
6. Use the AI Search Bar to search for a phrase, and confirm the playhead seeks to the exact timeline match.
7. Toggle Cloud AI mode, enter a Gemini API Key, and verify fallback capabilities.
