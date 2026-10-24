# GP8 parity A04: factory sound catalog (2026-10-24)

GP8 ships a catalog of ready-made sounds for different styles of playing. TabPlayer had five presets only: bypass, clean, crunch, lead and bass. This slice adds 19 independently authored factory sounds in six kinds of playing, which can be applied or previewed from the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Catalog:** each factory sound has a name, a kind of playing, a one-line description and a full effect chain. It is built on one of the existing presets, so older builds' preset handling is unchanged, and its blocks start from their defaults.

  | Kind | Sounds |
  |---|---|
  | Clean guitar | Warm jazz clean, Funk clean, Eighties chorus clean, Country chime, Surf tremolo |
  | Crunch | Blues crunch, Classic rock rhythm, Phased crunch |
  | Lead and high gain | Rock lead, Metal rhythm, Fuzz lead, Octave-up lead |
  | Ambient | Ambient wash, Octave shimmer |
  | Acoustic | Acoustic in a room, Close-miked acoustic |
  | Bass | Finger bass, Slap bass, Octave-down bass |

  The sounds use the gate, compressor, wah, drive, amp with its tone stack, cabinet, EQ, graphic EQ, microphone, octaver, pitch shift, chorus with tempo sync, phaser, tremolo, delay models and reverb models.
- **Applying:** the Sound task's Factory sound list is grouped by kind. Choosing a sound shows its description, which is also the list's accessible description. Apply factory sound records it as one undoable track-sound edit and says "Applied “Name”.". The choice is cleared on another track.
- **Instrument:** a factory sound sets the effects only. The track keeps its instrument voice, and the panel says so.
- **Previewing:** the Preview sound list has a group for each kind, such as "Bass sounds", after the factory presets. A factory sound previews and is kept or cancelled like a preset or saved sound, and records nothing until it is kept.
- **Levels:** the sounds are matched in level, so switching between them does not jump in loudness.
- **Saving:** an applied factory sound is an ordinary track sound. It can be edited, saved in My sounds, copied and pasted, and it opens in any build that has its blocks.

## Evidence
- **Editor** (`src/audio/factory-sounds.test.tsx`, 5 tests):
  - every sound has a unique id and name, a description, and at least two sounds in each kind;
  - every sound passes the editor's sound check, keeps the voice it is given, uses its preset, differs from every other sound and from its bare preset;
  - a sound's blocks start from their defaults, only the named blocks are switched on, it has the default order, and each call gives a fresh copy;
  - the Factory sound list is grouped by kind, Apply is disabled until a sound is chosen, the list is described by the sound's description and the instrument note, and applying records one edit with the track's voice and shows "Applied “Metal rhythm”.". This was confirmed to fail when the voice is dropped;
  - the choice is cleared on another track. This was confirmed to fail without the reset;
  - the Preview sound list shows the factory groups between the presets and My sounds, previews a sound with the track's voice, says "Previewing “Slap bass”." and keeps it as one edit;
  - `tests/factory-sounds.json`, which the native tests read, matches the catalog. `UPDATE_FACTORY_SOUNDS=1` rewrites it.
- **Native** (`src-tauri/tests/audio_factory_sounds.rs`, 2 tests):
  - every factory sound is read and accepted by the native player, written back as the same sound, and every value it writes is the editor's;
  - each sound plays a plucked A2 and A3 for two seconds and then four seconds of silence at 48 kHz. Every sample is finite, nothing exceeds full scale, the last 100 ms are below 5% of the peak, and each sound's level over the note is within 6 dB of the middle sound's:

    | Sound | Peak | RMS over the note | Last 100 ms |
    |---|---|---|---|
    | Warm jazz clean | 0.357 | 0.0768 | 0 |
    | Funk clean | 0.431 | 0.0512 | 0 |
    | Eighties chorus clean | 0.254 | 0.0527 | 0 |
    | Country chime | 0.233 | 0.0554 | 0 |
    | Surf tremolo | 0.404 | 0.0625 | 0 |
    | Blues crunch | 0.219 | 0.0712 | 0 |
    | Classic rock rhythm | 0.229 | 0.0738 | 0 |
    | Phased crunch | 0.117 | 0.0508 | 0 |
    | Rock lead | 0.196 | 0.0772 | 0.00005 |
    | Metal rhythm | 0.170 | 0.0673 | 0 |
    | Fuzz lead | 0.176 | 0.0577 | 0 |
    | Octave-up lead | 0.201 | 0.0758 | 0 |
    | Ambient wash | 0.206 | 0.0626 | 0.00296 |
    | Octave shimmer | 0.183 | 0.0640 | 0.00029 |
    | Acoustic in a room | 0.263 | 0.0555 | 0 |
    | Close-miked acoustic | 0.565 | 0.0802 | 0 |
    | Finger bass | 0.323 | 0.0649 | 0 |
    | Slap bass | 0.310 | 0.0786 | 0 |
    | Octave-down bass | 0.318 | 0.0670 | 0 |

    The levels span 4.0 dB. Without its 12 dB of amp gain, funk clean is 14.1 dB below the middle and the test fails.
- **Desktop:** `tests/desktop/parity-factory-sounds.mjs` on a Windows desktop-test build, with a sustained E2, B2 and E3 on a steel-string guitar:
  - Warm jazz clean and Metal rhythm were applied from the Factory sound list, each recorded as one edit holding the catalog's chain, with the "Applied" status. Every enabled block records each field the catalog sets; the native player leaves out only fields at their defaults;
  - their WAV exports through the Export dialog, from 0.1 to 1.5 s, are −24.8 and −27.3 dBFS. The share of power from 1 to 8 kHz is −25.4 dB for the jazz sound and −9.2 dB for the metal one;
  - Octave shimmer was previewed from the Preview sound list without recording an edit, then kept as one edit;
  - playback ran live; Undo restored Metal rhythm; there were no page errors;
  - the amp tone, sound-library and sound-preview desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 734 tests;
  - the full `vitest` suite: the load-sensitive files pass when run alone;
  - `tsc`;
  - `rustfmt` on the new native test.

## Review
- **Adversarial review:** approved, with two Medium and several Low notes.
  - **Medium, fixed:** the desktop test only compared the fields an edit recorded, so a block missing a value could pass. It now requires every field the catalog sets, allowing only a field at its default to be left out.
  - **Medium, fixed:** factory sounds keep the track's instrument, so a bass sound on a guitar track is a guitar through a bass rig. The panel now says that factory sounds set the effects only.
  - **Low, fixed:**
    - the factory sound choice stayed selected on another track; it is now cleared;
    - "Metal rhythm" sat under "Lead"; the group is now "Lead and high gain";
    - "Fuzz lead" used a crunch amp on the lead preset; it is now on the crunch preset;
    - "Octave synth bass" is renamed "Octave-down bass", as nothing in it is a synth;
    - the Preview list's "Factory: …" groups were easy to confuse with "Factory presets"; they are now named "… sounds";
    - Country chime's 1/32-note slapback was a doubling; it is now a 1/16 note, 125 ms at 120 bpm, with 2 dB more amp gain to keep its level;
    - the description is now the list's accessible description;
    - a variable that shadowed another is renamed.
  - **Low, kept:** `UPDATE_FACTORY_SOUNDS` rewrites the fixture and then passes, so it must not be set in CI. Without it, any change to the catalog or the defaults fails until the fixture is rewritten.

## Limits
- **Size:** 19 sounds against GP8's much larger catalog of signature sounds. None imitates a named artist or song.
- **No listening comparison** with GP8's sounds; the sounds were checked for level, decay and validity, not judged by ear against a reference.
- **No search or filtering** of the catalog beyond its six groups, and no factory sounds for drums, keys or other instruments.
- **Fixed catalog:** factory sounds cannot be changed or removed; an edited one is saved in My sounds instead.
