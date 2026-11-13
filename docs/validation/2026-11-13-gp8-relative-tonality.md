# GP8 parity P12: global relative tonality, native core (2026-11-13)

Slice 1 of `docs/superpowers/specs/2026-11-13-relative-tonality-design.md` (THE-57). The native core applies a playback-only key shift of -12 to +12 semitones. There is no user interface yet (slice 2), so the tracker rows P12 and P20 stay partial and are not updated by this note.

## What is built

- `PracticeSettings.tonality` (integer, -12..12, absent means 0), validated in Rust and in TypeScript. It is session-only: nothing is written to a `.tabplayer` file, no edit type was added, and exports are untouched.
- `audio/tonality.rs` `transposed_plan` returns a shifted copy of the plan (the same `Arc` for 0). All plan notes of a melodic track move, whatever their channel; percussion tracks and golpe knocks (a channel-9 attack on a melodic track that no plan note owns) never move. Keys clamp to 0..=127 through one function. Where two overlapping notes land on one clamped key, the earlier ends where the later starts (dropped if they start together), so the first note-off cannot release the second. Note bends of the shortened note after the cut go with it (they would otherwise bend the later note).
- A `SetPractice` that changes the shift builds a renderer from the shifted plan (samples loaded for the shifted keys) and installs it through the existing preserved install, so playback continues at the same tick and loop. The shift travels with the install: the callback's `SetPractice` never changes it, and `Install` adopts it when it accepts the renderer. A newer preparation that overtakes the install is reported and rolls the document back.
- The backing track's pitch is its saved semitones and cents plus the key shift, summed in whole cents (`BackingVoice::new_with_processing_shifted`); the saved processing is validated as it was and not rewritten.
- External MIDI output reads the shifted renderer, so routed melodic tracks are sent in the practice key and channel 10 is not.
- Front end: the field round-trips through validation, `practiceForBacking`, `PracticePanel.apply` and `practiceKey` without being reset.

## Evidence (automated, all on this machine)

- Rendered audio: +12 doubles and -12 halves the measured frequency of a recorded note, including a guitar on MIDI channel 10; sample selection follows the shifted key; percussion output is bit-identical at every shift; a shift of 0 is bit-identical.
- Clamped overlapping notes keep the later one sounding on the General MIDI synthesizer.
- Backing: an extra shift of 0 is bit-identical; a cancelling pair is exactly neutral; +-25 effective semitones through the grain stretcher stays finite and within 1% of the target at speeds 0.1, 1 and 3.
- Service: a shift driven through `AudioService::command` and a callback changes what is heard and is echoed; a failed sample load, a full queue, and an overtaking preparation change nothing; a sound change keeps the shift.
- MIDI out: sent keys are shifted, channel 10 is not, and a shift applied while playing releases the old keys and strikes the new ones.

## Limits

- Nobody has listened. How the shifted recorded guitar and bass sound near the ends of their recorded range (guitar regions span keys 40 to 86) is not judged; out-of-range samples degrade by resampling.
- The backing's effective shift can reach +-25 semitones. Frequency and finiteness were measured on a synthetic sine only, not on music, and not by ear.
- Colliding clamped notes are shortened or dropped, so a chord near key 0 or 127 can lose a note; this is deliberate and untested by ear.
- A key change waits up to 250 ms (injectable for tests) under the control lock for the callback's echo. The echo is tested first: a callback that took the install keeps the shift even if a newer preparation was announced since; supersession is reported only when the echo does not show the shift. If the callback does not answer in the time (a stalled callback), the change is treated as queued, like every other control, and the document commits it. While that install is outstanding (same generation, echo not yet showing it), further practice sends only queue the practice: nothing is reloaded or rebuilt and nothing waits. If the install is lost (a later preparation supersedes it and fails), the echo stays unshifted and the page stays pending; sending a different shift applies it, but sending the same shift again does not rebuild until the generation changes. A rejection for a reason other than a newer preparation goes unreported in the same way.
- A newer preparation that overtakes a shift after the practice command was processed can leave the other practice fields (for example speed) changed while the shift is not; the new preparation replaces them anyway.
- External MIDI hardware, other operating systems, and the time a shift takes to apply on a large score were not tried.
- The shift is not applied to the metronome, count-in, Line-In, note auditions or exports, by design.
- Not compared with a running Guitar Pro 8.
