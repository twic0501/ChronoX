# Agents.md

## Apps

- Web
- Desktop

## Rust

Shared code between apps live in `rust/`, not in `packages/`

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

## Smart Copilot Rules & Behavior Guidelines

### Flexible NLE Reasoning (No Rigid Templates)
- Banned: Do not constrain the agent to rigid, hardcoded lists of "12 skills". The co-pilot must adapt flexibly, use general logical synthesis, coordinate NLE operations (splits, trims, volume/retime adjustments, effects/colors) fluidly, and match the creative context.
- Keep output operations focused on high-quality editing decisions (e.g. matching audio stems, J-cuts, L-cuts, color grading ranges).

### Visual Interaction & User Choice
- When generating pending cuts, deletions, or splits:
  - Visual overlay: Map pending deletions as faded red overlays on the timeline so the user knows what will be deleted if they apply.
  - Interactivity: Allow the user to cancel individual proposed cuts/splits/deletes by right-clicking or clicking the close button on the timeline element, removing it from the ghost queue.
  - Finalization: Let the user review, and choose to **Apply** or **Reject** the proposed timeline edits as a batch.

### NotebookLM + Mixpeek Multimodal Synthesis Architecture
- **Multimodal Visual Eye (Mixpeek Style)**: Video reference ingestion must analyze visual components (aesthetic scoring, contrast, color histograms, motion vector intensity, scene boundaries) instead of relying solely on Speech-to-Text transcriptions. If a video has no audio, visual cues must dictate editing decisions.
- **Knowledge Distillation (NotebookLM Style)**: Compress rich video analysis and styling guidelines into a lightweight, human-readable Markdown (`.md`) format.
- **2-Stage Hybrid RAG (SurfSense Style)**: Use pre-filtering followed by hybrid search (combining semantic embeddings with tag/metadata exact matching) to identify the best presets, applying Reciprocal Rank Fusion (RRF) to score matches before execution.
- **MCP Delivery**: All NLE commands must map to standard Model Context Protocol schemas and broadcast to the editor workspace to let the user review and commit changes.
