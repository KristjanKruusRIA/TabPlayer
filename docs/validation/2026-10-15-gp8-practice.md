# Practice transport validation

Date: 2026-10-15. Branch `feat/gp8-parity`; released `main` remains `7fc41c7`. This is a bounded practice delivery under the full parity goal.

## Delivered behavior

Native practice supports relative speed from 10–300%, fixed 10–300 BPM across source tempo changes, and progressive coefficients with repetitions per speed. Metronome volume, silent visual pulses, zero-to-sixteen count-in bars and counts between loops use the same native audio clock. Transport displays acknowledged tempo, ratio, passes, pulse and loop state. Settings are ephemeral; edits/undo/redo retain them, and explicit New/Open resets them.

Count-in freezes score/backing position and active-note highlights. Pause/resume retains fractional progress; Stop cancels it. Loop wraps resolve the next trainer coefficient before the next count. Written meter remains explicit even for pickups, rare denominators and repeated occurrences. Fixed mode rejects effective backing audio, including muted backing; importing backing while fixed normalizes to relative speed with a visible notice. Fixed mode disables coefficient-based export; saved-speed export remains available.

Healthy device recreation preserves count phase and remaining duration; fault recovery is paused and restarts an interrupted count in full. A coherent snapshot and command barrier prevent queued settings or retired callbacks from publishing inconsistent state. Failed replacement reports a fault rather than a falsely ready silent stream.

## Verification

Final combined verification is **1,008 Vitest/85 files + 10 Node tests**, one explicit benchmark skip, typecheck; **177 Rust tests**, six explicit resource/hardware ignores, and formatting. The separately invoked private native corpus check passes all 17 regenerated plans. These totals are shared with the clipboard delivery.

Independent review covers pure clock/click/trainer arithmetic, frontend drafts/validation, acknowledged controller/wire/export behavior, renderer/callback/device integration and joined UI. The pure review adds 608 rational timing cases and 8,000 rate restorations. Native integration review passes 67 focused tests with three explicit ignores, plus five independent PCM tests covering 45 rate/tempo/count/seek/loop cases at 8/44.1/48/192 kHz. Warmed callback/render/seek/count/wrap paths retain allocation guards.

Headless PCM proves fixed loops across tempo changes, exact within-buffer count termination, progressive counts at the new coefficient, pause/seek/end transitions and backing silence until count completion. Stable-origin integer-frame advancement fixes a floating-point endpoint retrigger. Tiny positive loops consume a sample instead of hanging; idle seek retains fresh-Play count behavior. Recorded impulse onset tolerance is two samples; inherited rustysynth eight-frame blocks require an eight-sample GM bound, independently measured rather than treating block quantization as count drift.

## Windows audio acceptance

The final diagnostic binary passes `tests/desktop/parity-practice.mjs` through actual CPAL output and bounded WASAPI output-loopback capture on a 192 kHz device:

- Authored A4 remains approximately **443.4 Hz at 10%** and **444.4 Hz at 300%**, within the existing 3% physical-capture tolerance.
- Fixed 90 BPM produces four count clicks separated by exactly **128,000 captured frames**. Score audio follows the four-pulse count. Five louder guitar attacks remain spaced near two-thirds of a second across an authored 120→60 BPM change; release transients are excluded by the documented peak threshold.
- Paused count-in freezes pulse/tick; reopening the healthy output retains its state. Idle seek counts at the requested measure. Progressive loop completion enters the next count at 70% after its first 50% pass.
- Backing disables fixed mode even while muted. With silent count and score muted, an authored 880 Hz backing remains silent until count completion and captures near **884.8 Hz** at 300%.
- Practice leaves project content/dirty state and source hash unchanged. New resets defaults. The WebView emits **zero** secondary synth sample messages.

The visible practice panel and existing physical guitar artwork were inspected. Clipboard and the previous native mouse/range/measure workflow also pass on the rebuilt binary. Every diagnostic app stops after testing; diagnostic binaries and authored/private WAV/GP fixtures are not shipping assets.

Ignored receipts include `.analysis/parity/practice-audio-review.md`, `practice-clock-review`, `clipboard-practice-native.log`, `practice-native-corpus.log`, `practice-private-plan-corpus-after-tie-fix.log`, `clipboard-practice-desktop-build-final.log`, `practice-desktop-final.log`, `native-practice-result.json`, `native-practice.png` and the bounded loopback WAV/JSON files under `.analysis/desktop-smoke`.

## Remaining scope

Partial-beat loops/stepping require a performed-beat map and remain open. Export does not include live count-in or changing trainer coefficients; current progressive export freezes one coefficient. Original GP8 terminal/repetition/pickup/compound-count behavior, physical macOS/Linux audio/device recovery, offline count-in export and broader audio/engraving parity remain unverified. No production installer or new `main` release is produced by this batch.
