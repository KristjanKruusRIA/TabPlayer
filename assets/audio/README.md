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

The bundle contains 4,204 regions referencing 3,864 distinct recordings:
green guitar (976 regions), black guitar (948), darkblack bass (1,512), and
babyblue bass (768). Guitar has three recorded dynamics and ordinary,
staccato, release, feedback, plus green hammer and black behind-the-bridge
maps. Darkblack has four recorded dynamics, ghost, staccato, release, and
behind-the-bridge maps. Babyblue has two recorded dynamics and the default
low-string selection. All selected round-robin slots are retained. Babyblue
does not contain separate ghost/staccato recordings; those techniques use
documented processing of its ordinary recorded voice.

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
