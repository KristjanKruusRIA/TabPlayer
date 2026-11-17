import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The drum map is drawn in the sound dialog and in the narrow inspector. The layout select takes the full width under its label, so a
// long layout name is not cut short beside it.
it('stacks the drum map label above a full-width layout select', () => {
  const css = readFileSync('src/audio/sound-panel.css', 'utf8');
  expect(css).toMatch(/\.sound-panel \.drum-map-preset\s*\{[^}]*flex-direction:column/);
  expect(css).toMatch(/\.sound-panel \.drum-map-preset select\s*\{[^}]*width:100%/);
});

// "In this track" is a flat list of rows about 36 px high: the sound, the key, the note, the marker and the keys to try on one row where
// they fit, the keys to try under it where the width is too small, and no note names where it is narrower still.
it('draws a row on one line, wraps the keys to try under it when narrow, and drops note names when narrower', () => {
  const css = readFileSync('src/audio/sound-panel.css', 'utf8');
  expect(css).toMatch(/\.sound-panel \.drum-map-row\s*\{[^}]*grid-template-columns:subgrid[^}]*min-height:36px/);
  expect(css).toMatch(/\.sound-panel \.drum-map-table\s*\{[^}]*container-type:inline-size/);
  expect(css).toMatch(/@container \(max-width:\d+px\)\s*\{\.sound-panel \.drum-map-candidates\s*\{[^}]*grid-column:1\/-1/);
  expect(css).toMatch(/@container \(max-width:\d+px\)[^@]*\.drum-map-notename\{display:none\}/);
  expect(css).toMatch(/\.sound-panel \.drum-map-status:empty\s*\{margin:0\}/);
  expect(css).toMatch(/\.sound-panel \.drum-map-footer\s*\{display:flex;flex-wrap:wrap/);
});
