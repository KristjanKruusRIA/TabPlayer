# DI Guitar Model Architecture & Fine-Tuning Workflow

TabPlayer's DI guitar-to-tab transcription runs `DiGuitarNetV5` (`di_guitar_net.onnx`) directly inside Rust via `tract-onnx`.

- **Bundled model:** [src-tauri/assets/di-guitar-net/di_guitar_net.onnx](../src-tauri/assets/di-guitar-net/di_guitar_net.onnx)
- **Model metadata:** [src-tauri/assets/di-guitar-net/README.txt](../src-tauri/assets/di-guitar-net/README.txt)
- **DSP frontend & ONNX inference:** [src-tauri/src/audio/transcribe.rs](../src-tauri/src/audio/transcribe.rs)
- **Training workspace & scripts:** [E:/Training/README.md](file:///E:/Training/README.md)

---

## 1. Rust / `tract-onnx` Tensor Contract

Any replacement or custom ONNX file loaded by TabPlayer (either bundled in `src-tauri/assets/di-guitar-net/di_guitar_net.onnx` or selected via the UI custom-model picker in [src/audio/di-transcribe.ts](../src/audio/di-transcribe.ts)) must match the exact fixed-shape static ONNX contract defined in [src-tauri/src/audio/transcribe.rs](../src-tauri/src/audio/transcribe.rs):

| Tensor | Name | Shape (`f32`) | Notes |
| --- | --- | --- | --- |
| Input | `features` | `[1, 8, 216, 344]` | `22,050 Hz` mono audio, hop `256` (~`4.0 s` chunk, `44`-frame overlap), 8 harmonic/flux/brightness channels across `72` semitones × `3` sub-bins (`MIDI 24..95`, `C1..B6`) |
| Output 0 | `frame_logits` | `[1, 72, 344]` | Per-semitone active frame logits (`MIDI 24..95`) |
| Output 1 | `onset_logits` | `[1, 72, 344]` | Per-semitone onset logits |
| Output 2 | `attack_logits` | `[1, 344]` | Global pick/note attack logits |
| Output 3 | `palm_mute_logits` | `[1, 344]` | Global palm-mute probability logits |

### Export constraints for `tract-onnx`
- Export with `opset_version=14` and `dynamo=False` in PyTorch (as implemented in `E:\Training\train\model.py`).
- Static batch size `1` with folded BatchNorm/parameters (`Conv2d`, `ReLU`, `ConvTranspose2d`). Dynamic axes or newer ONNX opsets using `dynamo=True` can fail `tract-onnx` static shape inference.

---

## 2. DSP & Architecture Parity Scripts (`E:\Training\train\`)

Two verification scripts guarantee zero skew between Python training and Rust inference:

1. **`E:\Training\train\frontend.py`** — Reproduces `DiFrontendScratch` (`N_LO=4096`, `N_MID=1024`, `N_HI=512`, `HARMONICS=[0.5, 1.0, 2.0, 3.0, 4.0, 5.0]`, flux `2x` Hi-res, brightness `4x` Hi-res, log compression `log1p(mag * 40.0)`).
   ```powershell
   E:\Training\.venv\Scripts\python.exe E:\Training\train\frontend.py --verify
   ```
2. **`E:\Training\train\model.py`** — Exact PyTorch `DiGuitarNetV5(base_ch=40, main_ch=72)` (`1,018,020` parameters) that loads directly from `di_guitar_net.onnx` and exports opset-14 ONNX.
   ```powershell
   E:\Training\.venv\Scripts\python.exe E:\Training\train\model.py --verify
   ```

---

## 3. Fine-Tuning Pipeline Overview

Full step-by-step commands live in [E:/Training/README.md](file:///E:/Training/README.md). In summary:

1. **Prepare song folders** in `E:\Training\<Song>\` with `<Song>.gp`, `*-L*.wav` (paired to Track 0), and `*-R*.wav` (paired to Track 1).
2. **Build aligned dataset & replay cache** (`build_dataset.py`):
   - Parses tempo automation and tracks from `Content/score.gpif` inside `.gp`.
   - Computes global audio-to-tab lag via flux/impulse cross-correlation, snaps chord onsets locally, trims silent tails, and masks harmonics / audio-vs-tab mismatches.
   - Splits aligned songs 85% train / 15% validation with a 2-chunk gap to avoid 50%-overlap leakage, and synthesizes `300` replay chunks covering dense 5–7 string chords, power chords (`root+7` with/without `+12`), sustained notes, fast chugs, and minor-second dyads.
3. **Train with anti-forgetting safeguards** (`train.py`):
   - **Wide log-frequency pitch shifting** (`[-1, +16]` semitones on 75% of real chunks) plus mild gain/spectral tilt augmentation so low-tuned material (e.g., Drop D1/F#1/G#1) transfers across tunings.
   - **Mixed batches**: 65% real DI chunks + 35% synthetic replay chunks.
   - **Class weighting + L2 anchor**: `pos_weight` (`5.5` frame, `14.0` onset, `4.5` attack, `1.2` palm-mute) plus `2e-4` L2 penalty toward `--base-onnx`.
   - **Model Soup**: tests pitch-backbone interpolation `alpha_pitch ∈ {0.50, 0.75, 1.00}` while retaining full fine-tuned `attack_head` and `pm_head`.

---

## 4. Bundling a Newly Trained Model & Building the Installer

Once you have verified `E:\Training\output\di_guitar_net_finetuned.onnx`:

1. **Copy the ONNX file into the repo asset path (from the repository root):**
   ```powershell
   Copy-Item E:\Training\output\di_guitar_net_finetuned.onnx `
     src-tauri\assets\di-guitar-net\di_guitar_net.onnx -Force
   ```

2. **Update the size and SHA-256 in** [src-tauri/assets/di-guitar-net/README.txt](../src-tauri/assets/di-guitar-net/README.txt):
   ```powershell
   $item = Get-Item src-tauri\assets\di-guitar-net\di_guitar_net.onnx
   $hash = (Get-FileHash $item.FullName -Algorithm SHA256).Hash.ToLower()
   Write-Host "Size: $($item.Length) bytes"
   Write-Host "SHA-256: $hash"
   ```

3. **Run the Rust `transcribe` test suite** (includes ONNX loading, synthetic Drop D1 / Drop C / sustain / minor-2nd / palm-mute / chord anti-forgetting checks):
   ```powershell
   # Run from the repository root
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo test --locked --lib --manifest-path src-tauri/Cargo.toml transcribe
   ```

4. **Build a fresh Windows MSI installer:**
   ```powershell
   # Run from the repository root
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   npm run tauri -- build --bundles msi
   ```
   The installer is emitted under `src-tauri\target\release\bundle\msi\`.
