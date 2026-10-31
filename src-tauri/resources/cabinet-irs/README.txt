tabplayer IR packs - bundled cabinet impulse responses
CC0 1.0 Universal (CC0-1.0) - public domain dedication

Affirmer:      Kristjan Kruus
Dedicated:     2026-10-30
License URL:   https://creativecommons.org/publicdomain/zero/1.0/
SPDX:          CC0-1.0
The full dedication is in LICENSE-CC0.txt.

Every .wav file in this folder is a mono cabinet impulse response dedicated
to the public domain under CC0 1.0. No attribution is required. 48 files are
24-bit PCM at 48 kHz and the 10 DT410 files are 32-bit float at 44.1 kHz;
TabPlayer resamples each response to the device rate when it loads. The files
ship with TabPlayer so the cabinet block can convolve a track with a captured
cabinet without an import.

manifest.json lists every file with its identity, display name, byte size,
sample rate, channel count and SHA-256. The identity is the first 32 hex
digits of the SHA-256, which is how a document names a response. Run
`node scripts/generate-cabinet-irs.mjs` after changing any WAV here.

These responses are read-only: the picker lists them beside the responses in
the user's own library, but they cannot be removed. Trademarks appearing in
file names identify the gear that was captured and imply no affiliation or
endorsement. CC0 covers the audio recordings only, not those marks.
