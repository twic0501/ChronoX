# Skill: Editing Theory — Why a Cut Works

Walter Murch's principles. Every automated cut must be justified by these, not
just by beat timing.

## Rule of Six — priority when choosing a cut point

1. **Emotion (51%)** — does the cut serve the emotion of the moment? Always the
   top priority. A technically perfect cut that kills the mood is wrong.
2. **Story (23%)** — does it advance the story / add new information?
3. **Rhythm (10%)** — does it land on the rhythm of music or action?
4. **Eye-trace (7%)** — where is the viewer looking? Place the next shot's
   subject at the SAME screen position as the previous shot's focus point so
   the eye never has to hunt. Attention priority: big before small, moving
   before static, bright before dark, in-focus before out-of-focus.
5. **2D screen space (5%)** and **3D continuity (4%)** — respect the 180° axis
   and the 30° rule so characters stay spatially coherent.

Implication for automation: beat-snapping alone only optimises the 10% factor.
Prefer cut candidates at scene boundaries with motion continuity, and when
zooming/repositioning (set_transform), aim the frame so the subject stays at a
consistent anchor point across the cut.

## Movement matching

- Cut static shot → static shot, and moving shot → moving shot.
- NEVER cut a moving camera into a static shot: it reads as a jerk. If the
  reference style demands it, soften with a short dissolve or whip.
- **Cut on the blink**: an actor's blink is the perfect hidden cut point in
  dialogue.
- **Hidden cut / fake one-shot**: cut at the frame with maximum motion blur,
  ideally as something wipes across frame; a 2–4 frame blur_dissolve sells it.

## Trimming discipline

- Review the full sequence, then cut ruthlessly: any frame that adds no new
  information goes. Dead air kills pacing more than any missing transition.
- Short-form vertical video: plant a visual hook in the first 1–3 seconds and
  keep re-hooking every few seconds; the first shot must be the strongest.
