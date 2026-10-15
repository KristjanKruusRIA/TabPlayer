# GP8 selection playback validation

Date: 2026-10-15. Branch `feat/gp8-parity`; released `main` remains `7fc41c7`. This records the accepted cursor/selection playback delivery against its specification and plan, without changing the historical parity inventory.

## Delivered behavior

Canonical cursor and musical-selection coordinates resolve against the actual performed route. Repeated passages require an explicit occurrence; selecting alone sends no playback command. Fresh Play can start at the cursor, Play selection performs one finite full-mix passage, and Loop selection arms the exact interval without autoplay. Resume, acknowledged-loop and explicit measure-Seek intent retain their existing precedence. Native acknowledgement supplies the displayed range and complete clock.

The native callback owns finite half-open playback, count-in and completion. It excludes attacks, MIDI changes and clicks at the exclusive endpoint, ends once without incrementing loop passes, and retains the completed span for replay. Null-end cursor starts retain ordinary EOF, including a longer backing tail. Pause and healthy device recreation preserve the span; Seek, Stop and generation replacement retire it as specified. These are transient transport contracts, with no project schema or dependency change.

## Automated evidence and review corrections

The joined final run passed **1,572 frontend tests in 115 files**, one existing opt-in benchmark skipped, TypeScript and ten Node tests. Rust formatting and the joined suite passed **234 tests with six explicit ignores**. Logs are `.analysis/parity/selection-stylesheet-full-frontend-final.{json,log}` and `selection-joined-rust.log`.

Meaningful RED/GREEN cases cover map emission, rests/ties/grace, route coverage, ambiguity, stale choices, no-autoplay controls, explicit Seek and native atomic transitions. Scoped independent reviews accepted the mapper, resolver/controls, controller/plan, native and corrected UI joins. Review found a repeated identical Seek rejection could leave failed position intent active. A regression reproduced it; retiring the preceding operation error before a valid attempt fixed the transition without optimistically changing native state. Another review found an allocation test issued Replay before Ended. Its corrected buffer and explicit Ended assertion now exercise replay inside the uninterrupted zero-allocation guard. Both corrections received fresh scoped acceptance.

Native logical tests cover exact/fractional ceilings, same-tick program/CC/bend/metronome exclusion, tiny intervals, held-state reconstruction, queue/stale-generation rejection, snapshots/fault recovery and exact frame budgets at **44.1/48 kHz**. These are logical rates, separate from physical-device acceptance. The independent joined source verdict is ACCEPT in `.analysis/parity/selection-stylesheet-final-review.md`. The separate final script review accepted the exact hashes below, including native combobox locators and validated extensible float-WAV parsing: `.analysis/parity/selection-desktop-script-review.md`.

Seventeen authorized private plans regenerated successfully: **94,629 notes**, original files byte exact and public attack/program agreement. The explicitly invoked ignored Rust corpus test passed. Local receipts are `selection-private-audio-plan-report.json` and `selection-native-private-corpus.log`; private scores are not shipping fixtures.

The 100-bar/four-track benchmark produced 1,600 map rows / **209,621 JSON bytes**. Three preparation samples were 100.91–111.83 ms without the map and 95.32–99.02 ms with it: no measured regression, not a speedup claim from this noisy sample. Average cursor/passage query costs were 1.485/0.815 ms across 100 queries. `.analysis/parity/selection-map-benchmark.json` records the method; no speculative cache was added.

## Actual Windows acceptance

Root executed `tests/desktop/parity-selection-playback.mjs` on the rebuilt diagnostic app. The final receipt is `.analysis/desktop-smoke/selection-1792061283534-41596-result.json`, summarized in `.analysis/parity/selection-native-accepted-summary.json`: **21 grouped checks, five three-second float32 output-loopback WAV captures, actual 48 kHz, no page errors**.

The authored repeated route checks `[960,2880)` and occurrence-two `[8640,10560)`. A key-85 sentinel at the exclusive endpoint has positive-control amplitude 0.04165025 versus bounded maximum 0.000844508: ratio **0.020276**, below the 0.1 tolerance. Finite output becomes silent; partial loops remain audible. A 12-second backing against an eight-second score cuts with finite playback and continues past score EOF with null-end playback. Driver buffering makes these complementary physical checks, not exact sample-boundary proofs.

Actual pointer input at 115% zoom/all-track projection and Shift selection passed, alongside count/fixed/progressive practice, paused healthy-device reselect, history/presentation/generation transitions, source preservation and native save/full restart. Root inspected all four screenshots at 960/1280/1600px plus complete simile selection; physical guitar artwork remains intact. Earlier harness getter/pitch/combobox/WAVEEX corrections were test repairs. A closed-app loopback baseline contained unrelated audio (RMS 0.12394); after the user paused it, the final run passed. No listening-quality approval is inferred.

Diagnostic SHA-256: `f508e3215074639be81a7fa52bf68af052525d3853dfa6e1b76e735b0d5c07c7`.

| Acceptance source | SHA-256 |
| --- | --- |
| `tests/desktop/parity-selection-playback.mjs` | `04fd54b152005b62d47319563181908005fca4ddba35561446905618cb27a4c8` |
| `tests/desktop/selection-playback-fixture.mjs` | `3a279e8556482c74f4437792cebaac09873d8a3d963b6e3857e29bb9e79ea16b` |

## Remaining scope

Physical 44.1 kHz and macOS/Linux input/audio, hidden simile subdivisions, sparse pointer toggles/drag/resize, original GP8 runtime equivalence and historical effect tails remain unproven here. New-head CI, installers, `main` release and complete GP8 parity remain separate work. Shared-device loopback requires quiet surrounding output; all retained evidence remains local.
