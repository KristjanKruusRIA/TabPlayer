# GP8 parity A05 and A37: sound library and copying sounds (2026-10-23)

GP8 lets players save their own sound presets and reuse them, and copy a whole sound or a single pedal from one track to another. This slice adds both to TabPlayer's Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **My sounds (A05):**
  - **Save sound** stores the track's current sound under a name. The name is trimmed and may have 1–60 characters.
  - Saving under a name that already exists, in any letter case, replaces that sound and keeps the new spelling.
  - **Saved sound** lists the library sorted by name.
  - **Apply saved sound** sets the chosen sound on the current track as one undoable sound edit. The status says “Applied” only once the edit is accepted, and only if the same track is still shown.
  - **Rename saved sound** gives the chosen entry the typed name. It refuses a name another entry already uses.
  - **Delete saved sound** asks first, in an inline group (“Delete “Name”? This cannot be undone.”) with Delete and Cancel. Focus moves to Cancel and returns to the list afterwards.
  - The library is per user, not per score, and is shared by every track and score.
  - It is kept in the app's web storage. Each save, rename or delete reads the stored library afresh, so it keeps sounds that another TabPlayer window stored meanwhile. Open panels refresh when another window changes it or when the window regains focus.
  - When storage refuses a write, the change is kept for the rest of the run and the status says so.
  - Stored entries are repaired on reading:
    - missing blocks and fields take their defaults, and unknown fields are dropped;
    - entries whose sound the native player would reject are left out;
    - malformed entries and repeated names are left out;
    - named entries this version cannot use, such as a sound with a block from a newer version, are hidden but stay stored when the library changes, and their names stay taken.
- **Copy and paste (A37):**
  - **Copy sound** and **Paste sound** copy a track's whole sound, including its instrument voice and preset, to another track.
  - Each pedal has **Copy pedal** and **Paste pedal**. Paste is enabled only on the same kind of pedal, and replaces only that pedal's settings.
  - Each paste is one undoable sound edit.
  - Copies are snapshots: later changes to the source track do not change them. They last until TabPlayer closes.
- **Validation:** the editor's sound check now matches the native one field by field: every block's exact fields, their types, ranges and allowed values, the preset, the instrument voice, and the sound's own fields. It applies to saved sounds and to every sound edit.

## Evidence
- **Library** (`src/audio/sound-library.test.ts`, 8 tests):
  - save, replace in another letter case, sort, rename, a refused duplicate rename, delete, and a refused second delete;
  - what was stored in storage, read back after forgetting the in-memory copy;
  - name limits;
  - repair: malformed JSON, missing blocks, duplicate and empty names;
  - every kind of sound the native player rejects is dropped: unknown block, inherited `constructor` and `__proto__` blocks, text values, an out-of-range gate threshold, an unknown amp model, a 3-quarter-note delay and an unknown voice. An unknown field inside a block is dropped instead, keeping the entry. The rejected entries stay stored after a save, and a rename onto one of their names is refused;
  - sounds missing `voiceId`, with null effects or with extra fields are refused;
  - a sound another window stored in the same storage is kept by the next save;
  - storage that refuses writes: save, rename and delete report it, and the next accepted write stores everything kept meanwhile;
  - copies are independent snapshots.
- **Panel** (`src/audio/sound-library-ui.test.tsx`, 4 tests):
  - a saved sound applied to another track sends one `setTrackSound` edit with that sound;
  - “Applied” is shown only after the edit is accepted; a refused edit shows its error instead;
  - status and an open confirmation are cleared on another track;
  - rename and delete, with focus on Cancel and back on the list;
  - pasting a pedal changes only that pedal, a delay copy cannot be pasted into the reverb, and Paste sound sends the whole sound.
- **Desktop:** `tests/desktop/parity-sound-library.mjs` on a Windows desktop-test build, over three launches sharing one WebView2 profile:
  - **First launch:**
    - a deep square tremolo was set on the guitar and saved as “Wobble”;
    - pasting the tremolo pedal onto the bass recorded one edit for the bass that changed only the tremolo, and Undo removed it;
    - Paste sound and Apply saved sound each recorded the guitar's whole sound on the bass.
  - **Second launch:** “Wobble” was still listed. Deleting it asked first, then emptied the list.
  - **Third launch:** the list was still empty.
  - There were no page errors or alerts.
  - `parity-pitch-effects.mjs`, `parity-wah-effect.mjs`, `parity-modulation-effects.mjs` and `exports.mjs` still pass on the same build. `exports.mjs` failed once in a run straight after the other desktop tests, without the error being captured, and passed when run again. The shared harness now accepts a fixed WebView2 profile folder.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice;
  - the full `vitest` suite: 3,454 tests, with the load-sensitive `App`, `tuning-ui`, `corpus`, `library/content` and `WorkspaceApp` files passing when run alone;
  - `tsc`.

## Review
An adversarial review reported these issues, all fixed:
- **Medium:** after the first save, the library was read only from memory. A second TabPlayer instance's saved sounds were overwritten by the next save. Reads now go to storage each time, and memory is used only while storage refuses writes.
- **Medium:** the stored-sound repair accepted sounds the native player rejects (unknown fields, text values, out-of-range values, unknown models or voices, inherited block names), so applying them always failed. The editor's check now mirrors the native rules.
- “Applied” was shown before the edit was accepted.
- Rename and delete did not report a storage failure.
- The status region was hidden while empty, which some screen readers do not announce.
- The delete confirmation did not move focus, and the pedal buttons' names did not contain their visible labels.
- Status and confirmation stayed when switching tracks.
- The tests did not check what was actually stored.

A second adversarial review approved these fixes. It checked every field rule against the native validator, and confirmed that saved projects cannot hold a sound edit the stricter check rejects, because the native side already validated each one. It reported four low-severity issues. Three are fixed:
- sounds this version could not read were removed by the next change. They are now kept;
- “Applied” could appear on another track if the track changed while an apply was pending;
- the editor accepted sounds missing `voiceId`, with null effects or with extra fields.

The fourth is listed under Limits. These last fixes were checked by the tests above, not by a third review.

## Limits
- **Storage:** the library lives in the WebView's storage for this user. It is not a settings file that can be backed up, synced or moved with the app's other files.
- **No import or export:** presets cannot be shared as files.
- **One of each pedal:** a pedal can be pasted onto the same pedal of another track, but not added as a second instance; the signal chain is fixed.
- **Clipboard:** copies last until TabPlayer closes and are not on the system clipboard.
- **Other windows:** a second window's panel refreshes on focus or a storage event; it may show an outdated list until then. While storage refuses writes, this window works from its own copy, so a sound another window stores meanwhile is overwritten by this window's next change.
- **No reference:** there is no comparison with GP8's own preset manager.
