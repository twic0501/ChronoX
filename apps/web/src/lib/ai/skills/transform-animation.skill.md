# Skill: Transform & Keyframe Animation

Clip transforms animate via **keyframes** on property paths, with clip-local time
(0 = clip start). Animated properties:

- `scale` — 1 = 100% (keyframes both scaleX and scaleY together)
- `x`, `y` — canvas position offset in px, 0/0 centred
- `rotate` — degrees
- `opacity` — 0..1

## How to emit an animation — use `upsert_keyframe` (one op per keyframe)

A static transform sets ONE fixed value and does NOT move. To animate anything
(zoom, bounce, punch, push-in, ken-burns, shake, pop-in, slide, spin) emit
several `upsert_keyframe` ops — one per keyframe — on the same property.

Two equivalent shapes depending on the caller:

- **Agent tool call**: `upsert_keyframe(clip_id, property, time, value, interpolation?)`
- **Recipe / operations JSON** (mimic apply-recipe, single-shot):
  ```json
  {"action":"upsert_keyframe","clip_id":"<id>","property":"scale","keyframe":{"time":0.12,"value":1.15,"interpolation":"linear"}}
  ```
  `property` is one of `scale | rotate | x | y | opacity`. `time` is seconds from
  the clip's start; `value` is the number at that keyframe.

Do NOT use a static `transform` op for motion — it overwrites instead of animating.

## Presets — as concrete keyframe lists

Each line is one keyframe: `property @ time = value`.

- **punch** (beat accent, scale 1→1.15→1 in 0.25s):
  `scale @0.0=1.0`, `scale @0.12=1.15`, `scale @0.25=1.0`
- **pop_in** (titles, stickers):
  `scale @0.0=0.6`, `scale @0.2=1.04`, `scale @0.35=1.0` + `opacity @0.0=0`, `opacity @0.2=1`
- **ken_burns / push-in** (slow zoom across the whole clip):
  `scale @0.0=1.0`, `scale @<clip_end>=1.12` (talking heads: end at 1.05–1.08)
- **slide_in** (from left; use +900 for right):
  `x @0.0=-900`, `x @0.4=0`
- **spin_in** (playful intro):
  `rotate @0.0=-25`, `rotate @0.45=0` + `scale @0.0=0.8`, `scale @0.45=1.0` + `opacity @0.0=0`, `opacity @0.45=1`
- **shake** (impact/bass hit, ±14px for 0.5s):
  `x @0.0=0`, `x @0.1=14`, `x @0.2=-14`, `x @0.3=12`, `x @0.4=-8`, `x @0.5=0`

The agent may instead call `set_transform` with an `animate` argument naming one
of these presets — it expands to the same keyframes. In recipes/operations,
always expand to explicit `upsert_keyframe` ops as above.

## Guidelines

- Keep push-in zooms subtle: 1.03–1.08 for talking heads, up to 1.15 for hype edits.
- Zoom INTO the subject: pair scale with a position offset toward the subject
  (mimic's ADD_ZOOM sends centerX/centerY in 0..1; position = −center×100).
- Never animate scale below ~0.5 or above ~2.0 unless doing a deliberate zoom-through.
- Ease: keyframes default to linear; fake ease-out by adding a midpoint keyframe at
  ~80% of the value ~60% of the way through, or set `interpolation` to `ease_out`.
- Multiple properties animating together must share the same keyframe times or the
  motion feels broken.
