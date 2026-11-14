# File-format generations and foundation choice

Date: 2026-10-14 (condensed 2026-11-14 before publication). This note records which Guitar Pro file generations TabPlayer must test independently and why the foundation is Rust and Tauri plus alphaTab. TabPlayer's importers and exporters are written from public documentation, alphaTab's open source and the observed behaviour of files; no vendor code is included. The format facts below also rest on analysis of Guitar Pro 8 that is not published here. An earlier version of this note held details of that analysis; they are not needed to build or understand TabPlayer and were removed.

## Format generations

Each generation is tested on its own, because a reader that handles one says nothing about the others.

| Generation | Container and detection |
| --- | --- |
| GP3, GP4, GP5 | Legacy binary format. |
| GP6 (`.gpx`) | Container whose first four bytes read `BCFS` (uncompressed) or `BCFZ` (compressed). |
| GP7 and GP8 (`.gp`) | ZIP archive whose score is `Content/score.gpif`. |
| Bare GPIF | Plain XML file whose root element is `GPIF`. |

They are not a full specification: the schemas of each generation are recovered by testing against representative files, not from this note.

## Foundation comparison

Rust and Tauri plus alphaTab is the approved approach. The engineering reason is to reuse public parsers, engraving, and synthesis while implementing TabPlayer's own editor, history, and native save format. Rust supplies the native project/file/history core; Tauri provides the desktop shell and command boundary; alphaTab supplies the musical engine in the webview. [Tauri architecture](https://v2.tauri.app/concept/architecture/), [alphaTab introduction](https://alphatab.net/docs/introduction)

alphaTab 1.8.4's documented import generations include GP3/4/5, GP6 GPX, and GP7/8 GP. It offers `.gp` export through `Gp7Exporter`, but does not document older Guitar Pro exporters. The score model can be modified, with explicit consistency requirements and separate render/MIDI refresh. Its raw JSON representation is not guaranteed stable across versions. [Formats](https://alphatab.net/docs/category/formats), [Exporter](https://alphatab.net/docs/guides/exporter), [Score model](https://alphatab.net/docs/reference/score), [Serialization](https://alphatab.net/docs/guides/lowlevel-apis#serialize-data-model-fromto-json)

Export regenerates GPIF and container/configuration entries. Upstream round-trip tests establish internal model comparisons, with GP8 bend comparison exclusions; they do not establish lossless source preservation or acceptance by the Guitar Pro runtime. Retaining originals and testing supported musical fields are consequently requirements. [Pinned source and tests](https://github.com/CoderLine/alphaTab/tree/022a45c8e42370f9e12e68949d11eada370da83d/packages/alphatab)

TuxGuitar is a credible alternative foundation because it already supplies a desktop editor for all three platforms. A fork would inherit its existing UI, edit managers, and architecture. Its official format documentation lists GP3/4/5 import/export and GPX/GP7 import. The selected Rust/Tauri architecture supports a new interface while retaining alphaTab's existing musical engine. [Repository](https://github.com/helge17/tuxguitar), [Formats](https://www.tuxguitar.app/files/devel/desktop/help/file_formats.html)

Building a native engraving, parsing, editing, and audio engine from scratch would provide more control but expands the initial implementation considerably. Reserve that option for specific engine limits demonstrated by tests.

## Coverage

| Question | Status |
| --- | --- |
| Format generation boundaries | Answered at the level of the table above; full schemas are established by file tests, not here. |
| Import, render and playback foundation | Answered sufficiently from public documentation and source for choosing the initial engine; integration is tested in the app. |
| Original UI editing semantics | Not established. The editor behaviours are TabPlayer design choices. |
| Timbre, effects and sound-engine equivalence | Not established; TabPlayer uses a separately licensed SoundFont and its own audio engine. |
| Acceptance by Guitar Pro and advanced export fidelity | Not established without representative file tests in the original application. |
| Cross-platform packaged behaviour | Established only by running on each operating system. |

## Limits

- Reading public material and files does not establish equivalence with any commercial product.
- Round trips are not lossless; originals are retained and supported musical fields are tested.
- The proprietary sound engine is not replicated.
- This is an initial investigation supporting the first player and editor milestone, not a complete study of the format or a finished replacement.
