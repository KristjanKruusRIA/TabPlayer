# GP8 parity: recorded drum kit and drum articulations (A35, A23)

Date: 2026-11-06. Branch `feature/a35-drum-articulations` from `develop` at `1ee0c14`.

## What changed

Drum tracks on the Standard kit now play a recorded kit instead of the General MIDI bank. Before, every drum note was a General MIDI key, so articulations that share a key (rim shot and snare hit, half and open hi-hat, ride edge and middle) sounded the same, and chokes were notation only.

- The recordings are Virtuosity Drums (CC0-1.0), recorded at Virtuosity Musical Instruments in Boston with drummer Austin McMahon, pinned to `sfzinstruments/virtuosity_drums` revision `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`. TabPlayer uses the mid-microphone kit and percussion: 573 recordings, 219 MB. No NC material is used.
- `assets/audio/sources.json` adds the source `drums` and the instrument `virtuosity-kit`. The app-owned map `assets/audio/drums/Programs/tabplayer-kit.sfz` includes the repository's per-sound mappings, one key per kit sound. Keys follow General MIDI, plus 1 for the snare rim shot and 2 for the half-open hi-hat. The license is the repository's own `LICENSE`, so preparation and `copy-notices.mjs` now accept a source that owns its maps but not its license.
- Two recorded toms give the six General MIDI toms: low tom at −4, −2 and 0 semitones (keys 41, 43, 45), high tom at −1, 0 and +2 (47, 48, 50).
- Every sound is leveled to the General MIDI kit's peak at velocity 100, so a song keeps its balance against the guitars and existing drum mixes. The boost is capped at +18 dB. The muted triangle and the bell tree stay about 6 and 10 dB below General MIDI. Peaks before leveling ran from −7 dBFS (toms, rim shot) to −50 dBFS (bell tree).
- 96 percussion WAVs (congas, tumba, vibraslap, whistles) carry a 20-byte PCM `fmt` chunk with four zero bytes the decoder rejects. Preparation shortens the chunk to 16 bytes and refuses any non-zero extension. The manifest keeps both the source and prepared hashes, as for the bass WAV padding fix.

## How a drum note picks its sound

- `src/audio/kit-sound.ts` gives each drum note `kitSound` and `choke` in the playback plan. A track's own articulation table is matched to the standard Guitar Pro articulation it copies, by piece, sound, notehead and technique, because Guitar Pro numbers its own table. An entry that copies none sounds its own pitch.
- Rim shot → 1, half hi-hat → 2, ride edge and choke → ride, ride bell 2 → the ride bell, splash → the flat ride crash, crash medium → the sizzle crash, ride 2 → the flat ride, cowbell tips → cowbell, bongo and conga mute and slap → the plain hit, bell tree and jingle bell → their own recordings (not the ride bell they share a key with).
- No recording, so General MIDI plays them: china and its choke, hand clap, electric snare, side stick 2, timbales, woodblocks, cuica, castanets, surdo, grancassa, piatti, reverse cymbal, golpe and the metronome sounds. The Room, Jazz and Brush kits stay General MIDI.
- The renderer plays only the exact kit sound. A neighbouring key is never borrowed; a missing sound plays General MIDI once. A drum attack with no plan note plays General MIDI.
- Auditions send the kit sound, so entering a rim shot plays the rim shot.

## How it plays

- A drum is struck and rings out its recording, past the written note end. A choke articulation (ride, splash, china, crash high and medium, ride 2) stops 0.06 s after its note ends.
- SFZ `group`/`off_by` cuts voices on the same track: a closed or pedal hi-hat stops an open or half-open one (0.15 s fade), muted conga and triangle stop their open hits, and each whistle stops the last.
- Recorded drums take the per-piece drum mix (A23) the same way as the General MIDI kit: volume, pan, mute and solo per kick, snare, hi-hat, toms, cymbals and other.
- At most four strokes of one sound ring at once on a track; a fifth fades the oldest. A ride in eighths would otherwise keep dozens of long cymbal voices running.
- Only the kit sounds a song's notes ask for are loaded. A drum track on the Room, Jazz or Brush kit, or given a guitar or bass voice, plays General MIDI and loads no recordings.
- When the audio has no kit (a test's own audio), drum tracks play General MIDI.
- The Sound view says Automatic plays a drum track "as the recorded drum kit", except on the Room, Jazz and Brush kits.

## Evidence

- `src-tauri/tests/audio_recorded_kit.rs`, with an in-memory kit:
  - a kit sound plays its recording and not General MIDI as well; a note without one, a sound the kit lacks, missing kit audio and the Room kit play General MIDI;
  - a crash rings past its note, and a choked crash is silent 0.1 s after its note ends;
  - a closed hi-hat stops an open one and leaves a crash ringing;
  - a muted cymbal element silences the recorded crash, and half its gain gives a quarter of its power;
  - a fifth and sixth ride stroke leave four ringing;
  - rendering six rides, a hi-hat cut, a choked crash, a General MIDI china, a seek and the tail allocates no heap memory on the audio thread;
  - a guitar voice on a drum track plays General MIDI;
  - a drum note asks for its own kit sound, and one without a sound, a Room kit track and a guitar-voiced track ask for nothing.
- The ignored `bundled_kit_plays_every_sound` checks every one of the 43 sounds has a recording at every velocity 1 to 127, then loads the prepared kit and plays each, printing each one's peak beside General MIDI's. With `TABPLAYER_DRUM_DEMO=<file.wav>` it writes a demo: a two-bar groove with a rim shot and an open hi-hat cut by the closed one, then every sound in turn, then a crash and a choked crash.
- `src/audio/kit-sound.test.ts`: every named sound exists in the map and every mapped sound is reachable; shared-key articulations are told apart; a track's own table is read by what each entry copies.
- `src/audio/plan.test.ts`: drum notes in a planned score carry their kit sound.
- `scripts/prepare-audio.test.mjs`: the PCM `fmt` fix.
- Final runs on this branch, 2026-11-06:
  - `cargo test --locked`: 67 test results, all ok;
  - the ignored `selected_real_100bar_fourtrack_resource_budget` passed;
  - `audio_recorded_kit` with `--include-ignored`: 8 passed, against the prepared audio;
  - `cargo fmt --check`, `npm run typecheck` and the 9 `prepare-audio` tests passed.
- `npm test`: 5293 passed and 16 timed out at the 5 s test limit, in `App`, `WorkspaceApp`, `TrackSettingsPanel`, library content and MIDI import. Those five files pass on their own (277 tests). `develop` at `1ee0c14` times out in the same five files (15 tests) on this machine, so the timeouts are not from this change.

## Review

A fresh read-only review of the renderer, loader and mapping found no correctness bugs: no doubled or missing playback, cuts limited to their track, and the kit mix and old plans unchanged. Its points were fixed as above: the per-sound stroke cap, no recordings loaded for the other kits or guitar voices or as a placeholder, Rust range checks on the kit sound, the Sound view label, and ride bell 2. The others are listed under Limits.

## Limits

- Not yet checked by ear. Levels are matched by peak only, at one velocity.
- One microphone position. No snares-off kick or snare, no hi-hat pedal position (CC4), no snare roll, buzz or flam, no tom rim shots or other tom strokes. GP has no fields for most of these.
- The cymbals and percussion have no recorded choke; a choke fades the ringing recording.
- Six toms come from two recordings, so the transposed ones are approximations.
- A drum voice ignores Guitar Pro's dead, ghost and staccato marks beyond the lower velocity alphaTab gives a ghost note.
- Slot capacity is three per note, with no stealing. Cymbals ring for seconds, so a dense part keeps more voices alive than General MIDI did; the four-stroke cap bounds each sound, and the CPU cost was estimated, not measured on a device.
- An audio export's tail releases ringing cymbals over 0.5 s (hi-hats 0.15 s), so a final crash does not ring out fully.
- Seeking or looping into a sounding drum note strikes it again from the start, and a cymbal whose note ended before the seek point is not restored, as with General MIDI before.
- All 8 velocity layers of a used sound load at once; a full rock kit at every dynamic decodes to roughly 350 MB, estimated from the files.
- A prepared audio folder from before this change lacks the kit; playback then fails to load rather than falling back. `npm run prepare:audio` fixes it.
- The Sound view still offers guitar and bass voices on a drum track; they play General MIDI.
- No real GP drum file was checked against Guitar Pro 8.
