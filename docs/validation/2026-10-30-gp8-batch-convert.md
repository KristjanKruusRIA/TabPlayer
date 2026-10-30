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

honest-read.gp is all zeros. Its extra entries are carried into the output, and alphaTab's reader rejects fflate's stream for them. It fails safely with nothing written. No real file with this shape was tested.

## Single-file Open

| File | Result | Longest freeze | Peak |
|---|---|---|---|
| z64b-64m.gp | Refused after 9 ms | 21 ms | 59 MiB |
| lie64.gp | Refused after 15 ms | 21 ms | 60 MiB |
| stored40.gp | Refused after 1,323 ms | 1,317 ms | 844 MiB |
| gpif.gp | Refused after 21 ms | 21 ms | 71 MiB |
| honest-open.gp (240 MiB real output) | Admitted in 708 ms, parsed in 1,773 ms | 1,774 ms | 796 MiB |
| guitarpro7-notes.gp | Admitted, parsed | 21 ms | 61 MiB |
| guitarpro8-beat-tempo-change.gp | Admitted, parsed | 21 ms | 61 MiB |
| guitarpro5-notes.gp5 | Admitted, parsed | 21 ms | 60 MiB |

The stored40.gp freeze is the base64 decode on the window, and the peak includes the harness's own copy. The first honest-open.gp run hit the 120 s harness limit with no result and 61 MiB peak. The rerun above finished, and the cause of the first run was not found.

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
- Vitest, whole suite: 3,963 passed, 4 skipped; 250 files passed, 2 skipped.
- Cargo: `batch_convert` 28, `fs_identity` 7, `file_library::protected` 12, all passed.

## Limits

- No Linux or macOS target is installed and there is no WSL, so `cargo check --target` could not run. The Unix `mod sys` was type-checked on Windows against stand-in declarations, and the `libc` signatures were read from source. That proves types and borrows only. The `#[cfg(unix)]` tests have not run.
- On Unix, folders are still opened by path. Only the operations inside a held folder use its descriptor.
- The validator does not check CRCs and uses fflate, not alphaTab's decoder.
- Single-file Open runs the archive validator only, not the GPX stall probe.
- The MusicXML files repeat one simple bar, so their timings describe that shape.
