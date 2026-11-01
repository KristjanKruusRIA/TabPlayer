# Library Search Speed Over 50,000 Rows

## Behavior

`LibraryIndex::search` evaluates multi-field text queries, filters, and paging across up to 50,000 indexed rows.

Search was previously taking 1.96 s to 2.05 s in debug builds on 50,000 rows (at the threshold of the 2.0 s test limit in `a_page_search_over_fifty_thousand_rows_stays_fast`), intermittently failing under system load.

### Bottleneck Identification & Measurement

Direct timing breakdown of `search()` on 50,000 rows prior to optimization:
- `dedup`: 72.3 ms (3.5%)
- `filter_map`: 1,905.2 ms (93.1%)
- `sort`: 68.3 ms (3.3%)
- **Total elapsed**: 2,047.4 ms (> 2.0 s failure)

Root causes identified by profiling:
1. `filter_map` string allocations and character scans:
   - For every row, `file_name(row)` allocated a new `String`.
   - Concatenating all metadata fields into `fields` allocated another `String`.
   - `fold(&fields)` performed unicode case-folding, combining mark filtering, and iterated through all 23 character sets in `BASE_LETTERS` for every single ASCII character.
   - `filters.matches(row)` separately re-folded the title, artist, and every track name via `hits()`, running the 23-set `BASE_LETTERS` loop hundreds of times per row (~100 million total loop iterations across 50,000 rows).
   - In `map()`, `displayed_title(row)` allocated another `String` clone on every row.
2. `sort` tie-breaker re-computation:
   - In `rows.sort_by()`, when the primary sort key matched (all rows sharing the same title), the tie-breaker evaluated `key(Path::new(&left.path)).cmp(&key(Path::new(&right.path)))`.
   - In a 50,000 element sort with identical titles, this recomputed and allocated two lowercase path strings on every comparison (~1.6 million string allocations during sort).

### Optimizations Applied

1. Fast-path in `fold`:
   - All diacritics in `BASE_LETTERS` and combining marks are non-ASCII (`> 0x7F`).
   - If `value.is_ascii()`, `fold` returns `value.to_ascii_lowercase()` directly (vectorized, avoiding all 23 `BASE_LETTERS` linear scans and character decoding loops).
   - For non-ASCII strings, ASCII characters bypass the `BASE_LETTERS` and `is_combining` checks.
2. Zero-allocation `file_name_str` and `displayed_title`:
   - `file_name_str(path: &str) -> &str` borrows from the existing path slice without allocation.
   - `displayed_title<'a>(row: &'a LibraryResult) -> &'a str` borrows `metadata.title` or `file_name_str` without cloning.
3. Filter short-circuit and reusable buffer:
   - `filters.matches(row)` is checked first; if false, row is skipped immediately before constructing full-text fields.
   - When `tokens.is_empty()`, full-text construction and folding are bypassed completely.
   - A single reusable `fields_buf` is used across iterations rather than allocating a new string per row.
4. Pre-computed path key for sort tie-breaker:
   - `unique` already indexed entries by `path_key = key(Path::new(&row.path))`.
   - `path_key` is retained alongside `sort_key` in `rows`.
   - Sort tie-breaker compares `left_path.cmp(right_path)` directly, eliminating ~1.6 million `key()` allocations during sorting.

Post-optimization measurement on 50,000 rows:
- `dedup`: 86.7 ms
- `filter_map`: 124.9 ms (15.2x faster)
- `sort`: 1.56 ms (43.8x faster)
- **Total elapsed**: 189.7 ms to 216.3 ms (approx. **10x faster overall**, well below 2.0 s limit)

## Evidence

- `cargo test --manifest-path src-tauri/Cargo.toml --lib file_library::index::tests::a_page_search_over_fifty_thousand_rows_stays_fast -j 2`: passes in ~200 ms (search execution 189.7 ms).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib file_library -j 2`: all 78 tests in `file_library` passed.
- No schema, database, or index format changes made.
- Search results, sort order, and pagination are unchanged.

## Review

All changes are strictly internal performance optimizations in `src-tauri/src/file_library/index.rs`:
- Unicode folding semantics remain identical: `BASE_LETTERS`, combining marks, and fullwidth forms only apply to non-ASCII code points.
- Sorting tie-breaker uses the exact same `path_key` string that was previously derived by `key(Path::new(&row.path))`.
- Page limit and offset handling remain identical.

## Limits

- Search performance depends on CPU single-thread throughput for Unicode case-folding on non-ASCII text.
- Full `cargo test` is not run per repo rules (links >60 binaries); `--lib file_library` was verified.
- Desktop drivers requiring port 9223 were not run.
