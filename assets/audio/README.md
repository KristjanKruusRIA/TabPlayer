# Recorded audio resources

`sources.json` pins the public Karoryfer repositories and the chosen central
SFZ maps. `guitar-inventory.json` and `bass-inventory.json` contain original
source SHA-256 hashes and byte lengths, including each selected mapping and
the exact source license. The app-owned regions are generated from these
maps; MIDI controller/unison effects remain native engine processing.

Run `npm run prepare:audio` after dependency installation. The first setup
fetches public pinned inputs; later builds verify the bundled data offline.
Run `node scripts/prepare-audio.mjs --offline` to require existing inputs and
disable all downloading. The generated, ignored directory is
`src-tauri/resources/audio/`, bundled by Tauri as `audio/`.

The bundle contains 4,228 regions referencing 3,876 distinct recordings:
green guitar (976 regions), black guitar (948), darkblack bass (1,524), and
babyblue bass (780). Guitar has three recorded dynamics and ordinary,
staccato, release, feedback, plus green hammer and black behind-the-bridge
maps. Darkblack has four recorded dynamics, ghost, staccato, release, and
behind-the-bridge maps. Babyblue has two recorded dynamics and the default
low-string selection. All selected round-robin slots are retained. Babyblue
does not contain separate ghost/staccato recordings; those techniques use
documented processing of its ordinary recorded voice.

Both bass voices also have slap and pop layers from "BMC slap bass samples"
by Bruce H. McCosar, used under CC BY 3.0 (source `slap`). Unlike the
repository sources, it is one pinned archive: preparation downloads the
Internet Archive copy of the ccMixter zip, checks its size and SHA-256 (the
source `revision`), and extracts only flat entries within fixed count and
size limits. The app-owned maps and the attribution and license file live in
`slap/` and are hashed in `slap-inventory.json` like any other input. Twelve
sustained recordings are used: slaps on A1, Bb1, B1, C2, D2 and Eb2, and
pops an octave higher. Each root key is the measured settled pitch, within
20 cents. The pack has no C#, and notes outside each set's range are
transposed from its end sample. The short, hammer and thump recordings are
not used. FLAC recordings ship unchanged; the native loader decodes them.
An `extends` instrument adds its regions to the voice of the same id.

Drum tracks on the Standard kit play Virtuosity Drums, CC0 (source `drums`,
instrument `virtuosity-kit`), recorded at Virtuosity Musical Instruments in
Boston with drummer Austin McMahon: its mid-microphone kit and percussion,
573 FLAC and WAV recordings (219 MB). The app-owned map
`drums/Programs/tabplayer-kit.sfz` includes the repository's own per-sound
mappings, one key per kit sound: General MIDI keys, plus 1 for the snare rim
shot and 2 for the half-open hi-hat. Its two recorded toms give the six
General MIDI toms by transposing up to four semitones. Hi-hats, congas,
triangles and whistles carry SFZ `group`/`off_by`, so a closed hi-hat stops
an open one. The kit's license is the repository's own `LICENSE`. Timbales,
woodblocks, cuica, castanets, surdo, china, clap and electric snare have no
recording and play from the General MIDI bank, as do the Room, Jazz and
Brush kits.

Several upstream PCM24 bass release WAVs include a trailing zero padding byte
inside their data chunk length. Preparation fixes only that RIFF framing.
The manifest retains both the original source hash and prepared sample hash;
all complete recorded frames are preserved. Pitched SFZ `*sine` feedback is
not included as a recording. The actual background/microphonic feedback
recordings are included, with native pitched feedback processing separately.

`AudioResources::load_for_requests` selects and decodes only required
voice/key/velocity/articulation combinations during preparation. All eligible
round-robin slots, release recordings, and feedback layers remain available.
Its filtered manifest references only loaded PCM, and the renderer uses the
same `eligible_regions` function. This keeps a typical score from decoding
the entire 1.62 GB recording pack into several GB of stereo PCM. Full-library
`load` remains available for explicit verification. No disk access or decoding
occurs in the audio callback.

Inventory updates require an explicit `--record-inventory` first-fetch
operation; ordinary setup never changes tracked source hashes. The source
revision, raw mapping hash, exact source license, prepared sample hash and
SoundFont hash are available for offline verification. No private scores or
extracted RSE resources are included.
