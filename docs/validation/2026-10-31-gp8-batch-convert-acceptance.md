# F08 batch convert acceptance

Measurements and the full method are in `2026-10-30-gp8-batch-convert.md`.

## Behavior

A folder of older scores converts to the current GP format with a per-file report. Originals are never changed, nothing in the destination is replaced silently, a broken file fails alone, and Escape cancels between files. Every Open and restored project now reads its base in a Worker under a 15 s deadline, and a base no Worker read is refused.

## Evidence

- Merged at b67b6f0: `tsc` clean; `App.test.tsx` 143 of 143; other Vitest files 4163 passed, 2 skipped; 948 Rust tests passed, plus 28 in `batch_convert`.
- Desktop driver `parity-batch-convert` passed in the real app: all five steps. It had never run before; its first runs failed on two driver faults (a path pattern that missed Windows separators, and report columns read off by one), not on the product.

## Review

Security review rejected several rounds, then approved f6249f1. Five scan tests each fail on the old code: 9.0, 23.1, 16.0, 66.2 and 18.0 s. Two were widened afterwards because they carried DOM parsing and failed on correct code under parallel load.

## Limits

- The Unix code path has never been compiled or run. CI could not start on this branch because of a GitHub billing block, and the user chose to continue without it (2026-10-31).
- Overlays run on the window outside the deadline. Their loops were fixed as found, not audited, so a crafted local file may hold the window for an unmeasured time.
- A score that takes the Worker over 15 s no longer opens, and Open now parses twice.
- The deadline is not a memory bound. CRCs are not checked.
- A document that misses the deadline during restore leaves the session, and no UI restores its evidence copy. Reload is all or nothing.
