# TabPlayer native sound and backing audio

Date: 2026-10-14. Status: written specification awaiting user review. Shared requirements: [expansion specification](2026-10-14-tabplayer-deferred-features-design.md).

## Native audio boundary

Rust owns one transport and sample clock, all musical voices, backing audio, metronome, mixing and effects. Use CPAL for native device output. Decode local audio in Rust with Symphonia; use the same decoder for imported backing files and packaged voice samples. The processing core takes explicit sample rate, prepared musical events and sound/mix state, so it can render to a device or a file without requiring a GUI/audio device.

The TypeScript adapter uses public alphaTab MIDI generation/tick lookup to create a playback plan with track identities, ordered tempo events, note/control/program/per-note-bend events and repeated measure occurrences. A parallel articulation table associates source notes, strings, dynamics and techniques with every played occurrence. Ambiguous same-pitch notes in separate voices must remain distinct; matching only MIDI pitch is insufficient. A generation identifier prevents an old async preparation from replacing a newer edited score. Editing stops the current transport before replacing the plan.

The audio callback renders preallocated blocks; it performs no file I/O, decoding, blocking locks or Tauri calls. Preparation/decoding occurs on worker threads. Transport commands use a bounded message queue and renderer state is owned by the rendering thread. Status events report actual rendered position, ready/playing/paused/stopped state and device errors. The UI's public alphaTab external-media handler consumes this clock; no second synthesizer plays underneath the native engine.

Support the default device and selecting an available output device. Device changes preserve score/configuration and stop with a recoverable error if reopening fails. Internal DSP is stereo float at the selected output rate; offline rendering supports 44.1 and 48 kHz. Adapt to supported device sample formats/rates without changing musical pitch or duration.

## A2 Guitar/bass voices and sound assets

Build an independent recorded-sample engine in Rust. Samples retain recorded attacks and velocity/variation choices; the engine adds continuous pitch interpolation, sustain/release envelopes, articulation-specific damping and transitions. It must distinguish picked/fingered attack, palm mute, dead/ghost/staccato, let ring, hammer/pull/tap/legato, slides, independent bends/whammy/vibrato, natural/artificial/pinch harmonics, tremolo and trills. Repeated notes cycle suitable recorded variants deterministically. Tied segments sustain a single voice; hammer/pull and legato slides avoid a fresh picked attack. Different strings can bend simultaneously to different pitches.

Ship curated voices from Karoryfer Black And Green Guitars and Black And Blue Basses. Convert the required documented sample mappings into a pinned app-owned instrument manifest describing pitch/root key, velocity range, articulation, variant, sample path, loop/envelope and gain. Include each referenced sample and its provenance/license/hash. Asset preparation must preserve all chosen velocity/variation/articulation regions; do not relabel a single generic MIDI patch as realistic sound. Techniques lacking a distinct recording use explicit envelope/filter/pitch/transition processing of a suitable recorded voice. Existing General MIDI programs and percussion retain a native SoundFont path using the existing licensed Sonivox bank, so full songs remain playable.

The publisher's current free-library policy and both source repositories identify CC0 licensing. Pin source revisions and retain their exact license texts in the product. Download/prepare these public assets at build/setup time, bundle the selected result and require no runtime account or download. Do not use extracted RSE code, banks, presets or amp resources. Additional arbitrary sample-plugin hosting is outside this feature set.

## A3 Amps, effects and mixing

Provide independently written DSP blocks with explicit bypass and finite validated parameters: noise gate, compressor, drive/amp, cabinet filter, three-band EQ, chorus, tempo-synchronized delay and reverb. Use a fixed, documented signal order: voice → gate → compressor → drive/amp → cabinet → EQ → chorus → delay → reverb → track pan/gain → master mix/limiter. Cabinet processing uses app-generated filters, with its own tested frequency response. Bundle clean, crunch, lead and bass presets; users can edit their parameters and restore a preset. Switching configurations ramps parameters to avoid clicks.

Native projects persist selected voice/preset, block parameters, per-track gain/pan/mute/solo and backing gain/pan/mute/solo. The mixer resolves solo across score and backing channels consistently. The master output prevents invalid/clipped PCM. Stop/new/open/seek reset voices and delay state as appropriate; pause retains resumable musical position. User export settings control whether effect tails and the metronome are included.

Automatic voice selection follows the track's MIDI instrument. A user can explicitly choose a recorded guitar/bass voice instead, displayed as a sound-source override. General MIDI defaults bypass the guitar amp/cabinet blocks unless the user enables them. Sound sources and presets retain stable manifest identifiers across project replay.

## A1 Backing workflow and synchronization

Import, replace or remove one local backing file using native dialogs. Support PCM WAV, FLAC, MP3 and Ogg Vorbis; malformed/unsupported input yields an actionable error and keeps the current backing. Preserve encoded bytes in the asset table, not a machine-specific path. Extract embedded GP backing audio and its public sync points from the imported base; alphaTab marks raw audio bytes as JSON-ignored, so extraction must occur before transient model rebuilding. An external backing selection explicitly overrides the embedded backing, and removal allows choosing score-only playback.

The backing inspector shows duration, gain/pan/mute/solo and synchronization anchors. Each anchor identifies a score measure, playback occurrence and position within the measure plus the backing-file time. Start with a user-adjustable offset; allow adding, editing and deleting anchors for tempo drift. Validate strictly increasing score and backing times. Repeats/jumps use the chosen occurrence, not only the displayed measure number. Structural edits move surviving anchors with their musical location, remove anchors in deleted music and reject changes that make the remaining map invalid.

The Rust clock mixes synthesis and backing simultaneously. Between anchors, derive a piecewise time mapping and apply pitch-preserving time stretch to backing audio. Seeking and inclusive measure looping map both sources to the same position and clear stale sustained voices. Practice speed remains 25–200% and preserves pitch for both score and backing, including seeks/loops at non-default speed. Recompute score times after tempo/rhythm edits. Backing end produces silence while a longer score continues; longer backing continues to its mapped end for whole-song playback. Loop/export ranges bound both sources explicitly.

## Verification

| Check | Required evidence |
| --- | --- |
| Musical correctness | Independent note frequencies/timing and per-note pitch curves; ties sustain; legato avoids retrigger; distinct muted/dead/harmonic envelopes; overlapping same-pitch voices and different-string bends |
| Asset coverage | Manifest references resolve offline, hashes/licenses match pinned inputs, multiple velocity/variation regions are exercised, and shipping contains no private/proprietary samples |
| Sound quality | User listening acceptance of authored clean/distorted guitar and bass demos plus relevant passages from authorized scores; compare contrasting attacks, sustains, bends and mutes |
| DSP | Bypass transparency, finite bounded samples, parameter bounds, cabinet/EQ response, compressor behavior, delay timing, tail decay and deterministic preset output |
| Backing timing | Synthetic click/pitch files at multiple input rates, nonzero offset, drift anchors, repeats, speed 25/100/200%, seek and loop boundaries; output alignment within one DSP block and frequency retained within 1% |
| Runtime | Packaged Windows output capture and audible listening; corresponding macOS/Linux device smoke; no audio callback I/O/locks or dropouts in a 100-bar/four-track run |
| Persistence | Import/change/configure → undo/redo → atomic save → restart/reopen reproduces asset bytes, synchronization and sound settings; failed decode/save preserves the live document |
| Shared renderer | Live captured/offline rendering use the same event plan, voices and DSP, with documented device-resampling/latency differences |

## Primary references

- [alphaTab external media and synchronization](https://alphatab.net/docs/guides/audio-video-sync/)
- [alphaTab audio export excludes backing media](https://alphatab.net/docs/reference/api/exportaudio/)
- [CPAL platform backends](https://github.com/RustAudio/cpal)
- [Symphonia codec and license inventory](https://github.com/pdeljanov/Symphonia)
- [Karoryfer free-library licensing](https://shop.karoryfer.com/pages/free-samples)
- [Black And Green Guitars](https://github.com/sfzinstruments/karoryfer.black-and-green-guitars)
- [Black And Blue Basses](https://github.com/sfzinstruments/karoryfer.black-and-blue-basses)
