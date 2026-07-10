# Skill: Pacing & Montage Structure

How to structure an automatic edit so it feels authored, not generated.

## Shot length grammar

- Hook (first 1–3s): the single most striking shot, often with a `zoom` or
  `flash_white` entrance. Viewers decide to stay here.
- Body: alternate energy — 2–3 fast shots (0.6–1.2s) then one breather (2–4s).
  Constant pace is monotone; variation IS the style.
- Ending: longest shot of the edit + `fade` out, or a hard cut to black on the
  final downbeat for hype edits.

## Choosing what to keep

Use scene analysis (motion, faces, scenery classification) to rank segments:
1. Prefer segments with camera or subject motion for fast sections.
2. Prefer stable wide shots for breathers.
3. Drop segments with < 0.5s of usable content or heavy blur (unless stylistic).

## Applying a mimic profile to pacing

- `avg_shot_len` from the reference is a TARGET MEAN, not a fixed slice size —
  keep natural variance of ±40%.
- With intensity I: `target_len = footage_natural_len × (1−I) + reference_len × I`.
- Respect `letterbox`/`vignette` flags from the profile as global adjustment
  layers, applied once, not per clip.

## Speed ramps

- Ramp INTO a beat: slow (0.5×) for ~0.7s, then snap to 1.5–2× exactly on the beat.
- Use `curve` easing for ramps; linear rate jumps look like dropped frames.
- Keep total ramped duration under ~30% of the montage or it gets exhausting.

## Non-destructive discipline

Global looks → adjustment layers. Every batch of automated edits must go through
the command stack (one BatchCommand when possible) so a single Undo — or the
chat's "Revert all" — cleanly removes it.
