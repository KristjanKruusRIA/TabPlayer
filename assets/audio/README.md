# Audio resources

TabPlayer bundles only the pinned General MIDI SoundFont (`sonivox.sf2`, Apache License 2.0,
from `@coderline/alphatab` `1.8.4` in `sources.json`). All third-party recorded sample
packs previously bundled with the app have been removed.

Run `npm run prepare:audio` after dependency installation to generate and verify
`src-tauri/resources/audio/`, which Tauri bundles as `audio/`.
Run `node scripts/prepare-audio.mjs --offline` to verify existing prepared assets and
clean stale sample or license files without copying or modifying inputs unless needed.

## Optional Guitar Pro 8 standard soundbank integration

If the user has Guitar Pro 8's standard soundbank installed locally
(`com.arobas-music.soundbank.standard`, e.g. under
`C:\ProgramData\Arobas Music\Soundbanks\com.arobas-music.soundbank.standard` on Windows
or `/Library/Application Support/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard`
on macOS), TabPlayer can read its `.gp7bank` archives and `sets/*.json` definitions directly
at runtime when enabled in Soundbank settings.

No Guitar Pro soundbank files or extracted samples are bundled with, copied into, or
redistributed by TabPlayer.
