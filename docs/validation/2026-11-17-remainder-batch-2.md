# Left-over items, batch 2 - validation, 2026-11-17

Branch `agy/remainder-batch-2`, cut from `develop` at `a3e294b`. Five items, each implemented by one engineer and reviewed by a second,
read-only one. Every item came back from its first review with a defect; three needed one fix round and the hosted-instrument item two.
The final checks were run by the orchestrator on the final tree. Nothing here was tried in the desktop app, with a real plug-in, a real
MIDI device or a real audio device, and nobody listened to anything.

## What changed

| Item | Change |
|---|---|
| Hosted instrument after a seek | A track played by an instrument plug-in gets one note-on per key the score holds at the new position after a seek, a loop wrap and at the start of a range export, as the built-in kit does. A hit that ends exactly at that position is not struck. The strikes are sent with the first music frame, so a count-in sends none. Details and limits: `2026-11-17-instrument-restrike.md`. |
| MIDI out, late note end | A note end owed to a strike that never reached the port (no room, a drum-map change that gave a silent row a key or moved a row onto a sounding key, a release still owed at a hand-over) no longer ends a newer strike of that key. |
| Count-in in audio export (tracker row F25) | The Export dialog offers "Include count-in" for WAV, AIFF, FLAC, Ogg and MP3, off by default and not for stems. The file then starts with the count-in of the practice settings in the playback click sound; the music after it is sample-identical to the export without it, with and without a plug-in. A request without the field exports as before. |
| Trim to fit (tracker row E15) | An overfull voice whose last sounding beat crosses the barline has that beat shortened to the length that is left (tied pieces of exact written length) instead of removed. The button's hint says what will be shortened and what removed. A new optional `shorten: true` on the `fitVoice` edit is recorded only by the new gesture; an edit without it replays as before. |
| Drum map editor names | Kit-piece names, sound names and the source paragraphs are shown in en, et and de, falling back to the English name for an unknown id. Map files hold only numbers and are unchanged. |

Not built: restoring the tie when pasting after a cut through a held note (row E08). The clip is recorded in the edit, so it needs a
new optional field in the strict clip schema on both sides and in `tests/protocol.json`; it is left for its own slice.

## Review findings and how they were settled

- **Hosted instrument.** Round 1, high: a key whose note end falls exactly on the target position was struck again and released on the
  same sample. Round 1, medium: strikes were staged at the seek and so were sent inside a count-in. Round 2, medium: with the strike
  deferred, a hand-over or drum-map change during the count-in counted the same strikes twice and the key never got its note end. All
  fixed with tests that failed first; the third review approved. Left, low: when the score orders a new hit of a key before the note
  end of an earlier hit of the same key on the very position that is sought, the new hit is ended at once.
- **MIDI out.** Round 1, high: the drum-map hand-over was not covered. Fixed; approved. The guard counts per key, so when a sounding hit
  and an unsent one overlap on a key, the first note end is spent on the unsent one and the sounding hit lasts until the later note end
  or stop. `a_map_edit_during_playback_only_remaps_and_the_next_hit_goes_out_on_the_new_key` in `audio_midi_out.rs` expected the old
  order and was updated to this; nothing is left held after stop.
- **Count-in export.** Medium: with a plug-in the count-in was late against the music by the compensation delay. Fixed: one compensated
  stream, trimmed once; click onsets asserted on the beat with a 4800-frame plug-in delay. Low, fixed: normalisation measures the music
  only; a range export takes meter and tempo from the first bar's start.
- **Trim to fit.** Medium: the hint still announced a removal. Fixed.
- **Drum map names.** Medium: product names had been copied into the catalogues, and the Estonian names contradicted the app's own terms.
  Fixed; the test that keeps library names out of the app now takes its words from the layouts file.

## Checks (orchestrator's run, on the final tree)

- `cargo fmt --all -- --check`: clean. `npm run typecheck`: clean. `node scripts/secret-scan.mjs`: 0 findings.
- `cargo test --locked --workspace --no-fail-fast`: 99 test programs passed and one failed, on the test named above; after the update
  `--test audio_midi_out`: 26 passed.
- Real-helper suites, `--ignored --test-threads=1`: `plugin_helper` 17, `plugin_playback` 9, `plugin_export` 8, `plugin_editor` 6,
  `plugin_library` 2, `plugin_instrument` 25, all passed.
- `npm test -- --testTimeout=60000`: node tests 78 pass; `Test Files 458 passed | 4 skipped (462)`, `Tests 7714 passed | 5 skipped (7719)`.

## Limits

- Count-in export: trainer count phases and the count-in between loops are not exported; stems get none. A count-in shorter than the
  plug-in delay (about 0.1 s) is silent, and the last frames of the click tail are lost when the metronome is off, as in playback. If the
  click would clip at the music's normalisation gain it gets a lower gain of its own.
- Trim to fit: a tie from the shortened note into the next measure is dropped, as the removal dropped it. Shortening is declined, and the
  old removal used, when an earlier beat of the bar is a grace note, a tuplet, an empty beat, a full-bar rest or has a display override.
  The hint is recomputed on every score change and copies the score while a voice qualifies; not measured on a long score.
- Hosted instrument: the held-note scan runs on the first music frame on the audio callback over the plan up to that position; not
  measured on a large plan. A swap to another helper mid-note still sends the leaving instrument no release.
- Estonian and German strings, including about 150 drum names per language, were written without a native review.
- An older build refuses a project in which the new Trim to fit was used, as with any added edit field.
