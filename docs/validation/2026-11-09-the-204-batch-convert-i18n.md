# Validation Report: THE-204 Batch Convert Report Details Through i18n

**Ticket:** THE-204  
**Worktree:** `the-204`  
**Branch:** `agy/the-204-batch-convert-i18n`  
**Base:** `develop` (`d855761`)

---

## 1. Scope and Objective
Address the leftover limit from THE-202 recorded in `docs/validation/2026-11-09-the-202-i18n-sweep-4.md` (Limits: "Batch convert report details"):
- In `src/batch/convert.ts`:
  - Define and export `BatchDetail` discriminated union type holding return codes plus structured parameters for each conversion outcome:
    - `{ code: 'converted'; tracks: number; bars: number; savedAs: string; renamed: boolean; losses: string[]; note?: string | null }`
    - `{ code: 'cancelled' }`
    - `{ code: 'skipped'; reason: string }`
    - `{ code: 'failed'; message: string }`
  - Update `BatchRow.detail` to hold `BatchDetail`.
  - Update `convertScoreBytes` to return `{ bytes, tracks, bars, losses, detail }` to provide structured count and loss metadata.
  - Export `formatBatchDetail(detail: BatchDetail | string, t: (key: MessageKey, params?: Record<string, string | number>) => string): string` to render details through `t(...)`.
- In `src/batch/BatchConvertDialog.tsx`:
  - Render row detail table cells via `formatBatchDetail(row.detail, t)`.
- In `src/i18n/`:
  - Add trio entries in `src/i18n/en.ts`, `src/i18n/et.ts`, and `src/i18n/de.ts`:
    - `batch.detail_cancelled`
    - `batch.detail_saved_as`
    - `batch.detail_name_taken`
    - `batch.detail_losses`
    - `batch.detail_losses_more`
    - `batch.track_count_one`
    - `batch.track_count_other`
    - `batch.bar_count_one`
    - `batch.bar_count_other`
- In `src/batch/convert.test.ts`:
  - Move `runBatch` assertions to inspect structured `BatchDetail` codes and arguments.
  - Add test suite covering `formatBatchDetail` in `en`, `et`, and `de` across single/plural counts, curve losses (<=3 and >3), renamed files, notes, cancellations, skips, and failures.
- In `src/batch/BatchConvertDialog.test.tsx`:
  - Add test asserting that row details update dynamically into Estonian and German when language preference changes.
- In `src/i18n/surfaces.test.tsx`:
  - Add `<td>{row.detail}</td>` to the denylist pattern for `BatchConvertDialog.tsx` to guard against rendering unformatted details.

---

## 2. Verification
- `npm run typecheck` (`tsc --noEmit`): exit 0.
- Vitest on `src/batch/`, `src/i18n/`, `src/export/gp-losses.test.ts`: 8 files passed, 228 passed, 3 skipped.
