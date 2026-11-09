# THE-199: Section name crowds the tempo mark in the Windowline example

Date: 2026-11-09. Branch `agy/the-199-section-tempo-overlap`, based on `develop` at `f24e72b`.
Related: Linear `THE-199`, the THE-54 walk (`docs/validation/2026-11-08-the-54-practise-walk.md`, friction 12).

## Summary

At bar 1 of the bundled Windowline example, the section name `[Window] Window` sat tight under the tempo mark ` = 108`. It was crowding, not an overlap. An earlier version of this document called it an upstream alphaTab limit that the engraving layer could not fix. That was wrong.

alphaTab 1.8.4 has a public setting, `display.effectBandPaddingBottom` (default 2, since 1.7.0), and it is exactly the gap between stacked effect bands. This change raises it to 5 on both render paths.

## Cause

Both marks attach to bar 0, beat 0. The tempo band cannot share a band (`TempoEffectInfo.canShareBand` is false), so the tempo mark and the section marker take two vertical slots. Slot 1 starts at `slot0.y + slot0.height + effectBandPaddingBottom`.

Measured in an alphaTab 1.8.4 SVG render with a tempo of 108 and the section `[Window] Window`:

| Item | Position |
|---|---|
| Tempo text baseline | y 17.34 |
| Tempo band bottom (notehead bottom) | y 20.89 |
| Section text (hanging baseline) | y 22.89 |

`BarTempoGlyph` puts the notehead's bottom edge exactly at the band bottom (`notePosY = y + height + glyphBottom * scale`). The clear space between the two marks is therefore the 2 px padding, less the little that the bracket of the Georgia section text rises above its hanging baseline. That is about 2 px, tight but not overlapping.

An earlier draft counted 1.45 px by adding about 4.1 px of notehead descent below the baseline. That double-counted the drop already included in the band height, and it disagreed with its own -5.076 font-unit figure (3.55 px at the 0.7 note scale). Ignore that figure.

## Fix

- `src/engraving/effect-bands.ts` holds `EFFECT_BAND_PADDING_BOTTOM = 5` and `applyEffectBandSpacing(settings)`.
- The screen renderer (`src/ScoreView.tsx`, in the draw step next to `display.scale`) and PDF export (`src/export/pdf.ts`, next to the layout settings) both call it, so the two stay in step.
- With 5 the gap grows by 3 px, from about 2 px to about 5 px. The tempo mark does not move, and the section name and everything under it on that system moves down 3 px. Every other stacked effect band also gets 3 px more space.

### Why 5

It clears the marks by a visible margin (the reviewer suggested 5) without spending much page height: 3 px per stacked slot. A larger value such as 6 would add more height to every system with stacked marks for little further benefit. This is a judgement, not a measured optimum.

### Alternatives checked

- Reordering the bands (marker first) only moves the crowding: the bracket descenders then sit about 1.5 px above the tempo stem. That also needs an `@internal` alphaTab object, which is fragile.
- The earlier upstream recommendations (measure the tempo text, align to `this.x`) do not change the vertical clearance. A useful upstream request would be a per-band or minimum text clearance. TabPlayer does not need to wait for it.

## Tests

- `src/engraving/effect-bands.render.test.ts` renders a tempo mark and a section at bar 0 and measures the section text's y against the tempo band bottom. The section starts at least the shared padding below it, and the gap is wider than alphaTab's default.
- `src/ScoreView.layouts.test.tsx` fails if the screen renderer drops the setting in any layout.
- `src/export/pdf.test.ts` renders a score with a tempo and a section through `renderPdfPages` and fails if the export path drops the setting.
- I confirmed the last two fail with the setting removed from their path.
- `src/engraving/staff-groups.render.test.ts` records a SHA-256 of the default export pages. It changed because that fixture has a tempo and a section. The only difference I found (token for token, 133 changed y values on page 1, pages 2 and 3 identical) is the 3 px downward shift. The recorded hash was updated for that reason alone.

## Limits

- No in-app visual check was done. I did not open the Windowline example in the running app or look at a PDF page by eye. The evidence is SVG coordinates from jsdom renders.
- The pre-existing failures in `src/export/musicxml.test.ts` and `src/export/midi.test.ts` come from missing `.analysis/compatibility` fixtures in the worktree and also fail on the base commit.
- The 5 px value is a judgement, not a measured optimum.
