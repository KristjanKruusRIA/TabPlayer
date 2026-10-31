# Mixer view (2026-10-31)

Branch `feat/ui-mixer`, merged with `feat/gp8-parity`. The Mixer is the third View option: a Focus rail, one channel strip per track (selection, current sound, mute, solo, pan knob, volume fader) and the master output.

## Review fixes
- **Silent drag:** a fader, pan or focus drag now plays as it moves. `NativePlaybackController.previewMix` lays a session-only mix over the saved one and the player applies it as a mix change on the running plan (no re-preparation), at most every 70 ms through `useLivePreview`. Nothing is recorded until release; the release is one `setTrackMix` edit.
- **No step back:** the saved edit settles its promise, `mix()` reads the newest document first, and a heard drag ends only once the player holds the document that has the edit (or at once if it already does), so the sound and the fader never return to the old level. A refused edit or a cancelled drag (Escape, lost pointer, release where it began) ends the preview and records nothing.
- **Sound names:** a track with no instrument chosen is named by the native rule in `voices.rs` (`automaticVoice`): programs 24-25 green guitar, 26-31 black guitar, 33 babyblue bass, 32 and 34-39 darkblack bass, otherwise the General MIDI program name; percussion stays "Percussion".
- **Edited sounds:** a sound that differs from its factory sound or preset reads as "<Preset> (edited)".
- **Layout:** the Selected chip is a fixed 16 px slot present in every strip, so selecting moves nothing.
- **Busy:** buttons and Mute/Solo use `aria-disabled` and refuse, never `disabled`, so focus stays. The Mute/Solo change handlers refuse too.
- **Low:** help contexts for `.mixer-view` (Playback and mixing) and `.sound-view` (Tracks and sounds); the sound names are memoised per score and sounds, factory and preset effect keys are computed once; the sound readout is a `role="group"`; the Fader finds its thumb by ref rather than class.
- **Master:** `MasterPanel` sits at the right end of the mixer with the same props as `TrackPanel`, styled with the mixer tokens. Its audio and edits are unchanged.

## Second review fixes
- **Identity:** strips are keyed by track identity, and the sound heard for a drag ends when the track list changes, so a drag cannot be saved onto the track that took its index (deletion, undo, Ctrl+Z during a drag).
- **Busy mid-drag:** `useRange` ends a gesture when its control becomes disabled, and a release or move on a disabled control saves nothing; the value and the heard sound go back.
- **Refusal kept:** a refused dragged edit puts the saved mix back first and then reports the error, so the restoring `setMix` no longer clears it.
- **Master:** `MasterPanel` uses `aria-disabled` and `busyGuard`, so a focused control keeps focus when busy; `master()` reads the newest document (`latestMaster`), so a master slider does not step back. Audio and edit behaviour are otherwise unchanged.
- **Landing:** a heard drag ends when the loaded document's mix for the track moves off what the edit began from (or equals the one heard), so an unrelated reload, such as a track selection, no longer ends it.

## Evidence
- `src/mixer/MixerView.live.test.tsx` runs the real player against a fake native bridge and a host that takes edits late. It fails if the drag is silent, if it records before release, if the sound or the fader steps back, or if a cancelled drag keeps its level (checked by mutating the view).
- `src/audio/mix-preview.test.ts` covers the preview, clamping, an unknown track, a new document, edit settlement, the newest-mix read and a refused edit.
- `src/mixer/MixerView.test.tsx` covers strips, sound names by program, edited tones, the stable Selected slot, busy refusal with focus kept, focus, the master, and a stylesheet check for the scrolling row (jsdom applies no CSS).

## Limits
- Not run in the desktop app or by ear: the live drag was verified against a fake bridge, not the native audio engine, so the 10 ms crossfade and the 70 ms rate are untested by hearing. No screenshots were taken of the master strip or the Selected slot; the CSS is unmeasured in a real window.
- A drag on the master sliders is not heard live.
- No Rust changed, so no Rust tests were run for this work.
