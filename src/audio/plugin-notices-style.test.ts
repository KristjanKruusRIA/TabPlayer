import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The plug-in notices above the score (a crash, a missing plug-in, the built-in kit playing instead of an instrument)
// are drawn like the cabinet notices: padded boxes with a margin, not bare text against the window edge.
it('styles the page-level plug-in notices like the cabinet notices', () => {
  const css = readFileSync('src/audio/sound-panel.css', 'utf8');
  expect(css).toMatch(/\.plugin-notices\s*\{[^}]*margin:6px 12px/);
  expect(css).toMatch(/\.plugin-notices \.sound-ir-notice\s*\{[^}]*padding:6px 8px[^}]*border:1px solid/);
});
