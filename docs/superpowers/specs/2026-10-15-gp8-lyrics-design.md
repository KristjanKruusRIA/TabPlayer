# Guitar Pro 8 lyrics design

Date: 2026-10-15. Status: accepted subsystem design under the user's standing instruction to complete all parity changes using parallel workers; root accepted this bounded design. This refines [the umbrella parity design](2026-10-15-gp8-feature-parity-design.md).

## Outcome and scope

Deliver raw per-track lyrics: zero to five verse lines, independent start measures, derived syllable placement, visible/hidden native source, one-step apply/undo, structural replay, and proven standard visible GPIF interchange. The pinned [baseline](../../validation/2026-10-15-gp8-parity-baseline.md) row is **E20**. The implementation sequence is [the lyrics plan](../plans/2026-10-15-gp8-lyrics.md).

The approved slate/cream/lime editor layout and inspector forms remain the visual basis. Changing the selected track edits that track's own lyrics; it does not transfer or erase another track's lyrics. Clipboard/transfer, other song metadata, layout, and nested tuplets are outside this subsystem.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared TypeScript/Rust DTOs and validators, engine/router, App/EditorPanel/ScoreView, model rebuilds, GP adapter integration, selection/export integration, Git, and desktop verification.
- Feature workers edit only assigned new modules, panels, tests, and authored fixtures. Do not edit installed alphaTab or first-delivery feature files.
- DTO indices are zero-based; measure labels are one-based. Validate complete payloads and destinations before mutation. Undo/redo uses deterministic history replay.
- Standard GPIF fields must be demonstrated by public readers/writers or authored GP8 fixtures; no invented extension elements, IDs, or private properties.
- Model retention, native replay, rendered notation, musical output, and target-runtime GP8 compatibility require separate evidence.
- Lyrics are per selected track, with at most five source lines. Native reader/writer/render evidence establishes dispatched=false as hidden source. Mixed/embedded-comment syntax and actual GP8 runtime acceptance remain open.

## Observed capabilities and losses

These results come from small authored public-model probes on 2026-10-15. They do not imply product or GP8-runtime acceptance. The [official lyrics guide](https://www.guitar-pro.com/docs/gp8/score/lyrics) is retained in the existing public manual cache.

- `Lyrics.finish()` handles `a  b -> ['a','','b']`, `a\n\nb -> ['a','b']`, and `a+b c -> ['a b','c']`. However, `[CHORUS] hello -> ['','hello']`, `a--b -> ['a--','b']`, `a[CHORUS]b` stays literal, and `a___ b -> ['a','b']`. Public parsing alone cannot satisfy the manual's comments/repeated-hyphen rules and strips undocumented literal underscores.
- `Track.applyLyrics()` reparses every line, uses first staff/voice zero, skips empty/rest beats, follows `nextBeat`, and does not clear existing assignments. Assigning corrected `Lyrics.chunks` cannot bypass its parser.
- Public GP export preserves distributed beat arrays but reconstructs raw source. `[VERSE] Hel-lo  world+today - end\n\nnext` became ` Hel- lo  world+today - end next`, losing the comment and newline layout. Standard output uses Track `Lyrics dispatched="true"`, Line/Text/Offset, and per-beat Lyrics/Line.
- The public reader does not expose original raw lyric source on Track. Native raw source and renderer assignments therefore have different responsibilities.

## Contract and ownership

The lyrics owner creates `src/editor/lyrics-types.ts`, `lyrics-source.ts`, `lyrics.ts`, `LyricsPanel.tsx`, their focused tests, and `src/interchange/lyrics.ts` / `lyrics.test.ts`. Root imports the local type into its shared union after the current delivery is pinned.

```ts
export interface LyricLine { startBar:number; text:string }
export type TrackLyrics = { visible:boolean; lines:LyricLine[] };
export type LyricsCommand = {
  type:'setTrackLyrics'; track:number; visible:boolean; lines:LyricLine[];
};
export type LyricsDraft = TrackLyrics & { source:'raw'|'distributed' };
export function tokenizeLyrics(text:string):string[];
export function getTrackLyrics(score:model.Score,track:number):LyricsDraft;
export function applyLyricsEdit(score:model.Score,command:LyricsCommand):boolean;
export function copyLyricsSources(source:model.Score,destination:model.Score):void;
export function reflowLyrics(score:model.Score):void;
export function removeLyricsMeasure(score:model.Score,bar:number):void;
export function readGpifLyrics(score:model.Score,doc:Document):void;
export function writeGpifLyrics(score:model.Score,doc:Document):void;
```

Root calls the handler after narrowing the command; it need not import shared EditCommand into the owned module. The native DTO is `SetTrackLyrics {track:u32,visible:bool,lines:Vec<LyricLine>}`, with exact nested `{startBar:u32,text:String}` and `deny_unknown_fields`. Draft provenance is UI state, never a history field.

Arrays contain **0..5** lines; `[]` clears. Empty text preserves its verse slot. Every startBar must name an existing master bar, including hidden lines. Reject line six, unknown/missing fields, negative/fractional/out-of-uint32 indices, nonstrings, and nonboolean visibility before mutation. Return deep copies from getTrackLyrics so textarea drafts cannot mutate applied state.

## Source lifetime and structural behavior

Use a module-owned `WeakMap<model.Track,{value:TrackLyrics,managed:boolean}>`. Exact native commands are authoritative for edited tracks (`managed=true`). A preceding track deletion changes indices while the track object retains its source. Root copies sources by current track index immediately across each full score rebuild/clone. Store no custom property on alphaTab instances or in public model JSON.

Import exact standard GPIF Track/Lyrics/Line/Text and Offset in MasterTrack/Tracks order with `managed=false`, retaining blank slots. Do not confuse Score.words (author credit) or Beat.text with sung lyrics. Preserve imported distributed assignments until explicit Apply. Distributed-only imports get a reconstructed draft labeled “Reconstructed from displayed syllables”; preserve gaps between eligible beats and use `+` for joined words. Opening a panel writes nothing.

Applying a command validates every line and computes all destinations before mutation. Clear all Beat.lyrics in the chosen track's first staff, across every voice including empty/rest beats, then assign voice-zero eligible beats. Other staves/tracks remain unchanged. Eligibility is exactly `!beat.isEmpty && !beat.isRest`; tied continuations and grace beats remain eligible under this public-model rule and need explicit fixtures. Text beyond the score remains raw source without creating bars. Hidden lyrics retain source and clear assignments. One Apply is one history step.

After an accepted score edit and rebuild, root calls reflowLyrics for managed tracks after chains exist. This covers note/rest changes, beat insert/delete, first-staff/voice removal, and appended measures. Before deleting a measure, root calls removeLyricsMeasure: starts after the removed bar decrement; a start at the removed bar stays at the successor index, clamped to the new final bar when deleting the last bar. Undo obtains the earlier offsets by replay. Removing a track drops its cache entry with the object; adding a track creates no lyrics. Voice-copy does not implicitly copy track raw source.

## Parser and placement semantics

The tokenizer is owned because Track.applyLyrics reparses. Preserve raw source exactly; normalize only derived tokens. Required examples are:

```ts
expect(tokenizeLyrics('Hel-lo  world+today')).toEqual(['Hel-','lo','','world today']);
expect(tokenizeLyrics('[VERSE] hello')).toEqual(['hello']);
expect(tokenizeLyrics('a--b')).toEqual(['a-','','b']);
expect(tokenizeLyrics('a\n\nb')).toEqual(['a','b']);
expect(tokenizeLyrics('a+b c')).toEqual(['a b','c']);
expect(tokenizeLyrics('a___ b')).toEqual(['a___','b']);
```

Each ordinary space/hyphen separates syllables; additional separators allocate blank beats. A hyphen boundary displays one trailing dash on the preceding nonblank syllable. A run of CR/LF becomes one separator. Removing a leading bracket comment and its adjacent separator must not allocate a leading beat. Comments' internal spaces allocate no beats; an unclosed bracket excludes the remainder. Treat a tab as one separator while preserving its raw character. Embedded comments and mixed space/hyphen boundary examples remain a localized GP8 compatibility fixture before syntax parity closes; do not fall back to the demonstrated broken public parser.

## Panel interface

```ts
export interface LyricsPanelProps {
  score:model.Score; track:number; busy:boolean;
  onEdit:(command:LyricsCommand)=>void;
}
export function LyricsPanel(props:LyricsPanelProps):React.JSX.Element;
```

Follow existing details/summary and fieldset patterns. Show selected track name, Visible, up to five numbered textarea/start-measure rows, Add line, Remove line, and Apply lyrics. Convert UI measures 1..N to DTO 0..N-1 once on dispatch. Reset unsaved local draft when score or track changes. Include a short syntax hint and reconstructed-source provenance where applicable. Hidden source remains editable. No per-keystroke history or new transfer flow.

## Proven standard GPIF adapter and visibility boundary

writeGpifLyrics replaces managed Track/Lyrics nodes and imported nonempty/hidden raw sources with exact raw Text and zero-based Offset. Visible unmanaged syllable assignments remain unchanged. Use DOM text nodes for XML escaping of `&`, `<`, `]]>`, Unicode, and newlines. Preserve carriage returns using standard character references. Root integrates this with its single XML/ZIP rewrite, retaining unrelated source siblings and the first delivery's DSP/percussion patches. Literal CDATA terminators require a detached export model and bounded Beat lyric serialization because the public writer emits malformed CDATA and its reader loses adjacent CDATA chunks.

The supplied GPIO.dll reader at 0x1800f0d60 reads dispatched, the writer at 0x180115580 writes it while retaining raw verses, and renderer helper 0x1802129f0 returns that flag for its lyrics branch. This resolves the initial unknown: write dispatched=false for hidden source. Since alphaTab ignores the flag, the owned importer clears first-staff assignments while retaining exact raw source, and rebuilds keep hidden assignments clear. This execution-free evidence does not prove original GP8 runtime acceptance. Hashes, addresses and limits are recorded in the validation report and ignored native-gpif-semantics evidence.

## Acceptance and self-review

Native acceptance requires exact raw text/offsets, stale cleanup, first-staff distribution, five slots, atomic validation, one-step history, rebuild/structure preservation, and save/reopen. Visible/hidden GP acceptance needs independent XML inspection, distributed-matrix reopening, unchanged source/archive siblings, visual score/PDF review, and authored GP8 open. Mixed/embedded syntax and original GP8 runtime acceptance remain separately open.

- Source and renderer data are distinct; only managed native lyrics reflow.
- Finite DTOs/cache/adapter/panel interfaces have explicit owners.
- The linked plan covers parser, stale cleanup, provenance, structure, UI dispatch, native schemas, visible GP fidelity, and target-runtime checks.
- Standard visibility uses the native-proven dispatched flag; no private extension is proposed.
