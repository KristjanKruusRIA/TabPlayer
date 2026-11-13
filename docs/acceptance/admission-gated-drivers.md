# Admission-gated desktop drivers (THE-186)

**Nothing in this document has been run.** It was written by reading the drivers, their fixtures and tests, and the validation notes. It is a procedure for a person. It does not write an admission and no tool in the repository does: an admission contains a statement that a person reviewed the frozen source, and only that person can make it.

The three drivers:

| Driver | Fixture and admission code | What it is for |
|---|---|---|
| `tests/desktop/parity-backing-processing.mjs` | `backing-processing-fixture.mjs` | Pitch and filter controls of the backing sidebar, in real exports and a clean restart |
| `tests/desktop/parity-backing-tempo.mjs` | `backing-tempo-fixture.mjs` | Backing tempo and reference synchronisation |
| `tests/desktop/parity-score-layouts.mjs` | `score-layout-fixture.mjs`, `score-layout-observer.mjs` | The six score layouts at two window sizes, gestures, recovery, performance |

`docs/validation/2026-11-08-desktop-driver-sweep.md` lists all three as "not run" because each needs an admission the sweep could not write. Their self-tests pass there (`node --test`).

All three are Windows only (`process.platform` must be `win32`), use PowerShell, attach to the app over CDP on port 9223 (only one app can hold it), and must be run from the checkout root (each driver checks the working directory).

## What an admission is

A JSON file that binds one exact build to one exact source tree and says a person reviewed that source. `--prepare` reads it, checks every claim against the files on disk, and only then writes a fixture state. `--run` checks it again before and after the run. If any bound file changes, the run fails.

It proves: the executable under test was built from the source that is on disk now, built with the `desktop-test` feature and `VITE_DESKTOP_TEST=1`, built after the newest source edit, and an older known-bad executable is not the one being launched. It does not prove the app is correct.

`rootReviewed: true` means a person reviewed the frozen source and accepts it for this run. The code only checks that the value is `true`. Write it by hand, after reviewing, and not before.

## Why an admission goes stale

The source manifest (`sourceManifest()` in each fixture) hashes every file under `src`, `src-tauri/src`, `src-tauri/tests`, `src-tauri/capabilities`, `tests/desktop`, `scripts` and `public`, plus `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `tauri.test.conf.json` and `build.rs`. `docs/` is not in it.

So any edit to any of those after the build, including a new script, a test, or a changed driver, invalidates the admission and the executable. You must freeze first, build second, then write the admission. Do not touch file times to get around the order checks.

Merge the branches you want (this prep branch adds files under `scripts/` and `src/`) before you freeze.

## Fields, per driver

`hash` means lower-case SHA-256 hex, 64 characters. `path` means absolute, and for executables it must be the real path (no junction or symbolic link; the check compares the real path to the written one).

### Shared by all three

| Field | Value | Where it comes from |
|---|---|---|
| `version` | `1` | fixed |
| `worktree` | the checkout root | `pwd` there; must equal the checkout the driver is run from |
| `diagnosticFeature` | `"desktop-test"` | the Cargo feature you built with |
| `frontendDesktopTest` | `true` | you built with `VITE_DESKTOP_TEST=1` |
| `rootReviewed` | `true` | **a person writes this after reviewing the frozen source** |
| `sourceHashes` | map of relative path to hash | the exact output of `sourceManifest()` for that driver's fixture, taken after the freeze. The two manifest functions list the same folders and files; the score-layout one is sorted with `localeCompare`, the other two with default sort, so copy each driver's own function output rather than reusing one |
| `buildSourceSha256` | hash | `manifestDigest(sourceHashes)`: SHA-256 of `JSON.stringify(sourceHashes)` |
| `executable`, `executableSha256` | path, hash | the built `tabplayer.exe` and its hash (`Get-FileHash` or `certutil -hashfile`) |

### `parity-backing-tempo`

`format`: `"TabPlayerBackingTempoBuildAdmission"`.

| Field | Value | Source |
|---|---|---|
| `builtAtUtc` | ISO time | when the build finished; must be at or after the newest file mtime in `sourceHashes`, and the executable's mtime must be too |
| `rejectedPriorExecutableSha256` | `"fe93eb9c4855a0d99f1511defc24a673c14d79f25b79753fd5cf601b9c85e803"` | the constant `rejectedPriorExecutableSha256` in `backing-tempo-fixture.mjs` (a hash of an older P15 executable). The current executable's hash must differ |

### `parity-backing-processing`

`format`: `"TabPlayerBackingProcessingBuildAdmission"`. Needs everything in the tempo list except `rejectedPriorExecutableSha256`, and:

| Field | Value | Source |
|---|---|---|
| `builtAtUtc` | ISO time | as above |
| `rejectedExecutableSha256` | array of at least two different hashes | must include the same `fe93eb9c...` constant, plus the hash of the other older executable the note calls "current pre-P17" (`docs/validation/2026-10-16-gp8-backing-processing.md`). The code checks only that they are 64-hex, distinct from each other and from the current executable, and that the constant is there. Put real hashes of executables you know are old; do not invent one |
| `frontendManifestPath`, `frontendManifestSha256` | path, hash | a JSON file you write after the build: `{"buildSourceSha256": "<same as above>", "files": {"dist/...": hash, "src-tauri/resources/...": hash, ...}}` listing **every** regular file under `dist/` and `src-tauri/resources/` (the score-layout version of this file must match those two folders exactly; the processing check ignores extra entries outside them) |

Resource links are refused: every entry under `dist` and `src-tauri/resources` must be a real file, not a junction or link. A linked worktree that holds `src-tauri/resources/audio` as a junction will fail here (see "Other things that stop a run").

### `parity-score-layouts`

`format`: `"TabPlayerScoreLayoutBuildAdmission"`. The strictest.

| Field | Value | Source |
|---|---|---|
| `sourceReview` | `{ "status": "passed", "frozenRevision": "<40 hex>", "reportPath": path, "reportSha256": hash }` | `status` must be the word `passed`, and only a person who read the report writes it. `frozenRevision` is the git commit of the frozen source (`git rev-parse HEAD`; commit first so it matches). `reportPath` is a regular file inside the repository that records that review; the code checks only that it exists and matches the hash |
| `buildStartedAtUtc`, `builtAtUtc` | ISO times | start must be at or after the newest source mtime; start at or before end, end not in the future; the executable's mtime must lie from start to end. So copy the executable into place before you record `builtAtUtc` |
| `executable` | path | must be under `.analysis/desktop-smoke/`, and its grandparent folder must be named `score-layout-<anything>`, for example `.analysis/desktop-smoke/score-layout-<stamp>/runtime/tabplayer.exe` |
| `configPath`, `configSha256` | path, hash | the Tauri config used for the build |
| `buildLogPath`, `buildLogSha256` | path, hash | the build log |
| `frontendManifestPath`, `frontendManifestSha256` | path, hash | `{"buildSourceSha256", "files"}` covering exactly `dist/` and `src-tauri/resources/`, as for processing |
| `runtimeResourceManifestPath`, `runtimeResourceManifestSha256` | path, hash | a JSON file with exactly the keys `audioFiles`, `audioLink`, `audioTarget`, `buildSourceSha256`, `libraryFiles`, `libraryRoot`: hashes of every file in the `Library` folder beside the executable and in the audio folder it links to |
| `referencePacketHashes` | map of path to hash, not empty | the design reference files the visual review compares against: the generated concept images and JSON in `docs/design/reference-workstation/` (for example `grid-score-concept-v2.png`, `horizontal-page-concept-v2.png`, `horizontal-screen-concept-v2.png` and their `*-generated-concept-v2.json`), plus the spec and plan if you want provenance. Each must be a file inside the repository and match its hash |

Shape, with placeholders only (this is not a file to copy):

```json
{
  "format": "TabPlayerScoreLayoutBuildAdmission",
  "version": 1,
  "worktree": "<absolute checkout path>",
  "sourceReview": { "status": "<passed, only after review>", "frozenRevision": "<40 hex>", "reportPath": "<path>", "reportSha256": "<hash>" },
  "rootReviewed": "<true, only after review>",
  "diagnosticFeature": "desktop-test",
  "frontendDesktopTest": true,
  "sourceHashes": { "<relative path>": "<hash>" },
  "buildSourceSha256": "<hash>",
  "buildStartedAtUtc": "<ISO time>",
  "builtAtUtc": "<ISO time>",
  "executable": "<path>", "executableSha256": "<hash>",
  "configPath": "<path>", "configSha256": "<hash>",
  "buildLogPath": "<path>", "buildLogSha256": "<hash>",
  "frontendManifestPath": "<path>", "frontendManifestSha256": "<hash>",
  "runtimeResourceManifestPath": "<path>", "runtimeResourceManifestSha256": "<hash>",
  "referencePacketHashes": { "<path>": "<hash>" }
}
```

The tempo and processing shapes are the shared fields plus the extra rows above, under their own `format` strings.

## Commands, in order

Run everything from the checkout root in PowerShell. Never launch an old executable, and do not kill processes by name; the drivers manage their own processes.

1. **Merge and freeze.** Merge what you want tested. Make the tree final. Check `git status` is what you mean it to be.
2. **Prepare offline assets** (the manifest walks `public/`, which does not exist until this has run; in a fresh worktree `sourceManifest()` fails with `ENOENT ... public`):

   ```powershell
   node scripts/copy-assets.mjs
   node scripts/prepare-fonts.mjs
   node scripts/prepare-audio.mjs --offline
   node scripts/prepare-library.mjs
   node scripts/copy-notices.mjs
   ```

   These are the steps of `npm run prebuild`. Do them before the freeze so the generated files do not get newer mtimes than the build.
3. **Build the diagnostic app.** Use a fresh folder under `.analysis/desktop-smoke/` (for score layouts it must be named `score-layout-<stamp>`). The recipe in `tests/desktop/string-count-build.mjs` is the model: build the frontend with `VITE_DESKTOP_TEST=1`, write a Tauri config that keeps only the window list and sets `beforeBuildCommand` empty, wait so the build starts after the newest source file, record the start time, then

   ```powershell
   $env:VITE_DESKTOP_TEST = '1'
   npm run tauri -- build --no-bundle --features desktop-test --config <absolute config path>
   ```

   Keep the Cargo output in the default `src-tauri/target` (or `<cargo-target>/slot-1` to `slot-3`). Copy `target/release/tabplayer.exe` into the fresh folder and copy `audio` and `library` from `src-tauri/resources` beside it as real files (`dereference`). `string-count-build.mjs` itself writes a different packet (`TabPlayerStringCountBuild`) for a different driver and sets no review flag; do not reuse its output as an admission for these three.
4. **Review the frozen source.** Read the diff since the last accepted run. This is the step `rootReviewed` and `sourceReview` attest.
5. **Write the admission by hand** (an editor, not a script that fills in `rootReviewed`). Compute every hash from the real files. Record `builtAtUtc` after the build and after the executable copy.
6. **Prepare**, once per run:

   ```powershell
   node tests/desktop/backing-tempo-fixture.mjs      --prepare --admission=<absolute admission.json>
   node tests/desktop/backing-processing-fixture.mjs --prepare --admission=<absolute admission.json>
   node tests/desktop/score-layout-fixture.mjs       --prepare --admission=<absolute admission.json>
   ```

   Each prints `statePath`. A failed assertion here names the field that does not match.
7. **Run**, one driver at a time (port 9223):

   ```powershell
   node tests/desktop/parity-backing-tempo.mjs      --run --state=<statePath>
   node tests/desktop/parity-backing-processing.mjs --run --state=<statePath>
   node tests/desktop/parity-score-layouts.mjs      --run --state=<statePath>
   ```

   Each writes `result.json` and its screenshots under the state's `outputs/run-*` folder, and prints the receipt.
8. **Optional single confirmation.** Processing has `--confirm-visual --state=<new state>` for one targeted look after a visual fix. Score layouts have `--confirm-visual` after a correction packet; it is allowed once and the driver writes a marker (see below). A new admission and a new build are needed after any source fix.

## What to look at and what you attest

The drivers assert behaviour (IPC state, exports, timing, history). They cannot judge how the screen looks. Every screenshot carries a review field set to "pending" and nobody has marked it reviewed. The person running them looks at the frames and writes the verdict.

- **Backing processing.** Look at every `.png` in the run folder: the compact Pitch and filter disclosure in the left Backing sidebar (below mix, above Sync timing) at 960x720, 1280x900, 1600x1000 and 1280x620; the focus rings on the Semitones field and the Filter select; the invalid-entry guidance. Check: nothing is clipped or overlaps, the text is legible, the invalid message is readable and not only colour.
- **Backing tempo.** Compare the frames with `docs/design/reference-workstation/backing-tempo-concept.png` and `backing-waveform-concept.png`. The notes say the generated geometry is illustrative; real mono and stereo lanes and the existing workstation identity win. Check the plot is not clipped in compact docks, numeric focus is visible, and persisted Exit text does not overflow (the three things the earlier review withheld acceptance for).
- **Score layouts: the "actual ink" gate.** The driver captures 12 frames: six layouts (vertical page, horizontal page, grid, parchment, vertical screen, horizontal screen) at 1600x1000 and 1024x600. The receipt lists `pendingGates` including `actual ink`: "Root must inspect the bounded new frames together". Look at all 12 together. Check: the music and tab are readable and complete (no missing glyphs, no cut-off systems), physical-page modes show equal sheets (at least three), the arrangements are right for each mode, the toolbar wraps and keeps focus visible at both sizes, margins and borders are clean, and the dock does not overlap the score. "Ink" here means the real rendered notation, not the DOM. Write what you found per layout and size. The generated concepts guide the judgement; they are not screenshots.

Two further pending gates are printed by the score-layout driver and are not closed by the run: running-clock and stale queued callbacks, and performance on a representative private song. Do not report them as done.

What the person attests, in the validation note: which source was reviewed (the commit), that they read it, and per screenshot or layout what they saw. A passing `result.json` is not the attestation.

## What to record

Write `docs/validation/YYYY-MM-DD-<driver>-acceptance.md` for each driver run, with: date; commit and the manifest digest (`buildSourceSha256`); admission path and hash; executable path and hash; state path and hash; the run folder; `result.json` path and hash; `status` and step counts from it; `pageErrors` and `transportFallbacks` (must be empty); `inputsUnchanged` and `sourceUnchanged` (processing and tempo) or `integrity` (layouts); every screenshot name and hash; your visual findings; and the pending gates as printed. State plainly: Windows diagnostic build only, no installer, no physical audio device, no other OS. Report a failed run as failed, with the failing step and message. Do not commit the admission, state, screenshots or executable.

## Other things that stop a run (not the admission)

Each item says how it was established. "Read in the code" means read, not run. No driver was started. Two behaviours were also exercised directly outside the drivers; those are marked.

1. **`public/` missing.** Read in the code at `tests/desktop/backing-tempo-fixture.mjs:20-24` and `tests/desktop/score-layout-fixture.mjs:23-26`: `sourceManifest()` walks `public` with no existence check. Exercised: calling both functions in this worktree, which has no `public/`, threw `ENOENT ... public`. Prepare, run and the end-of-run integrity check all call it. In the main checkout, where `npm run predev` has run, `public/` exists.
2. **Resource junctions.** Read in the code at `tests/desktop/backing-processing-fixture.mjs:29` (a directory entry that is not a directory must be a regular file, else `Resource links are not admitted`). Exercised: on this Windows machine `fs.readdirSync(..., {withFileTypes:true})` reports a junction with `isDirectory() false`, `isFile() false`, `isSymbolicLink() true`, so that assertion would fail on a junction under `dist` or `src-tauri/resources`. The score-layout fixture refuses links inside its inventories at `tests/desktop/score-layout-fixture.mjs:20-21` but resolves the runtime `audioLink` to its target at line 44, so only that one entry may be a link. A linked worktree that points resources at a shared checkout therefore fails the processing check. `tests/desktop/string-count-build.mjs:24-26` dereferences for this reason.
3. **Edits since the drivers last ran.** From `git log`, not from the code: the tempo and processing drivers were accepted on Windows on 2026-10-16 at the sources their notes name (`447d2a9` for tempo, `be9e61a` for processing). Since then `1b9c0ba` (2026-10-31, "redesign the app shell and transport") changed the tempo and processing drivers, `54a72e7` changed the processing driver's library-dialog selector, and `d57d936` (2026-10-24) changed the score-layout driver. The score-layout driver has never been run to its visual gate (`2026-10-16-gp8-score-layout-integration.md` leaves the actual-ink batch open). The self-tests pass in the sweep; whether the drivers still find the controls in the redesigned shell is not known, because they have not been run since. A first run may fail on a selector and need a driver fix, which means a new freeze, build and admission.
4. **Score layouts allow one initial capture, ever.** Read in the code at `tests/desktop/parity-score-layouts.mjs:15` (the marker path `.analysis/desktop-smoke/score-layout-initial-runtime.json`), `:18` and `:605` (a run refuses to start while it exists: `Initial capture allowance is already reserved/consumed`) and `:585` (it is created just before the first screenshot). The confirmation is limited the same way: `:44` (`Second confirmation is forbidden`) and `:609` (the marker `score-layout-confirmation-runtime.json`). Check for these files in the checkout you run from before you spend the build. The plan (`2026-10-16-gp8-score-layout-desktop-acceptance.md`) says never to delete or reset them.
5. **Driver edits invalidate the admission.** Read in the code at `tests/desktop/backing-tempo-fixture.mjs:23` and `tests/desktop/score-layout-fixture.mjs:25`: `tests/desktop` and `scripts` are in the manifest, so fixing a driver after the build means rebuilding and writing a new admission.
6. **Platform and port.** Read in the code: Windows only, at `parity-backing-tempo.mjs:144`, `parity-backing-processing.mjs:199` and `parity-score-layouts.mjs:604`, and the same lines require the working directory to be the checkout root; port 9223 must be free, checked at `parity-backing-tempo.mjs:38`, `parity-backing-processing.mjs:50` and `parity-score-layouts.mjs:235`. The drivers launch the diagnostic executable themselves and check its path and start time; do not start the app by hand.

None of these is a reason to fabricate or weaken an admission.
