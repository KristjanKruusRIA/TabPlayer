# Live score page geometry

2026-10-16. Accepted source `2b9e17e1212e3f5a86fcfae1285ddc3a5df0fab3`. This is the geometry slice of the score-layout architecture; no interactive page UI or D01/D02 completion is claimed.

The new `src/engraving/screen-pages.ts` packs complete supplied SVG/system envelopes into validated physical sheets, keeps original renderer offsets/bounds, arranges columns/rows/grids, maps rectangles and inverse musical hits, and computes truthful limited fit percentages. It uses the existing page validation but subtracts only real margins for live capacity, without the PDF title/footer reservation. Original public objects and SVG strings remain unchanged.

Source SHA-256: `43FEE7EBA7783F92A218C72DE344A094021E3BD908ED185BEE23375662E99E80`. Test SHA-256: `627EA3B28E3A4F418996CDFADF39B1A000952BE7C791FEA0020EB25116CC9F85`. Interfaces are recorded in the Task1 block of `docs/superpowers/plans/2026-10-16-gp8-screen-page-geometry.md` and the released producer report.

## Verification

Both producer and root ran `npx vitest run src/engraving/screen-pages.test.ts --maxWorkers=2 --reporter=dot`:49 tests passed in one file, exit0. Both typechecks passed with `npm run typecheck`. Root checked the released hashes before committing. No Cargo, desktop build, app, audio or whole-suite check was needed for this module.

The actual installed public SVG renderer fixture contains24bars, two tracks, three staves, two distinct-pitch voices per staff and576noteheads. Its authored systems are `[2,3,1,2,2,2,2,2,2,2,2,2]`, with a repeat and real leading/trailing content. It produces12systems,14chunks and four pages at base scale1.13 on A4 portrait with15mm margins. Different spacing explains its different page count from the earlier throwaway probe; no ignored probe data is imported.

Tests perform8,640 strict rendered note/beat and independently paired source-object checks across25%,137.5%,300%, vertical/horizontal arrangements and1/2/3column grids. They check240blank-margin/gap points, literal page/fit arithmetic, raw content height without64px export reservation, preserved11.3px top-padding envelope extension, original SVG offset, zero-width cursor rectangles, final half-open edges, coincident voices/current-lane preference, rests and empty beats. Source models, finished bounds and chunks remain unchanged. Duplicate/missing/ambiguous chunks and oversized leading/system/trailing blocks reject instead of producing false pages.

The initial missing-module RED establishes test-first ordering only. Later meaningful failures demonstrated the fractional final-bottom boundary bug and accepted duplicate non-system geometry/repeated system bars; targeted fixes made those tests pass. All earlier receipts remain retained. The final scoped source has no observed unresolved test failure.

Fresh independent review accepted the frozen two-file patch without actionable findings; report `.analysis/parity/screen-page-geometry-independent-review.md`, SHA-256 `6B0C96CF692DDDDBF191B6FEF5FA325BFD2DE09C00483F0D2A4F6696AE8C8DC1`. It verified release hashes and audited actual-object oracles/receipts without rerunning checks.

Producer report `.superpowers/sdd/2026-10-16-gp8-screen-page-geometry/task-1-report.md`: `AC4893CE6A805A9A5EB0373E0723868B89A8B2E40B9BCE9136B669C954183263`. Root focused log `task-2-root-focused.log`: `5CDA38D3059403E045D1D8C3B90B1D5E1776A3A5A7D07AD2C10929BCCB79DED7`; root type log `task-2-root-typecheck.log`: `EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6`.

## Limits

The collector must deliver every chunk in the current generation; bounds cannot reveal an unassociated title/footer omitted upstream. Callers must pair this module's pagination/arrangement, gate active generations, canonicalize live projection objects, and apply host padding/border/scroll offsets once. Linear scans have no broad large-score performance claim.

Node renderer bounds do not establish complete glyph ink or browser font/overflow fidelity. Actual paper/cursor/scroll/highlight lifecycle, selection gestures, toolbar/fit resizing, native paused positions, real session persistence, representative-score performance and desktop observation remain integration gates. No physical audio, original GP8 runtime, platform/shipping or full parity claim follows. The parity overlay and released main remain unchanged.
