# S16 and E17: note audition

Date: 2026-10-24. Status: design. Rows S16 ("Tuning and individual-string audition") and E17 ("Edit/play preview while authoring") stay at their current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 plays a string's pitch when you click it in the tuning dialog, and plays a note as you enter it. TabPlayer has neither: its only sound comes from score playback. This slice adds one native capability, *audition*: play a short note or chord through a track's own instrument sound, without starting or disturbing playback. Both rows use it.

The seam map is in Claude's session scratchpad (`audition-seams.md`). In short:
- audio goes out through one cpal stream that stays open and writes silence while stopped;
- guitar and bass use recorded sample voices, and other programs and percussion use a GM SoundFont;
- a `Renderer` is built from a `PlaybackPlan`;
- the `control` and `access` locks are held across prepare.

## Chosen boundary

**Pre-render, then mix.** An audition request is rendered off the audio thread into a short stereo clip:
- it builds a one-track mini-plan, loads only the samples it needs, and runs the existing offline renderer with the track's effects, gain and pan;
- the clip is handed to the audio callback through its own small lock-free queue;
- the callback adds the clip's samples to its output, after normal playback, whether playing or stopped;
- the callback never builds renderers, allocates, locks or loads resources.

**Rejected options:**
- **A live mini-renderer in the callback:** it would put a second renderer and resource handling on the real-time path.
- **Injecting voices into the main renderer:** it would split `Renderer::frame`, which export shares, and it breaks during re-prepare.
- **A JavaScript oscillator:** it would not use the track's sound.

**Native command:** `audio_audition(owner, request)`, registered in both handler lists.
- **The request:**
  - `voice`: the same sound identity the track uses (its `TrackSound`/voice id and program, and whether it is percussion);
  - `mix`: the track's gain and pan, with its effects;
  - `notes`: 1–12 `{key, startMs, velocity}` entries, with key 0–127, start 0–1000 ms and velocity 1–127;
  - `durationMs`: 100–3000.

  The request carries its own sound, so a new track and a typed but unapplied tuning both sound right.
- **Owner check:** the owner must be the active document's audio owner, checked under the workspace lock the way `invalidate` checks it. It is not tied to the plan generation, so an audition works while a re-prepare is pending. A stale owner is refused with the existing "Audio owner is no longer active." error.
- **Threading and timing:**
  - Rendering runs on `spawn_blocking` and never takes the `control` or `access` locks used by prepare.
  - The clip is faded out over its last 30 ms.
  - A new audition replaces any clip still sounding, after a 5 ms fade, so repeated clicks never stack.
- **No stream:** if the output stream has never been opened, the command returns `{played:false}` instead of opening a device itself.
- **Status:** `audio_status` gains additive `auditionSerial` and `auditionPeak` fields, so tests can see that a clip reached the output.

**Mix rules:**
- An audition follows the track's own gain, pan and effects. Mute and solo do not silence it, so a muted track can still be auditioned.
- Track focus gains and the master playback position are not involved.
- Playback keeps running underneath, and the clip is added on top.

## UI

- **Tuning field (S16):** `TuningInput` gains an optional `onAudition(pitches:number[], strum:boolean)`. When it is given and the typed tuning parses, the field shows:
  - one small button per string, labelled with the full note and octave, such as "Play string 6 (E2)";
  - one "Play tuning" button that strums all strings from low to high, 60 ms apart, held 1.5 s.

  Both callers wire it with the addressed track's sound. The draft is auditioned, not the applied tuning. The saved-tunings dialog gets the same row of buttons for its details pitches.
- **Editing (E17):** after a successful note edit in `App.tsx` `edit()`, the new or changed notes of the edited beat play for 0.8 s at their sounding key (`tuning + fret + capo − transposition`). This applies only when "Play notes while editing" is on and playback is stopped. Rests, deletions, rhythm-only changes, undo and redo stay silent. A chord edit plays all its notes together.
- **Preference:** "Play notes while editing" is a toggle in the View menu. It defaults to on, and is stored in `localStorage` with the same read/write helpers pattern as `score-errors.ts`.

## Acceptance

- **Rust tests:**
  - offline clip rendering for a sample voice and a GM voice;
  - the callback adding a clip while stopped and while playing, with no allocation on the callback;
  - replacement fading the earlier clip;
  - owner refusal;
  - request validation bounds.
- **Frontend tests:**
  - exact `audio_audition` payloads from the tuning field and from editing, with keys that include capo and transposition;
  - silence for rests, deletions, undo and redo;
  - the preference default and its persistence;
  - no audition while playing.
- **Desktop:**
  - On a Windows desktop-test build, clicking a string button and Play tuning, then entering a note, each raise `auditionSerial` with a non-zero `auditionPeak`.
  - The project and history are unchanged by the tuning auditions.
  - Turning the preference off stops the edit audition.

## Scope

No MIDI output, no metronome change, no new dependency, and no audition from the instrument view or the fretboard (U12 is a separate row). Audition is not exported or recorded.
