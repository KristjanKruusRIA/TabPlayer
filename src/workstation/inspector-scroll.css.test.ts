import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom applies no stylesheet, so these pin the CSS text that the inspector's scrolling rests on: the inspector host is the one scroller,
// and nothing inside a tab may be a scroll container of its own that swallows the wheel (a nested overscroll-behavior:contain on a box that never overflows).
const read = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));
const trackPanels = rules(read('src/workstation/track-panels.css')), shell = rules(read('src/workstation/workstation-shell.css'));

describe('the inspector scrolls as one (the Track tab could not be scrolled with the wheel)', () => {
  it('has the inspector host as its scroller', () => {
    const host = shell.filter(rule => rule.selector === '.workstation-inspector');
    expect(host.map(rule => rule.body).join(';')).toMatch(/overflow:auto/);
  });
  it('does not make the Track tab a scroll container or trap the wheel', () => {
    const body = trackPanels.filter(rule => /(^|,)\s*\.track-settings\s*(,|$)/.test(rule.selector)).map(rule => rule.body).join(';');
    expect(body).not.toMatch(/overflow(-[xy])?:\s*(auto|scroll)/);
    expect(body).not.toMatch(/overscroll-behavior/);
    expect(body).not.toMatch(/height:\s*100%/);
  });
  it('adds no gutter of its own, since the tab panel has them (the Song tab and the Track tab line up)', () => {
    const body = trackPanels.filter(rule => rule.selector === '.track-settings').map(rule => rule.body).join(';');
    expect(body).toMatch(/padding:\s*0\s*;/);
  });
  it('has no other panel in the inspector that scrolls by itself with the wheel contained', () => {
    const own = ['src/workstation', 'src/audio'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.css')).map(name => `${dir}/${name}`));
    const traps = own.flatMap(file => rules(read(file)).filter(rule => /overscroll-behavior:\s*contain/.test(rule.body) && /overflow(-[xy])?:\s*(auto|scroll)/.test(rule.body)).map(rule => rule.selector));
    // The mixer channels and the master strip, and the backing waveform's horizontal strip, sit in the dock, which is not the inspector.
    expect(traps.filter(selector => !/\.track-panel|\.backing-waveform-viewport/.test(selector))).toEqual([]);
  });
});
