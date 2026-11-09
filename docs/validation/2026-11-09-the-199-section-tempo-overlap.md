# THE-199: Section Name and Tempo Mark Overlap in the Windowline Example

Date: 2026-11-09. Branch `agy/the-199-section-tempo-overlap`, based on `develop` at `f24e72b`.  
Related: Linear `THE-199`, `THE-54` walk (`docs/validation/2026-11-08-the-54-practise-walk.md`, friction 12).

---

## 1. Summary

During the THE-54 open-to-practise walk, bar 1 of the bundled CC0 example score **Windowline** (`assets/library/examples/example-windowline.tabplayer`) displayed visual crowding and collision between the section name `[Window] Window` and the initial tempo mark `♩ = 108`.

This investigation evaluates whether TabPlayer's engraving configuration layer can separate direction and section text, analyzes alphaTab 1.8.4's rendering pipeline, and concludes that **this layout collision is an upstream alphaTab engine limitation** that cannot be cleanly resolved in the engraving layer without upstream changes. Per the task brief ("documented as a limit"), this document records the root cause, exact rendering mechanics, mathematical collision measurements, and upstream recommendations.

---

## 2. Root Cause Analysis

### 2.1 Score Structure
In `assets/library/examples/example-windowline.tabplayer` (at edit `setMeasureSettings` for bar 0):
- `section: "Window"` sets `marker: "Window"` and `text: "Window"`.
- `tempos: [{ beat: 0, bpm: 108, linear: false }]` sets a tempo automation at beat 0 of bar 0.

Both annotations attach to bar 0, beat 0.

### 2.2 alphaTab Effect Band Architecture
alphaTab groups notation annotations positioned above the top staff into an internal `EffectBandContainer`:
1. **Renderer Registration:**
   In `alphaTab.Environment.defaultRenderers[0]` (`SlashBarRendererFactory`), shared top effect bands are registered in a fixed default order:
   - Index 0: `TempoEffectInfo` (`NotationElement.EffectTempo = 33`, `order: 0`)
   - Index 1: `TripletFeelEffectInfo` (`order: 1`)
   - Index 2: `MarkerEffectInfo` (`NotationElement.EffectMarker = 25`, `order: 2`)
   - Index 3: `DirectionsEffectInfo` (`NotationElement.EffectDirections = 21`, `order: 3`)

   When rendering standard notation or tablature (`ScoreBarRendererFactory`, `TabBarRendererFactory`), these shared top bands are prepended to the first active staff's `topEffectInfos`.

2. **Slot Allocation (`EffectBandSizingInfo`):**
   - `TempoEffectInfo` specifies `canShareBand = false`.
   - `MarkerEffectInfo` specifies `canShareBand = true`.
   - Because `TempoEffectInfo` cannot share a band, and because both glyphs anchor at beat 0 (their beat intervals overlap at beat 0), `EffectBandSizingInfo.getOrCreateSlot()` assigns them to two separate vertical slots:
     - **Slot 0:** `TempoEffectInfo` (order 0)
     - **Slot 1:** `MarkerEffectInfo` (order 2)

3. **Band Height and Vertical Positioning (`EffectBandContainer._updateEffectBandHeights`):**
   Vertical slot positions are computed sequentially:
   $$\text{Slot } 0: y = 0, \quad h = \text{slot}[0].\text{shared}.\text{height}$$
   $$\text{Slot } 1: y = \text{slot}[0].y + \text{slot}[0].\text{height} + \text{effectBandPaddingBottom}$$
   where default `display.effectBandPaddingBottom = 2` px.

### 2.3 The Rendering Flaws in alphaTab 1.8.4

1. **`BarTempoGlyph.doLayout()` ignores text metrics:**
   In `alphaTab.core.mjs` (lines 55624–55628):
   ```ts
   doLayout() {
     super.doLayout();
     const res = this.renderer.resources;
     this.height = this.renderer.smuflMetrics.glyphHeights.get(MusicFontSymbol.MetNoteQuarterUp) * res.engravingSettings.tempoNoteScale;
   }
   ```
   `BarTempoGlyph` calculates its height solely from the SMuFL notehead glyph `MetNoteQuarterUp` scaled by `tempoNoteScale` ($0.7 \times 29.84 = 20.89$ px). It never measures the accompanying text (`" = 108"`), never sets `this.width` (leaving `width = 0`), and never reserves space for font ascenders/descenders.

2. **`BarTempoGlyph.paint()` ignores glyph alignment and hardcodes horizontal origin:**
   In `BarTempoGlyph.paint()` (lines 55629–55648):
   ```ts
   let x = cx + this.renderer.getRatioPositionX(automation.ratioPosition);
   ...
   const notePosY = cy + this.y + this.height + this.renderer.smuflMetrics.glyphBottom.get(MusicFontSymbol.MetNoteQuarterUp) * res.engravingSettings.tempoNoteScale;
   canvas.textBaseline = TextBaseline.Alphabetic;
   ```
   Instead of using the aligned glyph coordinate `this.x`, `BarTempoGlyph` computes `x` from `getRatioPositionX(0)`. For bar 0 beat 0, this evaluates to the bar's note start offset ($x \approx 134.7$ px in Parchment layout).
   Meanwhile, `MarkerEffectInfo` (`TextGlyph`) also aligns its left edge to beat 0 ($x \approx 135.2$ px).
   **Both glyphs start at the exact same horizontal coordinate ($x \approx 135$ px).**

3. **Vertical Gap Collapse (1.45 px clearance):**
   - In Slot 0 (`TempoEffectInfo`):
     - `this.height` $= 20.89$ px.
     - `glyphBottom` of `MetNoteQuarterUp` is $-5.076$ font units $\times 0.7 = -3.55$ px.
     - `notePosY` (the alphabetic baseline of ` = 108` and the notehead origin) is $0 + 20.89 - 3.55 = 17.34$ px.
     - In Bravura / SMuFL, the notehead extends below the baseline by $0.69$ staff spaces ($\approx 4.1$ px). Thus the bottom of the notehead reaches $17.34 + 4.1 = 21.44$ px.
   - In Slot 1 (`MarkerEffectInfo`):
     - `band.y` $= \text{slot}[0].y + \text{slot}[0].\text{height} + \text{paddingBottom} = 0 + 20.89 + 2 = 22.89$ px.
     - `TextGlyph` paints `[Window] Window` with `font: bold 14px Georgia, serif` using SVG `dominant-baseline: hanging` at $y = 22.89$ px.
   - **Net vertical clearance:**
     $$22.89\text{ px} - 21.44\text{ px} = 1.45\text{ px}$$
   In standard screen rendering (Chromium / WebKit SVG engines on Windows/macOS/Linux), a 1.45 px gap between a 24 px music notehead and a 14 px bold serif font causes immediate visual collision and crowding.

4. **Lack of 2D Collision Resolution:**
   alphaTab lacks horizontal staggering or collision detection between effect bands. When two annotations occupy beat 0:
   - They cannot share a band because `TempoEffectInfo.canShareBand` is `false`.
   - Even if both shared a band, `EffectBandSlot.canBeUsed()` rejects sharing whenever beat ranges collide (`this.shared.lastBeat.isBefore(band.firstBeat)` is false for co-located beats).
   - alphaTab provides no horizontal offset mechanism (e.g., placing the rehearsal mark to the left or right of the tempo mark).

---

## 3. Engraving Layer Assessment

TabPlayer's engraving configuration layer (`src/engraving/`):
- Controls document stylesheet properties (`EngravingOverrides`): barlines, dynamics, brackets, system separators, chord placement, track names, bar numbers, multi-rests.
- Sets notation booleans and enums (`tabRhythm`, `fingering`, bend options).
- Controls typography families and scale factors (`EngravingTypography`).
- Applies bar widths, system gaps, and staff groups.

**Limitations:**
1. alphaTab exposes no configuration option in `Settings.display`, `Settings.notation`, or `EngravingSettings` to control:
   - The ordering of effect bands.
   - The horizontal positioning or collision offsetting of `MarkerEffectInfo` or `TempoEffectInfo`.
   - Per-band padding, margins, or relative positioning.
2. `settings.display.effectBandPaddingBottom` is a single global scalar on `DisplaySettings`. While increasing it would widen the vertical slot separation, it affects every effect band across all bars and tracks score-wide, does not solve the horizontal stacking, and is not exposed as an engraving override.
3. The glyph creation and placement classes (`BarTempoGlyph`, `MarkerEffectInfo`, `EffectBandContainer`, `EffectBandSlot`) are internal, unexposed, and hardcoded in alphaTab's rendering bundle.

---

## 4. Conclusion & Upstream Recommendation

The overlap between `[Window] Window` and `♩ = 108` at bar 1 of the Windowline example is an **upstream alphaTab layout engine limit**.

### Upstream Fix Requirements for alphaTab
To properly support co-located tempo markings and section markers at the start of a score:
1. `BarTempoGlyph.doLayout()` must measure the full rendered bounding box of tempo automations (including text prefix, metronome notehead, and tempo number), setting both `this.width` and `this.height` accurately.
2. `EffectBandContainer` / `EffectBandSlot` should support horizontal staggering for co-located measure-start annotations (e.g., positioning section markers before tempo marks, or allowing section markers and tempo marks to flow horizontally when sufficient measure width exists).
3. `BarTempoGlyph.paint()` should align to `this.x` rather than recalculating `getRatioPositionX(0)`, and ensure consistent baseline metrics relative to `band.y`.

### Parked Recommendation for TabPlayer
- Document this behavior as an upstream alphaTab engine limit.
- When authoring example scores or user documentation, note that attaching a section marker and a tempo change to the exact same measure start (bar 0, beat 0) results in tight vertical stacking by alphaTab.
