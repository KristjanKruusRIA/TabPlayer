# GP8 stylesheet interchange validation

Date: 2026-10-15. Branch `feat/gp8-parity`; released `main` remains `7fc41c7`. This records the bounded common/cut-time stylesheet delivery against the accepted stylesheet specification and plan. Earlier validation records and parity inventory counts remain historical evidence.

Product revision: `b73ae93682332c64029777cc4dfeaebfe2a77214`, committed and remote-verified on `feat/gp8-parity`.

## Delivered behavior

GP import applies the current `Content/Stylesheets/score.gpss` common/cut setting to eligible 4/4 and 2/2 measures. A present empty optional-boolean wrapper means false; an absent option remains inherited/unknown. A current member takes precedence over legacy styling, including when its option is absent. Legacy-only files use `Staff/drawTimeSignatureC`. Other meters retain their numeric signatures.

Unchanged imports preserve opaque stylesheet/view members. Explicit authoring, including setting an already-false value, records intent only after complete command validation. Detached provenance survives replay, aligned clones, excerpts and contextual structural edits without changing native project schemas. Export evaluates the final selected projection after archive/GPIF merging. Uniform known intent can be written; mixed, unresolved inherited or conflicting recognized view choices reject before writing. Source-free scores update generated legacy styling without inventing current GPSS members. Export help states these limits.

## Automated verification and review

Initial integration tests demonstrated 12 failures before the hooks were added. The final focused integration suite passed **216 tests in 8 files**, including 24 new replay/integration cases. It checks public precedence, equal-false native replay, Undo/Redo, clipboard and structural ownership, source-free output, writer atomicity/recovery and both XML/non-XML paths. Source bytes, unaffected archive siblings, MIDI, clocks, raw lyrics, chord/tie links and detached backing are checked where applicable. Pure codec/provenance reviews and the independent Task 4 integration review accepted their bounded scopes.

The joined final run passed **1,572 frontend tests in 115 files**, with one existing opt-in benchmark skipped; TypeScript and ten Node resource tests passed. Rust formatting and the joined native suite passed **234 tests with six explicit ignores**. Evidence is in `.analysis/parity/selection-stylesheet-full-frontend-final.{json,log}` and `selection-joined-rust.log`. An initial full-run failure used truncated active legacy bytes in an old projection fixture. Replacing them with a valid empty four-byte record count retained its sibling-preservation assertions; 31 focused cases and the full rerun then passed. Production validation was not relaxed.

The independent joined source review accepted the implementation with no actionable findings: `.analysis/parity/selection-stylesheet-final-review.md`. The separate final script review also accepted the exact acceptance hashes below, including the native combobox locator correction: `.analysis/parity/stylesheet-desktop-script-review.md`.

## Windows desktop acceptance

The Rust 1.88 diagnostic build completed. Root executed `tests/desktop/parity-stylesheet.mjs` against actual native imports, save/restart and exports. The final receipt is `.analysis/desktop-smoke/style-1792061117306-result.json`: **19 actual exports, nine expected rejection/recovery cases, 16 screenshots and no page errors**.

Both direct and dialog paths exported/reopened current true/false choices. Native save, full process restart, Undo/Redo and explicit equal-false replay passed. Mixed, inherited and conflicting/malformed view changes produced actionable errors; absent outputs stayed absent and existing sentinel destinations stayed byte exact. Subsequent valid exports succeeded. Untouched conflicting view data remained preserved. Root subsequently inspected all 16 images, confirming common C, cut C, numeric 4/4, 2/2 and 3/4, reopened results and errors; the receipt's scripted visual-pending field predates that inspection. No layout correction was needed.

Read-only retained-probe verification passed for both original common-time probes, preserving 14 members and MIDI identity. Original `GPCore.dll`/`GPIO.dll` hashes matched the retained record in `.analysis/parity/stylesheet-retained-probes.json`. No original GP8 program was executed.

Final diagnostic SHA-256: `f508e3215074639be81a7fa52bf68af052525d3853dfa6e1b76e735b0d5c07c7`.

| Acceptance source | SHA-256 |
| --- | --- |
| `tests/desktop/parity-stylesheet.mjs` | `ea7ebd9be74df1c5bae9afafda5e53e8e82bca4cc291a63b23d3a0cfc4b25073` |
| `tests/desktop/stylesheet-fixture.mjs` | `854d4c950c0859c572d29f41af6773c5e892db050a942212649e42f7cac0acf6` |

## Remaining scope

This does not prove external inherited defaults, complete score/view relationships, mixed per-measure GP representation or original GP8 runtime equivalence. The public outer loader may reject malformed inactive legacy styles. New-head CI, installers, a new `main` release and physical macOS/Linux acceptance remain separate work. Selection playback has its own validation record; this batch does not establish complete GP8 parity or change inventory counts.
