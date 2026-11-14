# GP8 parity T23 and fermata timing: a golpe sound, and a probe for the fermata hold (2026-11-12)

Linear THE-60, second slice, branch `agy/the-60-holds-golpe`. It follows [2026-11-12-gp8-export-losses.md](2026-11-12-gp8-export-losses.md), which left two families pinned as absent: a golpe sound and a played fermata hold.

**Where this stands.** Golpe now has a sound of its own, which nobody has heard yet. The fermata hold is **not implemented**: the evidence the notation design requires from Guitar Pro 8 could not be gathered here, and the tooling to gather it is in place.

## Golpe

A golpe beat used to plan exactly like a plain one. It now adds a short percussion hit on the beat's own track and leaves the written notes as they are, so a golpe on a chord is a tap with the chord and a golpe on a rest is the tap alone.

| Golpe | Sound | Velocity | Length |
|---|---|---|---|
| Thumb | General MIDI Low Wood Block (key 77) | 85 | up to 120 ticks, shorter if the beat is shorter |
| Finger | General MIDI Side Stick (key 37) | 75 | the same |

- **Plan** (`src/audio/golpe.ts`, `src/audio/plan.ts`): a note-on and note-off on MIDI channel 9, on the beat's track, for every played pass of the bar. Grace beats and percussion tracks get none. No plan field or wire format changed.
- **Renderer** (`src-tauri/src/audio/renderer.rs`): a channel-9 note-on that no plan note owns, on a pitched track, plays from the sound bank's Standard kit into that track's own output, so the track's mix gain, mute and solo apply. A seek into a hit does not strike it again.
- **MIDI export** (`src/export/midi.ts`): writes the same hit in the track's MIDI track.
- **External MIDI output** (`src-tauri/src/midi_out.rs`, `src-tauri/src/audio/midi_out.rs`): on a routed track the hit goes out on the port's percussion channel, takes no melodic channel and states the Standard kit there.
- A score without golpe plans and renders as before: the plan with every golpe cleared equals the plan with the hits filtered out, and in a two-track render the track without golpe is bit for bit the same.

### Limits

- **Not heard.** The tests show the hit is audible, differs between thumb and finger and has died away after 0.6 s. They do not show it sounds like a knock on a guitar. A low wood block is clearly pitched and may read as a wood block, not a body thump. The two sounds are constants in `src/audio/golpe.ts`; a recorded knock, or any sound outside the General MIDI kit, would need an explicit marker on the plan event.
- **Volume automation.** The hit follows the track's mix gain, mute and solo, not a volume or expression automation or fade on the track.
- **MIDI round trip.** Exporting MIDI and importing it back gives an extra drum part holding the hits, because the importer splits a part by channel. The import is not changed.
- **A pitched track whose own notes are on channel 9** keeps the earlier routing: its channel takes a melodic channel on an external port, and a golpe on it goes out there as a pitched note.
- **Shared percussion channel.** On an external port the knock shares channel 10 with a real drum track. The knock sends no volume, pan or bend range there, and states the Standard kit only when no drum track is live on that channel, so it plays through the drum track's kit and level and the guitar's fader does not reach the drums. After a drum track is muted or unrouted mid-play the knock keeps that kit until the next start or seek. A knock's note-off for key 37 or 77 can cut a drum track's side stick or wood block on a device that honours note-off for percussion. Two guitars knocking the same key on the same tick, and a knock lane that comes up before the drum track, are untested.
- No MIDI device was used.

## Fermata hold

The notation design ([2026-10-15-gp8-notation-design.md](../superpowers/specs/2026-10-15-gp8-notation-design.md), "Fermata authority and bounded first delivery") forbids guessing what the stored `Length` means and asks for an authored probe run through Guitar Pro 8.

- `node scripts/fermata-probe.mjs write` writes `fermata-probe-120.gp` and `fermata-probe-60.gp` into the git-ignored `.analysis/fermata-probe/`, with a `README.txt`. Each has 27 bars in 4/4: thirteen fermata cases, each followed by a plain control bar, on a fermata track, and a second track that sustains a whole note across each case. The cases are Short, Medium and Long at Length 0; Medium at 0.5, 1 and 2; Short and Long at 2; a fermata on a rest, on the last beat and on beat 2; and on a half note and an eighth note.
- `node scripts/fermata-probe.mjs analyse` reads the MIDI exported from Guitar Pro with its own Standard MIDI File reader and reports, per case, the observed note and tempo events against the expected timing, then what the numbers show: longer notes, inserted tempo changes, a shift of later events, or nothing; constant seconds, constant beats, or a multiple of the note's length; and whether both tracks are delayed.
- `src/interchange/fermata-probe.test.ts` checks the written Type, Length and Offset of every case by reading `score.gpif`, and runs the analyser on synthetic MIDI for four behaviours. The fermata element matches what `src/interchange/notation.ts` writes.

### Why the probe was not run

- The probe was not run in Guitar Pro 8 from here: no installed copy was available to run, and the analysis of Guitar Pro 8 that exists is not published here and did not run the program.
- Another executable on the machine was not run, because its origin could not be vouched for.

So the probe could not be run from here; the owner ran it, as recorded below. Whether Guitar Pro reads the written `Offset` as the intended beat is also unconfirmed; the README asks the user to check that the symbols sit over the labelled notes.

### What Guitar Pro 8 exported (2026-11-12)

The owner then exported both probe files as MIDI from an activated Guitar Pro 8. The two exports are committed as `src/interchange/fixtures/fermata-probe-120.gp8.mid` and `fermata-probe-60.gp8.mid`, with the layout they were made from, and pinned by `src/interchange/gp8-fermata-midi.test.ts`.

- Each file is format 1 with three tracks at 480 ticks per quarter, one tempo event (120 or 60) and one 4/4 time signature.
- The fermata track has 107 notes and the sustain track 69. Every onset is on the written grid and every note has its written length (quarter 480, half 960, eighth 240, whole 1920). The last note-off is at tick 51840, exactly 27 bars.
- The 120 and 60 BPM files are identical in every tick.

So **the MIDI Guitar Pro 8 exported from this probe contains no hold**, for Short, Medium or Long, for Length 0, 0.5, 1 or 2, on a note, a rest, a half note or an eighth. That is all it establishes:

- **It is not established that Guitar Pro read the fermatas.** Nothing in the MIDI shows it, nobody confirmed the symbols were visible, and there is no fermata placed by Guitar Pro itself in the same export as a positive control. No Guitar Pro-authored file with a fermata is available to compare the written element with.
- **Guitar Pro exported every note at MIDI key 0**, although the probe wrote each pitch three ways. The cause is not established. The probe now writes stringed notes on a tuned guitar staff, one possible cause; that version has not been through Guitar Pro.
- It says nothing about how Guitar Pro plays a fermata itself, only about its MIDI export.

TabPlayer's playback ignoring the fermata therefore matches Guitar Pro's MIDI export of our file, with the read unconfirmed. It is not established parity, and **no hold is implemented**. One step would settle the caveats: open the regenerated probe (`node scripts/fermata-probe.mjs write`) in Guitar Pro 8, confirm the symbols show on the case bars, add one fermata by hand on a control bar, save as `.gp` and export MIDI again.

## Review

Implemented by Sonnet subagents and reviewed by a Fable subagent.

- **Golpe commit.** Confirmed by reading: a golpe on a track routed to an external MIDI output was allocated a melodic channel and sent as a pitched note, with the knock itself silent. Fixed in the following commit. Confirmed by running: the MIDI round trip yields a drum part, recorded above as a limit.
- **Routing fix commit.** Reviewed by reading only. The blocking defect was confirmed fixed, with allocation unchanged for scores without golpe and no new work on the audio thread. Found: the knock lane wrote the guitar's volume, pan and the Standard kit onto the shared percussion channel, so a guitar's fader could move the drums and a drum track listed first lost its kit on each restatement. Fixed in the following commit, with tests for a drum track on a Power kit in both track orders.
- **Knock-lane fix commit.** No defect found; `cargo test --lib midi_out` (83 passed) and `--test audio_midi_out` (15 passed) were run by the reviewer on merged `develop`. Noted and left: a golpe guitar alone on a port states the Standard kit but no level on channel 10, so the knock plays at whatever volume the device last held there; and after a drum track is muted or unrouted mid-play nothing is restated until the next start or seek.
- **Evidence commit.** The reviewer decoded both exports with its own reader and confirmed every number above. It found the first wording ("Guitar Pro 8's MIDI export applies no hold") stronger than the data, and the key-0 cause stated as fact; both are reworded. It judged the fixtures appropriate to commit: 1.7 KB each of timing data from our own synthetic probe, with no personal data.
- **Probe commit.** Found sound: the cases separate the hypotheses, the MIDI reader handled 20,000 random tracks and two 8 MB degenerate files without throwing, and nothing is written into tracked folders.

## Verification

Worktree `.worktrees/the-60b`, 2026-11-12:

- `npm run typecheck`: no errors. `npm test`: Vitest 375 files passed, 3 skipped; 6429 tests passed, 7 skipped (run before the Rust-only fix commit; no TypeScript changed after it).
- `cargo test --locked --lib`: 901 passed, 7 ignored.
- `--test audio_golpe` 7, `audio_midi_out` 15, `audio_render` 38, `audio_recorded_kit` 7, `audio_drum_mix` 19, `audio_plan` 7: all passed.
- `cargo fmt --all -- --check`: clean.
- Not run: the full Cargo workspace beyond the above, and the desktop drivers.
