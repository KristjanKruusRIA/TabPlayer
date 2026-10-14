# Guitar Pro installer findings and TabPlayer foundation

Date: 2026-10-14. The supplied installer is Guitar Pro 8.1.5.31. Its payload contains a 64-bit native Qt application, separate proprietary libraries, and a large nested soundbank installer. The approved TabPlayer foundation is Rust and Tauri plus alphaTab, with independently implemented editing and persistence.

## Artifact identity and extraction

The investigated input is `C:\Users\krist\Downloads\Guitar Pro 8.1.5.31\guitar-pro-8-setup.exe`, 1,035,739,304 bytes. Its SHA-256 is `642eb400725ee7493de1695dafdd2cc12836c72ed6c4ea37799fbd767ea35d6e`. REA classified the installer wrapper as x86 PE. Windows version metadata reports Guitar Pro 8, Arobas Music, version 8.1.5.31.

Inno Setup headers identify setup data version 6.1.0. The official portable innoextract 1.9 package was downloaded to an analysis tools directory; its MD5 matched the publisher's displayed `72d0d0dd874b6236eaa44411f4470ee1`. Innoextract inventoried the installer and extracted only its `app` subtree, with exit code 0. The target installer and extracted application were not executed. These are shell-tool observations, separate from REA Evidence.

The extracted `GuitarPro.exe` is 52,829,848 bytes; its version is 8.1.5.31, and Windows Authenticode inspection reports a valid Arobas Music signature. `Qt5Core.dll` reports version 5.15.3.0. The inventory contains Qt Widgets, GUI, SVG, XML, network, printing, and platform plugins. A nested `tmp\soundbank-full.exe` is approximately 924 MiB; it was inventoried without being extracted or run.

The inventory also contains `GPCore.dll`, `GPIO.dll`, `AMPainting.dll`, `AMAudio.dll`, `GPRSE.dll`, `AMSoundFont.dll`, and audio-related codecs/libraries. Their names and imports indicate a modular score/I/O/render/audio organization; exact runtime responsibilities require further tracing.

## Static file I/O evidence

REA opened the extracted `GPIO.dll` as an x86-64 PE shared library, SHA-256 `3a225b022a507d20ab2b9fa2530b5ac5deed9d11445588e37e9227cce398d816`. Ghidra 12.1.4 default analysis reported 22,419 procedures and 11,573 defined strings. These are analysis inventory counts, not original-source function counts.

| Finding | Evidence and interpretation |
| --- | --- |
| Separate file generations | Procedure searches identify `GP5ScoreLoader`, `GP5ScoreExporter`, `GP6ScoreLoader`, `GP7ScoreLoader`, and `GPIFReader`/`GPIFWriter`. This observes native symbol inventory; names alone do not prove full format fidelity. |
| GP6 header detection | At `0x18009a880`, `GP6ScoreLoader::canImportData` checks length greater than three, reads four bytes, resets the file position, and accepts constants `0x53464342` or `0x5a464342`. In little-endian order these are `BCFS` and `BCFZ`. This is decompiler-derived static behavior. |
| GPIF XML detection | At `0x1800d7060`, `GPIFReader::canImportData` checks length of at least 64 bytes, requires the six-byte prefix `<?xml `, parses XML, and compares the root name with five bytes at `0x1804b0f3c`. REA read those bytes as `4750494600`, or `GPIF` followed by NUL. Runtime parser edge cases are unobserved. |
| GP7 container path | `GP7ScoreLoader::canImportData` at `0x1800a4730` checks an extension list and calls `FUN_1800a4800`. That helper constructs `am::filesystem::PKZipReader` and runs two further checks. ZIP-reader involvement is established; the exact accepted ZIP member/version rules are not yet decoded. |
| GPIF archive paths | Defined-string search observes `Content/score.gpif`, `/score.gpif`, and `score.gpif`, along with reader/writer symbols. These are candidates for container/schema tracing, not a complete archive specification. |

The complete local REA bundle is `.analysis/guitar-pro-8.1.5-31/rea-evidence.json`. Its Evidence identifiers include:

- Overview: `ev_d6c0b658fc16267dbad8cd0f5bef7dfad85648e7a05dcaf9d45fd379d98aa656`.
- Format symbol search: `ev_dbdc5f3e4edb2c40624a3bcd635b62495cbbe15530743b55303f6266508b5d6b`.
- GP6 detector: `ev_5ae910643188994dc0d640a5d4a5f9c71ab96c0223350a26a70fd9ae74200ebf`.
- GPIF detector: `ev_ce81c6c1cb62f4980d87803e61368b39f210d42afe9a3d29197300a33b404bed`.
- GPIF root bytes: `ev_a45401f982737f238781ffef92daa8ed0477ef22479aee4882b9c87f583a9047`.
- GP7 detector: `ev_e4c10881a419171a39c33d441f667cac78656ac0a6ecffcbfcb2fb83ec3d9823`.
- GP7 ZIP helper: `ev_2c7f6f785054e9014f166f33db9955dcfb136d1c9d62bc07ed6a0941ebf082f2`.
- GPIF strings: `ev_5ddb98fa5bb9e35be80e946dc1df32ca15d56ffdcd07e192c47ce914535ff91e`.

REA's pseudocode is a recovered representation, not original source. Defined-string coverage can omit undefined or packed bytes; unresolved indirect calls and untraced helpers remain limitations.

## Foundation comparison

Rust and Tauri plus alphaTab is the approved approach. The engineering reason is to reuse public parsers, engraving, and synthesis while implementing TabPlayer's own editor, history, and native save format. Rust supplies the native project/file/history core; Tauri provides the desktop shell and command boundary; alphaTab supplies the musical engine in the webview. [Tauri architecture](https://v2.tauri.app/concept/architecture/), [alphaTab introduction](https://alphatab.net/docs/introduction)

alphaTab 1.8.4's documented import generations include GP3/4/5, GP6 GPX, and GP7/8 GP. It offers `.gp` export through `Gp7Exporter`, but does not document older Guitar Pro exporters. The score model can be modified, with explicit consistency requirements and separate render/MIDI refresh. Its raw JSON representation is not guaranteed stable across versions. [Formats](https://alphatab.net/docs/category/formats), [Exporter](https://alphatab.net/docs/guides/exporter), [Score model](https://alphatab.net/docs/reference/score), [Serialization](https://alphatab.net/docs/guides/lowlevel-apis#serialize-data-model-fromto-json)

Export regenerates GPIF and container/configuration entries. Upstream round-trip tests establish internal model comparisons, with GP8 bend comparison exclusions; they do not establish lossless source preservation or acceptance by the Guitar Pro runtime. Retaining originals and testing supported musical fields are consequently requirements. [Pinned source and tests](https://github.com/CoderLine/alphaTab/tree/022a45c8e42370f9e12e68949d11eada370da83d/packages/alphatab)

TuxGuitar is a credible alternative foundation because it already supplies a desktop editor for all three platforms. A fork would inherit its existing UI, edit managers, and architecture. Its official format documentation lists GP3/4/5 import/export and GPX/GP7 import. The selected Rust/Tauri architecture supports a new interface while retaining alphaTab's existing musical engine. [Repository](https://github.com/helge17/tuxguitar), [Formats](https://www.tuxguitar.app/files/devel/desktop/help/file_formats.html)

Building a native engraving, parsing, editing, and audio engine from scratch would provide more control but expands the initial implementation considerably. Reserve that option for specific engine limits demonstrated by tests.

## Investigation coverage

| Question | Status |
| --- | --- |
| Exact supplied target and packaged version | Answered by REA identity, installer inventory, and Windows metadata. |
| Package and desktop technology | Answered for inventory and Qt dependency/version facts; detailed runtime architecture remains partial. |
| Format generation boundaries | Partially answered by symbol searches and focused native detectors. Full parser schemas are not recovered. |
| Import/render/playback foundation | Answered sufficiently for selecting the initial engine from public documentation and source. Actual app integration remains to be built and tested. |
| Original UI editing semantics | Unresolved; no runtime UI scenario was observed. The proposed editor behaviors are TabPlayer design choices. |
| RSE timbre, effects, and soundbank equivalence | Unresolved; first milestone uses a separately licensed SoundFont. |
| Real Guitar Pro acceptance and advanced export fidelity | Unresolved pending representative file tests and original-app validation. |
| Cross-platform packaged behavior | Unresolved pending implementation and execution on each OS. |

This is an initial investigation supporting the first player/editor milestone, not a complete reverse engineering of Guitar Pro or a completed replacement.

## Source and retention

The analysis directory retains the extracted application, installer inventory, extraction log, and complete Evidence bundle for focused follow-up. It is excluded from Git and product packaging. No files from adjacent download folders were used. The supplied installer remains unchanged.

[innoextract's official download and extraction documentation](https://constexpr.org/innoextract/) explains the execution-free extraction used here.
