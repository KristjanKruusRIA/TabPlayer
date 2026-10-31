# GP8 parity A32: lock track sound against automations (2026-10-31)

GP8 row A32: lock the current track sound against sound automations. While locked, sound changes in the score (instrument and sound automations) do not change what the track plays, in playback and export alike; unlocked, they apply as they do now.

## Behavior
- **Lock control:** The Sound view (`SoundPanel`) provides a "Lock sound against automations" checkbox directly in the track sound view.
- **Undoable edit:** Toggling the lock records a single undoable `setTrackSound` edit with `locked: true` or `locked` omitted/false, preserved in the document and project history. Selecting the current value records nothing.
- **Focus and interaction:** Controls stay focusable while busy (`aria-disabled` with handlers that refuse clicks), never disabling the focus-holding element.
- **Playback & Export:** In `audio::renderer` and `audio::voices`, locked tracks preserve the track's configured instrument / program throughout playback and audio export, ignoring score sound automations (`PlanMidiEvent::Program`) and note-level voice overrides.
- **Bit-identical unlocked rendering:** An unlocked document renders bit-identically (`f32::to_bits` float exactness) to an untouched default document.
- **Backward compatibility:** Older project documents and edit logs omit `locked`; older files replay cleanly and validate without schema migration issues.

## Evidence
- **Rust rendering test:** `audio_render::locked_track_sound_ignores_scheduled_program_changes_and_seek_while_unlocked_renders_bit_identically` proves bit-identical rendering between default and unlocked document (`f32::to_bits`), that locked playback ignores scheduled score program automations, and that seeking while locked preserves locked voice sound.
- **TypeScript & replay test:** `src/audio/track-sound-lock.test.ts` validates `completeSound` / `soundProblem`, verifies omitted `locked: false` for byte-identical serialization, replays old log entries without `locked`, and proves undo/redo restores state.
- **UI unit test:** `src/audio/SoundPanel.test.tsx` tests that clicking toggles lock via a single `setTrackSound` edit, unchanged values record nothing, and controls remain focusable while busy with `aria-disabled` refusing clicks.
- **Protocol verification:** `cargo test --release --test protocol` passes against schema serialization rules.

## Review
Pending.

## Limits
- **Per-track scope:** The lock is per-track within the document; it does not lock automations across other unlocked tracks.
- **Score display:** The score itself continues to display written sound/instrument change markings even while playback for the locked track ignores them.
