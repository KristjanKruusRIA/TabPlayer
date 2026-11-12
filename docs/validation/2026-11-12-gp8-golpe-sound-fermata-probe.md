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
- **A pitched track whose own channel is 9** keeps the earlier routing: its channel takes a melodic channel on an external port, and a golpe on it shares that lane.
- **Shared percussion channel.** On an external port the knock shares channel 10 with a real drum track. Its volume and pan there come from the guitar's mix level, and the last one written wins. Two guitars knocking the same key on the same tick, and a drum track set to a kit other than Standard, are untested.
- No MIDI device was used.

## Fermata hold

The notation design ([2026-10-15-gp8-notation-design.md](../superpowers/specs/2026-10-15-gp8-notation-design.md), "Fermata authority and bounded first delivery") forbids guessing what the stored `Length` means and asks for an authored probe run through Guitar Pro 8.

- `node scripts/fermata-probe.mjs write` writes `fermata-probe-120.gp` and `fermata-probe-60.gp` into the git-ignored `.analysis/fermata-probe/`, with a `README.txt`. Each has 27 bars in 4/4: thirteen fermata cases, each followed by a plain control bar, on a fermata track, and a second track that sustains a whole note across each case. The cases are Short, Medium and Long at Length 0; Medium at 0.5, 1 and 2; Short and Long at 2; a fermata on a rest, on the last beat and on beat 2; and on a half note and an eighth note.
- `node scripts/fermata-probe.mjs analyse` reads the MIDI exported from Guitar Pro with its own Standard MIDI File reader and reports, per case, the observed note and tempo events against the expected timing, then what the numbers show: longer notes, inserted tempo changes, a shift of later events, or nothing; constant seconds, constant beats, or a multiple of the note's length; and whether both tracks are delayed.
- `src/interchange/fermata-probe.test.ts` checks the written Type, Length and Offset of every case by reading `score.gpif`, and runs the analyser on synthetic MIDI for four behaviours. The fermata element matches what `src/interchange/notation.ts` writes.

### Why the probe was not run

- The installed Guitar Pro 8 under Program Files has no program file, only an uninstaller.
- The copy extracted in `.analysis/guitar-pro-8.1.5-31` carries a valid Arobas Music signature. Started with the probe file, it opened to a Software Activation window. It was closed again; no licence was entered and activation was not worked around.
- Another executable on the machine was not run, because its origin could not be vouched for.

So the hold waits for two MIDI files exported by the user from an activated Guitar Pro 8. The analyser has read only synthetic MIDI. Whether Guitar Pro reads the written `Offset` as the intended beat is also unconfirmed; the README asks the user to check that the symbols sit over the labelled notes.

## Review

Implemented by Sonnet subagents and reviewed by a Fable subagent.

- **Golpe commit.** Confirmed by reading: a golpe on a track routed to an external MIDI output was allocated a melodic channel and sent as a pitched note, with the knock itself silent. Fixed in the following commit. Confirmed by running: the MIDI round trip yields a drum part, recorded above as a limit.
- **Probe commit.** Found sound: the cases separate the hypotheses, the MIDI reader handled 20,000 random tracks and two 8 MB degenerate files without throwing, and nothing is written into tracked folders.

## Verification

Worktree `.worktrees/the-60b`, 2026-11-12:

- `npm run typecheck`: no errors. `npm test`: Vitest 375 files passed, 3 skipped; 6429 tests passed, 7 skipped (run before the Rust-only fix commit; no TypeScript changed after it).
- `cargo test --locked --lib`: 896 passed, 7 ignored.
- `--test audio_golpe` 7, `audio_midi_out` 15, `audio_render` 38, `audio_recorded_kit` 7, `audio_drum_mix` 19, `audio_plan` 7: all passed.
- `cargo fmt --all -- --check`: clean.
- Not run: the full Cargo workspace beyond the above, and the desktop drivers.
