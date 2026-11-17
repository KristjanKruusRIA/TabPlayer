import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom applies no stylesheet, so this pins the CSS text: the Track tab's generic button hover paints a raised dark fill, which on a pressed
// notation toggle (accent fill, dark ink) left dark ink on a dark button while the pointer rested on it after the click.
const css = readFileSync('src/workstation/track-panels.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));

describe('a pressed notation toggle under the pointer', () => {
  it('keeps the accent fill and ink the generic button hover would replace', () => {
    const hover = rules.find(rule => rule.selector.includes('.notation-toggle[aria-pressed=true]:hover'));
    expect(hover?.body).toMatch(/background:\s*var\(--ws-accent\)/);
    expect(hover?.body).toMatch(/color:\s*var\(--ws-accent-ink\)/);
    expect(rules.indexOf(hover!)).toBeGreaterThan(rules.findIndex(rule => rule.selector.startsWith('.track-settings button:hover:not(:disabled)')));
  });
});
