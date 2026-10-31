# Pitched trill sounding-transposition validation

2026-10-16. Root accepts the bounded source and serialized-artifact evidence at `3c51510f85be0c1c4446a8ea36f1a0cdc00d31d8`, based on `3a2a88fbf17f10785572fb7fec207ba04ca4dfd9`. Final document/artifact review and delivery remain pending at this checkpoint. Overall GP8 parity remains open.

## Behavior and scope

A non-stringed pitched trill now applies the same staff sounding transposition to its main and alternate pitches. Written 60/62 with offset +12 produces 48/50; offset -12 produces 72/74. Canonical written music and display transposition remain unchanged. The existing detached GP preparation normalizes both values once and zeroes the detached sounding offset; MIDI/plan preparation reuses it before the incumbent negative-duration tremolo correction.

Production changes are confined to `preparePitchedGpScore` in `src/interchange/pitched.ts` and the call/import in `prepareMidiScore` in `src/audio/plan.ts`. Existing signatures/callers, native DSP, transport, UI, dependencies, schema and IPC are unchanged. Stringed and percussion staves retain their existing pitch domains. The supported normalization domain is MIDI 0–127; no new general out-of-range/clamping policy is claimed.

Design: `docs/superpowers/specs/2026-10-16-gp8-pitched-trills-design.md`, SHA-256 `F1A7958C2AE9946DA91D3300085DBA23ACF0D2F9D4570FF0F23626F76AA22CBB`. The matching three-task plan is `docs/superpowers/plans/2026-10-16-gp8-pitched-trills.md`. Root retains exact source/check bindings in `.superpowers/sdd/2026-10-16-gp8-pitched-trills/task-3-verification-root.json`, SHA-256 `B061A1D39B681E9C88F456B4ECB4994AB9A45772FF078005FC21AC09B9A2899D`.

## Source, regression oracle and focused checks

The new `src/interchange/pitched-trill-oracle.test.ts` authors a one-bar whole-note trill at 120 BPM, with independent dynamics 3 and Sixteenth attacks. It decodes actual exported SMF bytes without alphaTab's reader/generator, checks direct and JSON playback-plan routes against literal events, and independently inspects GPIF XML before supplementary reimport.

| Sounding offset | Literal alternating MIDI keys | Serialized GPIF main / Trill |
|---|---|---|
| +12 | 48, 50 | 48 / 50 |
| -12 | 72, 74 | 72 / 74 |
| 0 | 60, 62 | 60 / 62 |

Each case has 16 attacks at ticks 0,240,...,3600, velocity 63, matching releases at 240,480,...,3840, PPQ 960 and end tick 3840. Both plan routes also assert the authored source address. A valid low-boundary 0/2 pair, display offset +7, independent mixed pitched offsets and a trill chord with a real ordinary neighbor are covered. Exact event equality excludes leaked carrier attacks; the neighbor keeps its whole-note duration and independent velocity 111.

Canonical JSON, note IDs/dynamics/pitches/offsets and captured relationships remain exact across the routes. Focused incumbent tests retain stringed/percussion, ordinary pitch/display, source backing bytes, archive siblings and tie/slur coverage. Both preparers are idempotent, including cross-preparation identity. The combined pitched/negative-duration tremolo fixture preserves IDs, dynamics and bidirectional ties while retaining its existing 7680-tick host / 11520-tick plan behavior. The harmony regression retains written 61/63 and emits alternating 49/51, followed by its three unchanged 48 notes.

Producer report `.analysis/parity/pitched-trills-producer-report.md` hashes to `0FC41B957C2933F51FEDF4E4507B6A719368E9DBCEEEBAEC609C049112D112BC`. The producer recorded meaningful RED before production or historical-expectation edits: five failures/one neutral pass, with alternate 62 instead of 50/74 while base/tick/velocity match. Log `producer-red-confirmed.log` hashes to `014963582EFC7E1BA500F90CC67E88DF979A3A750B121FBA513981D781C060A1`. This isolates the original defect and serves as the negative control; no additional mutation framework was needed.

Initial fixture mistakes and two harmony-expectation attempts remain preserved in that report and distinct logs. They are not relabeled product failures. Final producer GREEN passes 122 tests across six files, log `51D0A6E9B4FC2298397D07A108E036A8921D2026DF27D316EA3CC54A892B114B`; typecheck exits zero.

Independent source/oracle review `.analysis/parity/pitched-trills-independent-review.md`, SHA-256 `FE5817751F0D89AA7EDB14143D1E072C8EDE006C5BC0FD848D21C46DE62D8072`, approves spec compliance and quality without actionable findings. It verifies the two-function composition, lane-carrier ordering, clone/dynamics/link paths, idempotence, literal oracle and all six release hashes. Installed alphaTab's `isTrill` checks `trillValue >= 0`; assigning against `undefined` therefore preserves an alternate of zero. This is a source-contract check, distinct from the explicit 0/2 artifact fixture.

Root then ran at the joined source:

```text
npx vitest run src/interchange/pitched-trill-oracle.test.ts src/interchange/pitched.test.ts src/audio/plan.test.ts src/export/midi.test.ts src/harmony/transpose.test.ts src/interchange/gp.test.ts --maxWorkers=2 --reporter=dot
npm run typecheck
```

The focused command explicitly set `TABPLAYER_PITCHED_TRILL_ARTIFACT_DIR` to this worktree's `.analysis/parity`, then restored the previous environment value. Default tests write no artifacts; the opt-in uses exclusive creation for the four requested names. Root result: **122 passed, six files, exit 0**; typecheck **exit 0**. Logs under the plan's SDD directory are `root-focused-artifacts.log` (`BB34477583B214108DB4A2D8E311E3E8D1A401C82C393A2F20E1779781399BF5`) and `root-typecheck.log` (`EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6`). All six source/test hashes still match the reviewed release; no post-check source delta is present.

The incumbent unsupported-input throw assertion logs alphaTab's `EndOfReaderError`; existing 100-bar timing and Vitest worker advice also remain. Output is not described as pristine. These retained diagnostics do not represent a new failing test, and unrelated test cleanup is outside scope.

## Independently inspected retained artifacts

Root retained actual bytes from the asserted oracle outputs using exclusive creation:

| Authored artifact under `.analysis/parity/` | SHA-256 |
|---|---|
| `pitched-trills-plus12.mid` | `FC62F256AB9E159EE8BDF51C43F35F65956A4796D5E53A3DC86FC118CCCA2BB3` |
| `pitched-trills-plus12.gp` | `CCC3FEEA1A1374F4B6128C7BB87926B205BE5FABA4D242CFFC1BD3EF6EED70AC` |
| `pitched-trills-minus12.mid` | `2A989E636CA0C44BA7AC81D5A485BD0A7790F39C3436B8924EDB73DB314555E0` |
| `pitched-trills-minus12.gp` | `BF5B57815C3CDB588C764EE4785966C396F425110A2834EC1118CF0DB3C7D912` |

A separate read-only Python standard-library SMF/ZIP/XML parser imports no product code. Command: `python .analysis/parity/pitched-trills-artifacts-inspect-root.py ABSOLUTE_ARTIFACT_DIRECTORY`. Parser SHA-256 `1262F8C36D94834F75273FE6A301243CD66A3D501943E8D027C27EC74C7DCF70`; retained result `root-artifact-inspection.json` under the plan's SDD directory hashes to `5350757CC046F306B7BD4957B2F16276A7E9155F251E3CB678ACEF7E5194DBE8`.

Inspection exits zero and independently confirms both files have format-1 SMF, two tracks, PPQ 960, the exact 16 literal attacks/releases and both end ticks 3840. GPIF contains one real note, main pitch 48/72, exact Trill 50/74 and matching beat-to-note references. This establishes authored serialized outputs rather than relying on importer roundtrip agreement.

## Limits and parity assessment

This closes the specific transposed non-stringed trill interval defect in the declared valid domain. The JSON-plan function is tested; an actual worker transport or desktop audio callback was not exercised by this slice. No physical audio/listening, original GP8 runtime/import, arbitrary-score fidelity, other-platform, installer or shipping equivalence is established. No application/GUI/GenAI image is needed for this non-UI correction.

No unrelated whole frontend/native suite, Cargo, desktop build or predecessor acceptance was rerun. Prior 2647/617 results are not substituted for this source's focused evidence. Broad sounding-transposition partials and the other interchange-family losses remain open; this plan makes no parity-overlay promotion. P16/P17/P18 visual ceilings remain exhausted. Delivery and any current-head CI observation are separate root-owned gates.