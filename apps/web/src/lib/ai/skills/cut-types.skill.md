# Skill: Cut Types & When to Use Them

The editorial vocabulary of cuts, and how to realise each with ChronoX tools.

## Straight / hard cut
The backbone of continuity editing; normal dialogue and action. No effect —
just split + juxtapose. Default unless the moment asks for more.

## Jump cut
Same framing, time skipped — restlessness, urgency, or compressing a long
action. Build: cut_into_scenes (or manual splits) on ONE shot, delete the
middles, close_gaps. Keep segments 0.5–1.5s.

## Match cut
Joins two different places/times through similarity. Three kinds:
- **Graphic**: matching shapes/composition (bone → spaceship).
- **Movement**: cut mid-action so motion carries across the cut.
- **Audio**: a sound continues or rhymes across the cut.
Automation hint: when ordering clips, put shots with similar composition or
motion direction adjacent, then hard-cut mid-motion.

## Contrast cut
Two opposite shots back-to-back to express inner conflict or collapse:
a fast, loud, rapidly-cut run of shots → sudden HARD CUT to a long static
silent shot (mute_clip the target, no transition). The silence IS the effect —
do not add a transition here.

## Cutaway
Insert a detail shot (hands fidgeting, a clock, what the character is looking
at) between two pieces of the main action — adds context, emotion, or hides a
continuity error. Keep cutaways short (0.8–1.5s), then return to the action.

## Cross-cutting (parallel editing)
Alternate between two simultaneous events in different places to build
suspense (chases, deadlines). Shorten each alternation as the climax nears —
the accelerating rhythm is what creates tension.

## J-cut & L-cut (sound bridges)
When a picture cut feels harsh, lead with audio:
- **J-cut**: the NEXT scene's audio starts before its picture (viewer hears
  what's coming before seeing it).
- **L-cut**: the previous scene's audio continues over the new picture.
In ChronoX: offset the audio element's start relative to the video cut, or
keyframe volume across the boundary. Also the fix whenever dialogue scenes
feel choppy.

## Audio under dialogue
Whenever speech/voiceover is present, duck the music well below it — the voice
is always the focal point. Never let background music mask dialogue.
