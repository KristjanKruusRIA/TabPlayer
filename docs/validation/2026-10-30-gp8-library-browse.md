# GP8 parity L01: browse and filter the Library (2026-10-30)

GP8 browses and filters a catalog without leaving the open score. TabPlayer's Library could search folders by text. This slice adds field filters. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-library-browse-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build. The row is partial: see Limits.

## Behavior
- **Filters:** Title, Artist and Instrument fields sit beside Search, scope and Sort, with a Clear filters button.
- **Matching:** all words must appear, in any order. Matching ignores case and common Latin diacritics.
- **Title:** matches what the list shows, including the file name for a score with no title.
- **Combining:** filters work with search, folder scope, sort and paging, and totals count only matches.
- **Open score:** opening a result adds a tab, and the open score, its edits and its playback are unchanged.

## Evidence
- **Rust:** 848 tests passed on the merged branch, none failed.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout. The rest of the suite passed 3,753 of 3,754 with 1 skipped in a clean rerun. One earlier run failed `musicxml-tempo-offsets.test.ts`, a comparison of two zips that appears to depend on the clock; it passed alone.
- **Speed:** a release test searched 50,000 rows with text and all three filters in 390 ms, and asserts under 2 seconds.
- **Desktop:** `tests/desktop/parity-library-browse.mjs` passed on a Windows desktop-test build of the merged source. It filtered real folders and opened a result from both a dirty score and a finalized score, each left unchanged. `parity-document-tabs.mjs` also passed on the same build.

## Review
- **Code review:** an Opus review ran on the slice.
- **Findings and fixes:**
  - **High, fixed:** a score with an empty title could not be filtered or sorted by the name shown.
  - **Medium, fixed:** typed and stored Unicode forms did not match.
  - **Medium, fixed:** the driver never proved a dirty score stayed unchanged.
  - **Medium, fixed:** searches cloned every row.
  - **Medium, fixed:** the filter row did not wrap.
  - **Low, fixed:** the empty state, focus after Clear, and a stale search error.
- **Desktop run:** every failure was in test code. The driver expected one document at launch, the folder picker never took the foreground, and a catalog path carried a `\\?\` prefix. A Rust test also needed the new query fields, and optional filters now stay out of the serialized query. `parity-document-tabs.mjs` was stale in three places.

## Limits
- **Why partial:**
  - no connected online catalogs;
  - no genre, because the index holds no genre field;
  - Instrument matches track names, not instrument types.
- **Diacritics:** the folding table covers Latin letters. Other scripts match by lowercase only.
- **Unindexed scores:** a score without indexed metadata never matches an Artist or Instrument filter.
