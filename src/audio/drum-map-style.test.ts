import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The drum map is drawn in the sound dialog and in the narrow inspector. The layout select takes the full width under its label, so a
// long layout name is not cut to "Toontrack E..." beside it.
it('stacks the drum map label above a full-width layout select', () => {
  const css = readFileSync('src/audio/sound-panel.css', 'utf8');
  expect(css).toMatch(/\.sound-panel \.drum-map-preset\s*\{[^}]*flex-direction:column/);
  expect(css).toMatch(/\.sound-panel \.drum-map-preset select\s*\{[^}]*width:100%/);
});
