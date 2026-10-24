# S15: saved personal tunings

Date: 2026-10-22. Status: design only; S15 remains partial until the plan's source, automated, and actual desktop gates pass.

## Brief and evidence

Provide durable personal tuning save, recall, rename, and delete alongside the existing 25 immutable built-ins (guitar 6–9 strings; bass 4–6). A recalled tuning fills a draft; explicit Apply changes the document atomically. Applied names are document snapshots, independent of later library edits.

This is an architectural slice because it adds native persistence and extends edit wire contracts. The user has authorized parity work and waived additional approval questions and next-slice pauses. Preparation proceeds directly; implementation must wait for root's S14 release or use a root-approved isolated checkout. Current S14 source and runtime inputs are frozen and must not be changed by preparation.

Inputs: `.analysis/parity/saved-tunings-current-seams.md`, SHA256 `236985E2D8C871186CABF3F6EFC664C859A2820C5A25E3DFC6028A80F5FE3019`, and `.analysis/parity/saved-tunings-reference-review-root.md`. Root inspected actual GenAI image SHA256 `953C3FB9F5CF0EBC5D378A3D0B91D258381FDD9D4FAEEE385B99DFD75AA3F113` before S15 UI code. This fulfills the image prerequisite; it is reference artwork, not runtime evidence.

Assumptions: personal tunings are instrument-neutral pitch arrays, support 1–12 strings, and retain the current high-to-low order. Guitar/bass grouping remains a built-in catalog feature; six-string count does not imply an instrument. No new dependency, generic preferences system, localStorage persistence, project schema, or label-only edit command is needed.

## Chosen boundary

Use a small tuning-specific native store and typed bridge, mirroring `harmony_library.rs` and `src/harmony/library.ts`. A session-preferences extension would couple personal records to recovery lifecycle; a generic storage framework would add unnecessary scope. Neither is selected. The separate app-data file is `tuning-library.json`.

Shared wire types:

```ts
type SavedTuning = { id: string; name: string; tuning: number[] };
type TuningLibrary = {
  format: 'tabplayer-tuning-library'; version: 1; entries: SavedTuning[];
};
```

Rust equivalents use strict serde fields. Require a valid UUID, compare UUID identity case-insensitively, retain stored spelling on replacement, and reject duplicate identities. A new Save allocates a UUID; a rename puts the same UUID and pitches. Preserve insertion order when replacing; append new entries. Duplicate names and duplicate pitches are allowed and never act as identity.

Personal names are trimmed, nonblank, at most 80 Unicode scalar values, and valid XML 1.0 characters (tab/LF/CR, U+0020–D7FF, E000–FFFD, 10000–10FFFF); reject unpaired surrogates in TS. Do not normalize internal whitespace or Unicode. `tuning` is 1–12 integer MIDI pitches, each 0–127. Use existing `parseTuning`/`formatTuning` for note-plus-octave text; do not create another pitch parser. Accept no unknown envelope or entry keys and no unsupported version/format.

Native commands are `tuning_library_read()`, `tuning_library_put({entry})`, and `tuning_library_remove({id})`, all returning the complete `TuningLibrary`. Register in both invoke-handler lists. Resolve the normal app-data directory and use `spawn_blocking`, a tuning-store mutex, validation before mutation, and the existing atomic file writer. Missing file returns empty without creating a file. Invalid, duplicate, corrupt, or unknown-format content produces an error and preserves its bytes; do not silently reset or overwrite it. Removing an absent valid ID is idempotent.

## Library and draft UI

The shared `TuningInput` opens a compact charcoal dialog: two-column list/details, distinct Personal and Built-in sections, full note names with octaves, current selection visibly identified. Preserve the incumbent workstation. The reference's duplicated blue emphasis and abbreviated pitch strings are raster errors: use one primary **Use tuning** action, secondary **Save changes**, and full pitch text. At short heights, scroll the body internally and keep Cancel/Use tuning reachable.

- Selecting a row changes dialog details only. Identity is `{kind:'personal', id}` or `{kind:'builtin', index}`; the built-in index refers only to the immutable current catalog and is never persisted. Show pitches beside duplicate names so entries can be distinguished.
- **Save as new** creates a personal record from valid detail name/pitches. **Save changes** replaces the selected personal record; editing only its name is rename. **Delete** removes only the selected personal record. Built-ins expose no overwrite/delete action, but may be copied with Save as new. Storage errors preserve the details and last valid list; successful deletion clears dialog selection but does not change any outer draft.
- **Use tuning** copies detail pitches and name into the caller's draft and closes the dialog. Unsaved valid details may be used; Use accepts an empty document name, while Save requires the personal-name rules. **Cancel** closes without changing that draft. Saving does not itself Use or Apply.
- A direct pitch-text edit clears the selected library identity and draft name, even when its parsed pitches happen to match a named entry. This also applies inside dialog details: after editing pitches, enter a name to save as new or use the unnamed tuning; Save changes remains available for renaming an unchanged selected personal tuning. Selecting/using a tuning explicitly assigns its current detail name again. Library rename/delete never rewrites an already recalled draft or applied score name.
- Preserve existing percussion, busy, focus, validation, and string-count behavior. Both `TrackSettingsPanel` and `StructurePanel` use this same field/dialog behavior; there is no second saved-tunings implementation.

Extend the shared field with `tuningName: string` and `onTuningNameChange(name: string): void`; retain `value`, `onChange(notes)`, and existing revision reset. Callers own note/name drafts together and reset both when the addressed document/track/staff changes. A preset use updates both; direct text input sends `''`. Keep selected personal ID as transient dialog/draft UI state, never in project commands. A remount/revision reset clears that identity instead of inferring it from pitches.

Bridge functions in `src/tuning/library.ts` are `readTuningLibrary(): Promise<TuningLibrary>`, `putTuningLibraryEntry(entry: SavedTuning): Promise<TuningLibrary>`, `removeTuningLibraryEntry(id: string): Promise<TuningLibrary>`, and `subscribeTuningLibrary(listener: (library: TuningLibrary) => void): () => void`. Validate and clone inbound/outbound values. Serialize reads and mutations in one per-window promise queue that recovers after rejection; publish only successful snapshots. Each open dialog subscribes and reads fresh on open, so multiple shared fields converge. Read/notification results update lists only, never details or an outer draft; removed selections become unavailable until explicitly reselected or used as an independent unsaved draft. Guard open/read completion with a dialog generation token so closing, unmounting, or switching documents discards late UI callbacks. Other desktop windows refresh when their dialog next opens; live cross-window sync is outside scope.

## Atomic document names and compatibility

Add optional `tuningName?: string` to TS and Rust `setTuning`, `setStringCount`, `addTrack`, and `StaffSettings` used by `setStaffSettings`/`addStaff`. Rust uses `Option<String>` with omission on serialization; exact TS shape validation accepts precisely the old shape or that shape plus a string `tuningName`. Reject explicit null and unknown keys consistently in command validation. Document names allow any length of valid XML text, including empty, so imported names are not truncated to the personal-library limit.

| Payload | Result |
| --- | --- |
| Property omitted | Preserve each pre-S15 route's behavior: existing setTuning/configure retain their old name; S14 setStringCount clears it; creation keeps its prior default. |
| `tuningName: ''` | Explicitly clear the name. |
| Nonempty `tuningName` | Snapshot the exact supplied name on the resulting staff. |

New UI tuning applies always supply the draft name, including `''` after custom edits. Non-tuning capo/clef edits in `StructurePanel` preserve its initialized name. Apply explicit names only after successful pitch/remapping validation and after S14 string-count processing; one command must yield one undo step. Failed Apply leaves pitches, names, history, and dirty state unchanged. Existing S14 behavior and tests remain valid for omitted fields.

The model is `staff.stringTuning.name`. Use ordinary controller preview/native revision/edit replay routes; never mutate a score from a library callback. Undo/redo, replay, native project persistence, and clone use the snapshot in the command/model, not a library UUID lookup.

Use the existing application GP export/load path and alphaTab label support. Preserve high-to-low pitches without additional reversal. In `exportGpInterchange`, handle `]]>` in tuning label CDATA with the same export-only split principle already used for lyrics; do not mutate the live score or use a global textual replacement that changes unrelated content. Verify `]]>` plus Unicode, `&`, `<`, and `>` through the actual application path before claiming label roundtrip.

## Acceptance and scope

Native tests use unique temporary app-data roots and reopened store calls; desktop acceptance uses a dedicated test profile whose effective path is checked before writing. Never touch the user's real library or recovery state. Tests cover corruption byte preservation, failed mutation recovery, duplicate identity, save/reopen/rename/delete, and library/document isolation. Frontend tests cover strict bridge validation, queue ordering, stale callbacks, duplicate-pitch identity, both callers, immutable built-ins, and draft-only Use. Replay/GP tests cover every tuning-bearing route, omitted legacy payloads, explicit clearing, names with `]]>`, rollback, undo/redo, clone, reopen, and independence from rename/delete.

After one joined source review and root's checks, perform one owned fresh no-audio desktop run on the final source: save, restart/reopen the personal library, rename, recall, Apply, undo/redo, export/reopen GP, delete, and verify the applied name survives. Include full note/octave text, score name display, and a short-height dialog check. Reuse the current S14 owned driver only as a narrow pattern; do not add an overloaded 1000-line harness. Record source identity, effective test profile, receipts, and screenshots. Automated checks alone do not establish desktop acceptance.

S15 stays partial until those exact gates pass. No universal performance gates, proprietary original-GP8 verification, account integration, other-OS, or shipping claims are included. Self-review completed for scope, contracts, label compatibility, race behavior, ownership, and acceptance coverage; no implementation or tests are claimed here.
