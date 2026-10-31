# Rust test build memory

## Behavior

`cargo test` builds 66 test programs, and each one links the whole app. Cargo links as many at once as it has jobs, which is 28 on the development machine. Test builds now keep line tables only for this crate and no debug info for dependencies, and `.cargo/config.toml` caps Cargo at 6 jobs. Backtraces still show lines; stepping through tests in a debugger loses variable information.

## Evidence

Measured on Windows on 2026-10-31 by polling `link.exe` working sets.

- One program (`audio_amp`), relink: peak 3.6 GB before and 1.0 GB after, though the first figure may include other builds running then. Debug file 233 MB before and 10 MB after.
- Whole test build after the change: at most 6 linkers, 5.1 GB in total. Build folder 6.8 GB. An older folder with the previous setting held 67 GB, across more runs.
- Full `cargo test` after the change: only `a_page_search_over_fifty_thousand_rows_stays_fast` failed, the same test as before the change.

## Review

Merging the integration tests into one program was considered and not done. The limits above already bound memory, 8 test files use global state, and timing tests would then share a process.

## Limits

The whole build was not measured before the change, so no before and after total is claimed. The job cap also applies to app builds in this repository, which makes clean builds slower. macOS and Linux were not measured.
