# Third-party software

TabPlayer is an independent application. It contains no Guitar Pro application code, fonts, images, soundbanks or other extracted assets. Private test scores are excluded from builds.

- alphaTab 1.8.4, Copyright Daniel Kuschny and Contributors, is distributed unmodified under MPL-2.0. The complete licence and integrated-library notices are packaged in `alphatab/LICENSE` and `alphatab/LICENSE.header`. Corresponding source: https://github.com/CoderLine/alphaTab/tree/v1.8.4 . Integrated components retain their MIT/BSD notices in those files and in the unmodified JavaScript headers.
- Bravura, Copyright Steinberg Media Technologies GmbH, is distributed under SIL Open Font License 1.1. Its complete licence is packaged with the font in `font/Bravura-OFL.txt`.
- Sonivox SoundFont, Copyright (c) 2004–2006 Sonic Network Inc., is distributed under Apache License 2.0. Its notice is in `soundfont/LICENSE`; the complete Apache text is in `licenses/Apache-2.0.txt`.
- Karoryfer Black And Green Guitars and Black And Blue Basses, by Karoryfer Samples, are distributed under CC0-1.0. Sources are pinned to `sfzinstruments/karoryfer.black-and-green-guitars` revision `b3b3249d37dc977a1a297bd2dc053e6d9b6b805c` and `sfzinstruments/karoryfer.black-and-blue-basses` revision `6e7d674cdb41be7a54dbccb15472401ad01099b9`. Their complete, unmodified CC0 texts and SHA-256 source inventories are packaged under `licenses/audio/`; the native recorded libraries and licenses are bundled under `audio/`. Public source: https://github.com/sfzinstruments/karoryfer.black-and-green-guitars and https://github.com/sfzinstruments/karoryfer.black-and-blue-basses . App-owned mappings preserve the selected central velocity and variation layers; zero padding incorrectly included in a few published PCM24 data chunks is normalized without changing complete sample frames.
- "BMC slap bass samples" (2008) by Bruce H. McCosar (bmccosar), https://ccmixter.org/files/bmccosar/13742 , is used under Creative Commons Attribution 3.0 Unported (CC BY 3.0), https://creativecommons.org/licenses/by/3.0/ . TabPlayer plays twelve of its sustained slap and pop recordings, unchanged, as the bass slap and pop layers; it maps them to keys and transposes them during playback. The archive is pinned by SHA-256 `6b2af3543dd111b9f62b53544c4a02ae633fb775e20b42591e006a3c0d610d53` and fetched from its Internet Archive copy of the original ccMixter download. The attribution and complete license text are packaged in `licenses/audio/slap/LICENSE.txt` and bundled as `audio/licenses/slap.txt`, beside a SHA-256 inventory of each recording.
- Virtuosity Drums, recorded at Virtuosity Musical Instruments (Boston, MA) with drummer Austin McMahon and published at https://github.com/sfzinstruments/virtuosity_drums , is distributed under CC0-1.0. The source is pinned to revision `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`. TabPlayer plays its mid-microphone kit and percussion recordings, unchanged, through an app-owned map. The complete CC0 text and a SHA-256 source inventory are packaged under `licenses/audio/drums/` and bundled as `audio/licenses/drums.txt`; no attribution is required.
- The 58 cabinet impulse responses in `cabinet-irs/` are the app author's own captures, dedicated to the public domain under CC0-1.0 (affirmer Kristjan Kruus, 2026-10-30, Estonia). `README.txt` and the complete `LICENSE-CC0.txt` ship beside them; no attribution is required. Trademarks in file names identify the captured gear and imply no affiliation or endorsement.
- Noto Sans, Copyright Google and the Noto contributors; Noto Sans CJK JP, © 2014–2021 Adobe (http://www.adobe.com/); and Noto Emoji, Copyright 2013 Google LLC, are distributed under SIL Open Font License 1.1. The unmodified CJK and monochrome outline emoji fonts provide portable export text fallback. Export embeds subsets of these fonts and Bravura; complete licenses, copyright notices and pinned font provenance are packaged in `licenses/export-fonts/`.
- Noto Serif and Noto Sans Mono (Copyright 2018 The Noto Project Authors, github.com/googlei18n/noto-fonts) are distributed under SIL Open Font License 1.1, with Noto Sans Bold, Italic and Bold Italic, as the unmodified static TTF files pinned in `licenses/export-fonts/sources.json`. They have no Reserved Font Name. Noto Sans Mono has no italic face.
- Petaluma (Copyright © 2018, Steinberg Media Technologies GmbH, with Reserved Font Name "Petaluma") and Leland (Copyright (c) 2025, MuseScore BVBA, with Reserved Font Name "Leland") are distributed under SIL Open Font License 1.1 as the unmodified OTF files and SMuFL metadata JSON pinned in `licenses/export-fonts/sources.json`: no subsetting, conversion or filtering, so the Reserved Font Names stay valid. Petaluma's licence file states 2018; the font's own name table states 2021. PDF export embeds subsets, which the OFL FAQ allows. Symbols a music font lacks are drawn from Bravura.
- Instrument Sans (Copyright 2022 The Instrument Sans Project Authors, https://github.com/Instrument/instrument-sans) and IBM Plex Mono (Copyright © 2017 IBM Corp., https://github.com/IBM/plex) are distributed under SIL Open Font License 1.1 through the `@fontsource/instrument-sans` and `@fontsource/ibm-plex-mono` 5.3.0 packages, which bundle the unmodified Latin subsets so the interface looks the same offline. Each package's licence file is packaged under `licenses/`.
- Native audio uses CPAL 0.18.2 (Apache-2.0), Symphonia 0.6.1 (MPL-2.0), RustySynth 1.3.7 (MIT), and ringbuf 0.5.3 (MIT/Apache-2.0).
- External MIDI output uses midir 0.11.1, Copyright (c) 2015 Patrick Reisert and the RtMidi contributors, distributed under MIT. It talks to the system's MIDI service (WinMM on Windows, CoreMIDI on macOS, ALSA on Linux). Its complete license is included in the generated package inventory under `licenses/`.
- Fretlight guitar lights (wired USB HID, experimental) use hidapi 2.6.7, Copyright 2017 The hidapi-rs Developers, distributed under MIT. TabPlayer enables only its pure-Rust backends, `windows-native` and `linux-native-basic-udev`, so on Windows and Linux no C library is built and no system package is needed. The Linux backend uses basic-udev 0.1.3 (Sean Cross, MIT OR Apache-2.0; the crate ships no licence file and names no copyright holder, so its MIT text is packaged as `licenses/basic-udev-MIT.txt` and the Apache text is `licenses/Apache-2.0.txt`) and nix 0.30.1 (MIT; its licence file is in the generated package inventory under `licenses/`). macOS builds the HIDAPI C library bundled in the hidapi crate (Copyright (c) 2010, Alan Ott, Signal 11 Software), which TabPlayer uses under its BSD-style licence, packaged as `licenses/hidapi-bsd-license.txt`, and links the IOKit, CoreFoundation and AppKit system frameworks. The hidapi crate's own MIT licence file is in the generated package inventory under `licenses/`.
- Ogg Vorbis export uses vorbis_rs 0.5.6, aotuv_lancer_vorbis_sys 0.1.6 and ogg_next_sys 0.1.5, Copyright 2022 Alejandro González, distributed under BSD-3-Clause; the crates ship no licence file, so the complete upstream text is packaged as `licenses/vorbis-rs-BSD-3-Clause.txt`. They build the bundled aoTuV libvorbis (Copyright (c) 2003-2021 Aoyumi; Copyright (c) 2002-2020 Xiph.org Foundation) and libogg (Copyright (c) 2002 Xiph.org Foundation), both BSD-3-Clause; their `COPYING` files are included in the generated package inventory under `licenses/`.
- MP3 export uses LAME 3.100 (https://lame.sourceforge.io/; copyright Mark Taylor, Takehiro Tominaga, Robert Hegemann, Gabriel Bouvigne, Alexander Leidinger and the other LAME developers named in its source, 1999-2017), distributed under the GNU Library General Public License version 2 or (at your option) any later version; `gain_analysis.c` is under the GNU Lesser General Public License version 2.1 or later. TabPlayer builds the LAME 3.100 source bundled in mp3lame-sys 0.1.11 by Douman (LGPL-3.0, https://github.com/DoumanAsh/mp3lame-sys) and links it statically; its MPEG decoder is not built. TabPlayer's own source is released under the MIT License, so the app can be rebuilt against a modified LAME. The corresponding LAME source is that crate, https://crates.io/crates/mp3lame-sys/0.1.11 (checksum `54e3b1772db47828840702e5a2e05694527f731abadf9b931355d54035f019d8` in `Cargo.lock`). LAME's `COPYING` and `LICENSE` and the crate's licence are included in the generated package inventory under `licenses/`. The LGPL-3.0 builds on the GNU General Public License version 3, whose complete text is in `licenses/GPL-3.0.txt`.
- PDF export uses svg2pdf 0.13.0 (MIT/Apache-2.0) and pdf-writer 0.12.1 (MIT/Apache-2.0). Their complete license files are included in the generated package inventory under `licenses/`.
- PDF text shaping uses a locally patched usvg 0.45.1 (Apache-2.0 OR MIT). The patch merges fallback by complete source clusters so Latin ligatures and Unicode fallback can coexist. Upstream source revision `1b6c2fddbcbeffa8135df4323b02aaae84890907`, exact crate provenance and patch notes are retained in `vendor/usvg/`; both upstream licenses are packaged in `licenses/usvg-0.45.1/`.
- VST3 plug-in hosting (a separate helper process that loads the user's own plug-ins) uses the `vst3` crate 0.3.0 and `com-scrape-types` 0.1.1 by Micah Johnston (MIT OR Apache-2.0), whose bindings are generated from Steinberg's VST3 `pluginterfaces` (MIT, Copyright (c) Steinberg Media Technologies GmbH), and a Windows extract of SoundCraft's `vst3-host` FFI in the helper and its bundle resolution, which the app links as well through the protocol crate (Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors, MIT), with `libloading` 0.9.0 (ISC). The `vst3` licence files are in the generated package inventory under `licenses/`; the other texts are packaged as `licenses/steinberg-pluginterfaces-MIT.txt`, `licenses/com-scrape-types-MIT.txt` and `licenses/soundcraft-vst3-host-MIT.txt`.

  Steinberg VST3 pluginterfaces (https://github.com/steinbergmedia/vst3_pluginterfaces), MIT licence. The `vst3` crate 0.3.0 generates its bindings from the VST 3 SDK 3.8.0 interface headers, and the plug-in helper and the test plug-in link those bindings. The text below is the LICENSE.txt of that repository at tag v3.8.0_build_66 (commit 31d6eeba6daaa3e2a8bfbe3e7a90ca0b7fbfbc1c), verbatim:

  ```text
  //-----------------------------------------------------------------------------
  MIT License

  Copyright (c) 2025, Steinberg Media Technologies GmbH

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.

  //---------------------------------------------------------------------------------
  ```

  SoundCraft vst3-host (https://github.com/storytold/soundcraft, commit b6f9f15), MIT OR Apache-2.0, used here under MIT. TabPlayer's plug-in host helper vendors a Windows extract of its FFI (src-tauri/plugin-host/src/vst3/). SoundCraft's licence:

  ```text
  MIT License

  Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

  com-scrape-types 0.1.1 (https://github.com/coupler-rs/vst3-rs, authors: Micah Johnston), MIT OR Apache-2.0, used here under MIT:

  ```text
  Permission is hereby granted, free of charge, to any
  person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the
  Software without restriction, including without
  limitation the rights to use, copy, modify, merge,
  publish, distribute, sublicense, and/or sell copies of
  the Software, and to permit persons to whom the Software
  is furnished to do so, subject to the following
  conditions:

  The above copyright notice and this permission notice
  shall be included in all copies or substantial portions
  of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
  ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
  TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
  PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
  SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
  IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
  DEALINGS IN THE SOFTWARE.
  ```
- React, React DOM, Scheduler, Tauri and their dependencies retain their respective licences. Build-generated licence copies and package inventory are in `licenses/`.
- fflate 0.8.3, Copyright (c) 2026 Arjun Barrett, is distributed under MIT. Its complete license is packaged in `licenses/fflate-0.8.3/LICENSE`.
- Neural Amp Modeler capture playback (`src-tauri/src/audio/nam/`) is TabPlayer's own Rust port of the inference code of NAM Core (https://github.com/sdatkinson/NeuralAmpModelerCore), Copyright (c) 2023 Steven Atkinson, distributed under MIT. The `.nam` file format and test fixtures also come from the NAM trainer (https://github.com/sdatkinson/neural-amp-modeler, Copyright (c) 2019-2025 Steven Atkinson, MIT); fixture provenance and both licence texts are in `src-tauri/tests/fixtures/nam/README.md`. The `nam-rs` crate (MIT) is a development-only dependency used to cross-check output and is not shipped. NAM Core's licence:

  ```text
  MIT License

  Copyright (c) 2023 Steven Atkinson

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

The native `.tabplayer` format embeds the user's original score and records supported edits. Guitar Pro export is generated by alphaTab and can omit unsupported data; it is a separate export, with a warning and source-overwrite protection.
