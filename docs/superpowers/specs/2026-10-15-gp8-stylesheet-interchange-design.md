# Guitar Pro 8 common/cut stylesheet interchange

Date: 2026-10-15. Bounded design under the user's standing approval for all parity work and parallel implementation. Supports the [umbrella design](2026-10-15-gp8-feature-parity-design.md); execution follows [the implementation plan](../plans/2026-10-15-gp8-stylesheet-interchange.md). This extends the earlier source-style preservation contract for **one demonstrated option only**. It does not complete general GP stylesheet parity.

## Intent and approach

Read the authoritative GP full-score common/cut choice into the existing editor, preserve imported style bytes during unrelated work, and export representable edits without losing per-measure intent. TabPlayer already stores `MasterBar.timeSignatureCommon` and the finite `setMasterBarGestures` command. GP8 instead demonstrates a global stylesheet option applying to 4/4 and 2/2; numeric GPIF `Time` remains unchanged.

Use a tiny independent wire reader/patcher for exactly that GPSS path, a similarly bounded legacy record patcher, and ephemeral provenance distinguishing explicit values from absent/inherited source. Keep all existing commands and native history. Patching only BinaryStylesheet is ineffective when score.gpss exists. Replacing the stylesheet or importing its complete schema would unnecessarily risk unrelated styles and copy material outside this feature's need.

## Global constraints

- Native projects remain schema version **2**, engine version **1.8.4**; existing commands, clipboard versions **1/2**, and replay meaning stay compatible.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing TypeScript/React and Rust/Tauri stack; no new dependencies or vendor patches.
- Change only the demonstrated `StylesheetBase.bar(11) → BarStyle.showTimeSignatureAsSymbol(5) → OptionalBool.value(1)` path and legacy `Staff/drawTimeSignatureC` key. Do not invent a GPIF symbol field or expand other stylesheet options.
- Preserve original source bytes, unknown supported records, unrelated archive members, backing audio, raw lyrics, harmony and surviving links. No read/export operation adds document history or mutates canonical music.
- Untouched or semantically unchanged full-score intent preserves original stylesheet and scoreview bytes exactly. A changed projection rejects unsupported mixed or unresolved eligible-bar intent before output is written.
- Root owns shared integration, existing editor/engine/source-copy hooks, Git, full suites, builds, applications and CDP. Workers edit only their assigned new modules/tests.
- Retained static native evidence, independent byte/ZIP tests, public-model round trips, rendered output and original GP8 runtime acceptance are separate claims. Do not describe authored probes as original-GP8-opened fixtures.

## Evidence and current source

The ignored `.analysis/parity/native-stylesheet-semantics.{md,json}` and complete `native-stylesheet-evidence.json` establish proto3 field numbers **11/5/1**, wire types **2/2/0**, and native model conversion. GPIO's loader chooses `Content/Stylesheets/score.gpss` when present; only entry absence selects `Content/BinaryStylesheet`. A present empty OptionalBool is explicit false. A missing wrapper leaves the native optional unset, whose effective lookup can consult a parent before a final false fallback. Root/default-parent population is not established.

Retained descriptor Evidence IDs are `ev_00ffffdd52495ca4872f0bc4f867495839f204c5449962b3c80c3cabd0e75805`, `ev_b1792a83e60478f8de148e79c147b6d758bfb73c86d6022629c733d8f9d9891c`, and `ev_d106513f1307d00a026e5f03523b71374a299c6953fc9304d50cf38096441259`; precedence is `ev_881bab628623fd7b712f906b12e5b6919547cfe43afabbad1de22ac2882f3ef1`; optional lookup is `ev_6363f84b794a27de9fc855f8af2808352db985621ae5a09e839d734b0faf0c81`. The evidence note records original binary hashes, reverified descriptor bytes, authored archive hashes and honest limits. No new execution/decompilation is needed for this design.

Current owned `src/interchange/gp.ts` loads the public score, reads GPIF adapters and saves immutable archive siblings in a Score WeakMap. Export merges generated entries, then original entries, then regenerated GPIF. Its early return for no XML changes must still pass through the new stylesheet adapter. `copyGpInterchangeSource` already carries provenance through engine rebuild, selected export and clipboard clones. Installed alphaTab reads/writes legacy BinaryStylesheet, but does not handle this symbol key or current GPSS; its GP7 exporter creates legacy styles only. The existing legacy framing is a big-endian int32 record count, one-byte UTF-8 key length, key bytes, one-byte type, then a typed payload.

`src/editor/bar-gestures.ts` applies the complete `commonTime` field after validation. `setMeasureSettings` in `notation.ts` intentionally clears commonTime. `measures.ts` copies it into context-derived inserted masters; the older `appendMeasure` command in engine.ts retains its existing numeric-default meaning. Source markers must follow these paths without changing musical history. Codebase graph tools were unavailable; these claims came from focused current-source reads.

## Exact wire adapters

New modules expose only:

```ts
// src/interchange/stylesheet-wire.ts
readGpStylesheetSymbol(bytes:Uint8Array):boolean|null;
writeGpStylesheetSymbol(bytes:Uint8Array,enabled:boolean):Uint8Array;
// src/interchange/stylesheet-legacy.ts
readLegacyStylesheetSymbol(bytes:Uint8Array):boolean|null;
writeLegacyStylesheetSymbol(bytes:Uint8Array,enabled:boolean):Uint8Array;
```

`null` means the target wrapper/key is absent, never an error and never implicit false. For GPSS, the present empty wrapper is false. Illustrative literal messages: true `5a042a020801`, false `5a042a020800`, empty-wrapper false `5a022a00`. A missing parent path is appended when writing; existing unrelated root/bar/wrapper record bytes and order remain exact. Rewriting updates only the target and containing length headers. An already equal explicit value returns an equal detached copy; repeated writes are byte-idempotent.

The independent GPSS parser accepts wire types **0,1,2,5**, skips opaque unknown payloads without recursive interpretation, and descends only the target path. Bounds are **1,048,576 input/output bytes**, **8,192 aggregate visited records across the three parsed messages for both input and output**, **10 bytes per uint64 varint**, and field numbers **1–536,870,911**. Use checked integer arithmetic/BigInt for uint64 parsing; lengths must fit remaining bytes before conversion/allocation. Preflight added target records and encoded lengths before publishing output; a valid input whose missing path would exceed either output bound is rejected. Reject field zero, overflow, truncated tags/values/lengths, unsupported wires **3,4,6,7**, duplicate target containers/scalars, wrong target wires and target bool values outside **0/1**. Opaque duplicate unrelated fields are retained. Nonminimal but bounded varints may be read; untouched raw unknown encodings remain exact. These conservative limits are product choices, not native limits.

The legacy adapter has the same **1,048,576 bytes /8,192 records** input/output bounds, requires a nonnegative big-endian signed-int32 count and complete consumption, and preserves every unrelated record verbatim. Known framing types **0–7** have payload lengths **1,4,4,(signed-int16 length + bytes),8,8,16,4** respectively. Reject unknown types, negative string lengths, truncation, trailing bytes, duplicate target keys, target type other than **0**, and target bool outside **0/1**. Compare the exact ASCII target key bytes; unrelated UTF-8 content need not be decoded or normalized. Appending the missing key increments the count only if the output remains within both bounds; replacing an existing key changes its boolean byte only. Do not call alphaTab's internal BinaryStylesheet class or copy its implementation.

All four functions leave input arrays unchanged, return fresh output arrays where applicable, and throw an `Error` with `Unsupported GP common/cut stylesheet:` prefix for malformed or unsupported data. Readers do not silently fall back after error.

## Minimal intent provenance

The public boolean cannot distinguish numeric fallback from an explicit false edit. A small new `src/editor/time-signature-source.ts` uses WeakMaps on actual Score/MasterBar objects; it adds no vendor properties or persisted JSON fields. Its exact public surface is:

```ts
initializeTimeSignatureSource(score:model.Score,imported:boolean|null):void;
setTimeSignatureIntent(master:model.MasterBar,value:boolean):void;
copyMasterTimeSignatureSource(source:model.MasterBar,destination:model.MasterBar):void;
copyTimeSignatureSources(source:model.Score,destination:model.Score):void;
getTimeSignatureExportIntent(score:model.Score):{changed:boolean;value:boolean|null};
```

Initialization records the imported local global value and each master's imported intent plus its displayed boolean. For a known true/false option, apply that value only to eligible **4/4 or 2/2** masters. For an absent option, leave public-model values untouched and record inherited/unknown intent `null`; do not consult legacy when score.gpss exists. Other meters are untouched and excluded from export uniformity.

`setTimeSignatureIntent` records explicit authoring, including false equal to a previous displayed false. Call it after successful `setMasterBarGestures` validation/publication with the command's complete commonTime field; Apply already authors that entire snapshot. Call it after successful `setMeasureSettings` with false, preserving that command's existing clear behavior. Neither hook runs on rejected edits. Existing history replay recreates markers, so Undo/restart removes/reapplies the authoring naturally.

Markers carry their imported baseline and displayed baseline, not just current values. If a public caller changes the current boolean relative to that displayed baseline, export treats the current value as explicit intent. Returning to the imported known value is semantically unchanged even if a command was applied. Returning false to an inherited `null` baseline is an explicit change when recorded by a command. This comparison must not mutate marker state.

`copyTimeSignatureSources` copies the Score baseline and detached marker values by aligned source/destination master indices **before structural filtering or reordering**, as existing `copyGpInterchangeSource` callers do. No array-index marker survives a transform independently of its MasterBar. Context-derived blank masters copy the context marker through `copyMasterTimeSignatureSource`. The older append command also copies the preceding marker, without changing its existing numeric-default model boolean; a difference from the copied displayed baseline is detected as explicit current intent. Removed masters simply cease contributing. Excerpt/reorder keeps the markers on the retained objects. Do not attach source archive entries to an unrelated clipboard source.

A Score without imported archive provenance has explicit public-model boolean intent. A new master without a source marker likewise has its actual boolean as explicit intent. Existing multi-track clipboard master snapshots carry their explicit model commonTime value; replacing a master from that self-contained snapshot is explicit authoring, without changing clipboard versions. Single-track/phrase paste retaining destination masters leaves their provenance intact. No clipboard extension for external GP inheritance is introduced; clipboard's existing boolean model meaning remains compatible.

## Import and export policy

New `src/interchange/stylesheet.ts` exposes:

```ts
readStylesheetTimeSignatures(score:model.Score,entries:Readonly<Record<string,Uint8Array>>):void;
writeStylesheetTimeSignatures(score:model.Score,entries:Readonly<Record<string,Uint8Array>>):Record<string,Uint8Array>;
```

The new symbol reader reads the exact current entry if present, otherwise the exact legacy entry if present, otherwise records unknown local choice. Malformed active styles fail load before document publication; a present malformed GPSS never selects legacy as recovery. The outer alphaTab1.8.4 loader still parses legacy BinaryStylesheet for its other presentation fields before this adapter runs. Malformed inactive legacy data can therefore still prevent app import despite valid GPSS; this existing public-loader limitation remains explicit, and no source entry is stripped to hide it. The pure adapter's ability to preserve an already-built score with opaque inactive legacy data is not a claim that such an archive can be opened through alphaTab. Import does not parse or reinterpret scoreview styles. This slice displays the full-score local choice; external inherited defaults and individual GP scoreview overrides remain opaque.

Export runs **after musical track/staff/range selection**, so it checks only eligible masters actually being exported. No eligible masters means no stylesheet change. For an imported score, if every retained eligible intent equals its imported global baseline, return a new entry map with all original style byte values unchanged, including conflicting or unsupported view bytes. This fast path never parses views or patches legacy. It covers unrelated edits, unchanged imported differences between views/full score, Undo back to baseline and untouched unknown inheritance.

For an actual changed projection, every eligible intent must be a known boolean and all must agree. Reject any true/false mixture, or any unresolved inherited intent alongside an explicit edit. For a new score, require uniform eligible public booleans. `getTimeSignatureExportIntent` returns `{changed:false,value:null}` for no eligible bars or unchanged imported intent; otherwise `{changed:true,value:<uniform boolean>}`. It throws on unsupported changed mixtures/unknowns. In particular a one-bar explicit false after inherited import is a changed false, even though the displayed boolean did not move; in a multi-bar inherited import, setting only one bar false leaves unresolved neighbors and must reject rather than guessing their intent.

For a changed representable projection, patch the established option in an existing score.gpss. If score.gpss is absent, keep it absent and patch the existing/generated BinaryStylesheet only; do not create an incomplete current stylesheet. If score.gpss exists, also patch existing/generated BinaryStylesheet for legacy consumers. Require the generated legacy member supplied by the current GP exporter; missing legacy data at this integration boundary is an error. Merge/patch in detached arrays only and return only after every check succeeds.

Do not overwrite original view overrides. On changed projections only, inspect exact member paths matching `Content/Stylesheets/scoreview[1-9][0-9]*.gpss` with the same bounded reader. Absent view option or an explicit equal option is allowed and its bytes stay unchanged. A conflicting explicit option, unsupported bytes or malformed recognized view rejects the changed projection visibly. This conservative guard is TabPlayer policy, not recovered native rejection behavior; unreferenced/other stylesheet names stay opaque. Resolving all native view relationships or rewriting views is separate parity work. Untouched imported exports bypass this guard.

Existing direct export and export-dialog error surfaces display the thrown message; neither calls its file-writing bridge after failure. Exact mixed-intent copy: **`GP export cannot represent mixed common/cut and numeric measure choices. Export a uniform measure range or use consistent choices.`** Unresolved-intent copy: **`GP export cannot resolve inherited common/cut choices for every selected measure. Set each selected 4/4 or 2/2 measure explicitly before exporting changed choices.`** View-conflict copy includes the actual member path and says the imported view style conflicts with the changed full-score choice. Replace the export help text with **`Engraving settings affect the screen and PDF. GP export preserves source styling and supports uniform common/cut choices; mixed measure choices cannot be exported.`** No new modal or approval flow.

## Acceptance and boundaries

Require independent literal-byte tests for true/false/empty wrapper/absence, path creation, unknown records of each supported wire type at all three levels, nonminimal unknown encoding, all malformed/budget cases, legacy framing and exact preservation. Public GP adapter tests must cover GPSS-over-legacy conflict, absence without fallback, native replay, equal-false authoring, untouched incompatible view preservation, changed-view rejection, selection reducing mixed intent to a uniform range, clone/insert/remove/append/clipboard lifetimes, and source/archive immutability. Compare literal standard MIDI note/control events and measure clocks to prove that display import/export did not change musical output.

Root verifies a rebuilt Windows diagnostic app: imported true yields common/cut glyphs in 4/4 and 2/2, false yields numeric display, noneligible 3/4 stays numeric; explicit edits survive native save/full restart/Undo/Redo; representable GP export/reopen matches; mixed and unresolved choices report errors before file writes; unrelated imported view styles remain exact. Native frontend/Rust checks and independent review precede integration. No original binary or proprietary descriptor/code enters tracked product/test files; use independently authored minimal wire fixtures. The retained public/archive probes may supplement local verification without becoming private or vendor fixtures in Git.

Still open: original GP8 runtime acceptance, external parent/default-style reconstruction, alphaTab's import dependency on inactive legacy presentation data, editing native view-style overrides, per-bar mixed GP interchange without a demonstrated representation, full stylesheet families and physical platform/printing acceptance. These limitations stay in the final validation record; passing the bounded tests does not close them or the full parity goal.
