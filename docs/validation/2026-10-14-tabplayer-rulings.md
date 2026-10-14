# TabPlayer execution rulings — 2026-10-14

These decisions record approved-milestone tradeoffs, cases the independent reviewer set aside, and native verification findings. Costs are stated explicitly.

## Rulings

- Task 1: Ruling: create main.rs with the Tauri runtime in Task 3, rather than an empty binary in Task 1 — the standalone core is a library and has no GUI yet — cost if wrong: the desktop entry point is delayed until its integration task.
- Task 3: Ruling: bundle official alphaTab workers/fonts/SoundFont with a local asset copy script instead of its Vite helper — the published 1.8.4 Vite entry imports an absent dist/vite/alphaTab.vite.mjs module — cost if wrong: asset paths need maintenance and packaged regression checks.
- Task 4: Ruling: track name/instrument are chosen when adding a track; existing tracks support retuning — the approved finite command protocol has no rename or instrument-change command and the spec requires adding/configuring tracks — cost if wrong: users need a later command to rename or change existing instruments.
- Task 5: Ruling: use the public playerReady event without subscribing to cached midiLoaded — alphaTab 1.8.4 ships a recursive loadedMidiInfo getter that crashes registration; native launch reproduced it and a regression test now covers the boundary — cost if wrong: readiness after MIDI refresh needs runtime regression checks. Vendor bytes remain unmodified. Primary upstream issue: https://github.com/CoderLine/alphaTab/issues/2699
- Final: Ruling: macOS/Linux packaged builds and audio remain pending — Windows is the available verified host and the approved plan permits explicitly pending platforms — cost if wrong: platform-specific build/audio defects may remain undiscovered.
- Final: Ruling: actual Guitar Pro acceptance of exported files remains pending — the runtime is unavailable; supported-field model reimport is the evidence delivered — cost if wrong: exports may fail or differ in Guitar Pro even when alphaTab reimports them.
- Final: Ruling: installer installation/uninstallation and signing remain pending — the deliverable is an unsigned built Windows package plus a verified standalone app — cost if wrong: installer lifecycle issues or Windows trust prompts may obstruct installation.
- Final: Ruling: advanced-technique creation, detailed voice layouts, backing audio, RSE parity and PDF/MIDI/audio export remain deferred — the authorized first milestone is the basic player/editor — cost if wrong: this milestone does not satisfy workflows needing full Guitar Pro parity.
- Final: Ruling: existing-track rename/instrument changes stay deferred under Task 4 — the user gets initial name/program selection and later retuning — cost if wrong: changing an existing instrument still needs a later command.
- Final: Ruling: delayed native entry point, manual alphaTab asset copying and playerReady remain as the accepted Task 1/3/5 rulings — evidence supports the working desktop entry, packaged assets and readiness behavior — cost if wrong: integration timing, asset paths and MIDI readiness need maintenance as described in those rulings.
- Final: Ruling: changing either end of an imported tie updates the entire tied note — a tie represents one sustained pitch, and destination-only changes are silently reverted by alphaTab — cost if wrong: editing one segment independently requires a later break-tie command.
- Final: Ruling: render notation synchronously while retaining worker audio — native rapid-deletion testing reproduced alphaTab 1.8.4 rebuilding stale worker bounds against the replacement score, which throws and can break hit testing — cost if wrong: large-score rendering can block the UI; native redraw timings must be checked and worker rendering can be revisited later.

- Final: Ruling: retain the generated plan workspace after preserving its records — automatic approval review rejected recursive cleanup as blocked by policy without further detail — cost if wrong: ignored execution files remain as local clutter.

## Deferred minors

- Final: minor (deferred): fractional Measure/Beat input can produce an uncaught selection-handler error; use whole-number selections. Existing score and native project remain intact.
