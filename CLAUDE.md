# TabPlayer

Local Tauri 2 desktop tablature player and editor for guitar and bass. Rust owns document history, persistence, audio rendering and exports. React 19 and alphaTab 1.8.4 provide the interface, notation and score/MIDI preparation. Native playback is the timing authority. See `PRODUCT.md` for product intent; a comfortable UI is the leading priority.

## Where work happens

- `main` is the released line. `develop` is the working branch; slices branch from it into `.worktrees/` and merge back. Check `git worktree list` and the current branch before starting.
- Worktrees have no `.analysis/compatibility` fixtures, so `plan.test.ts` and many audio Rust tests can fail there for that reason alone.
- Commands assume Windows PowerShell. Cargo lives in `~/.cargo/bin` and may not be on PATH.

## Codebase map

- `src/`: React UI, grouped by area (`editor`, `engraving`, `shell`, `workspace`, `i18n`, `ui` and others).
- `src-tauri/src/`: native core; `audio/` is the renderer and `edit_types.rs` holds edit types. Integration tests are in `src-tauri/tests/`.
- `tests/desktop/`: real-app drivers. `tests/fixtures/`: shared protocol fixtures.
- `docs/validation/2026-10-15-gp8-parity-progress.md`: GP8 parity tracker. `docs/backlog.md`: unscheduled ideas outside it.

## Commands

```powershell
npm ci
npm run prepare:audio        # first-time setup; downloads pinned public audio
npm run tauri -- dev
npm test                     # Node resource tests, then Vitest
npm run typecheck
cargo test --locked --workspace --manifest-path src-tauri/Cargo.toml
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
node scripts/prepare-audio.mjs --offline
node tests/desktop/parity-<name>.mjs   # from the checkout root, after the desktop test build
```

`.cargo/config.toml` caps Cargo at 6 jobs and the test profile drops most debug info, because each of the 60-odd test programs links the whole app. Prefer `--lib` or a single `--test` over a full run while other work is going.

Keep Cargo output in each checkout's default `src-tauri/target`; `scripts/build-desktop-test.ps1` and the `tests/desktop` drivers read it from there. A clean test build is about 7 GB and a used target folder reaches 30 GB or more, so never point `CARGO_TARGET_DIR` at a scratchpad, and never give a task or subagent its own target folder. If the default is busy or stale, run `cargo clean` there or use `E:/cargo-target/slot-1` to `slot-3`, but only for `cargo test` and the like: the desktop script and drivers read just the default folder, so with a slot they silently test an old binary. A global hook enforces the folder rules.

CI runs on Windows, macOS and Linux with exact Rust 1.90.0 and Node 24.20.0, and also runs the ignored `selected_real_100bar_fourtrack_resource_budget` test in `audio_resources`. Pass `--locked` after the final `--` in Tauri builds.

## Desktop verification

- `scripts/build-desktop-test.ps1` builds the test app with the `desktop-test` feature.
- Drivers in `tests/desktop/` launch `.analysis/desktop-smoke/tabplayer.exe`, resolved from the current directory, and attach over CDP on port 9223. If you built elsewhere, copy that binary there first or the driver silently tests an old build.
- Only one app can use port 9223 at a time.
- Synthetic F5/Ctrl+R do not reach WebView2 accelerators; `page.reload()` is not proof of a real reload shortcut.

## Rules

- Do not retune `src-tauri/src/audio/tone.rs` unless the user asks. The tone was approved by ear.
- Do not hand-edit `src-tauri/gen/`, `src-tauri/resources/audio/` or `.analysis/compatibility/`. They are generated or fetched.
- Never commit or redistribute private scores, extracted binaries or generated test output.
- Edits to edit types or project schema must keep old `.tabplayer` projects and edit logs replayable.
- Treat imported files as untrusted: bound archive expansion and memory, and avoid check-then-use races on paths.
- One gesture is one undoable edit, and choosing the current value records nothing.
- New UI text goes through `src/i18n` with `en`, `et` and `de` entries. A control holding focus never gets `disabled` for busy; see `src/ui/useBusyGuard.ts`.
- Record evidence in `docs/validation/YYYY-MM-DD-*.md`. State limits plainly; report partial work as partial.
