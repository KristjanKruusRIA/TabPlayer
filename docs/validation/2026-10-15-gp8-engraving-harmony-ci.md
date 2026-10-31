# Engraving/harmony platform CI follow-up

Date: 2026-10-15. Product revision: `880c0a5b6e6c84813479ef469b64e3b46046fe44` on `feat/gp8-parity`.

[GitHub Actions run 38695038649](https://github.com/KristjanKruusRIA/TabPlayer/actions/runs/38695038649) completed successfully in all four jobs. The completed job/step state was inspected through the GitHub API.

| Job | Result | Verified scope |
|---|---|---|
| Audio preparation | Success | Complete prepared bank verified without downloading |
| Windows 2022 | Success | Frontend/resource and native tests, unsigned MSI/NSIS build, actual extracted package contents verified offline |
| macOS 15 | Success | Frontend/resource and native tests, unsigned app/DMG build, actual disk-image contents verified offline |
| Ubuntu 24.04 | Success | Frontend/resource and native tests, unsigned Debian/AppImage build, actual package contents verified offline |

These results postdate the local [engraving](2026-10-15-gp8-engraving.md) and [harmony](2026-10-15-gp8-harmony.md) reports. They add automated platform build/package evidence to the local Windows native workflows and all-page PDF inspection. The earlier reports and [progress overlay](2026-10-15-gp8-parity-progress.md) retain their original evidence snapshots and hashes.

Packages were built and inspected in CI; no installer release or `main` integration is claimed. Physical macOS/Linux audio/device behavior, printer and installation acceptance, code signing and original GP8 runtime comparison remain separate open gates. The full 258-requirement parity goal remains active.
