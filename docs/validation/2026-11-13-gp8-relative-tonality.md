# GP8 parity P12: global relative tonality (2026-11-13)

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

## Slice 2: the interface

A Key group in the transport (lower, value, raise, original key), three command-palette commands, hints on the backing and MIDI-out panels, and a "Change the key" help section, all in English, Estonian and German. No Rust changed.

### Verified (automated)

- Vitest: one click sends one whole settings object with only the key changed and the rest of the practice settings intact; the ends and the original key send nothing and stay `aria-disabled` and in place; a pending shift shows as pending, never `disabled`, and keeps focus; a busy editor blocks the buttons the same way; the labels exist in all three languages.
- Controller: a refused or superseded shift falls back to the acknowledged key and raises the notice; neither an edit nor a document change is recorded; a new document and a return to the first one both start at the original key.
- Palette: three app commands without shortcuts, found in English by key, semitone and practice; titles and aliases in all three languages; the existing orderings changed only by the new commands.
- CSS pins: the Key group is in both small-window caption rules.

### Not verified

- The width of the transport at 960 by 600 and whether the Key group fits there. The driver `tests/desktop/parity-key-shift.mjs` checks it (and the rest of the real-app flow: acknowledged in `audio_status`, kept tick, loop and generation while playing, reset, no edit and no dirty mark); it was syntax-checked and **not run**.
- The look of the group and its pending state in the real window, and use with a screen reader.
- The German and Estonian wording was written for this slice and has not been reviewed by a speaker; "Tonart" and "Helistik" were chosen as the nearest existing terms.
- Everything listed under Limits above still stands: nobody has listened, and the P12 and P20 tracker rows are not updated until the driver has run and the sound has been heard.

### After review (2026-11-13)

Verified by Vitest: the requested key survives an edit (carried into the next prepare); a request not acknowledged in time falls back with a notice and new requests are accepted; fast steps coalesce into one request each time, never two in flight; a refusal drops queued steps and shows one translated message with no raw error; the palette refuses at the limits, at the original key and while not ready, in English and German; a key step keeps a Practice panel draft; an embedded backing shows the hint; the hints are not live regions; the new document shows the original key at once; a focused key button keeps focus while the score is prepared; translated labels, hint and announcements in German and Estonian.

Not verified: the width of the row at 960 (the Key group is folded into More playback at 1100 px and below as a precaution, which was chosen without measuring); the driver `parity-key-shift.mjs` (now measuring every control's right edge with a selection, a double click, a palette command and a loop-bounded position check) is syntax-checked only; screen reader behaviour of the new live region; the coalescing and the 2.5 s bound against a real stalled callback.

### Real app (2026-11-13, after the second review)

`tests/desktop/parity-key-shift.mjs` was built (`scripts/build-desktop-test.ps1`) and **run against the real app, and passed**: with a selection present (the loop-selection button in the row) no transport control's right edge is outside the window at 1280, 1101 and 960 wide; the Key group is in the row at 1280 and 1101 and folded into More playback at 960, where it is reachable and its value shows on the More playback summary; in-row clicks at 1101 and folded clicks at 960 are acknowledged in `audio_status`; two activations in one task (a coalesced double step) both land; the palette's "Raise the key" and "Original key" work and "Original key" at the original key is refused with its message; a change while playing keeps the loop, the generation and a position inside the loop; reset returns to the original key; the project and the dirty flag are unchanged and the page reported no errors. The result is in `.analysis/parity/key-shift-result.json` (not committed).

Found while running it: a Playwright pointer double click on the folded Raise button delivers only one click, because the layout moves when the first change appears (the "♮ +n" mark widens the summary and the popover shifts); the driver therefore uses a same-task double activation. The shift of the popover on the first change is a visual wart, not measured further.

Still not verified: how it sounds; screen reader behaviour of the live region and of the summary mark; the 2.5 s bound and the coalescing against a genuinely stalled callback.

### Real app, final run (2026-11-13)

After the last fixes the app was rebuilt and `tests/desktop/parity-key-shift.mjs` passed again. It now performs a real pointer double click on the in-row Raise at 1101 px and on the folded Raise at 960 px (each gives +2), which the earlier run could not do because the popover moved under the pointer; it also measures the folded mark at 960 with a shift of +3 (label "Key +3", inside the summary and the window, no overflow) and the fit of every control with the mark shown. Result: `.analysis/parity/key-shift-result.json` (not committed). The earlier remarks on what is unverified (sound, screen reader, a genuinely stalled callback, translation review) stand.
