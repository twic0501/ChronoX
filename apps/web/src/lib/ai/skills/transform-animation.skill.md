# Skill: Transform & Keyframe Animation

Clip transforms animate via keyframes on property paths, with clip-local time
(0 = clip start):

- `transform.scaleX`, `transform.scaleY` — 1 = 100%
- `transform.position` — `{x, y}` canvas px, 0/0 centred
- `transform.rotate` — degrees
- `opacity` — 0..1

## Presets (see the `set_transform` tool's `animate` argument)

- **pop_in**: scale 0.6→1.04→1.0 over 0.35s + opacity 0→1. Titles, stickers, reaction clips.
- **slide_in**: position x −900→0 (or +900→0 for `from: right`) over 0.4s. Lower-thirds, B-roll reveals.
- **spin_in**: rotate −25°→0 + scale 0.8→1 + opacity 0→1 over 0.45s. Playful intros.
- **ken_burns**: slow scale 1.0→1.12 across the WHOLE clip duration. Photos, establishing shots, calm B-roll.
- **shake**: position jitters ±14px for 0.5s. Impacts, bass hits, comedic beats.
- **punch**: scale 1→1.15→1 in 0.25s centred on a given time. Beat accents (used by beat-sync).

## Guidelines

- Keep push-in zooms subtle: 1.03–1.08 for talking heads, up to 1.15 for hype edits.
- Zoom INTO the subject: pair scale with a position offset toward the subject
  (mimic's ADD_ZOOM sends centerX/centerY in 0..1; position = −center×100).
- Never animate scale below ~0.5 or above ~2.0 unless doing a deliberate zoom-through.
- Ease: keyframes are linear; fake ease-out by adding a midpoint keyframe at 80% of
  the value 60% of the way through.
- Multiple properties animating together must share the same keyframe times or the
  motion feels broken.
