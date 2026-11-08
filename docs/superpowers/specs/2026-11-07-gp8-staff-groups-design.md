# D11: staff groups, braces and per-staff spacing (THE-180)

Spec for Linear THE-180: "group chosen tracks under a brace or bracket, set independent staff gaps, and see long names on the first system and short names after". Also the D11 row of `docs/validation/2026-10-15-gp8-parity-progress.md`, whose remaining gap reads "Arbitrary grouping/braces, independent staff spacing and complete first/subsequent-system target engraving remain unclosed." Research notes are in the session scratchpad (`d11-findings.md`); the facts this spec relies on were checked against the code at `10f4fa4` and are restated here. D08 (per-system gaps, `docs/superpowers/plans/2026-11-07-gp8-system-gaps.md`) is the template.

## What alphaTab 1.8.4 gives, and what it does not

- `bracketExtendMode` has three values: no brackets, one bracket or brace per track (`GroupStaves`), or tracks with the same MIDI program (`GroupSimilarInstruments`). There is no API for a chosen set of tracks, and no multi-track brace (`StaffSystem.addStaff`, `alphaTab.core.mjs:57307-57338`).
- A brace is automatic: a track with more than one standard-notation staff. A bracket is painted only when more than one staff is visible, unless `showSingleStaffBrackets` (`SystemBracket.updateCanPaint`, `:56860-56877`).
- Track names end at `staff.x − accoladeBarPaddingRight − bracket.width − systemLabelPaddingRight` (`:57398`). The accolade (names plus bracket column) is `nameWidth + systemLabelPaddingLeft + systemLabelPaddingRight + bracketWidth`, and `systemLabelPadding*` are added only on systems that draw names (`:57229-57292`). Every staff starts at `x = accoladeWidth` (`:57505`).
- First system means system index 0 of the whole render (`:57236-57238`). An empty `shortName` falls back to the first 10 characters of `name` (`:12676-12680`).
- Vertical padding is one value for every track boundary (`trackStaffPaddingBetween`, default 5) and per-position staff paddings (`:56489-56494`, `:57498`). There is no per-boundary gap.
- A rendered system is one flat SVG chunk; staves are not grouped. `boundsLookup` gives one `BarBounds` per visible staff and bar (`bar.staff.track.index`, `bar.staff.index`), positioned at the staff's content area (`renderer.y = topPadding + topOverflow`, `:56508`), in the same coordinates as the chunk (`:54651-54666`).

So TabPlayer draws group marks itself and moves staves itself. Nothing in alphaTab is patched.

## Rulings

### Data

- Two new optional top-level fields on `EngravingOverrides`, added like `systemGaps`: Rust `#[serde(default, skip_serializing_if = "Vec::is_empty")]`, TypeScript a conditional key in `validateEngraving`. Both are omitted when empty. Old projects and logs replay unchanged; older builds refuse a log carrying either field (a recorded limit, as in D08).
  - `staffGroups?: {trackIds:string[]; kind:'bracket'|'brace'}[]`
  - `staffGaps?: {trackId:string; scale:number}[]`
- Both are carried by the existing `setEngraving` edit. There is no new edit type.
- Caps, the same in TypeScript and Rust:
  - at most 64 groups; each group names 2 to 64 track ids;
  - an id is nonempty and at most 65,536 UTF-8 bytes (identities embed one edit's JSON; the cap bounds memory, not names);
  - an id appears in at most one group (groups are flat and never overlap), and once per group;
  - at most 256 staff gaps; a gap id follows the group-id rule (nonempty, at most 65,536 UTF-8 bytes); ids distinct; `scale` finite, 0.25 to 4 (shown as 25 to 400%).
  - "Nonempty" means a length above zero in both languages (no trimming), and TypeScript counts bytes with `TextEncoder`, so TypeScript and Rust agree on every id.
- Rust checks only shape and caps, as for `profiles`. It cannot know which tracks are live or in which order.
- Track liveness is never validated for groups or gaps, at edit time or on replay. A stored id that no longer names a track is dormant. This keeps any later `setEngraving` (which re-sends the whole object) valid after a track removal.
- Saved styles reject both fields, as they reject profiles, bar widths and system gaps, in `style-library.ts` and `style_library.rs`. `styleOf` strips them and `styleApplied` keeps the document's own. No style-library version bump.
- `EngravingPanel` `apply()` and `reset()` re-attach the live `staffGroups` and `staffGaps`, as they do `barWidths` and `systemGaps`.

### Group membership

- Membership is by track identity (`trackIdentity`), so a group follows its tracks through `moveTrack`.
- A group is drawable when its live members are at least two tracks and form one contiguous run in the current track order. Stored order of `trackIds` is irrelevant; helpers write ids in current track order.
- When a move or removal breaks that, the group stays stored, is not drawn, and the panel says why:
  - "fewer than two of its tracks remain" (`tooFewTracks`);
  - "its tracks are no longer next to each other" (`notContiguous`).
  Moving the track back, or undo, makes it drawable again with no edit.
- `duplicateTrack`: the copy joins its source's group, and copies its source's staff gap. This deviates from the recommendation that the copy stay out, for a concrete reason: the copy is inserted directly after its source, so if it stayed out, duplicating any member that is not the group's last would split the run and silently stop the group from drawing. Joining is the only choice that never breaks a group. It also matches the existing rule that a duplicate starts with its source's sound, mix and profile (`copyTrackSettings`). If the group already holds 64 ids, the copy does not join (the group then reports `notContiguous`); this is a recorded limit.
- Creating a group requires at least two chosen tracks, contiguous in the current order, none already in a group. Changing a group's kind, removing one group, and removing all groups are the other gestures. There is no "edit members" gesture: remove and recreate.

### What is drawn, and when TabPlayer draws it

- A render "has groups" when at least one group is drawable and at least two of its members are among the rendered tracks (the visible tracks on screen, the exported tracks in export). Only rendered members count; a group is drawn over its rendered members. A group left with one rendered track is not drawn in that render (`notShown` in the panel when the screen hides its tracks).
- In a render without groups nothing changes: alphaTab draws its own brackets from the effective Brackets setting, and the output is byte-identical to today.
- In a render with groups:
  - the rendered score's `bracketExtendMode` is set to no brackets;
  - TabPlayer draws every accolade from the rendered staff bounds, in two columns left of the staves:
    - the inner column holds each track's own mark, as alphaTab would draw it under `GroupStaves`: a brace for a track with more than one standard-notation staff, otherwise a bracket over its visible staves when there are two or more, or one with Single staff brackets on. It is empty for every track when the effective Brackets setting is None;
    - the outer column holds the group marks;
  - a track in a brace group gets no inner mark. A track in a bracket group keeps only an inner brace (a piano in a bracketed section keeps its brace); its own inner bracket is dropped;
  - under "Group similar MIDI programs", the cross-track same-program brackets are not reproduced while groups are drawn; ungrouped tracks get their per-track marks. Recorded limit;
  - a group whose system shows only one of its staves (Hide empty staves) is drawn only when Single staff brackets resolves to on; with none visible it is not drawn in that system. This mirrors `updateCanPaint`.
- The columns are allocated once per render, so marks align on every system. Inner width is the widest inner kind present; outer width the widest group kind present. The reserve is `pad + inner + (outer ? pad + outer : 0)` in alphaTab units, `pad = accoladeBarPaddingRight`.
- Making room for the reserve:
  - `systemLabelPaddingRight += reserve`, so on systems that draw names the names end left of both columns;
  - the page padding's left side grows by `reserve × display.scale`, so systems without names also have room. A system with names then has `reserve` of blank space left of the names. That is the cost of not patching alphaTab, and it is recorded.
- Mark geometry, in render pixels:
  - a mark spans from the top of its first visible staff's `BarBounds` to the bottom of its last; the inner column's right edge is `staffLeft − pad`, the outer column's right edge is the inner column's left edge minus `pad`;
  - a bracket repeats alphaTab's `_paintBrackets` geometry: a `bracketThickness` bar overflowing the span by a quarter staff space plus 3, with the Bravura BracketTop (U+E003) and BracketBottom (U+E004) glyphs;
  - a brace is the Bravura brace (U+E000) scaled vertically to the span, as alphaTab scales it; its horizontal scale is the same factor capped at 4, so its width never exceeds the reserved `4 × braceGlyphWidth`;
  - each mark carries `data-tp-accolade="<group|track>-<bracket|brace>"`, which tests and the desktop driver use to find it.
- Extend bar lines keeps its whole-system alphaTab behaviour; bar lines that extend only through a group are not drawn. Recorded limit. alphaTab adds vertical room for its own bracket spikes; with its brackets off, a group bracket at a track boundary gets no such room. Recorded limit.

### Where marks show

- Paginated page layouts (vertical page, horizontal page, grid) and every export (PDF, SVG, PNG, print): marks are composed into each system's SVG, before pagination.
- Parchment, vertical screen and horizontal screen: alphaTab places chunks itself, so the marks are drawn in an overlay SVG over alphaTab's surface from the same bounds and the same geometry. Groups therefore show in every layout.
- Per-track export renders one track alone, so no group is drawn and alphaTab's own brackets return (a piano keeps its native brace).
- Groups are not written to Guitar Pro, MusicXML, MIDI or ASCII exports. Those writers never read `EngravingOverrides`; only `pdf.ts`, `selection.ts`, `types.ts` and `useExportCoordinator.ts` do.

### Staff gaps

- One gap per boundary between two adjacent tracks. The entry is stored by the upper track's id and means "the space below this track". Justification: it follows the track through moves the way a user describes it ("more room under the guitar"), needs one id instead of a pair, and has one clear dormant case. A pair key would go dormant after any reorder that separates the two tracks, which would be harder to explain in the panel.
- In each rendered system the gap applies at the boundary between the entry's track and the next track that has a visible staff in that system. It is inert for the last such track, for a track with no visible staff in that system, and for a dormant id. The panel names the last-track case.
- Gaps between the staves of one track (standard and tablature, a piano's two staves) are not included. Recorded limit.
- Size: `scale` is a percentage of alphaTab's default spacing at that boundary in that system. For upper track bottom `u` and lower track top `l` (from the `BarBounds` of their visible staves, render pixels), `measured = l − u`, `base = max(measured, 5 × renderScale)` (5 is `trackStaffPaddingBetween`), and the extra offset is `(scale − 1) × base`, never below `−measured`. This is the D08 unit style (a percentage of the default, 1 = unchanged); unlike D08's fixed 20 it is measured, because the default space between tracks is mostly the staves' overflow, not a padding constant.
- Mechanism: the system is cut into horizontal bands at the midpoint `u + measured / 2` of each boundary with a nonzero offset. Each band shows the system's SVG through a clip of its own y-range, translated down by the sum of the offsets above it. The system content is defined once and reused per band (`<defs>` and `<use>`), with ids prefixed per system so ids never collide on a page or in the screen DOM. The usvg export path accepts `<use>` and clip paths; only `<image>`, `<script>`, `<foreignObject>` and DTDs are rejected (`src-tauri/src/export/pdf.rs:60-71`). Group marks are drawn after the shift, so they span the moved staves.
- An element hanging more than halfway into the space between two tracks moves with the other track, and a bar line or alphaTab bracket crossing a cut shows a break through the added space. Recorded limit.
- Scope is D08's: paginated page layouts and export only. Parchment, vertical screen and horizontal screen do not show staff gaps; the panel says so. Gaps stay editable in every layout, because they are keyed by track, not by a rendered system, and they apply to export.
- Composition with D08: a system's height includes its staff gap offsets before D08 stacking. Screen and export both compose first, then paginate with the composed heights. The D08 offset rule and its base are unchanged.
- Overlays and hit testing follow moved staves. A system block carries its band shift. A rectangle maps its top and bottom separately, so a cursor or selection spanning several staves stretches over the added space. A point inside an opened gap maps to no score position.
- A gap-only edit does not re-render alphaTab. The render path uses an engraving without `systemGaps` and `staffGaps`, memoized on a key that leaves both out. A group edit does re-render, because it changes the bracket mode and the reserve.
- Gaps never change timing or native playback; they stay a settings edit.

### Names: long on the first system, short after

- This is already reachable with existing settings: names on all systems, first-system names full, other-system names short, with each track's short name set. D11 adds proof and a one-gesture option, and no new name data.
- One-gesture option "Long names first, short after" sets, in one `setEngraving`, `singleNames: 'allSystems'`, `multiNames: 'allSystems'`, `firstNames: 'full'`, `otherNames: 'short'`. Both policies are set so a per-track export (single-track policy) shows the same. Orientation is not touched. When the four already hold those values the control is unavailable (`busyGuard`, `aria-disabled`) and records nothing.
- Proof: a render-level test with the real renderer shows full names on system 0 and short names on later systems, in a multi-track and in a single-track render, and that names never overlap a drawn group mark. The desktop driver checks the same on the export pages.
- Not added: first-system-of-each-page names (alphaTab has no such notion), group labels, short-name editing (it is already in the Track inspector).

### UI

- A new "Design: staff groups" panel in Presentation tools, after "Design: system gaps". All text through `src/i18n` with `en`, `et` and `de`. Controls use `editBusy` and `busyGuard`, never `disabled`, for busy; unavailable controls are `aria-disabled` with a status line naming the reason.
- Groups:
  - a checkbox per track in current order, a kind choice (Bracket, Brace) and "Group chosen tracks". It is unavailable with a reason when fewer than two are chosen, when they are not next to each other, when one is already grouped, or at 64 groups;
  - a row per stored group: its tracks' names (or "removed track"), a kind choice (one change is one edit), the group's state, and "Remove group";
  - "Remove all groups".
- Staff gaps:
  - a track choice ("Space below"), a percentage field 25 to 400 that commits on Enter or blur, "Reset" and "Reset all staff gaps";
  - entering the current resolved value records nothing; resets are unavailable when nothing is stored for that track, or at all;
  - the status line says when the chosen track is the last of the rendered tracks (so it has no boundary below it in this view), and when the current layout does not show staff gaps.
- Names: the "Long names first, short after" button.
- Each action is one `setEngraving`. The helpers return the same object when nothing changes, and the panel sends nothing in that case, as `SystemGapsPanel` does.

## Global constraints

- Old `.tabplayer` projects and edit logs replay unchanged; an absent field loads as empty and serializes without the field.
- Without groups and gaps, every screen and export output is byte-identical; the existing page, pagination, PDF and header-footer tests pass unchanged.
- alphaTab 1.8.4 stays unmodified. Do not retune `tone.rs`. Do not rename the existing engraving labels; drivers use them.
- Rust: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, the `style_library` unit tests, `cargo fmt --check`, in the default `src-tauri/target`.

## Evidence and limits to record

- `docs/validation/2026-11-07-gp8-staff-groups.md` with the driver output, and the D11 tracker row (md and json) updated and kept partial.
- Limits to state there: staff gaps only in page layouts and export; no gaps between a track's own staves; extended bar lines are whole-system; no bracket-spike room at group edges; similar-program brackets not reproduced while groups draw; blank reserve left of names; midpoint cut can move a hanging element with the other track; breaks in crossing bar lines; older builds refuse the fields; not in GP/MusicXML/MIDI/ASCII or saved styles; per-track export draws no groups; the 64-member cap can stop a copy joining; no original-GP8 comparison exists in the repo.
