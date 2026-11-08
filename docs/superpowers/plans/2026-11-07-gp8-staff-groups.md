# D11 Staff Groups, Braces and Per-Staff Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group chosen tracks under a bracket or brace, set the space below each track, and prove long names on the first system and short names after, each as one undoable `setEngraving` edit, with export matching the screen (THE-180).

**Architecture:** Two optional top-level `EngravingOverrides` fields (`staffGroups`, `staffGaps`) keyed by track identity, validated in TypeScript and Rust like D08's `systemGaps`. When a render has a drawable group, alphaTab's brackets are switched off on the rendered score, room is reserved through alphaTab's label and page paddings, and TabPlayer draws every accolade from `boundsLookup` staff bounds. Staff gaps cut each system's SVG into clipped, translated bands before D08 stacking, in the paginated layouts and export, through one compose core; overlays and hit testing map through the same band shift.

**Tech Stack:** TypeScript, React 19, alphaTab 1.8.4 (unmodified), Vitest 5, Rust (serde, usvg/svg2pdf export), Node desktop drivers over CDP.

**Spec:** `docs/superpowers/specs/2026-11-07-gp8-staff-groups-design.md`

## Global Constraints

- Old `.tabplayer` projects and edit logs replay unchanged. An absent field loads as empty and serializes without the field. Older builds refusing the new fields is a recorded limit.
- Without groups and gaps every screen and export output is byte-identical. Existing expectations in `page.test.ts`, `page-text.test.ts`, `pdf.test.ts`, `header-footer.test.ts`, `screen-pages.test.ts` and `system-gaps.render.test.ts` stay as they are (new cases may be appended), and Task 5 pins a hash of the no-groups export pages taken before any export code changes.
- Caps (TS and Rust): at most 64 groups; 2 to 64 ids per group; at most 256 staff gaps. Every id (group or gap) has length above zero (no trimming) and at most 65,536 UTF-8 bytes (`TextEncoder` in TS); an id is in at most one group, once; gap ids distinct; gap scale finite, 0.25 to 4.
- No new edit type; both fields ride on `setEngraving`. Saved styles reject both. No style-library version bump.
- alphaTab stays unmodified; its enums are reached as `model.BracketExtendMode` and `model.MusicFontSymbol`. Do not retune `src-tauri/src/audio/tone.rs`. Do not rename existing engraving labels ("Brackets", "System spacing (%)" and others); drivers use them.
- alphaTab writes music glyphs as decimal references inside `<g transform="translate(x y)" class="at" ><text style="font-size: N%; stroke:none">&#NNNNN;</text></g>`. TabPlayer's marks use the same shape. Tests search for `&#57344;` (brace), `&#57347;` (BracketTop) and `&#57348;` (BracketBottom), never raw characters.
- New UI text goes through `src/i18n` with `en`, `et`, `de`. Busy uses `busyGuard` (buttons), `busySelect` (selects) and `aria-disabled` with ignored changes (checkboxes, inputs), never `disabled`. One gesture is one `setEngraving`; choosing the current value records nothing.
- A staff-gap-only edit must not re-render alphaTab and must not restart native audio. A group edit re-renders the notation (it changes bracket mode and reserve) but stays a settings edit.
- No `it` may ship without an `expect`.
- Rust: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib style_library`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib export::pdf`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, in the default `src-tauri/target` (or `E:/cargo-target/slot-1..3` for tests only). Never a scratchpad target.
- TypeScript: `npm run typecheck` and the touched Vitest files via `npx vitest run <files>`.

## Review Focus

1. **Clicking a moved staff.** After 200% below the guitar, a click on a lower-track notehead selects that note, a cursor spanning all staves stretches over the added space, and a click inside the opened gap selects nothing. Test: Task 7 `maps a click on a moved staff and returns null inside an opened gap`.
2. **Track edits under a group.** Duplicating a middle member keeps the group drawn; moving a member away makes it `notContiguous`; removing a member of a two-track group makes it `tooFewTracks`; replaying the log without the move draws it again with no edit. Test: Task 1 `keeps a group drawable through duplicate and reports move and remove states`.
3. **Rendering a subset.** Showing or exporting one track of a group draws no group mark and gives back alphaTab's own brackets (the piano keeps its native brace). Test: Task 5 `a single rendered member draws no group and keeps alphaTab's native brace`.
4. **Names against marks and page width.** With long horizontal or vertical names, the names end left of every drawn mark, and the widened system still fits the usable page width. Test: Task 5 `names end left of every mark and systems fit the page with the reserve`.
5. **Gap-only edits and old documents.** A staff-gap edit repaginates from held chunks without another alphaTab render, and a document without the new fields exports byte-identical pages. Tests: Task 8 `a staff-gap-only change recomposes without another render` and Task 5 `exports the recorded no-groups pages byte for byte`.

---

### Task 1: Data model, validation, edit helpers, duplicate and style rejection (TypeScript)

**Files:**
- Create: `src/engraving/staff-groups.ts`, `src/engraving/staff-groups.test.ts`
- Modify: `src/engraving/types.ts` (types, two optional fields), `src/engraving/projection.ts` (`validateEngraving` conditional keys, `projection.ts:37`), `src/engraving/system-gaps.ts` (`withoutStackingOffsets`, `engravingRenderKey`, `system-gaps.ts:95-97`), `src/document-settings.ts` (`copyTrackSettings`, `:9`), `src/engraving/style-library.ts` (`styleOf`, `styleApplied`, `validateEntry`, `:19,23,37-45`), `src/engraving/EngravingPanel.tsx` (`apply`/`reset`, `:53-58`)
- Test: `src/engraving/staff-groups.test.ts`, `src/engraving/style-library.test.ts`, `src/engraving/EngravingPanel.test.tsx`, `src/engraving/replay.test.ts`

**Interfaces:**
- Consumes: `EngravingOverrides`, `validateEngraving`, `withSystemGaps`, `withBarWidths`, `copyTrackSettings(settings, source, copy)` (called from `engine.ts:397` after the identities are spliced).
- Produces (in `types.ts`):
  - `type StaffGroupKind='bracket'|'brace'`; `interface StaffGroup {trackIds:string[];kind:StaffGroupKind}`; `interface StaffGap {trackId:string;scale:number}`
  - `EngravingOverrides.staffGroups?:StaffGroup[]`, `EngravingOverrides.staffGaps?:StaffGap[]`
- Produces (in `staff-groups.ts`):
  - `const STAFF_GAP_RANGE={min:.25,max:4}`, `MAX_STAFF_GROUPS=64`, `MAX_GROUP_TRACKS=64`, `MAX_STAFF_GAPS=256`, `MAX_TRACK_ID_BYTES=65_536`
  - `validStaffTrackId(id:unknown):id is string` (string, length > 0, UTF-8 bytes ≤ cap)
  - `validateStaffGroups(value:unknown):asserts value is StaffGroup[]`, `validateStaffGaps(value:unknown):asserts value is StaffGap[]`
  - `withStaffGroups(e:EngravingOverrides,groups:readonly StaffGroup[]):EngravingOverrides`, `withStaffGaps(e,gaps:readonly StaffGap[]):EngravingOverrides` (key dropped when empty)
  - `type GroupState='drawn'|'tooFewTracks'|'notContiguous'|'notShown'`
  - `interface ResolvedGroup {index:number;kind:StaffGroupKind;tracks:number[]}` (`tracks`: ascending document track indices that are rendered)
  - `groupStates(groups:readonly StaffGroup[]|undefined,trackIds:readonly string[],rendered?:readonly number[]):GroupState[]`
  - `drawnGroups(groups:readonly StaffGroup[]|undefined,trackIds:readonly string[],rendered:readonly number[]):ResolvedGroup[]`
  - `type GroupingProblem='tooFew'|'notContiguous'|'alreadyGrouped'|'tooMany'`
  - `groupingProblem(e:EngravingOverrides,trackIds:readonly string[],members:readonly string[]):GroupingProblem|null`
  - `addStaffGroup(e,trackIds,members:readonly string[],kind:StaffGroupKind):EngravingOverrides` (throws on a problem; ids written in current track order)
  - `setStaffGroupKind(e,index:number,kind):EngravingOverrides`, `removeStaffGroup(e,index:number):EngravingOverrides`, `removeAllStaffGroups(e):EngravingOverrides`
  - `staffGapOf(e,trackId:string):number` (1 when absent)
  - `setStaffGap(e,trackId:string,scale:number):EngravingOverrides` (scale within 1e-9 of 1 removes), `resetStaffGap(e,trackId):EngravingOverrides`, `resetAllStaffGaps(e):EngravingOverrides`
  - `resolveStaffGaps(gaps:readonly StaffGap[]|undefined,trackIds:readonly string[]):Map<number,number>` (document track index → scale; dormant ids skipped)
  - `copyTrackStaffLayout(e,source:string,copy:string):EngravingOverrides`
  - `LONG_FIRST_SHORT_AFTER={singleNames:'allSystems',multiNames:'allSystems',firstNames:'full',otherNames:'short'} as const`
  - `isLongFirstShortAfter(e):boolean`, `withLongFirstShortAfter(e):EngravingOverrides`
  - Every helper returns the same object when nothing changes.
- Produces (in `system-gaps.ts`): `withoutStackingOffsets(e):EngravingOverrides` (drops `systemGaps` and `staffGaps`); `engravingRenderKey` keys on it.

- [ ] **Step 1: Write the failing tests** in `src/engraving/staff-groups.test.ts`

```ts
const ids=['base/0','base/1','base/2','base/3'],big='x'.repeat(65_537),multi='é'.repeat(32_769); // 65,538 bytes, 32,769 UTF-16 units
it('validates groups: shape, kinds, 2..64 ids, 64 groups, id bytes, flat',()=>{
  expect(()=>validateStaffGroups([{trackIds:['base/0','base/1'],kind:'brace'}])).not.toThrow();
  expect(()=>validateStaffGroups([{trackIds:[' ','b'],kind:'bracket'}])).not.toThrow(); // no trimming
  for(const bad of [[{trackIds:['base/0'],kind:'bracket'}],[{trackIds:['a','a'],kind:'bracket'}],[{trackIds:['a','b'],kind:'curly'}],
    [{trackIds:['a','b'],kind:'bracket'},{trackIds:['b','c'],kind:'brace'}],[{trackIds:['','b'],kind:'bracket'}],
    [{trackIds:['a','b'],kind:'bracket',extra:1}],Array.from({length:65},(_,i)=>({trackIds:[`x${i}`,`y${i}`],kind:'bracket'})),
    [{trackIds:Array.from({length:65},(_,i)=>`t${i}`),kind:'bracket'}],[{trackIds:[big,'b'],kind:'bracket'}],[{trackIds:[multi,'b'],kind:'bracket'}]])
    expect(()=>validateStaffGroups(bad)).toThrow();
});
it('validates gaps: ids like group ids, distinct, 0.25..4, at most 256',()=>{
  expect(()=>validateStaffGaps([{trackId:'base/0',scale:.25},{trackId:'base/1',scale:4}])).not.toThrow();
  for(const bad of [[{trackId:'a',scale:.24}],[{trackId:'a',scale:4.01}],[{trackId:'a',scale:NaN}],[{trackId:'a',scale:1},{trackId:'a',scale:2}],
    [{trackId:'',scale:2}],[{trackId:big,scale:2}],[{trackId:multi,scale:2}],[{trackId:'a',scale:2,x:1}],Array.from({length:257},(_,i)=>({trackId:`t${i}`,scale:2}))])
    expect(()=>validateStaffGaps(bad)).toThrow();
});
it('validateEngraving accepts both keys only when present and an old engraving without them',()=>{
  expect(()=>validateEngraving(defaultEngraving())).not.toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGroups:[{trackIds:['a','b'],kind:'brace'}],staffGaps:[{trackId:'a',scale:2}]})).not.toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGroups:'x'})).toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGaps:[{trackId:'',scale:2}]})).toThrow();
});
it('resolves states and drawn groups over the rendered subset',()=>{
  const groups=[{trackIds:['base/2','base/1'],kind:'bracket' as const},{trackIds:['base/0','base/3'],kind:'brace' as const},{trackIds:['gone','base/3'],kind:'brace' as const}];
  expect(groupStates(groups.slice(0,2),ids)).toEqual(['drawn','notContiguous']);
  expect(drawnGroups(groups.slice(0,1),ids,[0,1,2,3])).toEqual([{index:0,kind:'bracket',tracks:[1,2]}]);
  expect(drawnGroups(groups.slice(0,1),ids,[1])).toEqual([]);
  expect(groupStates(groups.slice(0,1),ids,[1])).toEqual(['notShown']);
  expect(groupStates([groups[2]],ids)).toEqual(['tooFewTracks']);
});
it('keeps a group drawable through duplicate and reports move and remove states',()=>{
  // fourTracks(): a blank project plus three addPitchedTrack edits; group = tracks 0..2 as a bracket via setEngraving.
  const {project,doc}=grouped(fourTracks(),[0,1,2]);
  const dup=buildDocument(previewEdit(project,{type:'duplicateTrack',track:1}).project);
  expect(dup.settings.engraving.staffGroups![0].trackIds).toHaveLength(4);
  expect(groupStates(dup.settings.engraving.staffGroups,identitiesOf(dup))).toEqual(['drawn']);
  const pair=grouped(fourTracks(),[0,1]).project,moved=previewEdit(pair,{type:'moveTrack',track:0,to:3}).project;
  expect(groupStates(buildDocument(moved).settings.engraving.staffGroups,identitiesOf(buildDocument(moved)))).toEqual(['notContiguous']);
  const replayed=buildDocument({...moved,edits:moved.edits.slice(0,-1)}); // the log without the move
  expect(groupStates(replayed.settings.engraving.staffGroups,identitiesOf(replayed))).toEqual(['drawn']);
  const removed=buildDocument(previewEdit(pair,{type:'removeTrack',track:1}).project);
  expect(groupStates(removed.settings.engraving.staffGroups,identitiesOf(removed))).toEqual(['tooFewTracks']);
  expect(removed.settings.engraving.staffGroups).toEqual(buildDocument(pair).settings.engraving.staffGroups);
  void doc;
});
it('a copy does not join a group already holding 64 ids',()=>{
  const full=withStaffGroups(defaultEngraving(),[{trackIds:Array.from({length:64},(_,i)=>`t${i}`),kind:'bracket'}]);
  expect(copyTrackStaffLayout(full,'t5','copy').staffGroups![0].trackIds).toHaveLength(64);
  expect(copyTrackStaffLayout(withStaffGroups(defaultEngraving(),[{trackIds:['a','b','c'],kind:'brace'}]),'b','copy').staffGroups![0].trackIds).toEqual(['a','b','copy','c']);
});
it('copies the source gap to a duplicate and leaves other tracks alone',()=>{
  const e=withStaffGaps(defaultEngraving(),[{trackId:'base/1',scale:2},{trackId:'base/2',scale:.5}]);
  expect(copyTrackStaffLayout(e,'base/1','added/5/x').staffGaps).toEqual([{trackId:'base/1',scale:2},{trackId:'base/2',scale:.5},{trackId:'added/5/x',scale:2}]);
  expect(copyTrackStaffLayout(e,'base/0','added/5/x')).toBe(e);
});
it('add, kind, remove and gap helpers return the same object when nothing changes',()=>{
  const e=defaultEngraving();
  expect(groupingProblem(e,ids,['base/0'])).toBe('tooFew');
  expect(groupingProblem(e,ids,['base/0','base/2'])).toBe('notContiguous');
  const grouped=addStaffGroup(e,ids,['base/2','base/1'],'bracket');
  expect(grouped.staffGroups).toEqual([{trackIds:['base/1','base/2'],kind:'bracket'}]);
  expect(groupingProblem(grouped,ids,['base/2','base/3'])).toBe('alreadyGrouped');
  expect(setStaffGroupKind(grouped,0,'bracket')).toBe(grouped);
  expect(setStaffGroupKind(grouped,0,'brace').staffGroups![0].kind).toBe('brace');
  expect(removeStaffGroup(grouped,0).staffGroups).toBeUndefined();
  expect(removeAllStaffGroups(e)).toBe(e);
  expect(setStaffGap(e,'base/0',1)).toBe(e);
  const gapped=setStaffGap(e,'base/0',2);expect(staffGapOf(gapped,'base/0')).toBe(2);expect(setStaffGap(gapped,'base/0',2)).toBe(gapped);
  expect(resetStaffGap(e,'base/0')).toBe(e);expect(resetAllStaffGaps(gapped).staffGaps).toBeUndefined();
  const named=withLongFirstShortAfter(e);expect(isLongFirstShortAfter(named)).toBe(true);expect(withLongFirstShortAfter(named)).toBe(named);
  expect(named.stylesheet.firstNameDirection).toBe(e.stylesheet.firstNameDirection);
});
it('engravingRenderKey ignores staff gaps but not staff groups',()=>{
  const e=defaultEngraving();
  expect(engravingRenderKey(withStaffGaps(e,[{trackId:'a',scale:2}]))).toBe(engravingRenderKey(e));
  expect(engravingRenderKey(withStaffGroups(e,[{trackIds:['a','b'],kind:'brace'}]))).not.toBe(engravingRenderKey(e));
});
```

`grouped`, `fourTracks` and `identitiesOf` are local helpers in the test file over `engine.ts` (`previewEdit`, `buildDocument`, `trackIdentity`).

Also add:
- `style-library.test.ts` `a saved style neither carries nor clears staff groups and gaps`: `styleOf(e)` has neither key; `styleApplied(style,current)` keeps `current.staffGroups` and `current.staffGaps`; a library entry with either throws "A saved style cannot hold staff groups." / "A saved style cannot hold staff gaps.".
- `EngravingPanel.test.tsx` `apply and reset keep staff groups and gaps`: with `value` carrying both, clicking "Apply engraving" and then "Reset to source/default" sends two commands whose `engraving.staffGroups` and `engraving.staffGaps` equal `value`'s.
- `replay.test.ts` `an old log without staff groups or gaps replays and serializes without the keys`: the built engraving has neither key and `JSON.stringify` of it contains neither `"staffGroups"` nor `"staffGaps"`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/engraving/staff-groups.test.ts src/engraving/style-library.test.ts src/engraving/EngravingPanel.test.tsx src/engraving/replay.test.ts`
Expected: FAIL ("Failed to resolve import ./staff-groups" and the new style, panel and replay cases).

- [ ] **Step 3: Implement the Interfaces above.**

`validateEngraving` gains `hasGroups`/`hasStaffGaps` conditional keys exactly like `hasGaps`. `copyTrackSettings` assigns `settings.engraving=copyTrackStaffLayout(settings.engraving,source,copy)` after copying the profile: the copy id goes right after the source id in the source's group unless the group holds 64 ids; a gap entry is appended unless 256 exist. `styleOf`/`styleApplied`/`validateEntry` follow the `systemGaps` pattern. `EngravingPanel` `apply()`/`reset()` wrap with `withStaffGaps(withStaffGroups(..., value.staffGroups??[]), value.staffGaps??[])`. Contiguity: map live member ids to document indices, sort, require `max−min+1===count`.

- [ ] **Step 4: Run to verify pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/staff-groups.ts src/engraving/staff-groups.test.ts src/engraving/types.ts src/engraving/projection.ts src/engraving/system-gaps.ts src/document-settings.ts src/engraving/style-library.ts src/engraving/style-library.test.ts src/engraving/EngravingPanel.tsx src/engraving/EngravingPanel.test.tsx src/engraving/replay.test.ts
git commit -m "feat: staff groups and staff gaps data model (D11, THE-180)"
```

---

### Task 2: Rust model, validation, style library, protocol tests and composed-SVG PDF acceptance

**Files:**
- Modify: `src-tauri/src/engraving.rs` (`EngravingOverrides`, `validate`, `:171-252`), `src-tauri/src/style_library.rs` (`SavedStyle::validate`, `:60-84`; test module `:219`), `src-tauri/src/export/pdf.rs` (test module `:136`)
- Test: `src-tauri/tests/engraving_protocol.rs`, `src-tauri/src/style_library.rs`, `src-tauri/src/export/pdf.rs`

**Interfaces:**
- Consumes: Task 1's JSON shapes and caps; the composed SVG shape fixed in Task 4.
- Produces:
  - `#[serde(rename_all = "lowercase")] pub enum StaffGroupKind { Bracket, Brace }`
  - `pub struct StaffGroup { pub track_ids: Vec<String>, pub kind: StaffGroupKind }`, `pub struct StaffGap { pub track_id: String, pub scale: f64 }`, both `rename_all = "camelCase", deny_unknown_fields`
  - `EngravingOverrides.staff_groups: Vec<StaffGroup>`, `.staff_gaps: Vec<StaffGap>`, each `#[serde(default, skip_serializing_if = "Vec::is_empty")]`
  - `pub const MAX_STAFF_GROUPS: usize = 64; MAX_GROUP_TRACKS: usize = 64; MAX_STAFF_GAPS: usize = 256; MAX_TRACK_ID_BYTES: usize = 65_536;`
  - `fn valid_staff_track_id(id: &str) -> bool` (`!id.is_empty() && id.len() <= MAX_TRACK_ID_BYTES`)
  - `fn validate_staff_groups(&self) -> Result<(), String>`, `fn validate_staff_gaps(&self) -> Result<(), String>`, called from `validate()`

- [ ] **Step 1: Write the failing tests**
  - `engraving_staff_groups_are_optional_flat_bounded_and_round_trip_only_when_set`: an engraving without the key serializes without `"staffGroups"`; one group round-trips equal; rejected: 1 id, duplicate id in a group, an id in two groups, `""`, a 65,537-byte id, 65 groups, 65 ids, kind `"curly"`, an unknown field. A `" "` id is accepted.
  - `engraving_staff_gaps_are_optional_distinct_bounded_and_round_trip_only_when_set`: round trip; rejected: scale 0.24, 4.01, NaN and infinity (set on the struct, as the system-gap test at `engraving_protocol.rs:483` does), duplicate id, `""`, a 65,537-byte id, 257 entries.
  - `engraving_staff_layout_survives_history_undo_redo_save_and_reopen_beside_an_old_log`: a copy of `engraving_system_gaps_survive_history_undo_redo_save_and_reopen_beside_an_old_log` (`:489`) whose edit carries both fields; the reopened history holds them, the old log still opens without them.
  - `style_library.rs` unit `saved_style_rejects_staff_groups_and_gaps`: errors equal "A saved style cannot hold staff groups." and "A saved style cannot hold staff gaps.".
  - `export/pdf.rs` unit `converts_composed_systems_with_defs_use_and_clip_paths`: a page built from `page()` whose body is replaced by the Task 4 composed shape, hand-written: `<svg ... height="440"><defs><g id="export-s0-content"><rect x="30" y="120" width="20" height="20"/><text x="100" y="250" font-family="Bravura" font-size="34">&#57424;</text></g><clipPath id="export-s0-c0"><rect x="0" y="-1" width="794" height="181"/></clipPath><clipPath id="export-s0-c1"><rect x="0" y="180" width="794" height="1000"/></clipPath></defs><g transform="translate(0 0)"><use href="#export-s0-content" clip-path="url(#export-s0-c0)"/></g><g transform="translate(0 40)"><use href="#export-s0-content" clip-path="url(#export-s0-c1)"/></g><g data-tp-accolade="group-brace" transform="translate(10 260)" class="at" ><text style="font-size: 300%; stroke:none">&#57344;</text></g></svg>`. Assert `notation_tree(&p, &export_options(), "PDF")` is `Ok`, and `convert_pages(&[p], &AtomicBool::new(false))` returns bytes starting with `%PDF-` and containing `/FontFile`. It writes no file.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol staff`
Expected: FAIL to compile (`no field staff_groups`). The `pdf.rs` test may already pass; it is acceptance evidence for the composed shape, so record its result either way.

- [ ] **Step 3: Implement the Interfaces above**, with errors "Staff groups must name 2 to 64 distinct tracks, each in one group only." and "Staff gaps must be 25% to 400% of the default, one per track.". If the `pdf.rs` test fails, stop and report: the composed shape in Task 4 must change before any TypeScript compose code is written.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib style_library`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib export::pdf`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
Expected: PASS; fmt clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/engraving.rs src-tauri/src/style_library.rs src-tauri/src/export/pdf.rs src-tauri/tests/engraving_protocol.rs
git commit -m "feat: native staff groups and staff gaps validation (D11, THE-180)"
```

---

### Task 3: Shared fixture, accolade plan and render configuration

**Files:**
- Create: `src/engraving/staff-fixtures.ts`, `src/engraving/accolades.ts`, `src/engraving/accolades.test.ts`
- Modify: `src/engraving/projection.ts` (`EngravingProjection`, `:10`; `projectEngraving`, `:57`)
- Test: `src/engraving/accolades.test.ts`, `src/engraving/projection.test.ts`

**Interfaces:**
- Consumes: `drawnGroups`, `ResolvedGroup`, `withStaffGroups` (Task 1).
- Produces:
  - `staff-fixtures.ts`: `threeTrackScore(options?:{bars?:number;names?:[string,string,string];shortNames?:[string,string,string]}):{score:model.Score;ids:string[]}` — Guitar6 (one staff, standard + tablature, Drop D), Grand Piano (two standard staves), Drums (one percussion staff); short names Gtr., Pno., Dr.; 12 bars by default, laid out as systems of 2, 2, 4, 2 and 2 bars through the model layout (`masterBar` system breaks, as the desktop engraving fixture), multi-track name policy first system only; `ids` are `base/0..2`. Used by Tasks 3, 4, 5, 6 and 8.
  - `EngravingProjection.bracketMode:number` — the rendered score's `stylesheet.bracketExtendMode` after overrides.
  - `interface AccoladeMetrics {scale:number;pad:number;bracketThickness:number;staffSpace:number;brace:{width:number;height:number};spike:{top:number;bottom:number}}` — render pixels (alphaTab units × `display.scale`) from `settings.display.resources.engravingSettings` and `accoladeBarPaddingRight`.
  - `accoladeMetrics(settings:Settings):AccoladeMetrics`
  - `const BRACE_MAX_X_SCALE=4`, `const LABEL_PADDING_RIGHT=3` (alphaTab's default `systemLabelPaddingRight`)
  - `interface AccoladePlan {groups:ResolvedGroup[];nativeMode:number;singleStaffBrackets:boolean;braceTracks:ReadonlySet<number>;inner:number;outer:number;reserve:number}` — `inner`, `outer`, `reserve` in alphaTab units; `braceTracks` are rendered tracks with more than one standard-notation staff.
  - `planAccolades(input:{engraving:EngravingOverrides;trackIds:readonly string[];rendered:readonly number[];score:model.Score;nativeMode:number;settings:Settings}):AccoladePlan|null` — null when no group is drawn.
  - `normalizedPadding(padding:readonly number[]|null|undefined):[number,number,number,number]` — null → `[0,0,0,0]`; one value → four equal; two `[h,v]` → `[h,v,h,v]`; four unchanged.
  - `configureAccolades(settings:Settings,score:model.Score,plan:AccoladePlan|null,nativeMode:number):void` — writes absolute values on every call: `score.stylesheet.bracketExtendMode` = `model.BracketExtendMode.NoBrackets` with a plan, else `nativeMode`; `settings.display.systemLabelPaddingRight = LABEL_PADDING_RIGHT + (plan ? plan.reserve : 0)`; with a plan, `settings.display.padding = normalizedPadding(padding)` with `reserve × display.scale` added to index 0 only. Called after the caller sets `scale` and `padding` on each render pass.

- [ ] **Step 1: Write the failing tests** in `src/engraving/accolades.test.ts` (fixture `threeTrackScore()`; `settings=new Settings()`)

```ts
const unit=new Settings().display.resources.engravingSettings,braceW=unit.glyphWidths.get(model.MusicFontSymbol.Brace)!,bar=unit.bracketThickness;
const plan=(groups:StaffGroup[],nativeMode=1,rendered=[0,1,2])=>planAccolades({engraving:withStaffGroups(defaultEngraving(),groups),trackIds:ids,rendered,score,nativeMode,settings});
it('plans nothing without a drawn group',()=>{ expect(plan([])).toBeNull(); expect(plan([{trackIds:['base/0','base/1'],kind:'bracket'}],1,[1])).toBeNull(); });
it('a bracket group over guitar and piano reserves an inner brace column and an outer bracket column',()=>{
  const p=plan([{trackIds:['base/0','base/1'],kind:'bracket'}])!;
  expect(p.groups).toEqual([{index:0,kind:'bracket',tracks:[0,1]}]);expect([...p.braceTracks]).toEqual([1]);
  expect(p.inner).toBeCloseTo(braceW*BRACE_MAX_X_SCALE);expect(p.outer).toBeCloseTo(bar);expect(p.reserve).toBeCloseTo(3+p.inner+3+p.outer);
});
it('with Brackets None the inner column is empty and the reserve is still pad + inner + pad + outer',()=>{
  const p=plan([{trackIds:['base/1','base/2'],kind:'brace'}],0)!;
  expect(p.inner).toBe(0);expect(p.outer).toBeCloseTo(braceW*BRACE_MAX_X_SCALE);expect(p.reserve).toBeCloseTo(3+0+3+p.outer);
});
it('configures absolute values, never accumulating across renders, and restores them without a plan',()=>{
  const p1=plan([{trackIds:['base/0','base/1'],kind:'bracket'}])!,p2=plan([{trackIds:['base/1','base/2'],kind:'brace'}])!;
  settings.display.scale=1.5;
  settings.display.padding=[35,35];configureAccolades(settings,score,p1,1);
  expect(score.stylesheet.bracketExtendMode).toBe(model.BracketExtendMode.NoBrackets);
  expect(settings.display.systemLabelPaddingRight).toBeCloseTo(3+p1.reserve);expect(settings.display.padding).toEqual([35+p1.reserve*1.5,35,35,35]);
  settings.display.padding=[0];configureAccolades(settings,score,p2,1);
  expect(settings.display.systemLabelPaddingRight).toBeCloseTo(3+p2.reserve);expect(settings.display.padding).toEqual([p2.reserve*1.5,0,0,0]);
  settings.display.padding=[0,0,0,0];configureAccolades(settings,score,null,1);
  expect(settings.display.systemLabelPaddingRight).toBe(3);expect(settings.display.padding).toEqual([0,0,0,0]);expect(score.stylesheet.bracketExtendMode).toBe(1);
});
it('normalizes padding shapes',()=>{
  expect(normalizedPadding(null)).toEqual([0,0,0,0]);expect(normalizedPadding([7])).toEqual([7,7,7,7]);
  expect(normalizedPadding([5,9])).toEqual([5,9,5,9]);expect(normalizedPadding([1,2,3,4])).toEqual([1,2,3,4]);
});
```

In `projection.test.ts` add `projectEngraving reports the effective bracket mode`: with `brackets:'none'` `bracketMode` is 0; with `'staves'` 1; with `'inherit'` it equals the source score's `stylesheet.bracketExtendMode`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/engraving/accolades.test.ts src/engraving/projection.test.ts`
Expected: FAIL (module missing; `bracketMode` undefined).

- [ ] **Step 3: Implement the Interfaces above.** Inner width: 0 when `nativeMode === 0`; otherwise `brace.width × BRACE_MAX_X_SCALE` if any rendered ungrouped track or bracket-group member draws as brace, else `bracketThickness` if any ungrouped rendered track could draw a bracket, else 0. Outer: `brace.width × BRACE_MAX_X_SCALE` if any drawn group is a brace, else `bracketThickness`. `reserve = pad + inner + pad + outer` always, as the spec states. `singleStaffBrackets` comes from the rendered `score.stylesheet.showSingleStaffBrackets`.

- [ ] **Step 4: Run to verify pass** — the Step 2 command and `npm run typecheck`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/staff-fixtures.ts src/engraving/accolades.ts src/engraving/accolades.test.ts src/engraving/projection.ts src/engraving/projection.test.ts
git commit -m "feat: plan drawn accolades and reserve their room (D11, THE-180)"
```

---

### Task 4: Staff bands, shift, marks and the one compose core

**Files:**
- Create: `src/engraving/staff-layout.ts`, `src/engraving/staff-layout.test.ts`
- Modify: `src/engraving/accolades.ts` (marks and their SVG)
- Test: `src/engraving/staff-layout.test.ts`

**Interfaces:**
- Consumes: `AccoladePlan`, `AccoladeMetrics` (Task 3); type `ScreenSystem` (`screen-pages.ts`).
- Module rule: `accolades.ts` imports nothing from `staff-layout.ts` except types (`import type {TrackBand}`); `staff-layout.ts` imports values from `accolades.ts`. No run-time cycle.
- Produces (in `staff-layout.ts`, y in render pixels of the whole render):
  - `interface TrackBand {track:number;top:number;bottom:number;staves:number}` — from each `BarBounds.realBounds`, grouped by `bar.staff.track.index`, in rendered order; `staves` = visible staff count in the system
  - `systemTrackBands(system:ScreenSystem):TrackBand[]`; `staffLeftOf(system:ScreenSystem):number` (`system.bars[0].realBounds.x`)
  - `interface StaffShift {cuts:number[];offsets:number[]}` — ascending cuts; `offsets[k]` is the cumulative shift for `cuts[k] ≤ y < cuts[k+1]`
  - `const TRACK_STAFF_PADDING=5`
  - `staffShift(bands:readonly TrackBand[],gaps:ReadonlyMap<number,number>,renderScale:number):StaffShift|null` — null when every offset is 0
  - `shiftY(shift:StaffShift|null|undefined,y:number,edge:'top'|'bottom'):number` — `'bottom'` treats `y` as an exclusive end
  - `unshiftY(shift:StaffShift|null|undefined,y:number):number|null` — null inside an opened gap; where a negative offset makes two moved bands overlap, the lower band wins
  - `shiftTotal(shift:StaffShift|null|undefined):number`
  - `composeSystemSvg(input:{svg:string;id:string;left:number;top:number;width:number;height:number;shift:StaffShift|null;marks:readonly AccoladeMark[]}):{svg:string;height:number}` — `left`/`top` are the chunk's render position; returns the input string unchanged when `shift` is null and `marks` is empty
  - `composeSystem(input:{svg:string;id:string;left:number;top:number;width:number;height:number;system:ScreenSystem;plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics}):{svg:string;height:number;shift:StaffShift|null}` — the one core: bands → `staffShift(bands,gaps,metrics.scale)` → `systemAccoladeMarks` → `composeSystemSvg`
- Produces (in `accolades.ts`):
  - `interface AccoladeMark {role:'group'|'track';kind:'bracket'|'brace';x:number;top:number;bottom:number;width:number}` (render pixels)
  - `systemAccoladeMarks(plan:AccoladePlan,bands:readonly TrackBand[],metrics:AccoladeMetrics,staffLeft:number):AccoladeMark[]` — plan widths are scaled by `metrics.scale`
  - `accoladeSvg(marks:readonly AccoladeMark[],origin:{left:number;top:number}):string` — marks already shifted by the caller; one `<g data-tp-accolade="<role>-<kind>">` per mark containing alphaTab's glyph shape (`<g transform="translate(x y)" class="at" ><text style="font-size: N%; stroke:none">&#NNNNN;</text></g>`) and, for a bracket, a `<rect>`

Offset per boundary (upper band `u`, next present band `l`): `measured=l.top−u.bottom`, `base=max(measured,TRACK_STAFF_PADDING×renderScale)`, `offset=max((scale−1)×base,−measured)`; cut at `u.bottom+measured/2`.

Composed shape (fixed; Task 2 converts it natively):
- with a shift: the original root `<svg>` attributes with `height` (and `viewBox` height when present) set to `height + shiftTotal`; `<defs><g id="<id>-content">original content</g><clipPath id="<id>-c<k>">` one full-width rectangle per band in chunk-local coordinates (first band from −1, last to `height + 1`)`</clipPath></defs>`; per band `<g transform="translate(0 <offset>)"><use href="#<id>-content" clip-path="url(#<id>-c<k>)"/></g>`; then the marks;
- marks without a shift: the original string with `accoladeSvg(...)` inserted before its final `</svg>`; no `<defs>`, no bands;
- mark y values are shifted with `shiftY(...,'top')` for `top` and `'bottom'` for `bottom` before `accoladeSvg`.

- [ ] **Step 1: Write the failing tests** in `src/engraving/staff-layout.test.ts` (`fakeSystem(bars)` builds a `ScreenSystem` from `{track,staff,y,h}` rows with `bar.staff.track.index` and `bar.staff.index` set; system: guitar 100–160, piano 200–240 and 260–300, drums 340–380; render scale 1)

```ts
it('builds one band per track from realBounds with its visible staves',()=>expect(systemTrackBands(system)).toEqual([{track:0,top:100,bottom:160,staves:1},{track:1,top:200,bottom:300,staves:2},{track:2,top:340,bottom:380,staves:1}]));
it('shifts below a 200% boundary by the measured gap',()=>{
  const shift=staffShift(bands,new Map([[0,2]]),1)!;
  expect(shift).toEqual({cuts:[180],offsets:[40]});
  expect(shiftY(shift,150,'top')).toBe(150);expect(shiftY(shift,250,'top')).toBe(290);
  expect(shiftY(shift,180,'bottom')).toBe(180);expect(shiftY(shift,380,'bottom')).toBe(420);
  expect(unshiftY(shift,190)).toBeNull();expect(unshiftY(shift,290)).toBe(250);expect(shiftTotal(shift)).toBe(40);
});
it('never shrinks below touching, floors the base at the track padding, and the lower band wins an overlap',()=>{
  const shrink=staffShift(bands,new Map([[0,.25]]),1)!;expect(shrink.offsets).toEqual([-30]);
  expect(unshiftY(shrink,165)).toBe(195); // 165 is inside both moved bands; the lower band (moved up by 30) wins
  const tight=[{track:0,top:0,bottom:10,staves:1},{track:1,top:11,bottom:20,staves:1}];
  expect(staffShift(tight,new Map([[0,2]]),2)!.offsets).toEqual([10]);expect(staffShift(tight,new Map([[0,.25]]),2)!.offsets).toEqual([-1]);
});
it('ignores the last track, absent tracks and 100%',()=>expect(staffShift(bands,new Map([[2,3],[0,1],[7,2]]),1)).toBeNull());
it('returns the same SVG string with no shift and no marks',()=>{const svg='<svg width="500" height="400"><text>x</text></svg>';expect(composeSystemSvg({svg,id:'s0',left:0,top:0,width:500,height:400,shift:null,marks:[]}).svg).toBe(svg);});
it('composes clipped, translated bands with the chunk-local cut and the new height',()=>{
  const out=composeSystemSvg({svg:'<svg width="500" height="400" viewBox="0 0 500 400"><rect y="20"/></svg>',id:'export-s4',left:0,top:100,width:500,height:400,shift:{cuts:[180],offsets:[40]},marks:[]});
  expect(out.height).toBe(440);expect(out.svg).toMatch(/^<svg\b[^>]*height="440"[^>]*viewBox="0 0 500 440"/);
  expect(out.svg.match(/<use\b/g)).toHaveLength(2);expect(out.svg).toContain('id="export-s4-content"');
  expect(out.svg).toContain('<rect x="0" y="80" width="500"');expect(out.svg).toContain('translate(0 40)');
});
it('inserts marks without bands when there is no shift',()=>{
  const out=composeSystemSvg({svg:'<svg width="500" height="400"><text>x</text></svg>',id:'s0',left:0,top:0,width:500,height:400,shift:null,marks:[{role:'group',kind:'brace',x:10,top:100,bottom:300,width:20}]});
  expect(out.height).toBe(400);expect(out.svg).not.toContain('<defs>');expect(out.svg).toMatch(/<text>x<\/text><g data-tp-accolade="group-brace"[\s\S]*&#57344;[\s\S]*<\/svg>$/);
});
it('places group marks outside track marks and spans moved staves',()=>{
  const p={groups:[{index:0,kind:'bracket' as const,tracks:[0,1]}],nativeMode:1,singleStaffBrackets:false,braceTracks:new Set([1]),inner:metrics.brace.width*4/metrics.scale,outer:metrics.bracketThickness/metrics.scale,reserve:0};
  const out=composeSystem({svg:'<svg width="500" height="400"></svg>',id:'s',left:0,top:0,width:500,height:400,system,plan:p,gaps:new Map([[0,2]]),metrics});
  const marks=markBoxes(out.svg); // parses data-tp-accolade groups: role, kind, x, top, bottom (bracket: from its rect; brace: translate y and font-size)
  const group=marks.find(m=>m.role==='group')!,brace=marks.find(m=>m.kind==='brace')!;
  expect(brace.x+brace.width).toBeCloseTo(60-metrics.pad,1);expect(group.x+group.width).toBeLessThanOrEqual(brace.x-metrics.pad+1e-6);
  expect(group.top).toBeCloseTo(100-metrics.staffSpace/4-3,1);expect(group.bottom).toBeCloseTo(300+40+metrics.staffSpace/4+3,1); // spans the moved piano
  expect(brace.bottom).toBeCloseTo(340,1);expect(brace.width).toBeLessThanOrEqual(metrics.brace.width*BRACE_MAX_X_SCALE+1e-6);
});
it('draws a one-staff group only with single staff brackets',()=>{
  const only=fakeSystem([{track:0,staff:0,y:100,h:60}]);const p=(single:boolean)=>({groups:[{index:0,kind:'bracket' as const,tracks:[0,1]}],nativeMode:1,singleStaffBrackets:single,braceTracks:new Set<number>(),inner:0,outer:1,reserve:0});
  expect(systemAccoladeMarks(p(false),systemTrackBands(only),metrics,60).filter(m=>m.role==='group')).toEqual([]);
  expect(systemAccoladeMarks(p(true),systemTrackBands(only),metrics,60).filter(m=>m.role==='group')).toHaveLength(1);
});
```

`metrics` is `accoladeMetrics(new Settings())`; `markBoxes` is a local helper in the test using `DOMParser`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/staff-layout.test.ts`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement the Interfaces above.** Chunk-local coordinates are `x − left`, `y − top`.

- [ ] **Step 4: Run to verify pass** — the Step 2 command and `npm run typecheck`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/staff-layout.ts src/engraving/staff-layout.test.ts src/engraving/accolades.ts
git commit -m "feat: staff bands, accolade marks and system composition (D11, THE-180)"
```

---

### Task 5: Export wiring and render-level proof

**Files:**
- Create: `src/engraving/staff-render-helpers.ts`, `src/engraving/staff-groups.render.test.ts`
- Modify: `src/export/types.ts` (`SvgSystem`, `:10`), `src/export/pdf.ts` (`renderPdfPages`, `:64-100`), `src/engraving/staff-layout.ts` (`composeEngravedSystems`)
- Test: `src/engraving/staff-groups.render.test.ts`, `src/engraving/staff-layout.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4; `threeTrackScore`.
- Produces:
  - `SvgSystem.top?:number` and `SvgSystem.left?:number` — the chunk's render position from `RenderFinishedEventArgs` `y`/`x`, set for chunks with `firstMasterBarIndex ≥ 0` (handler at `pdf.ts:93`).
  - `composeEngravedSystems(systems:SvgSystem[],bounds:ScreenBounds,input:{plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics;idPrefix:string}):SvgSystem[]` in `staff-layout.ts` — calls `composeSystem` per system matched to bounds by `firstBar`, with id `<idPrefix>-s<firstBar>`; chunks without `firstBar` unchanged; returns the input array when nothing composes.
  - `renderPdfPages` (frozen path): keep the whole projection (today only `.score` is kept, `pdf.ts:78`); `planAccolades` over `selection.tracks` with `projection.bracketMode`; `configureAccolades` after `scale` and `padding` are set (`pdf.ts:85`). After rendering, in this order: the width check and `assertTextFits` on the raw systems (`pdf.ts:95-97`), then `composeEngravedSystems(..., {idPrefix:'export'})` with `resolveStaffGaps(engraving.staffGaps, trackIds)`, then the unchanged `paginateEngravedSystems`.
  - `staff-render-helpers.ts` (used by Tasks 5 and 6): `exportPages(input:{engraving:EngravingOverrides;rendered?:number[];score?:model.Score;ids?:string[];page?:PageLayout}):SvgPage[]` (A4, scale 1, `threeTrackScore()` by default); `pagesHash(pages:SvgPage[]):string` (SHA-256 hex of `JSON.stringify(pages)`); `withoutMarks(svg:string):string` (removes every `<g data-tp-accolade=...>...</g>`); `countText(svg:string,needle:string):number`; `markBoxes(svg:string)`, `nameBoxes(svg:string)` (text items whose content is a track name, with their right edge from `x` and the measured width), `systemBoxes(svg:string)` (each system's translate and width from `paginateEngravedSystems`' `<g transform="translate(left y)">`, matched only on direct children of the page root, so band wrappers are ignored); `systemTexts(input):string[][]` (text content per system, in order).

- [ ] **Step 1: Record the baseline hash before any code changes**

Create `staff-render-helpers.ts` with `exportPages` and `pagesHash` only, and a temporary test that prints `pagesHash(exportPages({engraving:defaultEngraving()}))`. Run it on the unchanged code: `npx vitest run src/engraving/staff-groups.render.test.ts`. Copy the printed hex into the test as `const NO_GROUPS_SHA256='<hex>'` and delete the print.

- [ ] **Step 2: Write the failing tests** in `src/engraving/staff-groups.render.test.ts`

```ts
const grouped=(kind:StaffGroupKind,trackIds:string[],e=defaultEngraving())=>withStaffGroups(e,[{trackIds,kind}]);
it('exports the recorded no-groups pages byte for byte',()=>{
  expect(pagesHash(exportPages({engraving:defaultEngraving()}))).toBe(NO_GROUPS_SHA256);
  expect(exportPages({engraving:withStaffGaps(withStaffGroups(defaultEngraving(),[]),[])})).toEqual(exportPages({engraving:defaultEngraving()}));
});
it('a bracket group draws one group bracket per system and turns alphaTab brackets off',()=>{
  const svg=exportPages({engraving:grouped('bracket',['base/0','base/1'])}).map(p=>p.svg).join(''),systems=systemBoxes(svg).length;
  expect(countText(svg,'data-tp-accolade="group-bracket"')).toBe(systems);
  expect(countText(svg,'data-tp-accolade="track-brace"')).toBe(systems);
  expect(countText(withoutMarks(svg),'&#57347;')).toBe(0);expect(countText(withoutMarks(svg),'&#57344;')).toBe(0);
});
it('a brace group spans guitar top to piano bottom on every system',()=>{
  const {svg,bounds}=exportWithBounds({engraving:grouped('brace',['base/0','base/1'])});
  for(const [index,mark] of markBoxes(svg).filter(m=>m.role==='group').entries()){expect(mark.top).toBeCloseTo(bounds[index].guitarTop,0);expect(mark.bottom).toBeCloseTo(bounds[index].pianoBottom,0);}
});
it('the drawn piano brace sits where alphaTab drew it',()=>{
  const native=braceBaselines(exportPages({engraving:{...defaultEngraving(),stylesheet:{...defaultEngraving().stylesheet,brackets:'staves'}}}));
  const drawn=markBoxes(exportPages({engraving:grouped('bracket',['base/0','base/1'])}).map(p=>p.svg).join('')).filter(m=>m.role==='track'&&m.kind==='brace').map(m=>m.bottom);
  expect(drawn).toHaveLength(native.length);drawn.forEach((y,i)=>expect(Math.abs(y-native[i])).toBeLessThanOrEqual(1));
});
it('a single rendered member draws no group and keeps alphaTab\'s native brace',()=>{
  const svg=exportPages({engraving:grouped('bracket',['base/0','base/1']),rendered:[1]}).map(p=>p.svg).join('');
  expect(svg).not.toContain('data-tp-accolade');expect(countText(svg,'&#57344;')).toBeGreaterThan(0);
});
it('names end left of every mark and systems fit the page with the reserve',()=>{
  const {score,ids}=threeTrackScore({names:['A very long guitar part name','Grand Piano','Drums']});
  for(const direction of ['horizontal','vertical'] as const){
    const e=grouped('brace',['base/1','base/2'],withLongFirstShortAfter({...defaultEngraving(),stylesheet:{...defaultEngraving().stylesheet,firstNameDirection:direction,otherNameDirection:direction}}));
    for(const page of exportPages({engraving:e,score,ids})){const names=nameBoxes(page.svg),marks=markBoxes(page.svg);
      expect(names.length).toBeGreaterThan(0);expect(Math.max(...names.map(n=>n.right))).toBeLessThanOrEqual(Math.min(...marks.map(m=>m.x))+.5);
      for(const s of systemBoxes(page.svg))expect(s.left+s.width).toBeLessThanOrEqual(usableRight(page)+1);}
  }
});
it('a 200% gap below the guitar moves piano and drums, not the guitar, by the measured gap',()=>{
  const base=exportWithBounds({engraving:defaultEngraving()}),gapped=exportWithBounds({engraving:withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}])});
  const measured=base.bounds[0].pianoTop-base.bounds[0].guitarBottom;
  expect(gapped.systemHeights[0]-base.systemHeights[0]).toBeCloseTo(measured,0);
  expect(gapped.trackTops[0]).toEqual([base.trackTops[0][0],base.trackTops[0][1]+measured,base.trackTops[0][2]+measured].map(v=>expect.closeTo(v,0)));
});
it('staff gaps compose before system gaps',()=>{
  const e=withSystemGaps(withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}]),[{bar:4,scale:2}]),pages=exportWithBounds({engraving:e});
  // the third system (bars 5-8 of the fixture's [2,2,4,2,2] layout) sits below the second by the composed height of the second plus the D08 offset 20 x 1 x 1
  expect(pages.systemTops[2]-pages.systemTops[1]).toBeCloseTo(pages.systemHeights[1]+20,0);
});
it('keeps refusing text that does not fit when staff gaps are set',()=>{
  const {score,ids}=threeTrackScore({names:['W'.repeat(400),'Grand Piano','Drums']});
  const e=withStaffGaps({...withLongFirstShortAfter(defaultEngraving()),typography:{family:'serif',textScale:3,titleScale:null,tabScale:null}},[{trackId:'base/0',scale:2}]);
  expect(()=>exportPages({engraving:e,score,ids})).toThrow(/fit/);
});
```

`exportWithBounds`, `braceBaselines` and `usableRight` are helpers in `staff-render-helpers.ts` (`exportWithBounds` returns pages joined plus per-system `guitarTop`, `guitarBottom`, `pianoTop`, `pianoBottom`, `trackTops`, `systemTops`, `systemHeights` read from the renderer's `boundsLookup` mapped into page coordinates; `braceBaselines` returns the y of each native `&#57344;` glyph's translate).

In `staff-layout.test.ts` add `composeEngravedSystems ids systems by first bar and leaves title chunks alone`: two systems with `firstBar` 0 and 4 and a title chunk without one; with a shift on both, the output ids are `export-s0-content` and `export-s4-content`, the title chunk is the same object, and with no plan and no gaps the input array is returned.

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/engraving/staff-groups.render.test.ts src/engraving/staff-layout.test.ts`; Expected: the hash test PASSES, the rest FAIL (no `data-tp-accolade`, gap not applied, `composeEngravedSystems` missing).

- [ ] **Step 4: Implement the Interfaces above.**

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/engraving/staff-groups.render.test.ts src/engraving/staff-layout.test.ts src/engraving/system-gaps.render.test.ts src/engraving/page.test.ts src/export/pdf.test.ts src/engraving/header-footer.test.ts src/engraving/page-text.test.ts` and `npm run typecheck`
Expected: PASS; existing expectations unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/export/types.ts src/export/pdf.ts src/engraving/staff-layout.ts src/engraving/staff-layout.test.ts src/engraving/staff-render-helpers.ts src/engraving/staff-groups.render.test.ts
git commit -m "feat: draw staff groups and staff gaps in export (D11, THE-180)"
```

---

### Task 6: Names proof, long first and short after

**Files:**
- Create: `src/engraving/staff-names.render.test.ts`

**Interfaces:**
- Consumes: `withLongFirstShortAfter` (Task 1), `threeTrackScore` (Task 3), `systemTexts` (Task 5's helper module).
- Produces: evidence only. If a test fails, fix the defect in the file that owns it (`staff-groups.ts` for the helper) and add that file to this task's commit.

- [ ] **Step 1: Write the tests** (real renderer, page narrow enough for at least three systems)

```ts
it('multi-track: full names on system 0, short names on later systems',()=>{
  const systems=systemTexts({engraving:withLongFirstShortAfter(defaultEngraving())});
  expect(systems.length).toBeGreaterThanOrEqual(3);
  expect(systems[0]).toEqual(expect.arrayContaining(['Guitar6','Grand Piano','Drums']));
  for(const later of systems.slice(1)){expect(later).toEqual(expect.arrayContaining(['Gtr.','Pno.','Dr.']));expect(later).not.toContain('Guitar6');}
});
it('single-track render follows the same rule',()=>{
  const systems=systemTexts({engraving:withLongFirstShortAfter(defaultEngraving()),rendered:[0]});
  expect(systems[0]).toContain('Guitar6');for(const later of systems.slice(1)){expect(later).toContain('Gtr.');expect(later).not.toContain('Guitar6');}
});
it('an empty short name falls back to the first 10 characters of the name',()=>{
  const {score,ids}=threeTrackScore({names:['Rhythm guitar two','Grand Piano','Drums'],shortNames:['','Pno.','Dr.']});
  expect(systemTexts({engraving:withLongFirstShortAfter(defaultEngraving()),score,ids})[1]).toContain('Rhythm gui');
});
it('without the option, names keep the source policy',()=>{
  const systems=systemTexts({engraving:defaultEngraving()});
  expect(systems[1]).not.toContain('Gtr.');
});
```

- [ ] **Step 2: Run** — `npx vitest run src/engraving/staff-names.render.test.ts`; Expected: PASS with the Task 1 helper. The fourth test is the control: it fails if the fixture's source policy already shows names on every system, in which case set the fixture's source `multiTrackTrackNamePolicy` to first system in `threeTrackScore` and rerun.

- [ ] **Step 3: Commit**

```bash
git add src/engraving/staff-names.render.test.ts
git commit -m "test: prove long names first and short names after (D11, THE-180)"
```

---

### Task 7: Screen pagination, mapping and hit testing through the band shift

**Files:**
- Modify: `src/engraving/screen-pages.ts` (`ScreenRenderChunk`, `paginateScreenScore`, `mapScreenRect`, `unmapScreenPoint`)
- Test: `src/engraving/screen-pages.test.ts`

**Interfaces:**
- Consumes: `StaffShift`, `shiftY`, `unshiftY`, `shiftTotal` (Task 4).
- Produces:
  - `ScreenRenderChunk.shift?:StaffShift` (render coordinates). `ScreenRenderChunk.height` stays the render-space height; the composed height is `height + shiftTotal(shift)`.
  - `paginateScreenScore` builds `sourceBounds` from the chunk rect and the system bounds with each bottom mapped through `shiftY(shift,bottom,'bottom')`, so the block height equals `composeSystemSvg`'s height even when the chunk rect is taller than the system bounds. Unchanged without `shift`.
  - `mapScreenRect` maps `rect.y` with `shiftY(...,'top')` and `rect.y+rect.h` with `shiftY(...,'bottom')`.
  - `unmapScreenPoint` inverts through `unshiftY`; a point in an opened gap returns null. `hitTestScreenPages` inherits this.

- [ ] **Step 1: Write the failing tests** in `screen-pages.test.ts` (`shiftedFixture()` builds two systems whose first has bars guitar 100–160 and piano 200–300 with a piano notehead at y 250, chunk rect 0–400 (taller than the system bounds 90–310), shift `{cuts:[180],offsets:[40]}`; arrangement scale 1, one page)

```ts
it('paginates a shifted chunk with its composed height, including a chunk taller than its system',()=>{
  const {p,plain}=shiftedFixture();
  expect(p.blocks[0].sourceBounds.h).toBe(440);expect(p.blocks[1].y-p.blocks[0].y).toBe(plain.blocks[1].y-plain.blocks[0].y+40);
});
it('maps a click on a moved staff and returns null inside an opened gap',()=>{
  const {p,a,system,pianoNote,toScreen}=shiftedFixture();
  expect(unmapScreenPoint(p,a,toScreen(10,290))!.point.y).toBe(250);
  expect(unmapScreenPoint(p,a,toScreen(10,190))).toBeNull();
  expect(hitTestScreenPages(p,a,toScreen(pianoNote.x,290))!.note).toBe(pianoNote.note);
  expect(unmapScreenPoint(p,a,toScreen(10,150))!.system).toBe(system);
});
it('stretches a rect spanning the cut',()=>{const {p,a,system}=shiftedFixture();expect(mapScreenRect(p,a,system,{x:0,y:100,w:10,h:200})!.h).toBe(240);});
it('places unshifted blocks exactly where they were',()=>{const {plain,plainAgain}=shiftedFixture();expect(plainAgain.blocks.map(b=>[b.page,b.x,b.y,b.sourceBounds])).toEqual(plain.blocks.map(b=>[b.page,b.x,b.y,b.sourceBounds]));});
```

`plain` paginates the same chunks without `shift`; `plainAgain` paginates them with `shift: undefined` set explicitly.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/screen-pages.test.ts`; Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the Interfaces above.**

- [ ] **Step 4: Run to verify pass** — the Step 2 command; Expected: PASS, existing cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/screen-pages.ts src/engraving/screen-pages.test.ts
git commit -m "feat: map screen overlays and hits through moved staves (D11, THE-180)"
```

---

### Task 8: ScoreView wiring: compose on paged layouts, overlay marks elsewhere, no re-render for gaps

**Files:**
- Modify: `src/ScoreView.tsx` (memos `:88-110`, padding `:382`, chunk boxes `:553`), `src/App.tsx` (ScoreView call `:856`), `src/engraving/staff-layout.ts` (`composeScreenChunks`), `src/engraving/system-gaps.ts` (remove `withoutSystemGaps`)
- Test: `src/ScoreView.layouts.test.tsx`, `src/engraving/staff-layout.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 7; `withoutStackingOffsets`, `engravingRenderKey`.
- Produces:
  - `ScoreView` prop `trackIds?:readonly string[]` (document track identities; `App` passes its `trackIds`, `App.tsx:239`).
  - The render path uses `withoutStackingOffsets(engraving)`; staff gaps are memoized separately on `JSON.stringify(engraving?.staffGaps??null)`, like `systemGaps`. `withoutSystemGaps` loses its last caller (`ScoreView.tsx:90`) and is deleted; it has no test.
  - The accolade plan is null unless both `projection` and `trackIds` are present; without a plan the source score is never written. Before each `renderScore`: `planAccolades` over the visible tracks with `projection.bracketMode`, then `configureAccolades(view.settings, projection.score, plan, projection.bracketMode)` after padding and scale are set (`:382`).
  - `composeScreenChunks(chunks:readonly ScreenRenderChunk[],bounds:ScreenBounds,input:{plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics}):ScreenRenderChunk[]` in `staff-layout.ts` — calls `composeSystem` per system chunk with id `tp-<chunk.id>`, `left = chunk.x`, `top = chunk.y`, and attaches `shift`; `height` stays render-space; returns the input array when nothing composes.
  - Paged layouts: the `paged` memo composes the held chunks before `paginateScreenScore`; its dependencies gain the staff-gap memo and the plan. Each chunk box's height is `chunk.height + shiftTotal(chunk.shift)`.
  - Continuous layouts: one `<svg data-tp-accolades aria-hidden="true" style="pointer-events:none">` overlay over the alphaTab surface, drawn from `api.boundsLookup` with `systemAccoladeMarks` and `accoladeSvg(marks,{left:0,top:0})` after each completed render; empty without a plan. No staff gaps there.

- [ ] **Step 1: Extend the test fake and write the failing tests**

Fake changes in `ScoreView.layouts.test.tsx`: the render emits, per system, one `BarBounds` per staff of every rendered track (guitar 100–160, piano 200–300, drums 340–380 offset by `i*450`) with `.bar` set to the score's bar of that staff, so `bar.staff.track.index` resolves; chunks keep `y=i*450`, `height=400`; `settings.display` keeps `padding`, `scale` and `systemLabelPaddingRight`. Tests pass `projection=projectEngraving(score,ids,engraving)` and `trackIds=ids` from `threeTrackScore()`.

```ts
it('a staff-gap-only change recomposes without another render',()=>{
  const {rerender,renders,blockTops}=mountPaged(defaultEngraving());const before=renders(),tops=blockTops();
  rerender(withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}]));
  expect(renders()).toBe(before);expect(blockTops()[1]-tops[1]).toBe(40);
});
it('a group change renders again with no brackets and the reserve',()=>{
  const {rerender,renders,view,projection}=mountPaged(defaultEngraving());const before=renders();
  const e=withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]);rerender(e);
  const plan=planAccolades({engraving:e,trackIds:ids,rendered:[0,1,2],score:projection().score,nativeMode:projection().bracketMode,settings:view().settings})!;
  expect(renders()).toBe(before+1);expect(projection().score.stylesheet.bracketExtendMode).toBe(model.BracketExtendMode.NoBrackets);
  expect(view().settings.display.systemLabelPaddingRight).toBeCloseTo(3+plan.reserve);expect(view().settings.display.padding[0]).toBeCloseTo(plan.reserve);
});
it('label padding stays absolute across group edits and returns to 3 when the last group goes',()=>{
  const {rerender,view}=mountPaged(defaultEngraving());
  const g1=withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),g2=withStaffGroups(defaultEngraving(),[{trackIds:['base/1','base/2'],kind:'brace'}]);
  rerender(g1);const r1=view().settings.display.systemLabelPaddingRight;rerender(g2);const r2=view().settings.display.systemLabelPaddingRight;rerender(defaultEngraving());
  expect(r1).toBeCloseTo(3+reserveOf(g1));expect(r2).toBeCloseTo(3+reserveOf(g2));expect(view().settings.display.systemLabelPaddingRight).toBe(3);
});
it('without projection or trackIds no plan is made and the source score is untouched',()=>{
  const {score}=threeTrackScore(),mode=score.stylesheet.bracketExtendMode;
  mountPaged(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),{projection:undefined,trackIds:undefined,score});
  expect(score.stylesheet.bracketExtendMode).toBe(mode);expect(document.querySelector('[data-tp-accolade]')).toBeNull();
});
it('continuous layouts draw marks in an overlay that ignores clicks and ignore staff gaps',()=>{
  const {container,chunkTops}=mountContinuous(withStaffGaps(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),[{trackId:'base/0',scale:2}]));
  const overlay=container.querySelector('svg[data-tp-accolades]')!;
  expect(overlay.querySelectorAll('[data-tp-accolade="group-bracket"]')).toHaveLength(3);expect((overlay as SVGElement).style.pointerEvents).toBe('none');
  expect(chunkTops()).toEqual([0,450,900]);
});
it('paged layouts put marks inside the composed chunks and size the boxes by the composed height',()=>{
  const {container}=mountPaged(withStaffGaps(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),[{trackId:'base/0',scale:2}]));
  const boxes=[...container.querySelectorAll<HTMLElement>('.score-svg-chunk')];
  expect(boxes[0].innerHTML).toContain('data-tp-accolade="group-bracket"');expect(boxes[0].style.height).toBe('440px');
});
```

`mountPaged`, `mountContinuous` and `reserveOf` are local helpers over the extended fake (`verticalPage` and `parchment` layouts).

In `staff-layout.test.ts` add `composeScreenChunks keeps render-space height and attaches the shift`: with a 200% gap the returned chunk has `height` 400, `shift` `{cuts:[180],offsets:[40]}` and an `svg` containing `id="tp-chunk-0-content"`; with no plan and no gaps the input array is returned.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/ScoreView.layouts.test.tsx src/engraving/staff-layout.test.ts`; Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the Interfaces above.** Keep D08's gap memo and `onSystems` reporting unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/ScoreView.layouts.test.tsx src/ScoreView.test.tsx src/engraving/staff-layout.test.ts src/engraving/screen-pages.test.ts src/engraving/system-gaps.test.ts src/App.test.tsx` and `npm run typecheck`
Expected: PASS. (`ScoreView.test.tsx`, `system-gaps.test.ts` and `App.test.tsx` are run unchanged as regression checks.)

- [ ] **Step 5: Commit**

```bash
git add src/ScoreView.tsx src/ScoreView.layouts.test.tsx src/App.tsx src/engraving/staff-layout.ts src/engraving/staff-layout.test.ts src/engraving/system-gaps.ts
git commit -m "feat: show staff groups and staff gaps on screen (D11, THE-180)"
```

---

### Task 9: Staff groups panel

**Files:**
- Create: `src/engraving/StaffGroupsPanel.tsx`, `src/engraving/StaffGroupsPanel.test.tsx`
- Modify: `src/App.tsx` (after `SystemGapsPanel` in `presentationTools`, `:875`), `src/i18n/en.ts`, `src/i18n/et.ts`, `src/i18n/de.ts`
- Test: `src/engraving/StaffGroupsPanel.test.tsx`, `src/i18n/i18n.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers and states; `busyGuard`, `busySelect` (`src/ui`).
- Produces:
  - `interface StaffGroupsPanelProps {value:EngravingOverrides;score:model.Score;trackIds:readonly string[];rendered:readonly number[];pageLayout:boolean;busy:boolean;locked?:boolean;onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown}`
  - `StaffGroupsPanel(props:StaffGroupsPanelProps)`
  - "Last track" means the last index in `rendered`.
  - English catalog (`en.ts`), keys under `staff_groups.`; `et` and `de` translate them:

| Key | English |
|---|---|
| `title` | Design: staff groups |
| `help` | Group neighbouring tracks under a bracket or brace, and set the space below a track as a percentage of the default (25 to 400). Saved with the document and printed; never changes timing. |
| `choose_track` | Include {name} |
| `kind` | Group mark |
| `kind_bracket` | Bracket |
| `kind_brace` | Brace |
| `create` | Group chosen tracks |
| `problem_tooFew` | Choose at least two tracks. |
| `problem_notContiguous` | Choose tracks that are next to each other. |
| `problem_alreadyGrouped` | A chosen track is already in a group. |
| `problem_tooMany` | This document already has 64 groups. |
| `group_label` | Group: {names} |
| `removed_track` | removed track |
| `state_drawn` | Drawn. |
| `state_tooFewTracks` | Not drawn: fewer than two of its tracks remain. |
| `state_notContiguous` | Not drawn: its tracks are no longer next to each other. |
| `state_notShown` | Not drawn in this view: fewer than two of its tracks are shown. |
| `remove` | Remove group |
| `remove_all` | Remove all groups |
| `gap_track` | Space below |
| `gap_field` | Staff gap (%) |
| `gap_reset` | Reset |
| `gap_reset_all` | Reset all staff gaps |
| `gap_last` | This is the last shown track, so there is no space below it to change in this view. |
| `gap_layout` | Staff gaps show only in the page layouts and in export. |
| `gap_invalid` | Enter a staff gap from {min} to {max}%. |
| `status_locked` | This document is locked. |
| `names_long_first` | Long names first, short after |
| `names_long_first_help` | Full track names on the first system, short names on every later system. |
| `names_already` | Names already show long first and short after. |

- [ ] **Step 1: Write the failing tests** in `StaffGroupsPanel.test.tsx` (`threeTrackScore()`, `ids`, `rendered=[0,1,2]`, `onEdit=vi.fn()`)

```ts
it('creating a group from two adjacent checked tracks is one command',async()=>{
  setup();await user.click(screen.getByLabelText('Include Guitar6'));await user.click(screen.getByLabelText('Include Grand Piano'));
  await user.selectOptions(screen.getByLabelText('Group mark'),'brace');await user.click(screen.getByRole('button',{name:'Group chosen tracks'}));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGroups).toEqual([{trackIds:['base/0','base/1'],kind:'brace'}]);
});
it('create is unavailable with a reason for one track or a gap in the run',async()=>{
  setup();const create=screen.getByRole('button',{name:'Group chosen tracks'});
  expect(create).toHaveAttribute('aria-disabled','true');expect(screen.getByText('Choose at least two tracks.')).toBeInTheDocument();
  await user.click(screen.getByLabelText('Include Guitar6'));await user.click(screen.getByLabelText('Include Drums'));
  expect(screen.getByText('Choose tracks that are next to each other.')).toBeInTheDocument();await user.click(create);expect(onEdit).not.toHaveBeenCalled();
});
it('a grouped track blocks a new group with a reason',async()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));
  await user.click(screen.getByLabelText('Include Grand Piano'));await user.click(screen.getByLabelText('Include Drums'));
  expect(screen.getByText('A chosen track is already in a group.')).toBeInTheDocument();
});
it('changing a group kind is one command and choosing the current kind records nothing',async()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));const kind=screen.getByLabelText('Group mark: Group: Guitar6, Grand Piano');
  await user.selectOptions(kind,'bracket');expect(onEdit).not.toHaveBeenCalled();
  await user.selectOptions(kind,'brace');expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGroups[0].kind).toBe('brace');
});
it('shows each stored group state, including a removed track',()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['gone','base/2'],kind:'brace'},{trackIds:['base/0','base/2'],kind:'bracket'}]));
  expect(screen.getByText('Group: removed track, Drums')).toBeInTheDocument();
  expect(screen.getByText('Not drawn: fewer than two of its tracks remain.')).toBeInTheDocument();
  expect(screen.getByText('Not drawn: its tracks are no longer next to each other.')).toBeInTheDocument();
});
it('remove and remove all are single commands and unavailable when there is nothing to remove',async()=>{
  setup();expect(screen.getByRole('button',{name:'Remove all groups'})).toHaveAttribute('aria-disabled','true');
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));
  await user.click(screen.getByRole('button',{name:'Remove group'}));expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGroups).toBeUndefined();
  await user.click(screen.getByRole('button',{name:'Remove all groups'}));expect(onEdit).toHaveBeenCalledTimes(2);
});
it('a staff gap commits on Enter and blur, rejects 24 and 401, and the current value records nothing',async()=>{
  setup();const field=screen.getByLabelText('Staff gap (%)');
  await user.clear(field);await user.type(field,'24{Enter}');expect(screen.getByRole('alert')).toHaveTextContent('Enter a staff gap from 25 to 400%.');
  await user.clear(field);await user.type(field,'401{Enter}');expect(onEdit).not.toHaveBeenCalled();
  await user.clear(field);await user.type(field,'100{Enter}');expect(onEdit).not.toHaveBeenCalled();
  await user.clear(field);await user.type(field,'200{Enter}');expect(onEdit.mock.calls[0][0].engraving.staffGaps).toEqual([{trackId:'base/0',scale:2}]);
  await user.clear(field);await user.type(field,'150');field.blur();expect(onEdit).toHaveBeenCalledTimes(2);
});
it('the last shown track gets the last-track status and its stored gap can still be reset',async()=>{
  setup(withStaffGaps(defaultEngraving(),[{trackId:'base/2',scale:2}]));await user.selectOptions(screen.getByLabelText('Space below'),'base/2');
  expect(screen.getByText('This is the last shown track, so there is no space below it to change in this view.')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Reset'}));expect(onEdit.mock.calls[0][0].engraving.staffGaps).toBeUndefined();
});
it('outside page layouts the panel says staff gaps show only in page layouts and export',()=>{
  setup(defaultEngraving(),{pageLayout:false});expect(screen.getByText('Staff gaps show only in the page layouts and in export.')).toBeInTheDocument();
});
it('long names first, short after is one command and unavailable once set',async()=>{
  setup();await user.click(screen.getByRole('button',{name:'Long names first, short after'}));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.stylesheet).toMatchObject(LONG_FIRST_SHORT_AFTER);
  setup(withLongFirstShortAfter(defaultEngraving()));expect(screen.getAllByRole('button',{name:'Long names first, short after'}).at(-1)).toHaveAttribute('aria-disabled','true');
});
it('busy keeps focus: controls are aria-disabled, never disabled, and record nothing',async()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),{busy:true});
  for(const control of screen.getAllByRole('button'))expect(control).not.toBeDisabled();
  for(const control of [...screen.getAllByRole('checkbox'),...screen.getAllByRole('combobox')])expect(control).not.toBeDisabled();
  await user.click(screen.getByRole('button',{name:'Remove group'}));await user.click(screen.getByLabelText('Include Drums'));expect(onEdit).not.toHaveBeenCalled();
});
```

`setup(value=defaultEngraving(), props={})` renders the panel with defaults (`pageLayout:true`, `busy:false`) and opens its disclosure, as `SystemGapsPanel.test.tsx` does (English is the default catalog there, with no provider). The existing `i18n.test.ts` catalog check covers the new keys in all three languages.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/StaffGroupsPanel.test.tsx src/i18n/i18n.test.ts`; Expected: FAIL (module missing; catalog keys missing).

- [ ] **Step 3: Implement the Interfaces above.** Follow `SystemGapsPanel`: percentage field 25 to 400, Enter/blur commit, edited-text guard. Buttons use `busyGuard({busy,unavailable,onClick})`; selects spread `busySelect(busy)`; checkboxes and the field use `aria-disabled` and ignore changes while busy. The group kind select's label is "Group mark: " plus the group label. `App` passes `score`, `trackIds`, `rendered={visibleTracks}`, `pageLayout={systemGapsLayout}`, `busy={editBusy}`, `locked={editLocked}`.

- [ ] **Step 4: Run to verify pass** — the Step 2 command plus `npx vitest run src/App.test.tsx` and `npm run typecheck`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/StaffGroupsPanel.tsx src/engraving/StaffGroupsPanel.test.tsx src/App.tsx src/i18n/en.ts src/i18n/et.ts src/i18n/de.ts
git commit -m "feat: staff groups panel with gaps and long-first names (D11, THE-180)"
```

---

### Task 10: Desktop proof, validation record and tracker (controller)

**Files:**
- Create: `tests/desktop/parity-staff-groups.mjs`, `docs/validation/2026-11-07-gp8-staff-groups.md`
- Modify: `docs/validation/2026-10-15-gp8-parity-progress.md` (D11 row, `:264`), `docs/validation/2026-10-15-gp8-parity-progress.json` (evidence map near `systemgaps_*`, `:1038-1055`; D11 entry, `:9498`)

**Interfaces:**
- Consumes: the built desktop test app (`scripts/build-desktop-test.ps1`, binary at `.analysis/desktop-smoke/tabplayer.exe`), the engraving fixture (`buildEngravingFixture`, `tests/desktop/engraving-fixture.mjs`), `window.__tabplayerTestExportPages` (`src/export/bridge.ts:31`), the `data-tp-accolade` attributes, the Task 9 English labels.
- Produces: driver output and the validation record.

- [ ] **Step 1: Write the driver**, based on `parity-system-gaps.mjs`, vertical page view at A4, using the Task 9 labels ("Design: staff groups", "Include Guitar6", "Group mark", "Group chosen tracks", "Space below", "Staff gap (%)", "Reset all staff gaps", "Remove group", "Remove all groups", "Long names first, short after"). Glyphs are matched as `&#57344;`/`&#57347;` in the page strings, or after `DOMParser` decoding. Checks, each a `check(name, body)`:
  - baseline: no `data-tp-accolade` on screen or in the export pages; the piano's native brace (`&#57344;`) is present in the export pages;
  - group Guitar6 + Grand Piano as a bracket: one `setEngraving` carrying the group; one `group-bracket` per system on screen and in the export pages; one `track-brace` per system;
  - change the group to a brace: one edit; one `group-brace` per system spanning guitar top to piano bottom within 1 px of the page's bounds;
  - names: "Long names first, short after" is one edit; system 1 of the export pages contains "Guitar6", "Grand Piano", "Drums"; later systems contain "Gtr.", "Pno.", "Dr." and not "Guitar6"; the rightmost name x is left of the leftmost mark x;
  - choosing the current kind or pressing the names button again records nothing;
  - 200% below Guitar6: piano and drums move down by the measured gap on screen and in the export pages, the guitar does not; a click on a piano notehead after the move selects that note;
  - a 200% system gap on the third system composes with it (D08 offset over the composed heights);
  - per-track PDF export of the guitar alone: no `data-tp-accolade`;
  - move Drums above Grand Piano: the status reads "Not drawn: its tracks are no longer next to each other." and no mark is drawn; undo restores the marks;
  - undo and redo every step; save and reopen keep groups, gaps and names; native playback generation unchanged across all edits; no page errors.

- [ ] **Step 2: Build and run**

Run: `powershell -File scripts/build-desktop-test.ps1`, then from the checkout root `node tests/desktop/parity-staff-groups.mjs`
Expected: every check prints PASS and the last line reads `staff-groups: N passed, 0 failed.` Run it three times; record any flake.

- [ ] **Step 3: Write `docs/validation/2026-11-07-gp8-staff-groups.md`** in the D08 record's shape: `## Behavior`, `## Evidence` (Vitest, Rust including the `pdf.rs` composed-SVG test, the driver output verbatim, the build commit), `## Limits`. Limits are copied from the spec's "Evidence and limits to record" list, plus what the driver did not cover (SVG, PNG and print exports not checked on the desktop; only export pages handed to the PDF writer are measured; the written PDF is checked by its `%PDF-` header only).

- [ ] **Step 4: Update the D11 tracker row** in both files:
  - JSON evidence map: add `staffgroups_behavior`, `staffgroups_evidence`, `staffgroups_limits`, each `{"path":"docs/validation/2026-11-07-gp8-staff-groups.md","start_line":…,"end_line":…,"kind":"validation_report"}` with the line ranges of the three sections as written, next to `systemgaps_limits`.
  - JSON D11 entry: append those three keys to `current_evidence`; keep `current_status` and `current_proven_status` `"partial"`; set `current_behavior` to name track groups (bracket or brace) drawn on screen and in export, the space below each track in page layouts and export, and the proven long-first/short-after names with its one-gesture option; set `remaining_gap` to: staff gaps not in parchment or screen layouts, no gaps between a track's own staves, whole-system extended bar lines, no first-system-of-each-page names, no GP stylesheet export, no GP8 comparison.
  - Markdown row `:264`: the same behaviour and remaining text, with links to the three new line ranges.

- [ ] **Step 5: Commit**

```bash
git add tests/desktop/parity-staff-groups.mjs docs/validation/2026-11-07-gp8-staff-groups.md docs/validation/2026-10-15-gp8-parity-progress.md docs/validation/2026-10-15-gp8-parity-progress.json
git commit -m "docs: record the D11 staff groups desktop run (THE-180)"
```
