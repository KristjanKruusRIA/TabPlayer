# Review fixes for the slices merged on 2026-11-12

A code review of `d855761..ec4474a` (THE-204, THE-205, THE-62, THE-63, THE-65 and THE-66, merged into `develop` on 2026-11-12) reported ten findings. This note records what was changed for the correctness findings and what was left.

## Fixed

| Finding | Change | Test |
|---|---|---|
| Multi-voice phrase paste lost the offset between voices and could overfill a bar (THE-66) | `makeMusicClip` pads a voice whose first selected beat comes later with leading rests, and `pastePhrase` sizes each copied measure by its longest voice. `restBeats` moved to `src/editor/common.ts` so both sides share it. | `keeps the offset between copied voices that start on different beats`, `moves a multi-voice phrase to the next bar when a later voice is the longest` |
| Annotations in the extra destination voices were kept by the target voice's beat index (THE-66) | Other voices are cut at the paste start tick, and a beat dropped because it straddles that tick detaches its notes. | `keeps the text of a later-voice rest that the paste does not reach` |
| A recorded phrase paste at the position just past the last beat no longer replayed (THE-66) | The precondition is `target.beat > beats.length` again, as before the slice. | `still pastes a phrase recorded at the position just past the last beat` |
| Multitrack paste was refused when no MIDI channel was free (THE-66) | A new track shares a channel instead, as Duplicate track does. | `appends a track when every free MIDI channel is taken` |
| A technique key on a staff without strings addressed the note by string (THE-65) | `planTechniqueToggle` uses `setNoteTechniquesByIndex` with the note's index on such staves. | `addresses the only note of a staff without strings by its index` |
| `Ctrl+M` announced a multivoice mode that no edit read (THE-65) | The key, its handler, the unused state, the help entry and the four strings in `en`, `et` and `de` are removed. | `leaves Ctrl+M alone: there is no multivoice editing mode to toggle`, `announces no multivoice mode on Ctrl+M` |

Each test was run and seen to fail before its fix, except the annotation test, whose first version passed for the wrong reason and was rewritten until it failed.

## Left as it is

- **Links dropped by an overwriting paste.** The review flagged that a paste now removes a tie or slur between untouched notes when a pasted note lands between them, where it used to refuse. The overwrite slice documents this as intended ([2026-11-10-gp8-clipboard-overwrite.md](2026-11-10-gp8-clipboard-overwrite.md)), so it is unchanged. The user gets no notice when it happens.
- **Cleanup findings.** `createTracks` still duplicates the channel and empty-bar code of `addTrack`; `Ctrl+Space` and `Ctrl+G` are still handled in two places; `convertScoreBytes` still returns an unused English `detail` string.

## Limits

- Simultaneous multivoice editing (S10) is not implemented; removing the toggle only removes the false claim. The parity tracker text and [2026-11-10-gp8-score-entry-3.md](2026-11-10-gp8-score-entry-3.md) are corrected to match.
- Leading rests in a copied later voice overwrite the destination voice from the paste start, the same way unselected beats inside a note selection already do.
- A shared MIDI channel means the appended track shares program changes on that channel with another track in a MIDI stream; MIDI export reassigns channels itself.
- Not run: Cargo tests (no Rust changed) and the desktop drivers. The findings were found by reading; only the fixed ones have tests.

## Verification

On the working tree with these changes, 2026-11-12:

- `npm run typecheck`: no errors.
- `npm test`: Node resource tests 0 failures; Vitest 366 files passed, 2 skipped; 6300 tests passed, 4 skipped.
