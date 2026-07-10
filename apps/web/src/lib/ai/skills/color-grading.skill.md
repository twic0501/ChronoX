# Skill: Color Grading

How to build looks with the `color-adjust` effect (all params are DELTAS around 0)
plus stackable stylistic effects.

## color-adjust parameters

- `brightness`, `contrast`, `saturation`: −1..1, deltas (0 = unchanged).
- `temperature` (warm > 0 / cool < 0), `tint`: −1..1.
- `gain_r`, `gain_g`, `gain_b`: channel multipliers around 1 (used by flash transitions).

## Recipes

### Cinematic Orange & Teal (the `grade_cinematic` preset)
contrast +0.18, saturation +0.06, temperature +0.10 on skin/highlight clips;
shadows pushed teal via gain_b +0.06. Add `vignette` intensity 0.25 and
`film_grain` 0.15 for the film feel.

### Moody / Desaturated
brightness −0.06, contrast +0.22, saturation −0.25, temperature −0.08.
Pair with `letterbox` (2.39:1) for drama.

### Vintage / VHS
saturation −0.1, temperature +0.12, add `film_grain` 0.35, `chromatic_aberration`
0.3, slight `lens_distortion`. Optionally `posterize` at low level.

### Clean bright vlog
brightness +0.08, contrast +0.10, saturation +0.12, temperature +0.04. No vignette.

## Adjustment layers

For a GLOBAL look, prefer one adjustment layer (`add_adjustment` op / global
ADD_EFFECT with clip_index −1) above the video track instead of per-clip effects:
it is non-destructive, editable in one place, and matches how AE/Resolve work.

## Mimic mapping

The style profile stores measured `color` statistics (warmth, contrast, saturation
levels of the reference). Apply them as DELTAS relative to the current footage's
own measurement — never copy absolute values, and scale every delta by the
requested intensity (0–1).
