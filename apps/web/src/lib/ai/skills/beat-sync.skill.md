# Skill: Beat Sync & Music-Driven Editing

How ChronoX aligns edits to music, and how to read a mimic style profile.

## The measurements

The AI worker extracts from audio: `bpm`, beat timestamps, downbeats.
From a reference video: `cut_times`, `avg_shot_len`, `beat_sync` (0–1 share of
cuts that land within 120ms of a beat), `transitions` histogram, motion energy.

## Cutting on the beat

- A cut "on the beat" lands within ±80ms of the beat timestamp. Snap, don't nudge:
  move the cut TO the nearest beat.
- Downbeats (every 4th beat at 4/4) carry the strongest accents — reserve
  `flash_white`, `zoom_punch` and `glitch` transitions for downbeats.
- High `beat_sync` (>0.6) in a reference = cut nearly every phrase; replicate the
  RATIO on the target audio's own beat grid, never copy raw timestamps.

## Beat punches without cutting

Between cuts, add scale "punches" (1→1+0.07·intensity→1 over ~0.22s) on downbeats
via keyframes — keeps long shots alive. Skip punches when intensity ≤ 0.15.

## fit_clips_to_audio flow

1. Measure the soundtrack (bpm + beats).
2. Choose target shot length from the style profile (`avg_shot_len` × intensity
   blend toward the footage's natural pacing).
3. Trim/split clips so each boundary lands on a beat; drop dead footage first
   (use scene analysis to keep the highest-motion segments).

## Common failure modes

- Cutting on EVERY beat above 120 BPM reads as strobing — cap at every 2nd beat.
- Speed ramps must preserve pitch (`maintainPitch: true`) or dialogue chipmunks.
- If the montage is longer than the music, either loop-extend audio or tighten
  shot lengths; never leave silent tail video.
