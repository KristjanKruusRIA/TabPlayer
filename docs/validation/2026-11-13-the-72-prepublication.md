# THE-72 pre-publication preparation

Date: 2026-11-13. Branch `agy/the-72-prepublication` (equal to `develop` at the start). The repository is private today and is meant to go public under MIT once the project is finished. Parts A and B are done in the working tree; Part C lists the proposals, and the decisions taken on 2026-11-14 and what was done are recorded in the last section.

## Part A: machine-specific paths in documentation (done)

- 27 tracked files changed, all documentation or notes. A home path became `<checkout>` (the repository root), `~/.cargo/bin`, `%APPDATA%`, `<scratch>/...` (a scratch folder) or `<cargo-target>/slot-N`. Markdown links that pointed at an absolute checkout path became relative links (`../../src/...`), so they resolve from the file's own folder.
- A collage path under another local repository, in `docs/superpowers/specs/2026-10-15-tabplayer-reference-workstation-design.md`, became "a local attachment (not in the repository)".
- Left on purpose:
  - `CLAUDE.md` line 39: project guidance naming the shared cargo-target slot folders on drive E.
  - `src-tauri/examples/tone_ab/main.rs` line 216: a default output path in code.
  - `tests/desktop/display-modes.mjs` lines 10 and 12 and `tests/desktop/selection-loop-drawing.mjs` lines 9 and 10: default screenshot folders in drivers. These are functional defaults and need a code decision (a temp-folder default is the obvious one).
  - `docs/research/2026-10-14-guitar-pro-investigation.md` line 7 and 11 of the JSON provenance records in `docs/design/reference-workstation/`: pending the decisions below.
- Recorded evidence text was normalised along with the paths, so the commands in those records are historical and are not runnable as written. Examples: the driver JSON in `docs/validation/2026-11-08-desktop-driver-sweep.md` line 93 now shows `<checkout>` where it recorded a real path, and the PowerShell lines of `docs/validation/2026-11-08-vst-spikes.md` set `CARGO_TARGET_DIR` to `<cargo-target>/slot-1`, which is a placeholder, not a folder. The same holds for other validation, handoff and plan documents among the 27.
- In `.impeccable/critique/2026-10-15T09-25-46Z__src-app-tsx.md` two links to screenshots in a local `output/` folder (untracked, not in the repository) became plain text saying so.
- Not path edits, but found: `.vitest/json/output.json` is tracked although `.gitignore` lists `.vitest/`. It is a failed test run, so it is generated test output (CLAUDE.md forbids committing it). It holds only checkout paths, no user name. `git rm --cached .vitest/json/output.json` removes it from the index; the owner's commit should do that.

## Part B: ignore rules and scan (done)

- `.gitignore` has three layers, in this order (a later rule wins). (1) Score, audio and archive types are ignored everywhere by extension: `.gp*`, `.gpx`, `.gpif`, `.ptb`, `.tg`, `.tabplayer`, `.musicxml`, `.mxl`, `.mid`, `.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.aif(f)`, `.nam`, `.zip`, `.7z`, `.rar`, `.tar`, `.tgz`, `.gz`. (2) Five directories that legitimately track such files re-include them: `assets/library/`, `src-tauri/resources/cabinet-irs/`, `src-tauri/tests/fixtures/`, `src/interchange/fixtures/`, `tests/fixtures/`. (3) Executables and plug-ins (`.exe`, `.msi`, `.dmg`, `.dll`, `.so`, `.dylib`, `.vst3`) and secrets (`.env` and `.env.*` except `.env.example`, `.pem`, `.key`, `.p12`, `.pfx`, `.p8`, `.jks`, `.keystore`, `.tauri/`) are ignored again everywhere, so the re-includes never expose them. `.gpif` is tracked only in `src/interchange/fixtures/`, which is re-included; nothing tracked uses the other new extensions.
- Verified with `git check-ignore`: in each of the five directories a new `.gp`, `.gp5`, `.gpx`, `.gpif`, `.tabplayer`, `.mid`, `.musicxml`, `.wav`, `.mp3`, `.flac`, `.nam`, `.zip` and `.tar.gz` is addable, while `.env`, `.env.local`, `.pem`, `.key`, `.p12`, `.exe`, `.dll` and `.vst3` are ignored; `.env.example` is addable; the same score types are ignored outside those directories. `git ls-files -ci --exclude-standard` lists only `.vitest/json/output.json`, which it already listed before the change.
- `scripts/secret-scan.mjs` scans every tracked file, and `scripts/secret-scan.test.mjs` (in the `npm test` Node list) runs it plus synthetic tests. It detects: private-key headers; minisign and base64-wrapped Tauri updater private keys (decoded, so the public key passes); `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `TAURI_PRIVATE_KEY` and `TAURI_KEY_PASSWORD` with any non-empty value that is not a reference such as `${{ secrets.X }}`; GitHub, AWS, Slack, Google, Stripe, npm, Anthropic and OpenAI token shapes, on every line including minified ones; `api_key` assignments; quoted or unquoted high-entropy or 40+ character hex values under secret-like names in JSON, TOML, YAML, `.env` and similar files; personal home paths; drive-letter `git`, `claude-tmp` and `cargo-target` folders; and tracked files of forbidden types (media types outside the five directories; executables and secret files anywhere). UTF-16 files with a byte-order mark are decoded. It prints file, line and rule, never the value.
- `node scripts/secret-scan.mjs` prints the number of files scanned and the findings, and exits 1 on findings. Where git is missing or the folder is not a repository (a source tarball), it prints a message and the test passes without scanning.
- Allowlist: home paths in the two Part C items, and drive-letter folders in the same JSON records, the declared exceptions listed in Part A, and `.vitest/json/output.json` (to be removed from the index). `.xml` is deliberately not forbidden; it is too common.
- Undetectable by design: short or low-entropy passwords, secrets written in prose or split over lines, secrets in unlisted file types or binaries, and a private score or other media file placed in one of the five re-included directories, which hold real fixtures and must be reviewed by hand.
- The scan found no real secret. Without the allowlist it reports only the groups above.
- Not removed from the index (the owner will do it in the commit): `.vitest/json/output.json`, with `git rm --cached`.
- Commands run after these changes: `node --test scripts/secret-scan.test.mjs` (15 tests), `node scripts/secret-scan.mjs`, `npm run typecheck`, and the Node resource part of `npm test` (`node --test` over the files named in `package.json`). The full Vitest run was not repeated; it is unaffected by these changes (earlier run in this branch: 7036 passed, 1 timing failure in `src/App.test.tsx` that passed when the file was run alone).

## Part C: owner decisions (proposals, nothing changed)

### (i) `docs/research/2026-10-14-guitar-pro-investigation.md`

It records an analysis of the Guitar Pro 8 installer: its local path and hash, the extraction steps, library names, addresses, recovered names and evidence identifiers pointing at a local analysis folder. None of it is needed by a reader of TabPlayer, and it reads as reverse engineering of a commercial product. It says nothing about activation, but the whole record is of that kind.

Proposed replacement, about 40 lines, titled "File-format generations and foundation choice":

1. Purpose and date, with one sentence saying TabPlayer's importers and exporters are implemented from public documentation, alphaTab's open source and observed behaviour of files, and that no vendor code is included.
2. Format generations to test independently: GP3/4/5 (legacy binary), GP6 (`BCFS`/`BCFZ` container), GP7/8 (ZIP with `Content/score.gpif`), bare GPIF XML (root element `GPIF`). Keep the magic bytes and member path, which are file-format facts, and drop every address and symbol.
3. Foundation comparison: keep the "Foundation comparison" section as it is, with its public links (Tauri, alphaTab, TuxGuitar).
4. Coverage table: keep, with the installer-specific wording removed.
5. Limits: static reading does not establish equivalence; round trips are not lossless; the proprietary sound engine is not replicated.

Drop: the installer path, size and hash, the extraction tool details, the library inventory, the address and name tables, the evidence identifier list, and the "Source and retention" section.

Other tracked files that link to or repeat it:
- `docs/superpowers/specs/2026-10-14-tabplayer-design.md` line 47 links to it (the link survives if the file keeps its name).
- `docs/superpowers/specs/2026-10-15-gp8-lyrics-design.md` line 97 and `docs/validation/2026-10-15-gp8-lyrics-notation.md` lines 36 and 38 name a vendor library with procedure addresses and a hash.
- `docs/validation/2026-10-31-gp8-buzz-roll.md` lines 12 to 31 and `docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md` line 42 describe inspecting the vendor application files in a local analysis folder.

Proposal: replace the file as outlined and strip the addresses and DLL references from those four documents, keeping the format facts they support. History still holds the originals (see iii).

### (ii) `docs/design/reference-workstation/`

20 PNG mockups, 30,146,814 bytes in total (1.28 to 1.74 MB each), generated images derived from a user-supplied collage that is not in the repository. Each has a `*-generated-concept*.json` provenance record (16 files) holding local generated-image and checkout paths; `score-layout-reference-selection.md` is the only prose file.

PNGs (bytes): backing-gp-export 1,582,411; backing-pitch-filter 1,735,795; backing-tempo 1,623,525; backing-waveform 1,470,290; export 1,439,256; grid-score 1,491,939 and v2 1,541,630; horizontal-page 1,516,523 and v2 1,497,228; horizontal-screen 1,445,904 and v2 1,401,864; library-examples 1,522,101; library-folders 1,493,043; library-recent 1,617,891; library-templates 1,533,429; parchment-score 1,468,704; recovery 1,280,856; saved-tunings 1,528,903; vertical-page 1,463,678; vertical-screen 1,491,844. All names end in `-concept.png`.

Referenced by (documentation only; no code, test or script reads them):
- `docs/acceptance/admission-gated-drivers.md` lines 84 and 163
- `docs/superpowers/plans/2026-10-15-tabplayer-reference-workstation.md`, `2026-10-15-gp8-backing-tempo.md`, `2026-10-16-gp8-backing-processing.md`
- `docs/superpowers/specs/2026-10-15-gp8-backing-tempo-design.md`, `2026-10-15-gp8-backing-waveform-design.md`, `2026-10-15-gp8-file-library-design.md`, `2026-10-15-gp8-recovery-session-design.md`, `2026-10-16-gp8-backing-processing-design.md`
- `docs/validation/2026-10-15-gp8-backing-tempo.md` (SHA-256 table), `2026-10-15-gp8-backing-waveform.md` (hash table), `2026-10-15-tabplayer-reference-workstation.md`, `2026-10-16-gp8-backing-processing.md`, `2026-10-16-gp8-score-layout-integration.md`

Options:
- Keep: no work, but 30 MB of images whose source collage may show a commercial product's interface, which I cannot judge from here. The JSON paths would still need neutralising.
- Replace with screenshots of TabPlayer: the honest public record, since the app now exists. Cost: the validation documents hold hashes of the current images, so they would need re-pointing, and about 10 screens would have to be captured.
- Remove: smallest public footprint. The referencing documents then have dead links and hash tables that cannot be checked.

Proposal: replace. Capture a handful of TabPlayer screenshots into `docs/screens/`, delete the directory, and turn the referenced paths in the documents above into "design reference, not published". If the collage is the concern, do not keep the originals even in a replacement commit.

### (iii) Working tree or history

Removing files from the working tree is not enough. A deletion leaves the content in every earlier commit, and anyone who clones the public repository gets all of it. On 2026-11-13 the repository had 1,009 commits across all refs, 19 local branches, 5 remote-tracking refs (including `origin/HEAD`) and 18 worktrees including the main checkout; these numbers change as work continues. Rewriting history (for example with `git filter-repo`) changes every commit hash from the first affected commit onward, which breaks every open worktree, every branch, the hashes quoted in the validation notes and any reference to a commit in Linear or a pull request, and needs a coordinated force push. The alternative is to publish a fresh repository with a squashed or curated history and keep this one as a private archive. Which of these to do, and whether the installer analysis, the mockups and the old local paths justify it, is the owner's call. I recommend deciding after items (i) and (ii), since they determine what has to be hidden.

Commit metadata: every commit records the author e-mail address, history contains more than one address, and one of them is a noreply form. Publishing the existing history publishes those addresses. The owner confirmed on 2026-11-13 that the commit e-mail address stays as it is, so this is decided and not open. It still bears on the choice between rewriting history and starting a fresh repository, because a rewrite could also change the recorded identity and a fresh repository would not carry the old addresses at all. No address is quoted here.

### (iv) Publishing step

Push named branches only, for example `git push origin main` and `git push origin develop`; never `git push --all`, `--mirror` or `--tags` without checking. `origin` currently pushes to `https://github.com/KristjanKruusRIA/TabPlayer.git`, which is the private repository; a public release should use a new or converted remote after the decisions above.

Local refs that must never be pushed: two refs outside `refs/heads` and `refs/remotes`, both under `refs/codex/turn-diffs/checkpoints/` (Codex turn checkpoints, 2 refs; the full names are in `git for-each-ref refs/codex`). They exist locally only; the configured fetch refspec is `+refs/heads/*:refs/remotes/origin/*` and there is no push refspec, so a plain `git push origin <branch>` does not send them. Do not run `git push --mirror` or `git push origin 'refs/*:refs/*'`. Also review which of the `agy/*` and `fix/*` branches should be public before pushing anything but `main` and `develop`. Nothing was changed or pushed here.

## Decisions of 2026-11-14 and what was done

Owner decisions:

- Condense the Guitar Pro investigation note and the passages in other documents that carried vendor library names, addresses or evidence identifiers (item i).
- Remove the 20 generated mockups (item ii).
- Publish the history as it is (item iii): no rewrite and no fresh repository. The earlier commits still hold the originals of everything removed below.
- The commit e-mail address stays as it is. No address is quoted here.

Done in the working tree (nothing staged or committed here):

- `docs/research/2026-10-14-guitar-pro-investigation.md` was rewritten (71 lines to 46). It keeps the file-format generations with their magic bytes and member path, the foundation comparison with its public links, a coverage table and the limits. It drops the installer path, size and hash, the extraction tool, the library inventory and versions, the address and name tables, the evidence identifiers, the source and retention section and every local path. The file name is unchanged, so the link in `docs/superpowers/specs/2026-10-14-tabplayer-design.md` still resolves.
- The same kind of detail was condensed, keeping each document's conclusions, in `docs/superpowers/specs/2026-10-15-gp8-lyrics-design.md`, `docs/validation/2026-10-15-gp8-lyrics-notation.md`, `docs/validation/2026-10-31-gp8-buzz-roll.md` and `docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md` (the four named above), and also in `docs/superpowers/specs/2026-10-15-gp8-stylesheet-interchange-design.md`, `docs/validation/2026-10-15-gp8-stylesheet-interchange.md` and `docs/superpowers/plans/2026-10-15-gp8-stylesheet-interchange.md` (evidence identifiers and hashes of vendor files). The golpe note's remark about trying an installed copy was reworded.
- The 20 PNG mockups and all 16 JSON provenance records in `docs/design/reference-workstation/` were deleted from the working tree; they had no purpose without their images. `score-layout-reference-selection.md` stays (other documents link to it) with a note that the images are gone. Fifteen documents that named the images (acceptance, plans, specs and validation notes) now say they were removed before publication; their hash tables are kept as a record and can no longer be checked. A search of `src`, `src-tauri`, `tests`, `scripts`, `package.json` and `.github` found no dependency on any of these files.
- `scripts/secret-scan.mjs`: the allowlist entries for the investigation note and the reference-workstation folder were removed. `node scripts/secret-scan.mjs` prints 0 findings (1825 tracked files) and `node --test scripts/secret-scan.test.mjs` passes (15 tests). Part B's allowlist paragraph above describes the state before this change.
- Still for the owner's commit: `git rm --cached .vitest/json/output.json`, and staging the deletions.

Publishing rule (unchanged): push named branches only, never `--all`, `--mirror` or `--tags` unchecked. The two refs under `refs/codex/turn-diffs/checkpoints/` must never be pushed (see item iv above).
