# Acceptance on a physical Mac and a physical Linux desktop (THE-73)

**Nothing in this document has been run.** It is a checklist for a person. It was written from the tracker rows, the README, the CI workflow and earlier validation notes. Where it says what to expect, that is what the code and notes suggest, not something seen on a Mac or Linux machine. If the app does something else, record what you saw; that is the useful result.

Tracker rows served (all in `docs/validation/2026-10-15-gp8-parity-progress.md`):

| Row | What it still needs |
|---|---|
| L10 | New feature flows on each target OS with actual audio, print and device evidence. No physical macOS or platform matrix exists. |
| W14 | Reveal the current file's folder, observed on macOS and Linux. Windows is observed. |
| W13 | File association, open at launch, second launch. macOS open events and Linux associations are untested. |
| D19 | A physical printer receipt. None exists on any platform. |

Each step below names the row it serves. A step with no row is setup that the other steps rely on.

## Before you start

- You need: the packages from a CI run (below), one Mac, one Linux desktop, a working audio output on each, and a printer attached to each (D19 needs paper, not a "Print to PDF" queue).
- Test scores. Use only files you are allowed to use. The repository has `legacy-gp3.gp3`, `legacy-gp4.gp4` and `legacy-gp5.gp5` under `tests/fixtures/` once `npm test` has fetched them. For `.gp` and `.tabplayer`, make them in the app: open a `.gp5`, choose Export, format Guitar Pro (writes `.gp`), and Save (writes `.tabplayer`). For `.gpx` and `.ptb` you must supply a real file; the repository has none. If you have none, mark those steps "not tested", do not skip silently.
- Do not use private scores in anything you commit. Record file names and sizes, not contents.

### Get the packages

CI (`.github/workflows/desktop.yml`) builds unsigned packages: `app,dmg` on `macos-15` and `deb,appimage` on `ubuntu-24.04`. It keeps the large installers only when the workflow is started by hand with `upload_packages` ticked, and keeps them for one day. Either:

1. Start the "Desktop tests and unsigned packages" workflow manually with `upload_packages` on, wait for it to finish, and download `unsigned-packages-macos-15-<sha>` and `unsigned-packages-ubuntu-24.04-<sha>` the same day; or
2. Build on the machine itself (README, "Build"):

```sh
# macOS
npm ci && npm run prepare:audio
npm run tauri -- build --bundles 'app,dmg' -- --locked
# Linux
npm ci && npm run prepare:audio
npm run tauri -- build --bundles 'deb,appimage' -- --locked
```

Linux build dependencies are listed in the workflow (`libwebkit2gtk-4.1-dev`, `libasound2-dev`, `libxdo-dev` and others). Packaging needs about 20 GiB free (the workflow checks for it). A build is not the same as an install of the CI package: say which you tested.

Record the commit hash the package was built from. The About and updates topic shows the version; the commit is in the CI run or `git rev-parse HEAD`.

---

## macOS

Record first: macOS version, Mac model and chip, display, audio output device, printer make and model, package file name and its SHA-256 (`shasum -a 256 <file>`).

| # | Step | Expect | Record | Row |
|---|---|---|---|---|
| M1 | Open the `.dmg`, drag TabPlayer to Applications, eject. | The app copies. The package is unsigned and not notarized, so Gatekeeper will likely block the first open. | Whether it blocked, what the message said, and how you opened it (for example right-click, Open, or System Settings, Privacy and Security). Do not change security settings beyond what you need and say what you changed. | L10 |
| M2 | Start TabPlayer. | A window opens and shows the welcome Library or an empty score. | Time to first window; any error text. | L10 |
| M3 | Open the Help menu and choose About and updates. | Version shows. | The version string. | L10 |
| M4 | File, Open `legacy-gp5.gp5`. Repeat for `.gp3`, `.gp4`, `.gp`, `.gpx`, `.ptb`, `.tabplayer`. | Each opens as a score in a tab. `.ptb` shows a notice listing what was dropped (experimental). | Per type: opened or not, notice shown, anything wrong on screen. "Not tested" where you had no file. | L10 |
| M5 | Press Play. Let a score play to the end. Try speed 50% and a loop. | Sound from the chosen output, in time with the highlight. | Audio device, whether sound was heard, glitches (clicks, dropouts), any device error text. | L10 |
| M6 | Switch the output device in the transport (if the app offers more than one) while stopped. | Playback uses the new device. | Devices listed and result. | L10 |
| M7 | File, Export. Format "Mixed audio", file type WAV. Save, then open the file in a player. | A playable WAV of the expected length. | File size, duration, whether it sounds right. | L10 |
| M8 | Repeat M7 with MP3, OGG Vorbis, FLAC and AIFF. | Each plays. MP3 is about 256 kbit/s and OGG about 192 kbit/s (per the export notes). | Per file type: opened in which player, result. The task names WAV, MP3, OGG, MIDI and PDF; FLAC and AIFF are extra. | L10 |
| M9 | Export format MIDI. Open the `.mid` in a MIDI player. | Plays the notes and tempo. | Result. | L10 |
| M10 | Export format PDF. Open it in Preview. | Pages show notation and tab. | Page count, any clipped or missing glyphs. | L10 |
| M11 | Export format Print. | The PDF opens in the default viewer through `/usr/bin/open` (`src-tauri/src/export/print.rs`). TabPlayer does not show a print dialog itself; you print from the viewer. | What opened. | D19, L10 |
| M12 | From the viewer, print that PDF on the physical printer. Choose A4 or Letter to match the paper. | Paper comes out. | Printer, paper size, scale, whether page edges and margins are clipped, whether notation is legible. Photograph the page (do not commit it if the score is private). **This is the D19 receipt: only a page that came out of a printer counts.** | D19 |
| M13 | Open a saved score, then use "Open containing folder" (workspace toolbar). | Finder opens with the file selected (`open -R`). | Whether Finder came to the front and the file was selected. | W14 |
| M14 | With a score that has never been saved, check "Open containing folder". | It is disabled (the button needs a saved path). | Result. | W14 |
| M15 | In Finder, select a `.gp5` file, Get Info, "Open with", choose TabPlayer, "Change All". Quit TabPlayer. Double-click a `.gp5`. | TabPlayer starts and opens the file (macOS delivers an open event; code handles `RunEvent::Opened`). | Whether TabPlayer appeared in "Open with" for each of `.tabplayer`, `.gp`, `.gpx`, `.gp5`, `.gp4`, `.gp3`; whether the double-click opened the score. | W13 |
| M16 | With TabPlayer already running, double-click a different `.gp` file. | The running app opens it; no second app instance appears. | Whether a second instance started; which score got focus. | W13 |
| M17 | Open from the command line: `/Applications/TabPlayer.app/Contents/MacOS/tabplayer ~/path/score.gp5`. | The score opens once the workspace is ready. Second launch from another shell hands its file to the running app and exits. | Result of both. | W13 |
| M18 | Drag a `.gp5` from Finder onto the TabPlayer window. | The score opens in a tab. Dropping an unsupported file shows an error and no crash. Dropping more than 32 files is capped. | Result for one file, for an unsupported file, and for several files. | W13, L10 |
| M19 | Edit a score (change one note) but do not save. Quit with Cmd+Q. | The app asks before closing a changed score. | The wording of the prompt, whether Cancel keeps the app open, whether Save/Discard behave. | L10 |
| M20 | Edit again, do not save, force quit (Activity Monitor), relaunch. | A "Recover unsaved work?" prompt offers the work. | Whether recovery appeared and what it offered. | L10 |
| M21 | Quit and relaunch with the last score open. | The app starts normally. | Anything odd. | L10 |

---

## Linux

Record first: distribution and version, desktop environment and session type (X11 or Wayland), CPU, audio stack (PulseAudio, PipeWire or plain ALSA), audio output device, file manager, default PDF viewer, printer make and model and how it is attached (CUPS), package file name and SHA-256 (`sha256sum <file>`), and whether you tested the `.deb` or the AppImage.

| # | Step | Expect | Record | Row |
|---|---|---|---|---|
| X1 | `.deb`: `sudo apt install ./tabplayer_*.deb`. AppImage: `chmod +x TabPlayer*.AppImage`. | Install completes, or the AppImage is runnable. The workflow extracts the AppImage itself, so a missing FUSE on your machine would be a machine issue; note it. | Commands and errors. | L10 |
| X2 | Start TabPlayer from the menu (deb) or by running the AppImage. | A window opens. | Start-up errors printed in the terminal if started from one. | L10 |
| X3 | Help menu, About and updates. | Version shows. | The version string. | L10 |
| X4 | File, Open each type as in M4. | As M4. | Per type result. | L10 |
| X5 | Play, speed 50%, loop, as in M5. | Sound from the chosen output. | Audio stack and device, sound heard, glitches, device error text. The app uses CPAL (ALSA); on PipeWire or PulseAudio check it still finds a device. | L10 |
| X6 | Export mixed audio as WAV, MP3, OGG, FLAC, AIFF as in M7 and M8. | Each file plays. | Per file type result. | L10 |
| X7 | Export MIDI. Open in a MIDI player. | As M9. | Result. | L10 |
| X8 | Export PDF. Open in the PDF viewer. | As M10. | Page count, glyph problems. | L10 |
| X9 | Export format Print. | The PDF opens through `xdg-open`. | Which viewer opened; if nothing opened, the error text. | D19, L10 |
| X10 | Print that PDF from the viewer to the physical printer. | Paper comes out. | As M12. **This is the D19 receipt for Linux.** | D19 |
| X11 | Open a saved score, use "Open containing folder". | The file manager opens on the containing folder through `xdg-open` (`src-tauri/src/reveal.rs`). It opens the folder; the code does not select the file on Linux. | Which file manager opened, whether the folder was right, whether the file was selected. | W14 |
| X12 | Unsaved score: check "Open containing folder". | Disabled. | Result. | W14 |
| X13 | `.deb` only: after install, check the association: `xdg-mime query default application/x-tabplayer` and in the file manager right-click a `.gp5`, "Open With". Double-click a `.gp5` with TabPlayer closed. | Unknown. The Linux association path was never tested (tracker W13). AppImage does not register associations by itself unless an integration tool does. | Output of the query, whether TabPlayer is offered for each of the six extensions, whether double-click opened it. | W13 |
| X14 | With TabPlayer open, double-click another `.gp` file (or run `tabplayer other.gp` from a shell). | The running app opens it, no second instance. | Result. | W13 |
| X15 | Run `tabplayer score.gp5` from a shell with the app closed. | The score opens once ready. | Result. | W13 |
| X16 | Drag a `.gp5` from the file manager onto the window; then an unsupported file; then several files. | As M18. | Result for each, and whether X11 or Wayland. Drag-and-drop between a file manager and a WebKitGTK window can differ by session, so note the session. | W13, L10 |
| X17 | Edit a score, do not save, close the window. | The app asks before closing a changed score. | Wording and Cancel/Save/Discard behaviour. | L10 |
| X18 | Edit, do not save, kill the process, relaunch. | Recovery prompt. | What appeared. | L10 |
| X19 | `.deb` only: `sudo apt remove tabplayer`. | Removed. | Result; whether app data in your home folder remains. | L10 |

---

## What counts as done

- D19: at least one printed page per OS, from a physical printer, with the printer recorded.
- W14: the reveal step observed on each OS.
- W13: association, open at launch, second launch and drop observed on each OS, including a clear "does not work" where it does not.
- L10: the open, play, export and print steps recorded with the audio device for each OS.

A step that fails is a result. Record it, with the exact message, and do not retry until it passes without writing down the first outcome. If you could not run a step, write "not run" and why.

## Results template

Copy this into `docs/validation/YYYY-MM-DD-physical-macos.md` or `...-physical-linux.md`, one file per OS. Fill every row; use `not run` with a reason, never leave blank. State the limits at the end.

```markdown
# Physical <macOS|Linux> acceptance (YYYY-MM-DD)

Tester: <name or initials>
Commit built from: <hash>
Package: <file name>, SHA-256 <hash>, source: <CI run id or local build>
Machine: <model, CPU>
OS: <name and version>, session: <X11|Wayland|n/a>
Audio: <stack> / <output device>
Printer: <make and model, connection>
Display: <size and scaling>

| Step | Row | Result (pass / fail / not run) | What was seen | Evidence (file or photo name, not committed if private) |
|---|---|---|---|---|
| 1 | L10 | | | |
| ... | | | | |

## Per-row summary

| Row | Observed on this OS | Not observed |
|---|---|---|
| L10 | | |
| W14 | | |
| W13 | | |
| D19 | | |

## Limits
- <what was not tested, for example no .gpx or .ptb file available>
- <anything that differs from the expectations in docs/acceptance/physical-macos-linux.md>
```

Do not change tracker rows from this document. Rows change only after the recorded results are reviewed.
