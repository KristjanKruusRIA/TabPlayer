# MIDI note capture: design (THE-70, U16 and U17)

Status: accepted 2026-11-13. Ticket THE-70 ("Add MIDI output and note capture (A26, U16, U17)"), tracker rows U16 and U17 in `docs/validation/2026-10-15-gp8-parity-progress.md`. MIDI output (A26) is delivered (`docs/validation/2026-11-07-gp8-midi-out.md`); this design covers the part that is not: MIDI input and note capture. `file:line` references were read at `6ad2d6f` (develop) in the worktree. Written for an implementer who has not read the codebase.

## Must not change

- **Edit types and the project schema.** No new edit command, no new field in `ProjectView`, `DocumentSettings` or any `.tabplayer` file. A captured chord is recorded as the existing `sequence` of `setNote`, `addPitchedNote`, `setDuration`, `insertBeat` and `setNoteSpelling` (`src/edit-types.ts:121-122`, `src-tauri/src/edit_types.rs:1372-1378`). Old builds replay captured music; old projects replay unchanged.
- **`sequence` limits.** 2 to 8 steps, no nesting (`MAX_SEQUENCE_COMMANDS` in `src/parity-commands.ts:171` and `src-tauri/src/edit_types.rs:1378`). Do not raise them.
- **MIDI output.** `src-tauri/src/midi_out.rs`, `src-tauri/src/audio/midi_out.rs`, the track mix `midiPort` and `src/audio/MidiOutPanel.tsx` stay as they are. Input reuses only the `MidiPortInfo` type (`midi_out.rs:60`).
- **Typed entry.** `planScoreEntry` (`src/editor/score-entry.ts:136`) keeps its behaviour and its tests. Extracting its advance block into a shared helper must not change a single result of the existing tests.
- **One gesture is one undoable edit**, and choosing the current value records nothing (`CLAUDE.md`). One captured chord is one history entry. A chord that adds nothing records nothing.
- **The audio thread.** Input has no part in the audio callback. Nothing is added to `src-tauri/src/audio/`.
- **Consent.** No MIDI port is opened until the user presses Start. The app never starts input by itself at launch, on opening a document or on reconnect.
- **Imported and device data are untrusted.** Bound everything a device or an event payload can make large (see "Hostile input").
- **New UI text** goes through `src/i18n` with `en`, `et` and `de` entries, and a control that holds focus never gets `disabled` for busy (`src/ui/useBusyGuard.ts:17`, `busySelect` at `:123`).

## Goal

A player connects a MIDI keyboard or MIDI guitar, picks it, presses Start, and plays. Each chord is written onto the selected beat with the chosen written duration, and the cursor moves to the next beat. On a tablature staff the pitches become strings and frets; on a standard-notation staff they become spelled pitches. Sensitivity (a chord window and a velocity floor) and the channel-to-string mapping are per-user settings.

## What Guitar Pro 8 does

- **From the manual page fetched 2026-11-13** (`https://www.guitar-pro.com/docs/gp8/tools/midi-capture` and `…/preferences-stylesheet/preferences/audio-midi`; the PDF pages the tracker cites, 79-80, 196-198 and 307-310, were not read):
  - The tool is opened from Sound > MIDI Capture (beat by beat).
  - Each note played is entered on the active beat, and after that beat is edited the cursor moves to the next beat automatically.
  - Entered notes take the duration currently selected in the editing palette, and durations can be changed afterwards.
  - "Capture Sensitivity" is the maximum delay in milliseconds between notes for them to be grouped as a chord. A higher value suits relaxed strumming, a lower one tight playing. No range or default is given.
  - For a MIDI guitar that sends each string on its own channel there are two choices, "First channel for highest string" and "First channel for lowest string".
  - For a keyboard, which sends no string or fret, strings and frets are assigned automatically from the score to give a practical fingering.
- **From the tracker:** U16 acceptance is "Capture chords into selected beat with chosen written duration". U17 acceptance is "Group notes within threshold and map guitar channels to correct strings". The current gaps read "No hardware input/capture process" and "No MIDI input configuration".
- **Repository record of the same manual:** `docs/superpowers/specs/2026-11-06-gp8-score-entry-design.md:17` notes that automatic advance outside MIDI capture is not documented. Typed entry's "Advance after entering a note" preference is therefore a TabPlayer choice (assumed), separate from capture's advance.
- **Assumed (not in the manual):** a velocity floor; an "Off" choice for the channel mapping; that the chord window is a gap between consecutive notes rather than a span from the first note; the defaults below.

## Decisions by the owner (2026-11-13)

- The default chord window is **60 ms**, set between 10 and 500 ms.
- The velocity floor defaults to **1**, which filters nothing. The setting is kept (1 to 127).
- Capture is **not blocked while the transport plays**. This is listed under Limits.
- **U17 stays synthetic** until a channel-per-string MIDI guitar is available: its acceptance is the injected-message tests below, and the validation note must say so plainly. The tracker row is not moved to a hardware-verified state.

## What exists

### MIDI output, which input mirrors

- **Listing.** `midi_out_ports` (`src-tauri/src/midi_out.rs:1418-1432`) lists on demand through `spawn_blocking`. It reaches `SystemMidi::ports` (`:113-169`), which makes a `midir::MidiOutput` each call. Listing opens no port.
- **Selection and persistence.** The chosen port is the track mix's `midiPort`, so it is document state, undoable and saved with the score. The delay is per user: `localStorage` key `tabplayer.midiOutDelay` (`src/audio/midi-out-preferences.ts:2`), pushed to native with `midi_out_set_delay` (`midi_out.rs:1435`), remembered natively for the session only.
- **Opening.** `MidiOut::ensure_ports` (`:703`) starts each open on its own thread (`open_job`, `:1058`) so a slow driver delays nothing. An open that exceeds 3 s fails, and a port is retried at most every 2 s (`:40-44`). A sender thread `midi-out-sender` (`:588-615`, `run_sender` at `:1391`) writes the messages.
- **Loss.** Detected only when a send fails (`set_open`, `:350`). The panel polls `midi_out_status` every second (`src/audio/MidiOutPanel.tsx:37-43`); there are no Tauri events.
- **Teardown.** `Drop for MidiOut` (`:1051`) and `RunEvent::Exit` (`src-tauri/src/lib.rs:1495`).
- **Names.** Ports are matched by name, first duplicate wins; WinMM truncates names to 31 characters; the session caps at 32 names (`src-tauri/src/audio/midi_out.rs:29`).

### Services that do not belong to a document

- `TunerState` (`src-tauri/src/tuner/mod.rs:478`) and `LineInState` are `.manage`d at `lib.rs:1067-1068` and stopped in `RunEvent::Exit` (`lib.rs:1484-1492`). The tuner uses session numbers and a stale-proof `stop_session` (`tuner/mod.rs:599`).
- The Line-In panel keeps its session in a module singleton, `lineInSession()` (`src/audio/line-in-session.ts:102`), so it survives the panel closing; Practice shows a dot while it is on (`src/i18n/en.ts:258`).

### Events and capabilities

- Native code emits with `app.emit` (`lib.rs:1106` `recovery-status`, `:1184` `native-audio-status`). The front end listens with `listen` (`src/audio/bridge.ts:64`), and tests mock `@tauri-apps/api/event` (`src/workspace/bridge.test.ts:8`).
- `src-tauri/capabilities/default.json` holds only `core:event:allow-listen`, `allow-unlisten` and window and dialog entries, and `src-tauri/build.rs` is the plain `tauri_build::build()`. The existing app commands (`midi_out_*`, `tuner_*`) need no capability entry, so input needs none.

### Test seams

- `MidiBackend` fakes in `midi_out.rs`: `Fake` (`:1463`), `RecordingPorts` (`:271`), `ListedPorts` (`:225`).
- A desktop-test-only logging port, `TEST_PORT_NAME` (`:53`), enabled by `TABPLAYER_MIDI_OUT_TEST=1` (`:119-123`), read back through `midi_out_test_log` (`:1444-1448`). There is no OS virtual port.
- Driver `tests/desktop/parity-midi-out.mjs`. Integration tests in `src-tauri/tests/audio_midi_out.rs`.
- midir 0.11.1 is already a dependency (`src-tauri/Cargo.toml:37`). Its input API, read from the cargo registry source: `MidiInput::ignore(Ignore)`, with `Ignore::All` meaning sysex, time and active sensing (`midir-0.11.1/src/lib.rs:13-22`, `src/common.rs:70`), and `connect(&port, name, FnMut(u64, &[u8], &mut T) + Send + 'static, data)` (`src/common.rs:120-128`).

### The note-entry path

- **Plan and run.** `planScoreEntry` (`src/editor/score-entry.ts:136-166`) builds one edit and the next cursor. Its advance block is `:151-164`. `runEntryPlan` (`src/App.tsx:541`) records it and moves the cursor.
- **Queue.** Keys that arrive while an edit is in flight wait in `entryQueue` (`App.tsx:186`; `ENTRY_QUEUE_MAX=8`, stale after 2 s, `:125`), run one at a time by `drainEntry` (`:673-686`) through `performItem` (`:626`). The type is `EntryItem` (`:119-123`). The dispatch decision, including the refusal latch, is `:732-736`.
- **Writing a note.**
  - `keyTarget` (`src/instruments/entry.ts:59-77`) picks the lowest fret on a free string, through `openStringKey` (`src/editor/partial-capo.ts:31`, which includes capo, partial capo and transposition), the banjo drone helpers `fretExists` and `fretKey` (`src/editor/banjo-drone.ts:34,36`) and `maxEntryFret` = 24 (`entry.ts:19`).
  - Pitched staves use `addPitchedNote` and `spellingStep` (`src/editor/notation-entry.ts:212`). `respellNote` shows how an `EntryPitch` literal is built (`score-entry.ts:284`); `automaticSpelling` is at `notation-entry.ts:104`.
  - `oneEdit` (`notation-entry.ts:204`) wraps steps into a `sequence`.
- **Duration.** `autoDurationEdit` (`src/editor/input-preferences.tsx:72`) sets the entry duration (`entryDuration` ref, `App.tsx:178`) on a rest, and falls back with `AUTO_DURATION_UNFIT` when it does not fit the bar.
- **Fingering.** `planFingering` (`src/editor/fingering.ts:14`) re-places existing notes while preserving their pitch, with a centre-fret dynamic programme (`:42-66`). It reads pitch from alphaTab's `realValue`. I did not verify whether `realValue` includes the partial capo kept in `partial-capo.ts:16`, so this design does not reuse it for placement.
- **Preferences.** Per-user input preferences are `localStorage` (`input-preferences.tsx:27`, panel at `:96`, mounted in the View menu at `App.tsx:958`). The Line-In and MIDI-out preferences follow the same pattern (`src/audio/line-in-preferences.ts:16`).

## Design

### 1. A session-scoped input service

New `src-tauri/src/midi_in.rs`. The state mirrors `TunerState`: managed, cheap to clone, session numbers, `stop_session`. A backend trait mirrors `MidiBackend` so tests need no hardware. Not hung off `NativeAudio.service`: input has nothing to do with documents or the audio callback.

### 2. Consent and lifetime

- Listing opens nothing. `midi_in_start(port, settings)` is the only open.
- The chosen port name is remembered in `localStorage`, but monitoring is always off at launch (the Line-In precedent, A29 in the tracker).
- No virtual port is created. No automatic reconnect: Start, or Refresh then Start, retries.
- Input runs until Stop or app exit, like Line-In, so the player can watch the score with the panel closed. It is stopped in `RunEvent::Exit` beside the tuner (`lib.rs:1484`).

### 3. Events, not polling

The grouped chord reaches the page as a Tauri event. Rejected: polling like `tuner_read` (up to one poll interval of extra latency and constant IPC for a discrete stream that must not lose notes); `tauri::ipc::Channel` (used nowhere in the repository). Payloads carry `session` and `seq`, and the page attaches its listener before it calls `midi_in_start`.

### 4. Chord grouping is native

A pure `ChordGrouper` state machine with an injected microsecond clock groups note-ons. JavaScript timing would be skewed by webview stalls.

- The midir callback stamps each message with its own arrival time and ignores the driver timestamp, whose origin differs per backend.
- A chord closes when `chord_window_ms` passes with no new note. A new note within the window extends it. This reading of "maximum delay between notes" is assumed.
- A chord is also closed when its first note is 4 times the window old, and at 8 notes.
- Note-offs are not forwarded. A note-on with velocity 0 is a note-off and never a note.
- Notes below the velocity floor are dropped and counted.
- Duplicate `(channel, key)` pairs in one chord keep one note, the louder.

### 5. Writing is a pure planner that reuses the entry queue

- `planMidiCapture` returns the same `EntryPlan` or `EntryRefusal` as typed entry, so `runEntryPlan` records it, moves the cursor and updates `entryDuration` and `entryNear`.
- Capture always advances, as the manual describes (from the manual page fetched 2026-11-13); the typed-entry "Advance after entering a note" preference does not govern it. The advance block of `planScoreEntry` (`score-entry.ts:151-164`) is extracted into an exported helper that both use. Do not copy it.
- Duration is `autoDurationEdit` with the auto-duration preference treated as on: the entry duration if one has been chosen, otherwise the beat's own rhythm.
- A new `EntryItem` kind `capture` goes through the existing queue. The `refusing`/`entryQueueing`/`performItem` decision at `App.tsx:732-736` is extracted into one `dispatchEntryItem(item)` shared by the key handler and capture, so a chord that cannot join waiting keys is refused and the music has no hole.
- A chord is applied only when a document is open, the view is the score, the document is editable (`entryBlocked`, `App.tsx:549`) and a beat is selected. Otherwise a notice says why.
- Capture never toggles. A pitch already on the beat is skipped, not removed (unlike `keyTarget`). If nothing is new there is no edit, and `score_entry.present` (`src/i18n/en.ts:141`) is shown.

### 6. Placement and the channel mapping

- **Tab staves.** Each note is placed by the centre-fret dynamic programme of `fingering.ts:42-66`, but with `openStringKey`, `fretKey`, `fretExists` and `maxEntryFret` as the source of pitch, so capo, partial capo and the banjo drone are honoured. Strings already used on the beat are excluded. A note below the capo, or beyond fret 24, cannot be placed and is refused with a notice.
- **Pitched staves** (no tuning): `addPitchedNote` with `key + staff.transpositionPitch`, spelled through `spellingStep`.
- **Percussion staves** are refused, as `entryBlock` does for typed entry (`notation-entry.ts:158`).
- **Channel mapping** (`StringMapping`): `off`, `lowestFirst`, `highestFirst`. `note.string` 1 is the lowest-pitched string (`partial-capo.ts:4`). `lowestFirst` sends 0-based channel c to string c+1; `highestFirst` sends it to string count-c. A channel at or beyond the string count, or channel 10, is unmapped and falls back to automatic placement. A pinned string that cannot reach the pitch also falls back, with a notice. The labels follow the manual wording (from the manual page fetched 2026-11-13); `off` is assumed and is the default, because a keyboard sends every note on one channel.
- **Step budget.** The steps are: an optional duration step, up to one note step per pitch, optional spelling steps, and an optional `insertBeat`. At most 8. A chord that needs the insert holds at most 7 notes; excess notes are dropped with a notice. Spelling steps are added only where the spelling differs from the default and the budget allows.

### 7. Settings are per user

`localStorage` key `tabplayer.midiCapture`: `{port, chordWindowMs, minVelocity, stringMapping}`, read with try/catch and clamped, in the manner of `line-in-preferences.ts`. There is no native settings file; native receives the values at `midi_in_start` and `midi_in_configure`. They are not saved with a document and are not part of the project.

### 8. UI

- `src/editor/MidiCapturePanel.tsx`, rendered under `InputPreferencesPanel` in the View menu (`App.tsx:958`), so it is a viewer setting like the other score-input choices. It holds: port select and Refresh, Start/Stop, chord window (10 to 500 ms, step 5, default 60), minimum velocity (1 to 127, default 1), string mapping (slice 3), and a status line with the last chord named by `formatPitch` (`src/tuning.ts:3`).
- A small "MIDI capture on" indicator beside the Note entry toggle (`App.tsx:979`), as the Practice dot does for Line-In.
- Start and Stop use `busyGuard`, and selects use `busySelect`, never `disabled` for busy. New keys `midi_in.*` in `en`, `et` and `de`.

## Interfaces

```rust
// src-tauri/src/midi_in.rs
pub trait MidiInBackend: Send + Sync + 'static {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String>;                 // MidiPortInfo from midi_out.rs
    fn open(&self, name: &str, sink: RawSink) -> Result<Box<dyn InputLink>, String>;
}
pub type RawSink = Box<dyn FnMut(&[u8]) + Send>;
pub trait InputLink: Send {}                                              // dropping it closes the port
pub struct CaptureSettings { pub chord_window_ms: u32 /* 10..=500 */, pub min_velocity: u8 /* 1..=127 */ }
pub struct Chord { pub seq: u64, pub at_us: u64, pub notes: Vec<ChordNote> }   // at most 8 notes
pub struct ChordNote { pub key: u8, pub velocity: u8, pub channel: u8 }
pub struct ChordGrouper;      // new(CaptureSettings); push(at_us, channel, key, velocity) -> Option<Chord>; poll(now_us) -> Option<Chord>
pub struct MidiInState;       // Clone, Default, managed like TunerState

#[tauri::command] pub async fn midi_in_ports(state) -> Result<Vec<MidiPortInfo>, String>;
#[tauri::command] pub async fn midi_in_start(state, app, port: String, settings: CaptureSettings) -> Result<u64, String>;
#[tauri::command] pub fn midi_in_configure(state, session: u64, settings: CaptureSettings) -> Result<(), String>;
#[tauri::command] pub async fn midi_in_stop(state, session: Option<u64>) -> Result<(), String>;
#[tauri::command] pub fn midi_in_status(state) -> MidiInStatus;
#[cfg(feature = "desktop-test")] #[tauri::command] pub fn midi_in_test_inject(state, bytes: Vec<u8>) -> Result<(), String>;
```

- **Events** (camelCase JSON):
  - `midi-in-chord {session, seq, atMs, dropped, notes:[{key, velocity, channel}]}`.
  - `midi-in-status {session, state: 'running'|'stopped'|'lost'|'error', port, message}`.
- **Registration.** Add the commands to both `generate_handler!` lists (`lib.rs:1345-1347`, `:1461-1464`, the test-only inject command only in the second). Add `.manage(midi_in::MidiInState::default())` beside `lib.rs:1068`, and `stop()` in `RunEvent::Exit` beside `lib.rs:1484`.
- **Test port.** A "Test MIDI input" port, enabled by `TABPLAYER_MIDI_IN_TEST=1` in desktop-test builds only (copy `midi_out.rs:119-125`), whose sink is the same one `midi_in_test_inject` feeds.

```ts
// src/audio/midi-in.ts
export interface MidiInBridge { ports():Promise<MidiOutPort[]>; start(port:string,s:CaptureSettings):Promise<number>; configure(session:number,s:CaptureSettings):Promise<void>; stop(session?:number):Promise<void>; status():Promise<MidiInStatus>; subscribe(onChord:(c:MidiChord)=>void,onStatus:(s:MidiInStatus)=>void):Promise<()=>void>; }
export const nativeMidiIn:MidiInBridge;
export function parseChordEvent(payload:unknown):MidiChord|null;       // null on anything unexpected

// src/editor/midi-capture-preferences.ts
export interface MidiCapturePreferences {port:string;chordWindowMs:number;minVelocity:number;stringMapping:StringMapping}
export const DEFAULT_MIDI_CAPTURE:MidiCapturePreferences;               // 60 ms, floor 1, 'off'

// src/editor/midi-capture.ts (pure)
export type StringMapping='off'|'lowestFirst'|'highestFirst';
export interface CapturedNote {key:number;velocity:number;channel:number}
export function channelString(channel:number,stringCount:number,mapping:StringMapping):number|null;
export function planChordFingering(staff:model.Staff,notes:{key:number;string:number|null}[],occupied:ReadonlySet<number>):{string:number;fret:number}[]|null;
export function planMidiCapture(request:CaptureRequest):EntryPlan|EntryRefusal;
```

`EntryRefusal['refused']` gains the reasons the planner needs (for example `unreachable`, `too_many`), each with a `score_entry.*` string in all three languages.

## Compatibility and replay

- No schema change and no new edit, so nothing about replay, migration or old builds changes. Captured notes are ordinary edits in the log.
- A chord is one `sequence` (or one single edit) and one undo.
- Tuplet beats and bars the duration does not fit keep the existing skip notices.
- Nothing a device sends is persisted. Only the port name and three numbers are stored, in `localStorage`.

## Hostile input and realtime

- **No audio thread involvement.** Input threads are midir's own and the worker's; the audio callback is untouched.
- **Callback.** The midir callback does no allocation beyond copying three bytes into a fixed struct. It sets `ignore(Ignore::All)`, keeps only 3-byte note-on messages with velocity above 0, validates bytes below 128, and pushes with a non-blocking `try_send` into `sync_channel(256)`, counting drops in an atomic. A flood of a million messages a second costs a few nanoseconds each and cannot grow memory.
- **Worker.** One thread owns the grouper: a fixed group of 8 notes, deduplicated by `(channel, key)`. It uses `recv_timeout` with a wake at least every 250 ms.
- **Output rate.** A token bucket allows 32 chords a second with a burst of 8. Chords beyond it are dropped and counted, and the count is reported as `dropped`.
- **Loss.** midir reports no unplug. The worker polls `ports()` once a second; two misses in a row emit `lost` and drop the connection.
- **Page side.** Payloads are untrusted: `parseChordEvent` returns null on any surprise, events of another session are ignored, and a chord holds at most 8 notes. The existing queue bounds what can wait (8 keys, 2 s).
- **Privacy.** Note data stays on the machine. Nothing is logged. Error text carries port names, not notes.

## Test plan

- **Rust, no hardware.**
  - `ChordGrouper` with a fake clock: the window and its extension, the span cap, the 8-note cap, dedup, velocity floor, rate bucket, velocity-0 note-ons.
  - A fake `MidiInBackend` driving `MidiInState`: start, stop, a stale `stop_session` that leaves a newer session running, configure, a failed open, an open that never returns, device loss.
  - A flood of one million messages stays bounded and drops are counted.
  - `src-tauri/tests/midi_in.rs` through the public API.
- **TypeScript.**
  - `channelString` for both orders, extra channels, channel 10.
  - `planChordFingering` with standard tuning, capo, partial capo, the banjo drone, occupied strings, notes below the capo.
  - `planMidiCapture`: one chord is one `sequence` and one undo; an existing pitch records nothing; a bar-end advance inserts a beat; a refusal keeps the selection; a pitched staff spells correctly; the 7-note cap.
  - `parseChordEvent` against malformed payloads.
  - Panel and preferences tests, with `vi.mock('@tauri-apps/api/event')` as `src/workspace/bridge.test.ts:8` does.
  - A queue test: chords that arrive faster than edits land in order, and an overflow refuses the rest.
  - An i18n parity test for the new keys.
- **Desktop driver** `tests/desktop/parity-midi-in.mjs`, patterned on `parity-midi-out.mjs`, driving the test port with `midi_in_test_inject`:
  - the test port is listed;
  - three note-ons within 20 ms give one edit, and undo removes it in one step;
  - a second chord lands on the next beat;
  - a burst of 100,000 messages leaves the UI responsive and reports drops;
  - Stop closes it.
- **Only with real hardware (not done by this work):** opening a port on each operating system; unplug detection (WinMM, CoreMIDI, ALSA); real MIDI-guitar channel and pitch-bend traffic and which channel is string 1; real strum timing to confirm the 60 ms default; Bluetooth MIDI; macOS and Linux behaviour (unrun).

## Limits

- U17's channel mapping is verified only with injected messages, until a channel-per-string guitar is available. The validation note says so, and the tracker row is not moved past what that evidence supports.
- Capture is not blocked while the transport plays. A user who routes a track to a virtual cable that loops back to the capture input would capture their own playback.
- The 60 ms default and the gap-based window are not measured on real playing.
- The chord window adds its length to the latency from playing to writing.
- Pitch bends, aftertouch, sustain and note lengths are ignored. Duration comes from the entry duration only.
- Percussion staves are not captured.
- A chord that needs an inserted beat holds at most 7 notes.
- Ports are matched by name; duplicates are not told apart.
- Nothing is verified on macOS or Linux.

## Slices

Each slice is implemented, reviewed and merged on its own. Smallest useful first.

1. **Input service and panel, no score writing.**
   - Files: new `src-tauri/src/midi_in.rs`; `src-tauri/src/lib.rs` (module, `.manage`, both handler lists, exit); `src-tauri/tests/midi_in.rs`; `src/audio/midi-in.ts`; `src/editor/midi-capture-preferences.ts`; `src/editor/MidiCapturePanel.tsx` (port, Start/Stop, chord window, velocity floor, last-chord readout); `src/App.tsx` (mount the panel, the indicator); `src/i18n/en.ts`, `et.ts`, `de.ts`; `tests/desktop/parity-midi-in.mjs`; a note in `docs/validation/`.
   - Result: a verified path from device to page, with the chord readout proving it.
2. **Capture into the score with automatic fingering.**
   - Files: new `src/editor/midi-capture.ts`; `src/editor/score-entry.ts` (extract the advance helper); `src/App.tsx` (`EntryItem` kind `capture`, `dispatchEntryItem`); new `src/editor/useMidiCapture.ts`; `src/i18n/*` (`score_entry.*`); tests; the driver extended to check the written notes and one-step undo.
3. **U17 channel-to-string mapping.**
   - Files: `src/editor/midi-capture.ts` (`channelString`, pinned placement); `src/editor/MidiCapturePanel.tsx` and `midi-capture-preferences.ts` (the mapping select); `src/i18n/*`; fixtures with capo and partial capo; tests; a validation note that states U17 was verified with injected messages only.

## Implementation notes (slice 1)

Where the code differs from, or adds to, the design above.

- **Watchdog thread.** Loss detection runs on its own thread (`midi-in-watch`), not the worker, so a slow system listing cannot delay a chord.
- **One long-lived listing client.** `SystemMidiIn` makes one `MidiInput` the first time something lists and keeps it; the watchdog and Refresh share it. A client that cannot be made is an `Err`, never an empty list, and a failed listing counts for nothing in the watchdog. Listing happens only when the player opens the View menu (or presses Refresh or Start), not at launch.
- **Ordering.** A `Running` notice is chosen and sent while no `Stopped` for the same session can be sent (`Inner.notices`), so Running never follows Stopped.
- **Outstanding opens.** An open that never returns holds a thread and a sink. A Start for the same port is refused while its open is outstanding, and any Start is refused while 4 opens are outstanding (`MAX_PENDING_OPENS`); a hung port does not block other ports. Once an open is 30 s overdue the refusal says TabPlayer has to be restarted to use that port again (codes `open_pending`, `open_stuck`, `open_busy`, `open_busy_stuck`, worded in en/et/de by the page; the cap check and the recording of an open happen under one lock). The stuck thread cannot be cancelled; this is a stated limit.
- **Listing is never waited for.** A player's Refresh waits up to 500 ms for a listing in progress and then fails with "still in progress"; the watchdog never waits and skips that tick (it counts for nothing). A watchdog thread that is itself stuck inside the driver stays stuck until the driver returns. `shutdown()` lets go of the listing client.
- **Notices.** Status notices carry a rising `seq`, assigned under a lock that is not held while the notice is sent; the page drops a notice older than one it has seen, so Running never takes effect after Stopped.
- **Disclosure.** The panel is its own collapsed section in the View menu; the system MIDI client is made when that section is opened or Refresh is pressed.
- **Worker order.** Queued notes are taken first and the open chord is closed afterwards (`drain_then_poll`), so a descheduled worker does not split a chord.
- **Test clock.** `MidiInState::with_clock` replaces the session clock with one a test moves, so grouping tests do not depend on scheduling.
- **Page.** The session lives in `src/editor/midi-capture-session.ts` so listening survives the panel; the toolbar badge subscribes to a string snapshot (off, on, lost), so chords do not re-render the App, and a lost device changes the badge and is announced through a live region.

Stated limits (not fixed; unverified without hardware):

- **macOS.** CoreMIDI notifications need a run loop on the thread that made the client. The listing client is made on a Tauri command or worker thread, which has none, so the device list may not update after a replug until the app restarts. Not tested.
- **Linux.** ALSA port names embed client numbers, and ports are matched by name, so a remembered port may show as not connected after a replug that changes its number. Not tested.
- **Two devices with the same name.** `open` takes the first, and the watchdog only checks that some port has the name, so it will miss the unplug of one of two. Ports are matched by name throughout.
- **Open on a thread.** `open` still makes its own client for each Start, as midir's `connect` consumes it.
- **Settings per note.** The worker reads the settings for each queued note, so a configure applies to every note queued after it.

## Implementation notes (slice 2)

Where the spec was silent or the code differs.

- **Planner.** `planMidiCapture` (`src/editor/midi-capture.ts`) returns the same `EntryPlan` or `EntryRefusal` as typed entry. Its advance block was extracted from `planScoreEntry` as `advanceAfter` in `score-entry.ts` (typed entry's results are unchanged; its tests pass untouched). New refusal reasons `percussion` and `unreachable` have `score_entry.*` text in en, et and de, and the notice for notes that did not fit has `score_entry.capture_dropped`.
- **Placement.** `planChordFingering` first finds any valid assignment (augmenting paths), so a chord that can be played is never refused for want of search, then improves on it by a bounded search (at most 200,000 nodes, costs kept incrementally): strings in use on the beat are left alone; the cost is 8 per fret of stretch between fretted notes, the distance of each fretted note from the hand (the lowest frets when there is no hand yet; an open string costs 1), and 6 for each pair where a higher pitch sits on a lower string. Ties go to the lower string (the search visits strings in ascending order and keeps the first of equal costs; the first valid assignment is used only if the search found nothing at least as good). The capo, partial capo and banjo drone come from `openStringKey`, `fretExists` and `maxEntryFret`, as for typed entry. The hand is the rounded mean fretted fret of the last captured chord, kept in the page.
- **Out of range.** A pitch no string can play refuses the whole chord (`unreachable`, naming the pitch); nothing is clamped and nothing is partly written. More pitches than free strings refuses with `no_string`. This is the reading of "refused with a notice" in section 6.
- **Percussion** is refused with a message (`percussion`), as typed entry does; capturing drum pads is left for later.
- **Step budget.** Eight steps: an optional duration step, one per pitch, and an optional `insertBeat`. No pitch is ever given up for them (a chord that cannot be placed whole is refused, and a chord that is placed is written whole). The priority is pitches, then the entry duration, then the new beat. The duration is left out only when eight pitches leave no step for it, and then the player's entry duration is kept for the next chord (`plan.entry`), not overwritten by the beat's own. The beat is never bought with the duration: when it does not fit (the edit is full, or its rhythm does not fit the rest of the bar), the cursor moves on by other means (the next bar) and the notice says which of the two reasons applies. A pitch the beat already holds is skipped, never removed; a chord that adds nothing records nothing and says the pitches are already there.
- **Always advances.** Capture advances whatever typed entry's "Advance after entering a note" says; auto-duration counts as on (the entry duration is applied to a rest first).
- **Queue.** `EntryItem` gained kind `capture`. The dispatch decision that the key handler made is now `dispatchEntryItem` (keys); chords use `dispatchChord`, which shares the queue (8, stale after 2 s) but has its own small lane (at most 4 waiting) and never sets the refusal latch, so a flooding device cannot keep typed keys out; a chord arriving at a full queue is turned away and counted (it never sets the latch or says "busy"), and a typed key arriving at a full queue evicts the NEWEST waiting chord, so the chords played first stay in order. Every chord that does not reach the score is counted in `notWritten` and shown in the panel: a full lane, an eviction, a queue cleared by a click, undo, view change, note entry turned off or a stale or failed predecessor, an unmounted editor, a refused plan, a refused or unlanded edit, and the blocked states above. Chords of another session or repeated sequence numbers never reach the queue (the session filters them); a queued chord for another document is dropped by the queue's own document check, and an editor that is no longer active has no listener.
- **No-write cases.** With note entry off or outside the score view, a chord is only shown and nothing is said. With a header menu or a dialog open, or focus in a text field, it is shown and counted as not written (typed keys cannot reach the score then either); with a menu open the panel says why, next to the readout, until a chord is written. A locked or finalized document and a busy editor refuse with the usual entry messages. Capture never moves the focus.
- **Undo.** One chord is one history entry. Undo also puts the cursor back where the chord was written, when the chord is the last edit and the cursor has not been moved since (`undoEdit` in `App.tsx`).
- **Menus.** Opening a section inside a command menu used to close the menu: the header's click handler and `commandToggle` closed every other open `<details>`, including the menu around the section. They now close only details that neither contain nor sit inside the one opened, and buttons inside an element marked `data-menu-keep` do not dismiss the menu. jsdom did not show this in slice 1; it was found in the real app.
- **End of the score.** When the cursor cannot move on (the last beat of the last bar), the chord is written, the notice says the end was reached, and the next chord is refused (and counted) with a message until another edit or an Add bar changes the score, so it never merges into the same beat. Typed entry stays on the beat there and toggles; capture does not.
- **Undo marks.** The cursor-restore mark and the end mark are cleared by any other edit and by undo, so a reused revision number cannot match a later typed note.
- **Focus.** Dismissing a menu focuses the menu's own button only, never the summary of a section nested inside it.
- **Chords that fail.** A chord whose planner or writer throws is counted (live or from the queue). The cursor and score are read fresh from the controller when a chord runs, and `moveTo` repairs against the controller's score, so a change that is not the app's own (redo) cannot leave a chord planned against a stale render; this window could not be reproduced in a test.

## Implementation notes (slice 3)

Where the spec was silent or the code differs. Review fixes of 2026-11-13 are included.

- **Model.** As in section 6 and section 7: `stringMapping` is `off` (the default), `lowestFirst` or `highestFirst`, kept in `tabplayer.midiCapture` with the other three settings (no new stored field, so the slice 1 and 2 preference tests pass unchanged). There is no per-channel table and no "first channel" number. A stored value that is not one of the three is repaired to `off` (existing `readMidiCapturePreferences`). The page's own choice is the source of truth for the session: if storage refuses a save, `activeStringMapping()` still returns the unsaved choice, so the select and the chords agree.
- **Strings are positional.** String 1 is the last tuning entry, the bottom tab line (the lowest string of an ordinary guitar or bass; the short drone string of a banjo, which sounds high). The panel words the options by tab line ("Channel 1 is the bottom tab line" / "the top tab line"), not by pitch.
- **Channel to string** (`channelString`). `highestFirst`: channel c is string count-c, so the top string is channel 0 on any track. `lowestFirst`: channel c is string c+1, shifted up by the strings a track has beyond six, so a 6-string guitar's low string is string 2 on a 7-string track and string 3 on an 8-string one (the spec had no anchoring rule; without it every note on such a track lands one string off). Channels past six, or past the strings of a shorter track, and channel 10 (index 9) are unmapped. Where channels 1 to 6 land: 4 strings, lowest first 1 2 3 4 and highest first 4 3 2 1 (channels 5 and 6 unmapped); 5 strings, 1 to 5 and 5 to 1 (channel 6 unmapped); 7 strings, 2 to 7 and 7 to 2; 8 strings, 3 to 8 and 8 to 3. While the mapping is on and the cursor is on a track whose string count is not six, the panel says so with these numbers (a persistent, translated line).
- **Read at write time.** Each chord reads the mapping as it is written (`activeStringMapping()` in `writeCapture`), so a change applies to the next chord, also while input runs. It is page-side only; nothing is sent to the native side and no Rust changed.
- **Identity with a mapping on is (string, pitch).** The same pitch on two mapped strings is two notes and both are written, also when the beat already holds that pitch on another string. A mapped note whose own string already holds that pitch is left out (it is already there); a chord that adds nothing records nothing (`present`).
- **Refused whole, counted** (nothing is moved or dropped quietly). The message names note and string: a mapped string that cannot play the pitch (`unreachable`: below the open string or capo, past `maxEntryFret`, a fret the banjo drone lacks), even when another string could; two different notes on one mapped channel (`channel_shared`); a mapped string that already holds a different note on the beat (`string_taken`). These live only in `planMidiCapture`; `buildDocument` and replay are untouched.
- **Genuinely unmapped channels** (no string on this track, channel 10) fall back to the fingering rule (section 6), never onto a string another note of the chord pinned. The notice names note and channel, and the panel counts these notes ("written on another string", `plan.moved`). A copy of a pitch on such a channel, when the pitch is already pinned or on the beat, is not written again; this is reported in a notice and counted (`plan.skipped`, "not written again"). Both counts are shown in the panel, are not live regions, and reset at Start.
- **Pitched staves** ignore the mapping. Percussion is still refused.
- **Mode off** goes through the slice 2 code path unchanged; tests compare it with explicit slice 2 placements and show that channels are ignored.
- **Reset.** One button restores the chord window, the velocity floor and the mapping to their defaults (not the chosen input) and tells a running session about the sensitivity.

Stated limits of slice 3:

- There is no first-channel setting: a device that sends its strings on channels 11 to 16, or starts at another channel, is unmapped and placed by the fingering rule (with a notice and a count).
- A 7-string MIDI guitar on a 7-string track with `lowestFirst` is shifted by one string (the anchoring assumes a 6-string device). Use `highestFirst` for it.
- After two undos the next chord lands on the next beat, not the first one: the cursor-restore mark covers only the last chord (slice 2 behaviour).
- Which channel a real hex pickup sends its lowest string on, pitch bends and strum timing are not verified (no MIDI guitar available).
