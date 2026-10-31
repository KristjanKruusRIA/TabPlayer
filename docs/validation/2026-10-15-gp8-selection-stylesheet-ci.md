# Selection playback and stylesheet: cross-platform CI

Observed 2026-10-15. This records the completed [GitHub Actions run 38724478672](https://github.com/KristjanKruusRIA/TabPlayer/actions/runs/38724478672) at `f6350fc3e1bb33e1e63c7d81524c87e0df61c8de` on `feat/gp8-parity`. The product changes are `b73ae93682332c64029777cc4dfeaebfe2a77214`; `f6350fc` changes only the macOS allocation-test observer warm-up. Later local document-tabs changes are outside this run.

| Job | Result | Packaging and actual contents check |
| --- | --- | --- |
| Audio preparation, 116386947040 | Success | Prepared pinned offline bank |
| Ubuntu 24.04, 116387321249 | Success | Unsigned Debian and AppImage; actual contents verified offline |
| Windows 2022, 116387321299 | Success | Unsigned MSI and NSIS; actual contents verified offline |
| macOS 15, 116387321340 | Success | Unsigned app and DMG; actual disk-image contents verified offline |

Every desktop job reports success for frontend/resource tests, native core/rendering/persistence/export tests, shipping package build, and its applicable package-contents verifier. Checks intended for another OS are explicitly skipped. The final connector job/step response is retained locally at `.analysis/parity/ci-38724478672-jobs.json`.

The preceding macOS failure was isolated to the test's first status observer allocating a Darwin mutex while the callback allocation counter was active. The corrected test warms that non-callback observer before the guard and retains all guarded work and assertions. This run confirms the correction on macOS as well as Windows and Linux. Production audio code and allocation budgets were unchanged by the correction.

Related runtime evidence remains in [selection playback](2026-10-15-gp8-selection-playback.md) and [stylesheet interchange](2026-10-15-gp8-stylesheet-interchange.md). Their original source and artifact identities remain historical evidence; subsequent document-addressing script migrations do not change what those receipts proved.

This is build/test/package evidence. It does not establish physical macOS/Linux audio, native printing or installer lifecycle, signing, original Guitar Pro runtime equivalence, a new `main` release, document-tabs acceptance, crash recovery, or complete GP8 parity.
