# L01: browse and filter the Library by title, artist and instrument

Date: 2026-10-24. Status: design. Row L01 ("Integrated score library browsing/filtering") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's welcome page and library let you browse a catalog and filter it by artist, title, instrument and genre without leaving the score you are working on. TabPlayer already has a Library dialog (`src/library/`, `src-tauri/src/file_library/`) with Recent, Templates, Folders and Examples sections, a welcome panel, a native metadata index of user-chosen folders, and one free-text search over title, artist, album and track names. Opening any result already goes through `WorkspaceController.openSource`, which adds a tab and never replaces the open score. What was missing is the field filters. This slice adds them to the indexed Folders catalog. It adds no edit command, no schema field and no service connector.

## Behaviour

- The Folders section gains three text fields beside Search, scope and Sort: **Title filter**, **Artist filter** and **Instrument filter**, and a **Clear filters** button (disabled while all are empty).
- Each filter is a folded match. Its whitespace-separated words must all appear in the field, in any order.
  - Folding (also applied to the free-text search) is full Unicode lowercase, fullwidth ASCII and ideographic space to their plain forms (the part of NFKC that matters here), combining marks dropped, and precomposed Latin letters reduced to their base letter ("ß" to "ss", "æ" to "ae"). So NFC and NFD spellings match each other and "Bjork" finds "Björk".
  - Decision: matching is **diacritic-insensitive**. std has no normalization and no dependency may be added, so the table covers Latin-1 and Latin Extended-A plus the common Latin Extended-B letters; other scripts match by lowercase only. This is deliberately looser than the Recent/Templates/Examples text search, which stays NFKC plus lowercase in the browser.
  - **Title** matches what the list displays: the indexed title, or the file name when the score has no metadata or its title is empty.
  - **Artist** matches the indexed artist.
  - **Instrument** matches the indexed track names: at least one single track name must contain every word. The index stores track names, not instrument types, so this is the closest real field.
  - A score without indexed metadata (unreadable or not yet parsed) never matches an artist or instrument filter.
- Filters combine with each other, with the free-text search, with the folder scope, with Sort and with paging. Changing a filter returns to the first page.
- Searching is the existing debounced native `file_library_search`. The query gains `title`, `artist` and `instrument` strings. The filtering runs in `LibraryIndex::search`, so totals and pages count only matching scores.
- The "Showing previous results" line, shown after a failed request, names any active filter so the displayed rows are never mislabelled.
- Opening a result is unchanged: it opens as a new tab and the open score, its edits and its playback are untouched. Searching and filtering never open anything.

## Cost

A search borrows rows from the shared per-folder indexes (`Arc`) instead of deep-cloning them, folds the filter words once, and clones only the returned page. A release test searches 50,000 indexed rows with text plus all three filters (every row matching): about 0.39 s on the development machine, asserted under 2 s.

## Wire and compatibility

- `LibraryQuery` (Rust `types.rs`, TypeScript `types.ts`) adds `title`, `artist`, `instrument`. In Rust they are `#[serde(default)]`, so a query without them (older callers, existing drivers) means "no filter" and nothing else about the strict query shape changes. The TypeScript controller always sends all three.
- No persisted data changes: the index, the catalog and the project are untouched, so no strict schema needs a new field.

## Acceptance

- Unit tests (Rust): each filter matches only its own field; words are all-required and case-insensitive; instrument words must hit one track; rows without metadata fall back to the file name for title and never match artist or instrument.
- Unit tests (TypeScript): the controller sends the filters with the text, keeps them across paging and clears them together; the dialog's three fields reach the bridge, Clear filters resets them, there is no genre control, and searching never calls the open or save callbacks.
- Desktop driver `tests/desktop/parity-library-browse.mjs`: with two indexed original scores it checks that the screen and the native search agree for artist, title and instrument filters, that combined filters narrow to nothing, that an artist is not matched as an instrument, that no genre control exists and no result carries a genre, and that opening a result adds a second tab while the first document's snapshot is byte-for-byte equal.

## Scope and recorded limits

- **Local only.** TabPlayer has no authorized connected catalog and this slice adds no service connector, account sign-in or vendor catalog. "Authorized connected catalogs" in the row's acceptance cannot be met and stays a recorded limit; the Library searches the user's own indexed folders, recent files, the user's templates and the bundled original examples.
- **No genre filter.** Scores carry no genre field: alphaTab's `Score` has none and the index records only title, artist, album and track names. A genre filter would need invented data, so none is offered. The Folders hint says so.
- **Instrument is the track name**, not a canonical instrument type.
- Filters apply to the Folders index. Recent, Templates and Examples keep their single text search; they are short, already filtered by title, artist, album, track and instrument names, and unchanged.
- Not a design copy of the GP8 welcome page: the existing Library dialog layout stays.
