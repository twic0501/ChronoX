# Skill: Transitions

How each transition type in `add_transition` is built internally, and when to use it.
All transitions are REAL two-clip constructions made of keyframes on `opacity`,
`transform.*` and effect parameters — never a fake overlay clip.

## Catalog

| type | mechanism | overlap? | best for |
|---|---|---|---|
| dissolve | incoming clip's opacity 0→1 over the shared window | yes | gentle scene changes, memories |
| blur_dissolve | dissolve + both clips ramp a `blur` effect to 0.7 | yes | dreamy / defocus mood shifts |
| dip_black | outgoing opacity →0, incoming 0→1, no overlap | no | chapter breaks, dramatic pauses |
| flash_white | `color-adjust` gain_r/g/b spike 1→3 on both sides of the cut | no | beat drops, energy spikes |
| whip | both clips slide ±900px horizontally + `blur` ramps 0.8 | yes | travel vlogs, fast POV changes |
| slide | incoming clip slides in from x=+900 over the outgoing tail | yes | UI-style reveals, listicles |
| push | outgoing slides out to −900 WHILE incoming slides in from +900 | yes | side-by-side location changes |
| spin | outgoing rotates 0→180° out, incoming −180→0° in, blur 0.8 | yes | high-energy montage, sports |
| zoom | outgoing scales 1→1.6 with `radial_blur`, incoming 1.6→1 | yes | zoom-through hits, music videos |
| glitch | `glitch` effect intensity spikes on both sides of a hard cut | no | tech/gaming edits, corruption motif |
| zoom_punch | hard cut kept; scale spikes to 1.18 on both sides | no | landing cuts exactly on beats |
| fade | opacity fade-in at sequence start + fade-out at the end | – | opening/closing a whole edit |

## Rules of thumb

- Duration 0.3–0.5s for energetic edits, 0.7–1.0s for cinematic/slow pieces.
- Overlap types shorten the timeline: every clip after the cut ripples left by the
  overlap. Mention this to the user when applying many at once.
- Never mix more than 2–3 transition families in one edit; it reads as amateur.
- Beat-driven edits: put `flash_white`, `zoom_punch` or `glitch` ON the beat
  (they are cut-centred), and start `dissolve`/`whip` half a duration BEFORE the beat
  so the midpoint lands on it.
- When mimicking a reference, match the transition FAMILY and density from the
  style profile (`transitions` histogram), not the exact timings.
