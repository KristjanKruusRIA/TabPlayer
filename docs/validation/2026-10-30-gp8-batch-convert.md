# GP8 batch convert validation (draft)

Draft of what was measured for the F08 security fixes. The orchestrator finishes this record.

## Method

Crafted files were regenerated with `poc/zip-lie.mjs`, `poc/zip-more.mjs` and `poc/z64b.mjs`, plus truthful archives at the limits. The real worker and conversion bundle ran in headless Edge, the Chromium engine behind WebView2. Longest freeze is the largest window-thread timer gap. Peak is the largest single process in the harness's Edge profile, sampled by polling. Desktop drivers were not run, so nothing here was measured in the app itself.

## Batch

| File | Result | Longest freeze | Peak |
|---|---|---|---|
| z64b-64m.gp (was 181,525 ms) | Failed: ZIP64 record does not match | 21 ms | 59 MiB |
| z64b-max.gp | Failed: ZIP64 record does not match | 21 ms | 61 MiB |
| z64-max.gp | Failed: ZIP64 record does not match | 21 ms | 59 MiB |
| lie64.gp (was 37,247 ms) | Failed: entries do not fit | 21 ms | 60 MiB |
| lie640.gp | Failed: entries do not fit | 21 ms | 60 MiB |
| stored40.gp (was 1,318 MiB) | Failed: stored size differs | 29 ms | 71 MiB |
| stored300.gp | Failed: stored size differs | 21 ms | 71 MiB |
| gpif.gp (was 36,522 ms, 3,002 MiB) | Failed: entry exceeds 32 MiB | 21 ms | 61 MiB |
| walk8.gp | Failed: local/central mismatch | 21 ms | 61 MiB |
| walk40.gp | Failed: local/central mismatch | 20 ms | 59 MiB |
| honest2.gp | Failed: entry exceeds 32 MiB | 22 ms | 60 MiB |
| honest-read.gp (63 MiB real output) | Failed at read-back: Invalid huffman | 1,028 ms | 326 MiB |
| honest-read-over.gp | Failed: exceeds 64 MiB total | 21 ms | 59 MiB |
| stall.gpx | Failed: 15 s deadline | 22 ms | 82 MiB |
| guitarpro3-notes.gp3 | Converted | 31 ms | 59 MiB |
| guitarpro4-notes.gp4 | Converted | 40 ms | 60 MiB |
| guitarpro5-notes.gp5 | Converted | 36 ms | 59 MiB |
| guitarpro6-notes.gpx | Converted | 35 ms | 63 MiB |
| guitarpro7-notes.gp | Converted | 57 ms | 53 MiB |
| guitarpro7-bends.gp | Converted | 48 ms | 58 MiB |
| guitarpro8-beat-tempo-change.gp | Converted | 60 ms | 58 MiB |
| xml5.musicxml | Converted, before the export cap change | 2,875 ms | 1,269 MiB |
| xml12.musicxml | Converted | 5,883 ms | 2,456 MiB |
| xml20.musicxml | Converted, 41,467 bars | 25,455 ms | 3,847 MiB |
| xml26.musicxml | Failed: entry exceeds 122 MiB | 7,088 ms | 3,831 MiB |
| xml31.musicxml | Failed: entry exceeds 122 MiB | 7,175 ms | 4,561 MiB |
| xml32.musicxml | Failed: larger than 32 MiB | 21 ms | 65 MiB |

honest-read.gp is all zeros. Its extra entries are carried into the output, and alphaTab's reader rejects fflate's stream for them. It fails safely with nothing written. No real file with this shape was tested. The 25.5 s for xml20.musicxml is one shape, a repeated simple bar, and not a ceiling: nothing bounds the window's time on a file that passes.

## Single-file Open

Every format now goes to the stock reader in a Worker first. Times are from the check starting to the result. The parse column is the window's own parse of what passed.

| File | Result | Longest freeze | Peak |
|---|---|---|---|
| stall.gpx (hung past 45 s before) | Refused at the 15,016 ms deadline | 22 ms | 79 MiB |
| bcfz-bomb.gpx (declares 2 GiB) | Refused in 50 ms | 21 ms | 58 MiB |
| z64b-64m.gp | Refused in 32 ms | 21 ms | 58 MiB |
| z64b-max.gp | Refused in 33 ms | 21 ms | 57 MiB |
| z64-max.gp | Refused in 30 ms | 21 ms | 57 MiB |
| lie64.gp | Refused in 34 ms | 21 ms | 56 MiB |
| lie640.gp | Refused in 38 ms | 21 ms | 56 MiB |
| stored40.gp | Refused in 1,306 ms | 1,273 ms | 712 MiB |
| stored300.gp | Refused in 1,284 ms | 1,254 ms | 713 MiB |
| gpif.gp | Refused in 34 ms | 21 ms | 57 MiB |
| walk8.gp | Refused in 42 ms | 21 ms | 57 MiB |
| walk40.gp | Refused in 81 ms | 50 ms | 81 MiB |
| honest2.gp | Refused in 36 ms | 21 ms | 58 MiB |
| honest-read.gp | Admitted in 662 ms, parsed in 387 ms | 387 ms | 254 MiB |
| honest-read-over.gp | Admitted in 782 ms, parsed in 433 ms | 434 ms | 267 MiB |
| honest-open.gp (240 MiB output) | Admitted in 2,410 ms, parsed in 1,591 ms | 1,592 ms | 702 MiB |
| guitarpro3-notes.gp3 | Admitted in 41 ms, parsed in 3 ms | 21 ms | 57 MiB |
| guitarpro4-notes.gp4 | Admitted in 39 ms, parsed in 4 ms | 21 ms | 61 MiB |
| guitarpro5-notes.gp5 | Admitted in 37 ms, parsed in 5 ms | 21 ms | 62 MiB |
| guitarpro6-notes.gpx | Admitted in 44 ms, parsed in 9 ms | 21 ms | 61 MiB |
| guitarpro7-notes.gp | Admitted in 80 ms, parsed in 22 ms | 22 ms | 60 MiB |
| guitarpro7-bends.gp | Admitted in 82 ms, parsed in 15 ms | 21 ms | 61 MiB |
| guitarpro8-beat-tempo-change.gp | Admitted in 85 ms, parsed in 18 ms | 21 ms | 61 MiB |
| xml5.musicxml | Admitted in 450 ms, parsed in 435 ms | 436 ms | 415 MiB |
| xml20.musicxml | Admitted in 1,713 ms, parsed in 1,665 ms | 1,665 ms | 1,178 MiB |

The stored40.gp and stored300.gp freezes are the base64 decode on the window, and the peaks include the harness's own copy. The harness runs the admission and the score read. It does not build a document or render. An earlier honest-open.gp run hit the 120 s harness limit with no result, and the cause was not found. It has finished on both later runs.

On batch, bcfz-bomb.gpx failed in 40 ms at 54 MiB, stall.gpx failed at 15,019 ms with a 22 ms freeze, and guitarpro7-notes.gp still converted.

## Decoder comparison

`archive-decoders.test.ts` runs each crafted stream through the validator, `unzipSync` and alphaTab's own `ZipReader`.

| Stream | Validator (fflate) | alphaTab |
|---|---|---|
| Sound | Accepts | Accepts, same bytes |
| Cut one byte short, in half, or to one byte | Refuses | Refuses or loses the next entry |
| 1 or 8 trailing bytes, or a header signature, after the final block | Refuses | Loses the next entry |
| Over-subscribed literal codes | Accepts when the declared size is 0 | Refuses after producing 128 MB |
| Incomplete literal codes | Accepts | Refuses |
| One distance code, as fflate writes | Accepts | Refuses |
| Unfinished stored block | Refuses | Refuses |

They disagree on Huffman tables, where fflate is laxer, so the validator alone is not enough. The stock reader runs in the same Worker under the deadline, so the stricter result wins. No case had both accept and read different bytes, but this is a tested set, not a proof.

The one-distance-code row also explains honest-read.gp on batch: fflate's output for all-zero data is a stream alphaTab refuses at read-back.

## Race harness

| Mode | Result |
|---|---|
| read | 299 swaps, 8,355 refused, 0 outside bytes returned |
| write | 1,124 swaps, 2,990 refused, 0 files outside |
| write-deep | 4,013 swaps, 263 refused, 0 files outside |
| two-loop, two-source, two-temp, two-temp2, two-final | Swap refused by the system (error 32), output in place, nothing outside |
| protected-alias | Direct and UNC alias both refused |
| collide, cant-replace | Numbered copy, existing file untouched |
| held | Write failed, temporary file stays while the harness holds it |
| inject | Refused |

## Automated checks

- `tsc`: clean.
- Vitest, whole suite with `TABPLAYER_STALL_CASE` set: 4,264 passed, 3 skipped; 263 files passed, 2 skipped.
- `cargo test --locked` with `a_page_search_over_fifty_thousand_rows_stays_fast` skipped: 963 passed, 10 ignored, across 62 test binaries. That timing test failed twice in the full parallel run and passed alone. It is outside this work.

## Limits

- The Unix code is proven only by CI. No Linux or macOS target is installed and there is no WSL, so `cargo check --target` could not run. The Unix `mod sys` was type-checked on Windows against stand-in declarations, and the `libc` signatures were read from source. That proves types and borrows only. The `#[cfg(unix)]` tests have not run, and CI has not yet run this branch.
- On Unix, the destination folder itself is still opened by path. Folders below it and files in them use held descriptors.
- The validator does not check CRCs.
- The memory bound is the 64 MiB base limit, the decoding limit, the GPX declared size and the deadline. The system offers no heap limit for one Worker, so a heavy file can allocate until the deadline ends it. Nothing here tested a Worker running out of memory.
- A score that takes the Worker over 15 s no longer opens, where it used to open after a freeze.
- The window's second parse, the MusicXML preparation and the app's overlays have no deadline.
- `TABPLAYER_STALL_CASE` must be set for the real-Worker stall test to run, because `stall.gpx` is not committed.
- The MusicXML files repeat one simple bar, so their timings describe that shape.

## Limits added by the third review

- The Open check also covers restore and reload. A document that misses the deadline during restore is left out of the session, and nothing in the UI brings back its evidence copy.
- The deadline is not a memory bound: with it raised to 60 s, an allocating Worker killed the renderer at 21 to 25 s. No file reached that ceiling; honest admission peaked at 2.8 GiB.
- A 63 MiB honest file is admitted, then fails in `buildDocument` with "Invalid string length".
- Slow patterns were fixed in the offset match, `hasSoundMix`, the bar-length check and the ASCII header. Workers lack `DOMParser`, so the overlays run on the window, outside the deadline, and each needs its own bound. `xml.ts:51,76` was reasoned about, not measured.
- Overlay loops have been fixed as found, not audited exhaustively. A crafted local file may still hold the window for an unmeasured time after the Worker check; the known heavy linear shape held it for 15.9 s at 31 MiB on batch.
