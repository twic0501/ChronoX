# ChronoX Agent Tools Reference

Every tool the editing agent (`apps/web/src/lib/ai/agent.ts`) can call, what it
does, and its key arguments. The agent calls ONE tool per step, sees the real
result, and decides the next step (agent loop) until it calls `finish`.

## Discovery & analysis

| Tool | Function |
|---|---|
| `list_clips` | Lists every timeline clip with id, name, type, duration. Always the first call. |
| `analyze_scenes` | Scene detection on a clip: how many scenes, which are scenery vs contain a person. Prerequisite for scene-based cutting/filtering. |
| `list_skills` | Lists the markdown skill recipes (techniques knowledge base). |
| `read_skill` | Reads one skill's full recipe by name or topic keyword (`grid`, `beat`, `grading`…). The agent retrieves it before attempting an unfamiliar technique (agentic RAG). |

## Cutting & sequencing

| Tool | Function |
|---|---|
| `cut_into_scenes` | Splits a clip at every detected scene boundary. |
| `keep_only_scenery` | Deletes talking-head shots, keeps landscape/scenery shots (after `cut_into_scenes`). |
| `close_gaps` | Ripple-packs all video clips from t=0, removing gaps left by deletions. |
| `set_clip_speed` | Retime: slow-mo / speed-up, optional cinematic ramp curves (`ease_in`, `ease_out`, `ease_in_out`). |

## Look & effects (non-destructive)

| Tool | Function |
|---|---|
| `grade_cinematic` | Orange & Teal grade. Without `clip_id` it becomes ONE adjustment layer over the whole timeline. |
| `apply_look` | Full look as a stack of adjustment layers: `cinematic`, `warm`, `teal_orange`, `moody`, `bw`; letterbox/vignette overrides. |
| `add_effect` | One effect on one clip (17 types: halation, glitch, film_grain, duotone, chromatic_aberration…); without `clip_id` it becomes a global adjustment layer. |
| `set_transform` | Static transform (position/scale/rotate/opacity) and/or keyframed presets: `pop_in`, `slide_in`, `spin_in`, `ken_burns`, `shake`, `punch`. |

## Transitions

`add_transition` — real two-clip constructions from keyframes (overlap types
ripple the timeline so clips genuinely share a window):

`dissolve`, `blur_dissolve`, `dip_black`, `flash_white`, `whip`, `slide`,
`push`, `spin`, `zoom` (radial-blur zoom-through), `glitch`, `zoom_punch`,
`fade` (sequence edges). Omit `clip_id` → every cut; pass it → only the cut
before that clip.

## Audio & music

| Tool | Function |
|---|---|
| `mute_clip` | Mutes one clip or all video clips. |
| `add_music` | Adds a library audio asset as the soundtrack at t=0. |
| `trim_audio_before_vocals` | Speech-to-text finds where vocals start; keeps only the instrumental intro. |
| `fit_clips_to_audio` | Shrinks the sequence to exactly fit the soundtrack with every cut on a beat. |

## Mimic & Style Library

| Tool | Function |
|---|---|
| `mimic_style` | Measures a reference video (pacing, color, motion, beat-sync, letterbox, transition histogram) and recreates the style on the timeline — adapted, with optional `intensity` 0–1 blending. |
| `save_style` | Persists the extracted style profile to the Style Library (survives across projects; only the PROFILE is stored, so re-application always re-adapts). |
| `list_styles` | Lists saved styles. |
| `apply_style` | Re-applies a saved style to the CURRENT footage — deltas recomputed against this footage's own measurements, scaled by `intensity`. |

## Interaction & control

| Tool | Function |
|---|---|
| `ask_user` | Pauses the run and asks the user ONE clarifying question with 2–4 options; the answer resumes the loop. Used only for genuine creative ambiguity. |
| `finish` | Ends the run with a summary. Every run is checkpointed on the undo stack — the chat then offers "Keep AI edits / Revert all (N)". |

## Skills knowledge base

`apps/web/src/lib/ai/skills/*.skill.md` — technique recipes the agent reads on
demand: `transitions`, `color-grading`, `transform-animation`, `masks-grid`
(split-screen & N×M grids), `beat-sync`, `pacing-montage`, `editing-theory`
(Murch's Rule of Six, eye-trace, movement matching), `cut-types` (jump/match/
contrast/cutaway/cross-cutting, J-cut & L-cut), `transition-psychology`
(what each transition means + the 0→max→0 adjustment-layer pattern). Add a new skill by
dropping a `<name>.skill.md` file and registering it in `skills/registry.ts` +
`skills/index.ts`.
