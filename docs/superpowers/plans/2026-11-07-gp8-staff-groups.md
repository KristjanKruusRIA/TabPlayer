# D11 Staff Groups, Braces and Per-Staff Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group chosen tracks under a bracket or brace, set the space below each track, and prove long names on the first system and short names after, each as one undoable `setEngraving` edit, with export matching the screen (THE-180).

**Architecture:** Two optional top-level `EngravingOverrides` fields (`staffGroups`, `staffGaps`) keyed by track identity, validated in TypeScript and Rust like D08's `systemGaps`. When a render has a drawable group, alphaTab's brackets are switched off on the rendered score, room is reserved through alphaTab's label and page paddings, and TabPlayer draws every accolade from `boundsLookup` staff bounds. Staff gaps cut each system's SVG into clipped, translated bands before D08 stacking, in the paginated layouts and export; overlays and hit testing map through the same band shift.

**Tech Stack:** TypeScript, React 19, alphaTab 1.8.4 (unmodified), Vitest 5, Rust (serde, usvg/svg2pdf export), Node desktop drivers over CDP.

**Spec:** `docs/superpowers/specs/2026-11-07-gp8-staff-groups-design.md`

## Global Constraints

- Old `.tabplayer` projects and edit logs replay unchanged. An absent field loads as empty and serializes without the field. Older builds refusing the new fields is a recorded limit.
- Without groups and gaps every screen and export output is byte-identical: `page.test.ts`, `page-text.test.ts`, `pdf.test.ts`, `header-footer.test.ts`, `screen-pages.test.ts` and `system-gaps.render.test.ts` pass unchanged.
- Caps (TS and Rust): at most 64 groups; 2 to 64 ids per group; an id nonempty and at most 65,536 UTF-8 bytes; an id in at most one group, once; at most 256 staff gaps with distinct ids; gap scale finite, 0.25 to 4.
- No new edit type; both fields ride on `setEngraving`. Saved styles reject both. No style-library version bump.
- alphaTab stays unmodified. Do not retune `src-tauri/src/audio/tone.rs`. Do not rename existing engraving labels ("Brackets", "System spacing (%)" and others); drivers use them.
- New UI text goes through `src/i18n` with `en`, `et`, `de`. Busy uses `busyGuard`, never `disabled`. One gesture is one `setEngraving`; choosing the current value records nothing.
- A staff-gap-only edit must not re-render alphaTab and must not restart native audio. A group edit re-renders the notation (it changes bracket mode and reserve) but stays a settings edit.
- Rust: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib style_library`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, in the default `src-tauri/target` (or `E:/cargo-target/slot-1..3` for tests only). Never a scratchpad target.
- TypeScript: `npm run typecheck` and the touched Vitest files via `npx vitest run <files>`.

## Review Focus

1. **Clicking a moved staff.** After 200% below the guitar, a click on a lower-track notehead selects that note, a cursor spanning all staves stretches over the added space, and a click inside the opened gap selects nothing. Test: Task 7 `maps a click on a moved staff and returns null inside an opened gap`.
2. **Track edits under a group.** Duplicating a middle member keeps the group drawn; moving a member away makes it `notContiguous`; removing a member of a two-track group makes it `tooFewTracks`; undo restores drawing with no edit. Test: Task 1 `keeps a group drawable through duplicate and reports move and remove states`.
3. **Rendering a subset.** Showing or exporting one track of a group draws no group mark and gives back alphaTab's own brackets (the piano keeps its native brace). Test: Task 5 `a single rendered member draws no group and keeps alphaTab's native brace`.
4. **Names against marks and page width.** With long horizontal or vertical names, the names end left of every drawn mark, and the widened system still fits the usable page width. Test: Task 5 `names end left of every mark and systems fit the page with the reserve`.
5. **Gap-only edits and old documents.** A staff-gap edit repaginates from held chunks without another alphaTab render, and a document without the new fields exports byte-identical pages. Tests: Task 8 `a staff-gap-only change recomposes without another render` and Task 5 `exports byte-identical pages without groups or gaps`.

---

### Task 1: Data model, validation, edit helpers, duplicate and style rejection (TypeScript)

**Files:**
- Create: `src/engraving/staff-groups.ts`, `src/engraving/staff-groups.test.ts`
- Modify: `src/engraving/types.ts` (types, two optional fields), `src/engraving/projection.ts` (`validateEngraving` conditional keys), `src/engraving/system-gaps.ts` (`withoutStackingOffsets`, `engravingRenderKey`), `src/document-settings.ts` (`copyTrackSettings`), `src/engraving/style-library.ts`, `src/engraving/EngravingPanel.tsx`
- Test: `src/engraving/staff-groups.test.ts`, `src/engraving/style-library.test.ts`, `src/engraving/EngravingPanel.test.tsx`, `src/engraving/replay.test.ts`

**Interfaces:**
- Consumes: `EngravingOverrides`, `validateEngraving`, `withSystemGaps`, `withBarWidths`, `copyTrackSettings(settings, source, copy)`.
- Produces (in `types.ts`):
  - `type StaffGroupKind='bracket'|'brace'`; `interface StaffGroup {trackIds:string[];kind:StaffGroupKind}`; `interface StaffGap {trackId:string;scale:number}`
  - `EngravingOverrides.staffGroups?:StaffGroup[]`, `EngravingOverrides.staffGaps?:StaffGap[]`
- Produces (in `staff-groups.ts`):
  - `const STAFF_GAP_RANGE={min:.25,max:4}`, `MAX_STAFF_GROUPS=64`, `MAX_GROUP_TRACKS=64`, `MAX_STAFF_GAPS=256`, `MAX_TRACK_ID_BYTES=65_536`
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
  - `isLongFirstShortAfter(e):boolean`, `withLongFirstShortAfter(e):EngravingOverrides` (same object when already set)
  - Every helper returns the same object when nothing changes.
- Produces (in `system-gaps.ts`): `withoutStackingOffsets(e):EngravingOverrides` (drops `systemGaps` and `staffGaps`); `engravingRenderKey` now keys on it.

- [ ] **Step 1: Write the failing tests** in `src/engraving/staff-groups.test.ts`

```ts
const ids=['base/0','base/1','base/2','base/3'];
it('validates groups: shape, kinds, 2..64 ids, 64 groups, id bytes, flat',()=>{
  expect(()=>validateStaffGroups([{trackIds:['base/0','base/1'],kind:'brace'}])).not.toThrow();
  for(const bad of [[{trackIds:['base/0'],kind:'bracket'}],[{trackIds:['a','a'],kind:'bracket'}],[{trackIds:['a','b'],kind:'curly'}],
    [{trackIds:['a','b'],kind:'bracket'},{trackIds:['b','c'],kind:'brace'}],[{trackIds:['','b'],kind:'bracket'}],
    [{trackIds:['a','b'],kind:'bracket',extra:1}],Array.from({length:65},(_,i)=>({trackIds:[`x${i}`,`y${i}`],kind:'bracket'})),
    [{trackIds:Array.from({length:65},(_,i)=>`t${i}`),kind:'bracket'}],[{trackIds:['x'.repeat(65_537),'b'],kind:'bracket'}]])
    expect(()=>validateStaffGroups(bad)).toThrow();
});
it('validates gaps: distinct ids, 0.25..4, at most 256',()=>{ /* accepts {trackId:'base/0',scale:.25} and 4; rejects .24, 4.01, NaN, duplicate id, 257 entries, extra key */ });
it('validateEngraving accepts both keys only when present and an old engraving without them',()=>{
  expect(()=>validateEngraving(defaultEngraving())).not.toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGroups:[{trackIds:['a','b'],kind:'brace'}],staffGaps:[{trackId:'a',scale:2}]})).not.toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGroups:'x'})).toThrow();
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
  // engine-level: build a 3-track document, group tracks 0..2 as a bracket, then previewEdit:
  // duplicateTrack 1 -> the group holds 4 ids and groupStates(...)==['drawn'];
  // moveTrack 0 to 3 on a 4-track document whose group is tracks 0..1 -> ['notContiguous'];
  // removeTrack 1 on a group of tracks 0..1 -> ['tooFewTracks'], and the stored group is unchanged.
});
it('copies the source gap to a duplicate and leaves other tracks alone',()=>{ /* copyTrackStaffLayout(withStaffGaps(e,[{trackId:'base/1',scale:2}]),'base/1','added/5/x').staffGaps has both ids at 2 */ });
it('add, kind, remove and gap helpers return the same object when nothing changes',()=>{
  const e=defaultEngraving();
  expect(groupingProblem(e,ids,['base/0'])).toBe('tooFew');
  expect(groupingProblem(e,ids,['base/0','base/2'])).toBe('notContiguous');
  const grouped=addStaffGroup(e,ids,['base/2','base/1'],'bracket');
  expect(grouped.staffGroups).toEqual([{trackIds:['base/1','base/2'],kind:'bracket'}]);
  expect(groupingProblem(grouped,ids,['base/2','base/3'])).toBe('alreadyGrouped');
  expect(setStaffGroupKind(grouped,0,'bracket')).toBe(grouped);
  expect(removeStaffGroup(grouped,0).staffGroups).toBeUndefined();
  expect(removeAllStaffGroups(e)).toBe(e);
  expect(setStaffGap(e,'base/0',1)).toBe(e);
  const gapped=setStaffGap(e,'base/0',2);expect(staffGapOf(gapped,'base/0')).toBe(2);expect(setStaffGap(gapped,'base/0',2)).toBe(gapped);
  expect(resetStaffGap(e,'base/0')).toBe(e);expect(resetAllStaffGaps(gapped).staffGaps).toBeUndefined();
  const named=withLongFirstShortAfter(e);expect(isLongFirstShortAfter(named)).toBe(true);expect(withLongFirstShortAfter(named)).toBe(named);
  expect(named.stylesheet.firstNameDirection).toBe(e.stylesheet.firstNameDirection);
});
it('engravingRenderKey ignores staff gaps but not staff groups',()=>{ /* key(e)===key(withStaffGaps(e,[...])) and key(e)!==key(withStaffGroups(e,[...])) */ });
```

Also add: in `style-library.test.ts` `a saved style neither carries nor clears staff groups and gaps` (`styleOf` strips both; `styleApplied` keeps the document's; a library entry with either is rejected with "A saved style cannot hold staff groups." / "...staff gaps."); in `EngravingPanel.test.tsx` `apply and reset keep staff groups and gaps`; in `replay.test.ts` `an old log without staff groups or gaps replays and serializes without the keys`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/engraving/staff-groups.test.ts src/engraving/style-library.test.ts src/engraving/EngravingPanel.test.tsx src/engraving/replay.test.ts`
Expected: FAIL ("Failed to resolve import ./staff-groups" and the new style/panel/replay cases).

- [ ] **Step 3: Implement the Interfaces above**

`validateEngraving` gains `hasGroups`/`hasStaffGaps` conditional keys exactly like `hasGaps`. `copyTrackSettings` calls `copyTrackStaffLayout` after copying the profile: the copy id is inserted right after the source id in the source's group unless the group holds 64 ids; a gap entry is copied unless 256 exist. `styleOf`/`styleApplied`/`validateEntry` follow the `systemGaps` pattern. `EngravingPanel` `apply()`/`reset()` wrap with `withStaffGaps(withStaffGroups(..., value.staffGroups??[]), value.staffGaps??[])`. Contiguity: map live member ids to document indices, sort, and require `max−min+1===count`.

- [ ] **Step 4: Run to verify pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/staff-groups.ts src/engraving/staff-groups.test.ts src/engraving/types.ts src/engraving/projection.ts src/engraving/system-gaps.ts src/document-settings.ts src/engraving/style-library.ts src/engraving/style-library.test.ts src/engraving/EngravingPanel.tsx src/engraving/EngravingPanel.test.tsx src/engraving/replay.test.ts
git commit -m "feat: staff groups and staff gaps data model (D11, THE-180)"
```

---

### Task 2: Rust model, validation, style library and protocol tests

**Files:**
- Modify: `src-tauri/src/engraving.rs`, `src-tauri/src/style_library.rs`
- Test: `src-tauri/tests/engraving_protocol.rs`, `src-tauri/src/style_library.rs` (unit test module)

**Interfaces:**
- Consumes: Task 1's JSON shapes and caps.
- Produces:
  - `#[serde(rename_all = "lowercase")] pub enum StaffGroupKind { Bracket, Brace }`
  - `pub struct StaffGroup { pub track_ids: Vec<String>, pub kind: StaffGroupKind }` and `pub struct StaffGap { pub track_id: String, pub scale: f64 }`, both `rename_all = "camelCase", deny_unknown_fields`
  - `EngravingOverrides.staff_groups: Vec<StaffGroup>` and `.staff_gaps: Vec<StaffGap>`, each `#[serde(default, skip_serializing_if = "Vec::is_empty")]`
  - `pub const MAX_STAFF_GROUPS: usize = 64; MAX_GROUP_TRACKS: usize = 64; MAX_STAFF_GAPS: usize = 256; MAX_TRACK_ID_BYTES: usize = 65_536;`
  - `fn validate_staff_groups(&self) -> Result<(), String>`, `fn validate_staff_gaps(&self) -> Result<(), String>`, called from `validate()`

- [ ] **Step 1: Write the failing tests**
  - `engraving_staff_groups_are_optional_flat_bounded_and_round_trip_only_when_set`: an engraving without the key round-trips without it; one group round-trips; rejected: 1 id, duplicate id in a group, an id in two groups, empty id, a 65,537-byte id, 65 groups, 65 ids, unknown kind, unknown field.
  - `engraving_staff_gaps_are_optional_distinct_bounded_and_round_trip_only_when_set`: round trip; rejected: scale 0.24, 4.01, NaN/inf (set directly on the struct, as the system-gap test does), duplicate id, empty id, 257 entries.
  - `engraving_staff_layout_survives_history_undo_redo_save_and_reopen_beside_an_old_log`: copy of `engraving_system_gaps_survive_history_undo_redo_save_and_reopen_beside_an_old_log` carrying both fields.
  - `style_library.rs` unit: `saved_style_rejects_staff_groups_and_gaps` (errors "A saved style cannot hold staff groups." and "A saved style cannot hold staff gaps.").

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol staff`
Expected: FAIL to compile (`no field staff_groups`).

- [ ] **Step 3: Implement the Interfaces above**, with error messages "Staff groups must name 2 to 64 distinct tracks, each in one group only." and "Staff gaps must be 25% to 400% of the default, one per track."

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib style_library`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
Expected: PASS; fmt clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/engraving.rs src-tauri/src/style_library.rs src-tauri/tests/engraving_protocol.rs
git commit -m "feat: native staff groups and staff gaps validation (D11, THE-180)"
```

---

### Task 3: Accolade plan and render configuration

**Files:**
- Create: `src/engraving/accolades.ts`, `src/engraving/accolades.test.ts`
- Modify: `src/engraving/projection.ts` (`EngravingProjection.bracketMode`)

**Interfaces:**
- Consumes: `drawnGroups`, `ResolvedGroup` (Task 1).
- Produces:
  - `EngravingProjection.bracketMode:number` — the rendered score's `stylesheet.bracketExtendMode` after overrides.
  - `interface AccoladeMetrics {scale:number;pad:number;bracketThickness:number;staffSpace:number;brace:{width:number;height:number};spike:{top:number;bottom:number}}` — render pixels (alphaTab units × `display.scale`), read from `settings.display.resources.engravingSettings` (`glyphWidths`/`glyphHeights` of Brace, BracketTop, BracketBottom; `bracketThickness`; `oneStaffSpace`) and `accoladeBarPaddingRight`.
  - `accoladeMetrics(settings:Settings):AccoladeMetrics`
  - `const BRACE_MAX_X_SCALE=4`
  - `interface AccoladePlan {groups:ResolvedGroup[];nativeMode:number;singleStaffBrackets:boolean;braceTracks:ReadonlySet<number>;inner:number;outer:number;reserve:number}` — `inner`, `outer`, `reserve` in alphaTab units; `braceTracks` are rendered tracks with more than one standard-notation staff.
  - `planAccolades(input:{engraving:EngravingOverrides;trackIds:readonly string[];rendered:readonly number[];score:model.Score;nativeMode:number;settings:Settings}):AccoladePlan|null` — null when no group is drawn.
  - `configureAccolades(settings:Settings,score:model.Score,plan:AccoladePlan|null,nativeMode:number):void` — sets `score.stylesheet.bracketExtendMode` to `BracketExtendMode.NoBrackets` with a plan, else back to `nativeMode`; with a plan adds `reserve` to `settings.display.systemLabelPaddingRight` and `reserve × settings.display.scale` to `settings.display.padding[0]` (expanding a one-value padding to four values first). Called after the caller sets `scale` and `padding`.

- [ ] **Step 1: Write the failing tests** in `src/engraving/accolades.test.ts` (fixture: Guitar6 1 staff, Grand Piano 2 standard staves, Drums 1 staff; ids `base/0..2`)

```ts
it('plans nothing without a drawn group and restores the native mode',()=>{
  expect(planAccolades({engraving:defaultEngraving(),trackIds:ids,rendered:[0,1,2],score,nativeMode:1,settings})).toBeNull();
  configureAccolades(settings,score,null,1);expect(score.stylesheet.bracketExtendMode).toBe(1);expect(settings.display.systemLabelPaddingRight).toBe(3);
});
it('a bracket group over guitar and piano reserves an inner brace column and an outer bracket column',()=>{
  const plan=planAccolades({engraving:withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),trackIds:ids,rendered:[0,1,2],score,nativeMode:1,settings})!;
  expect(plan.groups).toEqual([{index:0,kind:'bracket',tracks:[0,1]}]);expect([...plan.braceTracks]).toEqual([1]);
  const unit=new Settings().display.resources.engravingSettings;
  expect(plan.inner).toBeCloseTo(unit.glyphWidths.get(MusicFontSymbol.Brace)!*BRACE_MAX_X_SCALE);
  expect(plan.outer).toBeCloseTo(unit.bracketThickness);
  expect(plan.reserve).toBeCloseTo(3+plan.inner+3+plan.outer);
});
it('with Brackets None the inner column is empty and the reserve is pad plus the group column',()=>{ /* nativeMode 0: plan.inner===0, braceTracks still reported, reserve===3+outer */ });
it('a group with one rendered member plans nothing',()=>{ /* rendered [1] -> null */ });
it('configures no brackets and the reserve on settings',()=>{
  settings.display.scale=1.5;settings.display.padding=[0];configureAccolades(settings,score,plan,1);
  expect(score.stylesheet.bracketExtendMode).toBe(BracketExtendMode.NoBrackets);
  expect(settings.display.systemLabelPaddingRight).toBeCloseTo(3+plan.reserve);
  expect(settings.display.padding).toEqual([plan.reserve*1.5,0,0,0]);
});
it('projectEngraving reports the effective bracket mode',()=>{ /* brackets:'none' -> projection.bracketMode===0; 'inherit' -> the source stylesheet's value */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/engraving/accolades.test.ts src/engraving/projection.test.ts`
Expected: FAIL (module missing; `bracketMode` undefined).

- [ ] **Step 3: Implement the Interfaces above.** Inner width: 0 when `nativeMode === 0`; otherwise `brace.width × BRACE_MAX_X_SCALE` if any rendered ungrouped track or bracket-group member draws as brace, else `bracketThickness` if `nativeMode !== 0` and any ungrouped rendered track could draw a bracket, else 0. Outer: `brace.width × BRACE_MAX_X_SCALE` if any drawn group is a brace, else `bracketThickness`. When `inner` is 0 the groups use the inner position and `reserve = pad + outer`. `singleStaffBrackets` comes from the rendered `score.stylesheet.showSingleStaffBrackets`.

- [ ] **Step 4: Run to verify pass** — the Step 2 command; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/accolades.ts src/engraving/accolades.test.ts src/engraving/projection.ts src/engraving/projection.test.ts
git commit -m "feat: plan drawn accolades and reserve their room (D11, THE-180)"
```

---

### Task 4: Staff bands, shift, marks and system composition

**Files:**
- Create: `src/engraving/staff-layout.ts`, `src/engraving/staff-layout.test.ts`
- Modify: `src/engraving/accolades.ts` (marks and SVG)

**Interfaces:**
- Consumes: `AccoladePlan`, `AccoladeMetrics` (Task 3); `ScreenSystem` (`screen-pages.ts`).
- Produces (in `staff-layout.ts`, all y in render pixels of the whole render):
  - `interface TrackBand {track:number;top:number;bottom:number;staves:number}` (`staves` = visible staff count in the system)
  - `systemTrackBands(system:ScreenSystem):TrackBand[]` — from each `BarBounds` grouped by `bar.staff.track.index`, in rendered order
  - `staffLeftOf(system:ScreenSystem):number` — `system.bars[0].realBounds.x`
  - `interface StaffShift {cuts:number[];offsets:number[]}` — ascending cuts; `offsets[k]` is the cumulative shift for `cuts[k] ≤ y < cuts[k+1]`
  - `const TRACK_STAFF_PADDING=5`
  - `staffShift(bands:readonly TrackBand[],gaps:ReadonlyMap<number,number>,renderScale:number):StaffShift|null` — null when every offset is 0
  - `shiftY(shift:StaffShift|null|undefined,y:number,edge:'top'|'bottom'):number` — `'bottom'` treats `y` as an exclusive end
  - `unshiftY(shift:StaffShift|null|undefined,y:number):number|null` — null inside an opened gap
  - `shiftTotal(shift:StaffShift|null|undefined):number`
  - `composeSystemSvg(input:{svg:string;idPrefix:string;top:number;width:number;height:number;shift:StaffShift|null;marks:readonly AccoladeMark[]}):{svg:string;height:number}` — returns the input string unchanged when `shift` is null and `marks` is empty
- Produces (in `accolades.ts`):
  - `interface AccoladeMark {role:'group'|'track';kind:'bracket'|'brace';x:number;top:number;bottom:number;width:number}`
  - `systemAccoladeMarks(plan:AccoladePlan,bands:readonly TrackBand[],metrics:AccoladeMetrics,staffLeft:number):AccoladeMark[]`
  - `accoladeSvg(marks:readonly AccoladeMark[],shift:StaffShift|null,top:number):string` — one `<g data-tp-accolade="<role>-<kind>">` per mark, glyphs emitted in the same element shape and class (`at`) as alphaTab's SVG music text

Offset per boundary (upper band `u`, next present band `l`): `measured=l.top−u.bottom`, `base=max(measured,TRACK_STAFF_PADDING×renderScale)`, `offset=max((scale−1)×base,−measured)`; cut at `u.bottom+measured/2`.

- [ ] **Step 1: Write the failing tests** in `src/engraving/staff-layout.test.ts` (synthetic `ScreenSystem` with bands guitar 100–160, piano 200–300 (two staves), drums 340–380; render scale 1)

```ts
it('builds one band per track with its visible staves',()=>expect(systemTrackBands(system)).toEqual([{track:0,top:100,bottom:160,staves:1},{track:1,top:200,bottom:300,staves:2},{track:2,top:340,bottom:380,staves:1}]));
it('shifts below a 200% boundary by the measured gap',()=>{
  const shift=staffShift(bands,new Map([[0,2]]),1)!;
  expect(shift).toEqual({cuts:[180],offsets:[40]});
  expect(shiftY(shift,150,'top')).toBe(150);expect(shiftY(shift,250,'top')).toBe(290);
  expect(shiftY(shift,180,'bottom')).toBe(180);expect(shiftY(shift,380,'bottom')).toBe(420);
  expect(unshiftY(shift,190)).toBeNull();expect(unshiftY(shift,290)).toBe(250);expect(shiftTotal(shift)).toBe(40);
});
it('never shrinks below touching and floors the base at the track padding',()=>{
  expect(staffShift(bands,new Map([[0,.25]]),1)!.offsets).toEqual([-30]);
  const tight=[{track:0,top:0,bottom:10,staves:1},{track:1,top:11,bottom:20,staves:1}];
  expect(staffShift(tight,new Map([[0,2]]),2)!.offsets).toEqual([10]);
  expect(staffShift(tight,new Map([[0,.25]]),2)!.offsets).toEqual([-1]);
});
it('ignores the last track, absent tracks and 100%',()=>{ expect(staffShift(bands,new Map([[2,3],[0,1],[7,2]]),1)).toBeNull(); });
it('returns the same SVG string with no shift and no marks',()=>{const svg='<svg width="500" height="400"><text>x</text></svg>';expect(composeSystemSvg({svg,idPrefix:'s0',top:0,width:500,height:400,shift:null,marks:[]}).svg).toBe(svg);});
it('composes clipped, translated bands with unique ids and the new height',()=>{
  const out=composeSystemSvg({svg:'<svg width="500" height="400"><rect y="120"/></svg>',idPrefix:'p1-s2',top:0,width:500,height:400,shift:{cuts:[180],offsets:[40]},marks:[]});
  expect(out.height).toBe(440);expect(out.svg).toMatch(/^<svg\b[^>]*height="440"/);
  expect(out.svg.match(/<use\b/g)).toHaveLength(2);expect(out.svg).toContain('id="p1-s2-content"');expect(out.svg).toContain('translate(0 40)');
});
it('places group marks outside track marks and spans moved staves',()=>{
  const marks=systemAccoladeMarks(plan /* bracket group tracks 0..1, piano brace */,bands,metrics,60);
  const group=marks.find(m=>m.role==='group')!,brace=marks.find(m=>m.role==='track'&&m.kind==='brace')!;
  expect(brace.x+brace.width).toBeCloseTo(60-metrics.pad);expect(group.x+group.width).toBeLessThanOrEqual(brace.x-metrics.pad+1e-9);
  expect([group.top,group.bottom]).toEqual([100,300]);expect(brace.width).toBeLessThanOrEqual(metrics.brace.width*BRACE_MAX_X_SCALE);
  expect(accoladeSvg(marks,{cuts:[180],offsets:[40]},0)).toContain('data-tp-accolade="group-bracket"');
});
it('draws a one-staff group only with single staff brackets',()=>{ /* bands with only track 0 present: no group mark unless plan.singleStaffBrackets */ });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/staff-layout.test.ts`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement the Interfaces above.** Composed shape: the original root `<svg>` attributes with `height` (and `viewBox` height when present) replaced; `<defs><g id="<prefix>-content">original content</g>` plus one `<clipPath id="<prefix>-c<k>">` per band; per band `<g transform="translate(0 <offset>)"><use href="#<prefix>-content" clip-path="url(#<prefix>-c<k>)"/></g>`; then `accoladeSvg`. Clip rectangles are chunk-local (`y − top`), full width; the first band starts above the chunk and the last ends below it.

- [ ] **Step 4: Run to verify pass** — the Step 2 command; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/staff-layout.ts src/engraving/staff-layout.test.ts src/engraving/accolades.ts src/engraving/accolades.test.ts
git commit -m "feat: staff bands, accolade marks and system composition (D11, THE-180)"
```

---

### Task 5: Export wiring and render-level proof

**Files:**
- Modify: `src/export/types.ts` (`SvgSystem.top`), `src/export/pdf.ts`, `src/engraving/staff-layout.ts` (`composeEngravedSystems`)
- Create: `src/engraving/staff-groups.render.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces:
  - `SvgSystem.top?:number` — the chunk's y in the render, set for chunks with `firstMasterBarIndex ≥ 0`.
  - `composeEngravedSystems(systems:SvgSystem[],bounds:NonNullable<rendering.ScoreRenderer['boundsLookup']>,input:{plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics;scale:number;idPrefix:string}):SvgSystem[]` in `staff-layout.ts` — composed `svg` and `height`; chunks without `firstBar` unchanged; systems matched to bounds by `firstBar`.
  - `renderPdfPages` (frozen path): after `projectEngraving`, `planAccolades` over `selection.tracks`, then `configureAccolades` after scale and padding are set; after rendering, `composeEngravedSystems(...)` with `resolveStaffGaps(engraving.staffGaps, trackIds)`, then the unchanged `paginateEngravedSystems`.

- [ ] **Step 1: Write the failing tests** in `src/engraving/staff-groups.render.test.ts` (real renderer, modelled on `system-gaps.render.test.ts`; three-track fixture with names Guitar6/Grand Piano/Drums and short names Gtr./Pno./Dr.; A4 page)

```ts
it('exports byte-identical pages without groups or gaps',()=>{ expect(pages(engraving)).toEqual(pages(withStaffGaps(withStaffGroups(engraving,[]),[]))); /* and equal to the pre-change snapshot helper used by system-gaps.render.test.ts */ });
it('a bracket group draws one group bracket per system and turns alphaTab brackets off',()=>{
  const svg=pages(grouped('bracket',['base/0','base/1'])).map(p=>p.svg).join('');
  expect(count(svg,'data-tp-accolade="group-bracket"')).toBe(systemCount);
  expect(count(svg,'data-tp-accolade="track-brace"')).toBe(systemCount); // the piano keeps its brace
  expect(withoutMarks(svg)).not.toContain(String.fromCharCode(0xE003)); // no alphaTab BracketTop outside data-tp-accolade groups
});
it('a brace group spans guitar top to piano bottom',()=>{ /* group-brace mark top/bottom equal the first/last member BarBounds edges of each system within 0.5 px */ });
it('the drawn piano brace sits where alphaTab drew it',()=>{ /* render with brackets 'staves' and no group; read the y of alphaTab's U+E000 brace text per system. Render again with a bracket group over guitar and piano: each track-brace mark's bottom is within 1 px of that y (the reserve moves staves sideways only) */ });
it('a single rendered member draws no group and keeps alphaTab\'s native brace',()=>{
  const svg=pagesFor([1],grouped('bracket',['base/0','base/1'])).map(p=>p.svg).join('');
  expect(svg).not.toContain('data-tp-accolade');expect(svg).toContain(String.fromCharCode(0xE000));
});
it('names end left of every mark and systems fit the page with the reserve',()=>{
  // horizontal and vertical name orientation, names 'A very long guitar part name'
  for(const page of pages(...)) { expect(rightmostNameX(page)).toBeLessThanOrEqual(leftmostMarkX(page)); expect(systemRight(page)).toBeLessThanOrEqual(usableRight+1); }
});
it('a 200% gap below the guitar moves piano and drums, not the guitar, by the measured gap',()=>{
  // distance guitar->piano grows by measured (l.top-u.bottom from renderer.boundsLookup); piano->drums unchanged; system height grows by the same
});
it('staff gaps compose before system gaps',()=>{ /* with a 200% staff gap and a 200% system gap on system 3: system 3's top moves by the D08 offset computed from the composed heights of earlier systems; page breaks use composed heights */ });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/staff-groups.render.test.ts`; Expected: FAIL (no `data-tp-accolade` in output, gap not applied).

- [ ] **Step 3: Implement the Interfaces above.** Read `e.y` into `top` in the `partialRenderFinished` handler. The `idPrefix` is `export-s<systemIndex>`; `paginateEngravedSystems` keeps systems in order, so ids stay unique per page.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/engraving/staff-groups.render.test.ts src/engraving/system-gaps.render.test.ts src/engraving/page.test.ts src/export/pdf.test.ts src/engraving/header-footer.test.ts src/engraving/page-text.test.ts`
Expected: PASS; the existing files unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/export/types.ts src/export/pdf.ts src/engraving/staff-layout.ts src/engraving/staff-groups.render.test.ts
git commit -m "feat: draw staff groups and staff gaps in export (D11, THE-180)"
```

---

### Task 6: Names proof, long first and short after

**Files:**
- Create: `src/engraving/staff-names.render.test.ts`

**Interfaces:**
- Consumes: `withLongFirstShortAfter` (Task 1), `renderPdfPages` (Task 5).
- Produces: evidence only; no new code unless a test exposes a defect.

- [ ] **Step 1: Write the tests** (real renderer, three-track fixture, page narrow enough for at least three systems)

```ts
it('multi-track: full names on system 0, short names on later systems',()=>{
  const systems=systemTexts(withLongFirstShortAfter(defaultEngraving()),[0,1,2]);
  expect(systems[0]).toEqual(expect.arrayContaining(['Guitar6','Grand Piano','Drums']));
  for(const later of systems.slice(1)){expect(later).toEqual(expect.arrayContaining(['Gtr.','Pno.','Dr.']));expect(later).not.toContain('Guitar6');}
});
it('single-track render follows the same rule',()=>{ /* rendered [0]: system 0 has 'Guitar6', later 'Gtr.' */ });
it('an empty short name falls back to the first 10 characters of the name',()=>{ /* shortName '' and name 'Rhythm guitar two' -> later systems show 'Rhythm gui' */ });
it('without the option, names keep the source policy',()=>{ /* defaultEngraving(): system 1 has no 'Gtr.' when the source policy is first system only */ });
```

- [ ] **Step 2: Run** — `npx vitest run src/engraving/staff-names.render.test.ts`; Expected: PASS with the Task 1 helper. A failure here is a defect to fix before continuing (record what was wrong in the commit message).

- [ ] **Step 3: Commit**

```bash
git add src/engraving/staff-names.render.test.ts
git commit -m "test: prove long names first and short names after (D11, THE-180)"
```

---

### Task 7: Screen pagination, mapping and hit testing through the band shift

**Files:**
- Modify: `src/engraving/screen-pages.ts`
- Test: `src/engraving/screen-pages.test.ts`

**Interfaces:**
- Consumes: `StaffShift`, `shiftY`, `unshiftY`, `shiftTotal` (Task 4).
- Produces:
  - `ScreenRenderChunk.shift?:StaffShift` (render coordinates).
  - `paginateScreenScore` builds `sourceBounds` from the chunk rect and the system bounds with their bottoms mapped through `shiftY(shift, bottom, 'bottom')`; unchanged without `shift`.
  - `mapScreenRect` maps `rect.y` with `shiftY(...,'top')` and `rect.y+rect.h` with `shiftY(...,'bottom')`.
  - `unmapScreenPoint` inverts through `unshiftY`; a point in an opened gap returns null. `hitTestScreenPages` inherits this.

- [ ] **Step 1: Write the failing tests** in `screen-pages.test.ts`

```ts
it('paginates a shifted chunk with its composed height',()=>{ /* chunk height 400 -> 440 with shift {cuts:[180],offsets:[40]}; the next block starts 440 below */ });
it('maps a click on a moved staff and returns null inside an opened gap',()=>{
  // system bounds: guitar bar 100-160, piano bar 200-300; shift {cuts:[180],offsets:[40]}
  expect(unmapScreenPoint(p,a,screenPoint(250+40))!.point.y).toBe(250);
  expect(unmapScreenPoint(p,a,screenPoint(190))).toBeNull();
  expect(hitTestScreenPages(p,a,noteheadOnPiano)!.note).toBe(pianoNote);
});
it('stretches a rect spanning the cut',()=>{ expect(mapScreenRect(p,a,system,{x:0,y:100,w:10,h:200})!.h).toBe((200+40)*a.scale); });
it('leaves unshifted chunks byte-for-byte as before',()=>{ /* existing expectations unchanged */ });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/screen-pages.test.ts`; Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the Interfaces above.**

- [ ] **Step 4: Run to verify pass** — the Step 2 command; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engraving/screen-pages.ts src/engraving/screen-pages.test.ts
git commit -m "feat: map screen overlays and hits through moved staves (D11, THE-180)"
```

---

### Task 8: ScoreView wiring: compose on paged layouts, overlay marks elsewhere, no re-render for gaps

**Files:**
- Modify: `src/ScoreView.tsx`, `src/App.tsx` (pass `trackIds`), `src/engraving/staff-layout.ts` (`composeScreenChunks`)
- Test: `src/ScoreView.layouts.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 7; `withoutStackingOffsets`, `engravingRenderKey`.
- Produces:
  - `ScoreView` prop `trackIds?:readonly string[]` (document track identities, from `App`).
  - The render path uses `withoutStackingOffsets(engraving)`; staff gaps are memoized separately on `JSON.stringify(engraving?.staffGaps??null)`, like `systemGaps`.
  - Before `renderScore`: `planAccolades` over the visible tracks with `projection.bracketMode`, then `configureAccolades` after padding and scale are set.
  - Paged layouts: the `paged` memo composes held chunks with `composeScreenChunks(chunks:readonly ScreenRenderChunk[],bounds:ScreenBounds,input:{plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics;scale:number}):ScreenRenderChunk[]` (in `staff-layout.ts`, `idPrefix` from the chunk id, `shift` attached) before `paginateScreenScore`.
  - Continuous layouts: one `<svg data-tp-accolades>` overlay over the alphaTab surface, drawn from `api.boundsLookup` with `systemAccoladeMarks` and `accoladeSvg(marks,null,0)` after each completed render; empty without a plan. No staff gaps there.

- [ ] **Step 1: Write the failing tests** in `ScoreView.layouts.test.tsx` (the file's fake alphaTab API)

```ts
it('a staff-gap-only change recomposes without another render',()=>{ /* renders count unchanged; the second block's top moves by the shift total */ });
it('a group change renders again with no brackets and the reserve',()=>{ /* renders +1; fake score stylesheet.bracketExtendMode===0; settings.display.padding[0]===reserve*scale */ });
it('removing the last group restores the native bracket mode and padding',()=>{});
it('continuous layouts draw marks in an overlay and ignore staff gaps',()=>{ /* parchment: [data-tp-accolades] contains group-bracket; chunk tops unchanged by a gap */ });
it('paged layouts put marks inside the composed chunks',()=>{ /* verticalPage: chunk innerHTML contains data-tp-accolade */ });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/ScoreView.layouts.test.tsx`; Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the Interfaces above.** Keep D08's gap memo and `onSystems` reporting unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/ScoreView.layouts.test.tsx src/ScoreView.test.tsx src/engraving/screen-pages.test.ts` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ScoreView.tsx src/ScoreView.layouts.test.tsx src/App.tsx src/engraving/staff-layout.ts
git commit -m "feat: show staff groups and staff gaps on screen (D11, THE-180)"
```

---

### Task 9: Staff groups panel

**Files:**
- Create: `src/engraving/StaffGroupsPanel.tsx`, `src/engraving/StaffGroupsPanel.test.tsx`
- Modify: `src/App.tsx` (after `SystemGapsPanel` in `presentationTools`), `src/i18n/en.ts`, `src/i18n/et.ts`, `src/i18n/de.ts`

**Interfaces:**
- Consumes: Task 1 helpers and states.
- Produces:
  - `interface StaffGroupsPanelProps {value:EngravingOverrides;score:model.Score;trackIds:readonly string[];rendered:readonly number[];pageLayout:boolean;busy:boolean;locked?:boolean;onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown}`
  - `StaffGroupsPanel(props:StaffGroupsPanelProps)`
  - i18n keys under `staff_groups.`: `title`, `help`, `choose_track` ({name}), `kind`, `kind_bracket`, `kind_brace`, `create`, `problem_tooFew`, `problem_notContiguous`, `problem_alreadyGrouped`, `problem_tooMany`, `group_label` ({names}), `removed_track`, `state_drawn`, `state_tooFewTracks`, `state_notContiguous`, `state_notShown`, `remove`, `remove_all`, `gap_track`, `gap_field`, `gap_reset`, `gap_reset_all`, `gap_last`, `gap_layout`, `gap_invalid` ({min},{max}), `status_locked`, `names_long_first`, `names_long_first_help`, `names_already`.

- [ ] **Step 1: Write the failing tests** in `StaffGroupsPanel.test.tsx`

```ts
it('creating a group from two adjacent checked tracks is one command',()=>{ /* check Guitar6 and Grand Piano, choose Brace, click create -> onEdit once with staffGroups [{trackIds:['base/0','base/1'],kind:'brace'}] */ });
it('create is unavailable with a reason for one track, a gap in the run or an already grouped track',()=>{ /* aria-disabled="true", status text t('staff_groups.problem_notContiguous'), click records nothing */ });
it('changing a group kind is one command and choosing the current kind records nothing',()=>{});
it('shows each stored group state, including a removed track',()=>{ /* 'removed track' label and state_tooFewTracks */ });
it('remove and remove all are single commands and unavailable when there is nothing to remove',()=>{});
it('a staff gap commits on Enter and blur, rejects 24 and 401, and the current value records nothing',()=>{});
it('the last track gets the last-track status and the gap is still reset-able',()=>{});
it('outside page layouts the panel says staff gaps show only in page layouts and export',()=>{});
it('long names first, short after is one command and unavailable once set',()=>{ /* onEdit once with the four stylesheet values; rerender with them -> aria-disabled */ });
it('busy keeps focus: controls are aria-disabled, never disabled',()=>{});
```

Also run the i18n catalog test, which must pass with the new keys in all three languages.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/engraving/StaffGroupsPanel.test.tsx src/i18n`; Expected: FAIL (module missing; catalog keys missing).

- [ ] **Step 3: Implement the Interfaces above.** Follow `SystemGapsPanel`: percentage field 25 to 400, Enter/blur commit, edited-text guard, `busyGuard({busy,unavailable,onClick})` for every button. `App` passes `rendered={visibleTracks}`, `pageLayout={systemGapsLayout}`, `busy={editBusy}`, `locked={editLocked}`.

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
- Modify: `docs/validation/2026-10-15-gp8-parity-progress.md` (D11 row), `docs/validation/2026-10-15-gp8-parity-progress.json` (D11 entry)

**Interfaces:**
- Consumes: the built desktop test app (`scripts/build-desktop-test.ps1`, binary at `.analysis/desktop-smoke/tabplayer.exe`), the engraving fixture (`buildEngravingFixture`), `window.__tabplayerTestExportPages`, the `data-tp-accolade` attributes.
- Produces: driver output and the validation record.

- [ ] **Step 1: Write the driver**, based on `parity-system-gaps.mjs`, vertical page view at A4. Checks, each a `check(name, body)`:
  - baseline: no `data-tp-accolade` on screen or in the export pages; the piano's native brace is present in the export pages;
  - group Guitar6 + Grand Piano as a bracket: one `setEngraving` carrying the group; one `group-bracket` per system on screen and in the export pages; one `track-brace` per system;
  - change the group to a brace: one edit; `group-brace` per system spanning guitar top to piano bottom (within 1 px of the BarBounds read from the page);
  - names: apply "Long names first, short after": one edit; export page text of system 1 contains "Guitar6", "Grand Piano", "Drums"; later systems contain "Gtr.", "Pno.", "Dr." and not "Guitar6"; the rightmost name x is left of the leftmost mark x;
  - choosing the current kind or pressing the names button again records nothing;
  - 200% below Guitar6: piano and drums move down by the measured gap on screen and in the export pages, the guitar does not; a click on a piano notehead after the move selects that note;
  - a 200% system gap on the third system composes with it (D08 offset from the composed heights);
  - per-track PDF export of the guitar alone: no `data-tp-accolade`;
  - move Drums above Grand Piano: the group status reads "its tracks are no longer next to each other" and no mark is drawn; undo restores the marks;
  - undo and redo every step; save and reopen keep groups, gaps and names; native playback generation unchanged across all edits; no page errors.

- [ ] **Step 2: Build and run**

Run: `powershell -File scripts/build-desktop-test.ps1`, then from the checkout root `node tests/desktop/parity-staff-groups.mjs`
Expected: every check prints PASS and the last line reads `staff-groups: N passed, 0 failed.` Run it three times; record any flake.

- [ ] **Step 3: Write `docs/validation/2026-11-07-gp8-staff-groups.md`** in the D08 record's shape: Behavior, Evidence (Vitest, Rust and the driver output verbatim, the build commit), Limits. Limits copied from the spec's "Evidence and limits to record" list, plus anything the driver did not cover (SVG, PNG and print exports not checked on the desktop; only export pages handed to the PDF writer are measured).

- [ ] **Step 4: Update the D11 tracker row** in both files. Keep `current_status` and `current_proven_status` `partial`. `current_behavior` names track groups (bracket or brace) drawn on screen and in export, the space below each track in page layouts and export, and the proven long-first/short-after names with its one-gesture option. `remaining_gap` names: staff gaps not in parchment or screen layouts, no gaps between a track's own staves, whole-system extended bar lines, first-system-of-each-page names, GP stylesheet export, no GP8 comparison. Add the new record to the evidence links.

- [ ] **Step 5: Commit**

```bash
git add tests/desktop/parity-staff-groups.mjs docs/validation/2026-11-07-gp8-staff-groups.md docs/validation/2026-10-15-gp8-parity-progress.md docs/validation/2026-10-15-gp8-parity-progress.json
git commit -m "docs: record the D11 staff groups desktop run (THE-180)"
```
