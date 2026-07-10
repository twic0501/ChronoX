# Skill: Transition Psychology & Construction Principles

WHY each transition, not just how — plus the universal construction pattern
borrowed from Premiere/AE workflows.

## What transitions mean to the viewer

- **Dissolve / crossfade**: time passing; two spaces or ideas blending into
  one another. A SLOW dissolve (1.0–1.5s) with slow music reads far more
  emotional than a hard cut — never rush it. Use `add_transition dissolve`
  with a generous duration for reflective moments.
- **Fade to/from black** (`dip_black`, `fade`): a full stop or a beginning.
  Fade-in for openings, dawns, new chapters; fade-out for endings. Placing one
  mid-video signals a chapter break — use sparingly.
- **Flash / light leak** (`flash_white`): a burst of energy or a memory spark.
  The classic light-leak workflow aligns the BRIGHTEST frame of the leak
  exactly on the cut line — which is exactly what flash_white does (gain peak
  centred on the cut). Same rule for `glitch` and `zoom_punch`: the peak sits
  ON the cut.

## Pacing by shot complexity

Shot duration must scale with how much the eye needs to read:
- Wide/long shots contain more information → hold them LONGER.
- Close-ups read instantly → they can be short.
- Short shots = frantic energy; long shots = calm. Automation must not slice
  wide establishing shots as aggressively as close-ups — when fitting clips to
  a beat grid, give wide shots 1.5–2× the target shot length.

## The adjustment-layer transition pattern (0 → max → 0)

Every "designed" transition (glow, lens distortion, blur ramp, zoom-through)
follows one keyframe pattern, applied on an adjustment layer spanning the cut:

1. Layer starts a little before the cut and ends a little after.
2. Parameter at layer start = minimum (0).
3. Parameter at the exact cut point = maximum.
4. Parameter at layer end = back to 0.

In ChronoX this is how zoom/spin/whip/glitch transitions are already built
(effect-param keyframes peaking at the boundary). To invent a NEW transition:
add_effect as a global adjustment layer over the cut region, then keyframe its
intensity 0 → max → 0 centred on the cut.

## Matte / masked reveals

Ink-blot and smoke matte transitions = a luma matte controlling which clip
shows through. ChronoX approximation: animate a `rectangle`/`ellipse` mask on
the top clip from covering-nothing to covering-everything across the cut
(see the masks-grid skill for reveal wipes). Reverse the animation for the
opposite direction; speed it up if it drags — matte transitions should
complete in 0.4–0.8s.
