# Bundled cabinet impulse responses (2026-10-31)

Fifty-eight cabinet impulse responses now ship with TabPlayer and play through the cabinet block's existing impulse-response system. A document still stores only the response's identity, name and level trim; the built-in `open`, `closed` and `bass` models remain for documents that name no response. This closes the first limit recorded for A06 ([cabinet IR](2026-10-30-gp8-cabinet-ir.md#L17-L19)).

## Behavior

- **What ships:** 58 mono WAV captures in six packs under `src-tauri/resources/cabinet-irs/`: Bass Amp (14), DT410 (8), Fender (4), Mesa V30 4x12 (15), Recto V30 (1) and Zilla V30 2x12 (16). They total **5,130,898 bytes**. 48 files are 24-bit PCM at 48 kHz and the 10 DT410 files are 32-bit float at 44.1 kHz; each is resampled to the device rate when its kernel is made.
- **Read-only beside the user's own:** `IrLibrary::with_bundled` loads `manifest.json` from the resource folder and lists those responses after the user's, sorted by name. `IrEntry.bundled` marks them, the picker disables Remove for them, and `remove` refuses them unless an older user copy of the same bytes is still in the user folder.
- **Identity:** a response's identity is the first 32 hex digits of the SHA-256 of the whole file, the same scheme the user library already uses. Importing bytes identical to a bundled response returns the bundled entry and writes nothing into the user's folder.
- **Display names:** each name starts with its pack (`Bass Amp · 8x10 Ampeg SVT 97`, `Mesa V30 4x12 · Upper left · SM57 1.00in · 7603`), so the flat picker groups naturally by pack. All 58 names are unique and at most **53** characters, inside the 64-character document limit.
- **Failure is contained:** a missing or invalid bundled manifest logs why and leaves the user's responses and the built-in cabinets working. A bundled file that has changed or cannot be read shows the existing missing/unreadable notice and the built-in cabinet plays; the document is unchanged.
- **Packaging:** `tauri.conf.json` bundles `resources/cabinet-irs/` to `cabinet-irs/`. `scripts/verify-packaged-resources.mjs` now requires exactly one `cabinet-irs/manifest.json`, compares it with the source manifest, verifies every listed WAV's size, SHA-256 and identity, checks `README.txt` and the CC0 license against the source, and rejects any extra file. `node scripts/generate-cabinet-irs.mjs` rebuilds the manifest from the WAVs.

## Evidence

| Check | Command | Result |
| --- | --- | --- |
| Asset manifest, identities and generator agreement | `node --test scripts/cabinet-ir-assets.test.mjs` | 3 of 3 pass; 58 WAVs, unique 32-digit identities, matching SHA-256 and sizes, CC0 notice |
| Packaged resource audit | `node --test scripts/verify-packaged-resources.test.mjs` | 10 pass, 1 skipped (Windows file symlink EPERM); includes cabinet IR hash, inventory and manifest mismatch cases |
| Bundled library and playback | `cargo test --test audio_bundled_ir` | 2 of 2 pass: all 58 listed and make kernels at 44.1 and 48 kHz; a bundled response is audible through a track, cannot be removed, and an identical import copies nothing |
| Existing IR suite | `cargo test --test audio_cabinet_ir` | 18 of 18 pass; user import/remove, fallback, real-time safety and document compatibility unchanged |
| Full native suite | `cargo test -j 1 -- --skip file_library::index::tests::a_page_search_over_fifty_thousand_rows_stays_fast` | 410 library tests plus every integration suite pass, 0 failed, 4 ignored |
| Focused frontend | `npx vitest run src/audio/cabinet-ir.test.tsx src/audio/SoundPanel.test.tsx src/document-settings.test.ts` | 43 of 43 pass, including bundled listing, disabled Remove and bundled import copy |
| Types | `npm run typecheck` | clean |

The full `npm test` run on this shared machine reported **4,657 passed, 22 failed, 4 skipped** in 292 files. Every failure is a 5-second timeout under load (19) or the pre-existing `WorkspaceApp` assertion `expected undefined to be type of 'function'` (3 parameterized cases). The five affected files — `App`, `tuning-ui`, `midi-import`, `library/content` and `WorkspaceApp` — pass **255 of 255** when run alone with `--maxWorkers=1 --testTimeout=60000`, so none is caused by the cabinet IR work. The filtered timing benchmark also passes alone; its 2-second budget is not met while other sessions compile.

The bundled manifest SHA-256 is `b250bb8fa67f44fb4091fa1255df7211dabbb1b63d476537031c0b5fde28d4cc`; the generator `scripts/generate-cabinet-irs.mjs` hashes to `65e6f7def96df2102767827a811499d03b51a45f59bcf8c03e449af4354b5176`.

## Licensing

The WAVs are the CC0 1.0 captures from the `tabplayer-ir-packs` set: affirmer Kristjan Kruus, dedicated 2026-10-30, published from Estonia, no attribution required. `README.txt` records the dedication, the formats and the read-only rule; `LICENSE-CC0.txt` carries the full legal code. Trademarks in file names identify the captured gear and imply no affiliation or endorsement; CC0 covers the audio recordings only.

## Limits

- **Picker:** it is still a flat select of every response; with 58 bundled names the pack prefix sorts and groups them, but there is no search or `<optgroup>`.
- **Listening:** the captures are unchanged from the CC0 set; this change did not judge them by ear, and no desktop smoke run of the packaged installer was made.
- **Platforms:** the Windows package audit and native tests ran here; macOS and Linux package extraction was not repeated.
