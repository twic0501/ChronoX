# Skill: Masks, Split-Screen & Grid Layouts

Available mask types (registry `src/lib/masks`): `rectangle`, `ellipse`, `split`,
`polygon`, `brush`, `box-like`. Masks reveal only part of a clip; combined with
transforms they build multi-clip layouts.

## Split screen (2-up)

1. Stack the two clips on two video tracks over the same time range.
2. Add a `split` mask to the top clip (vertical divider at 50%).
3. Shift each clip's `transform.position.x` (± quarter of canvas width) so both
   subjects stay centred in their half.

## Grid (4-up and up) — "the grid effect"

For an N×M grid of simultaneous clips:

1. Put each clip on its own video track, same time range.
2. Scale each clip to 1/N horizontally coverage: `transform.scaleX = scaleY = 1/max(N,M)`.
3. Position each cell: for a 2×2 grid on a 1920×1080 canvas, offsets are
   x = ±480, y = ±270 (quarter of each dimension).
4. Add a `rectangle` mask per clip sized to its cell to crop overflow (only
   needed if the source aspect differs from the cell aspect).
5. Animate cells in one-by-one with 0.1s staggered `pop_in` for the classic
   grid-intro look.

## Reveal wipes with masks

Animate a `rectangle` mask's width 0→100% to wipe-reveal a clip — this is how
"paper unroll" and "door open" reveals are made. `ellipse` growing from 0 makes
an iris-in.

## Vignette vs mask

Darkened corners = `vignette` EFFECT (cheap, animatable intensity), not a mask.
Use masks only when hiding/revealing regions of the frame.
