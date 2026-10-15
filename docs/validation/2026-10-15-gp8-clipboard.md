# Musical clipboard and linked-note fidelity validation

Date: 2026-10-15. Branch `feat/gp8-parity`; released `main` remains `7fc41c7`. This advances E08–E11/E21 within the full 258-requirement goal; it does not establish full Guitar Pro parity.

## Delivered behavior

An application clipboard retains selected music across New/Open. Single-track phrases use one voice lane; complete bars include all selected staves/voices. Multitrack Copy expands to complete bars, and Cut removes those bars globally. Successful Cut replaces the clipboard after one committed erase/remove command. Paste supports existing track/staff mappings, repetitions and six content filters through one self-contained history command. Saved projects replay after a full process restart with an empty clipboard.

Snapshots omit unrelated music, native projects, source paths/archive siblings, raw lyric sources and backing assets. Paste retains destination provenance, lyrics, backing bytes and mapped anchors. Conversion preserves sounding pitch with destination tuning/capo/transposition; melodic/percussion transfers can produce the documented rhythmic rests. Invalid mappings, incompatible links and unsupported musical contexts reject before publication.

Copy is serialized against committed music. Failed native edits, Cut, history changes and document replacements preserve playback preparation. Successful Paste clears indexed chord-member selection. Text controls and dialog descendants retain their own shortcuts. Settings replay derives exact post-paste maps while retaining the canonical music and embedded-byte identities, so mixer undo/redo keeps playback running.

## Verification

- Final full frontend: **1,008 Vitest tests across 85 files**, one explicit benchmark skip; **10 Node resource tests**. Typecheck passes.
- Full Rust 1.88 suite: **177 passed**, six explicit hardware/resource ignores; formatting passes. All **59** shared edit examples round-trip. Practice shared wire cases are tested separately.
- Independent reviews cover strict DTOs, sanitized source/store, conversions/paste, controller/history/UI integration and linked-note fidelity. Reported defects received meaningful failing regressions before fixes.
- Final Windows diagnostic build passes `tests/desktop/parity-clipboard.mjs`: copy across New, repeated one-command paste, Cut/undo, literal MIDI, save, full process restart and replay with an empty clipboard. A partial piano phrase converts to guitar while retaining its leading rest and exact chord onset. Four-track guitar9/bass6/drums/keys Copy/Cut/Paste retains alignment and independently compared MIDI. Invalid duplicate mappings preserve the project. Mixer edit/undo/redo after Paste retains native audio generation and running state. Authored source hashes remain unchanged.
- The previous mouse/range/measure desktop workflow also passes on the final binary, including native audio and process restart.

Ignored receipts: `.analysis/parity/clipboard-practice-frontend-final.log`, `clipboard-practice-native.log`, `clipboard-practice-typecheck-final.log`, `clipboard-practice-fmt.log`, `clipboard-practice-desktop-build-final.log`, `clipboard-desktop-final.log`, `native-clipboard-result.json`, `native-clipboard.png`, and `range-desktop-practice-regression.log`.

## Tie preservation correction

The private playback audit exposed a pre-existing public-model case: two duplicate chord notes share one incoming tie origin, whose forward pointer refers only to the last. Forward-only capture lost the other connection and created two/seventy-four extra attacks in corpus scores 9/16. Capture now retains incoming-only edges before canonical forward edges. Detachment preserves a surviving sibling or clears all dependent ties/bend continuations when removing the origin. Legacy note/rest/beat/measure deletion uses the same cleanup.

Six worker regressions and four legacy-engine regressions verify the correction. Independent serialized SMF decoding proves exactly one attack at tick 0 and termination at tick 1920 through cloning, MIDI/GP export, replay and plan generation. All **17 authorized private playback plans** now match the unchanged public MIDI attack/release/pitch/program reference with original source hashes intact. Their regenerated written-meter plans also pass the explicit native corpus validator.

## Bounded gaps

Partial multivoice slicing, sustained-beat division, overwriting sounding destination music, lyric splicing, automatic track/staff/voice creation, OS/MIDI clipboard interoperability and scale diagrams remain open. Whole-bar Paste inserts globally, including before empty bars. Context-dependent similes, incomplete repeat groups/directions and incompatible conversions reject visibly.

Contradictory multi-lane program/bank streams reject where the pinned generator suppresses their effective MIDI events. Duplicate incoming tie ownership is retained for ordinary score playback/export but remains unsupported by this clipboard schema. Long-link GP import, continuous controller ramps, audible pedal semantics, original GP8 runtime acceptance and physical macOS/Linux checks remain open. No shipping installer or new `main` release is produced here.
