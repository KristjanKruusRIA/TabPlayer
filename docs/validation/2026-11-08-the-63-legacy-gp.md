# Legacy Guitar Pro import audit and large MIDI export (THE-63, F01, F12)

Date: 2026-11-08. Status: **unverified → unverified (reviewed)**.

Audit of legacy Guitar Pro import generations (GP3, GP4, GP5) and large arrangement MIDI export performance and semantics, closing verification gaps on parity tracker rows F01 and F12.

## Behavior

### 1. F01 Legacy Guitar Pro Import Audit
Three small, independent binary fixtures (`tests/fixtures/legacy-gp3.gp3`, `legacy-gp4.gp4`, `legacy-gp5.gp5`) were authored directly from binary format specifications and alphaTab's `Gp3To5Importer` implementation (`src/import/legacy-gp-fixture.ts`). No third-party files, downloaded assets, or private scores were used.

Each fixture exercises:
- **Multiple tracks**: Track 0 (Lead Guitar, 6-string standard tuning `[64, 59, 55, 50, 45, 40]`, program 25 Acoustic Nylon), Track 1 (Bass, 4-string standard tuning `[43, 38, 33, 28]`, program 33 Acoustic Bass).
- **Percussion track**: Track 2 (Drums, `staves[0].isPercussion = true`, program 0, kick=36, snare=38).
- **Repeats**: Measure 0 repeat start (`isRepeatStart = true`), Measure 1 repeat end with count 2 (`isRepeatEnd = true`, `repeatCount = 2`).
- **Bends**: Single note bend (4 semitones full bend).
- **Overlapping bends**: Polyphonic double stop with bends on two strings simultaneously on the same beat (string 2 fret 8 bent 2 semitones, string 3 fret 7 bent 4 semitones).
- **Slides**: Shift slide out on fret 7.
- **Hammer-ons**: `isHammerPullOrigin = true` on fret 5.
- **Harmonics**: Natural harmonic (fret 12) and Pinch harmonic (fret 7).
- **Tuplets**: Triplet eighth notes (tuplet 3:2) in 4/4 meter.

#### Per-Generation Breakdown: What Works, What is Lost, What is Unsupported

| Feature | Guitar Pro 3 (`v3.00`) | Guitar Pro 4 (`v4.06`) | Guitar Pro 5 (`v5.10`) |
|---|---|---|---|
| **Multiple tracks & tuning** | Works (all tracks, names, tunings, programs preserved) | Works (all tracks, names, tunings, programs preserved) | Works (all tracks, names, tunings, programs preserved) |
| **Percussion track** | Works (`isPercussion = true`, drum notes mapped) | Works (`isPercussion = true`, drum notes mapped) | Works (`isPercussion = true`, drum notes mapped) |
| **Repeats & alternate endings** | Works (repeat start/end, stored count = count - 1) | Works (repeat start/end, stored count = count - 1) | Works (repeat start/end, direct repeat count) |
| **Tuplets** | Works (standard tuplets 3:2, 5:4, 6:4, etc.) | Works (standard tuplets 3:2, 5:4, 6:4, etc.) | Works (standard tuplets 3:2, 5:4, 6:4, etc.) |
| **Single bends** | Works (bend points, type, height preserved) | Works (bend points, type, height preserved) | Works (bend points, type, height preserved) |
| **Overlapping bends** | Works (polyphonic notes in chord each retain bends) | Works (polyphonic notes in chord each retain bends) | Works (polyphonic notes in chord each retain bends) |
| **Slides** | Works for Shift slide; complex slides unsupported | Works for Shift, Legato, Out Down/Up, Into Below/Above | Works for Shift, Legato, Out Down/Up, Into Below/Above |
| **Hammer-ons / pull-offs** | Works (`isHammerPullOrigin = true`) | Works (`isHammerPullOrigin = true`) | Works (`isHammerPullOrigin = true`) |
| **Harmonics** | Works at beat level (Natural/Artificial only; Pinch collapsed to Artificial) | Works at note level (Natural, Pinch, Tap, Semi, Artificial) | Works at note level (Natural, Pinch, Tap, Semi, Artificial) |
| **Voices per measure** | 1 voice only (Voice 2 unsupported) | 1 voice only (Voice 2 unsupported) | 2 voices supported (Voices 3-4 unsupported) |
| **Lyrics** | Unsupported (format has no lyrics section) | Works (up to 5 lines mapped to starting measures) | Works (up to 5 lines mapped to starting measures) |
| **Directions (Coda/Segno)** | Unsupported | Unsupported | Works (19 direction types and jump targets) |
| **Page setup & templates** | Unsupported | Unsupported | Works (header/footer text templates, margins) |
| **Beaming & ottava** | Unsupported | Unsupported | Works (8va/8vb/15ma/15mb, forced split/merge) |
| **Modern tempo units** | Lost (stored as quarter BPM) | Lost (stored as quarter BPM) | Lost (stored as quarter BPM) |
| **Backing audio & sync** | Unsupported | Unsupported | Unsupported |
| **GTP (Guitar Pro 1/2)** | Unsupported by alphaTab | Unsupported by alphaTab | Unsupported by alphaTab |

### 2. F12 Large Arrangement MIDI Export
A large arrangement of 16 tracks (15 melodic tracks + 1 percussion track) and 1,000 bars was synthesized and exported via `src/export/midi.ts`.
- **Melodic track limit**: Standard MIDI File (SMF) has 16 logical channels; channel 9 (GM percussion) is reserved for drums, capping melodic tracks at 15. The exporter enforces this limit.
- **Track count**: Output SMF Format 1 contains 17 tracks (1 Conductor track + 16 instrument track streams).
- **Event count**: Exactly 48,195 events generated (32,000 note events, conductor tempo/meter events, track names, program changes, volume/pan controllers, EndOfTrack markers).
- **End time**: Exactly 3,840,000 ticks (1,000 bars × 3,840 ticks/bar at 960 PPQ division).
- **Performance**: Measured on this machine: ~1,380 ms to 1,500 ms (Windows x64, Node 24.22.1).

## Evidence

- `src/import/legacy-gp-fixture.ts`: Authored binary generator conforming to GP3, GP4, and GP5 format specifications.
- `tests/fixtures/legacy-gp3.gp3`: Authored GP3 fixture (1,436 bytes).
- `tests/fixtures/legacy-gp4.gp4`: Authored GP4 fixture (1,491 bytes).
- `tests/fixtures/legacy-gp5.gp5`: Authored GP5 fixture (2,134 bytes).
- `src/import/legacy-gp.test.ts` (6 tests passing):
  - Imports all three fixtures.
  - Verifies survival of tracks, tuning, percussion, repeats, hammer-ons, slides, harmonics, bends, overlapping bends, tuplets.
  - Asserts format limits and differences per generation (single voice in GP3/4, beat-level harmonics in GP3, lack of directions/lyrics in GP3, 2-voice limit in GP5).
- `src/export/midi-large.test.ts` (1 test passing):
  - Builds 16 tracks × 1,000 bars arrangement.
  - Exports to MIDI and decodes bytes using an independent SMF decoder.
  - Confirms Format 1, 17 tracks, 48,195 events, end time 3,840,000 ticks, within bounded execution time (< 10 s).
- Test runs:
  - `npx tsc --noEmit`: 0 errors.
  - `npx vitest run src/import/legacy-gp.test.ts src/export/midi-large.test.ts`: 7 tests passed (0 failed).

## Review

During implementation and format analysis of `node_modules/@coderline/alphatab`:
1. **Repeat Count Storage in GP3/GP4 vs GP5**: In GP3 and GP4, `readByte() + 1` is evaluated by alphaTab's reader for `repeatCount`, so the stored byte must be `repeatCount - 1`. In GP5, `repeatCount` is stored as-is.
2. **Harmonics Scoping**: GP3 encodes harmonics inside beat-level effects (bit 2 natural, bit 3 artificial), applying the type uniformly to all notes on that beat. GP4 and GP5 encode harmonics in note-level effects bytes.
3. **Channel Program Mapping**: Playback information is indexed via a 64-entry channel table in GP3/4/5; programs must be written to the allocated channel slots for tracks to retain their GM sound presets.

## Limits

- **Authored fixtures, not original Guitar Pro binaries**: Fixtures were authored by code from the format specifications and alphaTab importer behavior, not saved by original Guitar Pro 3, 4, or 5 applications.
- **Original Guitar Pro 8 runtime unverified**: Tests prove internal compatibility with alphaTab's `Gp3To5Importer`, not certified runtime parity against Guitar Pro 8's closed-source import engine.
- **Desktop drivers not run**: Desktop drivers require port 9223 and the running desktop application; they were not run for this offline unit test audit.
- **GTP (Guitar Pro 1 and 2) unsupported**: alphaTab does not implement an importer for the earliest `.gtp` format; GTP remains unverified and unsupported.
- **MIDI channel-wide bends**: MIDI protocol uses channel-wide pitch wheel messages; polyphonic bends within a single track on the same channel cannot be individually bent in Standard MIDI format 0/1 without per-note MPE or allocating multiple MIDI channels per track.
- **15 melodic-track cap**: MIDI export is capped at 15 melodic tracks due to the 16-channel SMF limit with channel 9 reserved for drums.
