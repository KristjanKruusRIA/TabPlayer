# P08 metronome sound choice

Date: 2026-11-06. Branch `feature/p08-metronome-sound`, from develop at 2b9fa0e.

P08 had metronome level and a silent visual mode. The open gap was choosing the metronome's sound. This slice adds four synthesised sounds:

- **Beep:** the original, unchanged.
- **Woodblock:** two inharmonic partials with a fast decay.
- **Cowbell:** two clipped partials a sixth apart, with a longer ring.
- **Stick:** a short noise burst over a faint tone.

The sound is chosen under Practice settings, in the Practice popover. It applies to playback, the count-in and audio export.

## Behaviour

- **Synthesis:** each sound is made on the audio thread with no assets and no allocation. Accents raise the pitch of the tonal sounds and make the stick louder. No sound is louder than the original beep's ceiling of 0.25 times the volume, so changing the sound never jumps the level.
- **Applying:** a change of sound takes effect on the next click. It never cuts off a click that is still ringing.
- **Old settings:** settings written before this change have no `sound` field and keep the beep, in both Rust (`#[serde(default)]`) and TypeScript (an optional field). An unknown sound is refused.
- **Export:** a mixed or stem export that includes the metronome uses the sound chosen when the export starts. The request carries `metronomeSound` only when the metronome is on, and older requests default to the beep.
- **UI text:** the label and the four names are in `en`, `et` and `de`.

## Evidence

- **`cargo test --test audio_practice`: 18 of 18 pass.** New tests:
  - each sound is distinct, stays within the beep's ceiling and ends;
  - the beep is sample-exact with the old formula;
  - accents raise the woodblock's pitch by its ratio, and the cowbell's in direction only;
  - every sound renders without allocating;
  - settings with no sound, with a chosen sound and with an unknown sound behave as stated.
- **`cargo test --test audio_render the_chosen_click`:** the renderer's metronome stem starts with each voice's exact accented shape, the pulse count is unchanged, and the four stems differ.
- **Vitest:**
  - The Practice panel lists the four sounds in order, applies a chosen sound, and reads old settings as the beep.
  - Validation accepts each sound and settings without one, and refuses unknown or empty values.
  - The export coordinator sends the sound only with a metronome.
  - In `src/audio`, `src/export`, `src/i18n`, `src/App.test.tsx` and `src/workspace`, the 20 failures are all known ones. Fifteen are missing fixtures in the worktree. The other five are WorkspaceApp and App tests that also fail on develop (THE-173).
- **Typecheck:** clean.
- **Wider Rust run:**

  | Suite | Result |
  |---|---|
  | `--lib` | 446 pass, 4 ignored |
  | `audio_render` | 38 pass, 1 ignored |
  | `audio_practice` | 18 pass |
  | `audio_transport` | 7 pass, 1 ignored |
  | `audio_practice_transport` | 15 pass |
  | `audio_drum_mix` | 19 pass |
  | `reference_sync` | 12 pass |

- **Desktop, Windows test build from this branch** (scratchpad check, not committed):
  - Opened the instrument fixture, opened the Practice popover and found the sound under Practice settings. It showed Beep first, with options Beep, Woodblock, Cowbell and Stick.
  - Chose Woodblock, turned the metronome on and applied.
  - `audio_status` from the native service then reported `{"enabled":true,"volume":0.4,"visual":false,"sound":"woodblock"}`.
  - The panel showed Woodblock after reopening. Playback started and stopped with no page errors.
  - The run did not capture or listen to the audio.
- **`node tests/desktop/parity-practice.mjs`:** passes (exit 0) with the expected native settings now including `sound: "beep"`.

## Review

A fresh realtime-safety review of the audio-thread changes found no blocker. Changes made from it:

- `tests/desktop/parity-practice.mjs` expects the `sound` field in the native settings.
- Device-path tests: `shared_practice_carries_every_metronome_sound` and `count_in_clicks_use_the_chosen_sound` (the count-in's first 400 frames match an accented voice of the chosen sound).
- Each sound's length lives in one table (`ClickSound::shape`), and the restore threshold after a seek uses that length.
- The cowbell's gain was lowered from 0.5 to 0.3, so it sits nearer the other sounds.

Accepted limits from the review: like the beep, a ringing cowbell can be cut by a retrigger, the end of the tail or a seek. The select sits in the panel's existing `fieldset disabled={busy}`, the same pattern as the other practice settings.

## Limits

- The sounds were not judged by ear in this session. The beep is unchanged. The other three have only been measured, not heard.
- The sound is not stored with the score. Like the rest of the practice settings, it lives in the native audio session.
- There is no original Guitar Pro 8 comparison of its metronome sound set.
