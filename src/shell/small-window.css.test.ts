import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactWindowHeight } from './small-window';

// jsdom applies no stylesheet, so these pin the CSS text that the layout rests on. They say what the rules are, not how they render:
// nothing here measures a pixel. The widths and heights in the comments are arithmetic from the stylesheet, not measurements.
const css=readFileSync('src/workstation/gp-shell.css','utf8');
/** The declaration blocks of every rule whose selector text contains `fragment`, . */
const bodies=(fragment:string,source=css)=>[...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].includes(fragment)).map(match=>match[2]);

describe('Loop, Click and Speed captions (THE-196, friction 4)',()=>{
  const captionRules=bodies(">.transport-caption").filter(body=>body.includes('position:absolute'));
  it('are still hidden by the general toolbar rule, apart from the bar position',()=>{
    expect(bodies('.gp-toolbar .transport-caption:not(.transport-bar-number)').join(';')).toMatch(/clip-path:inset\(50%\)/);
  });
  it('stay visible for the three groups, in one rule that names each of them',()=>{
    const selector=css.match(/([^{}]*\.transport-loop[^{}]*)\{[^{}]*position:absolute[^{}]*text-overflow:ellipsis/)?.[1]??'';
    expect(selector).toContain('.transport-loop');expect(selector).toContain('.transport-click');expect(selector).toContain('.transport-speed');expect(selector).toContain('>.transport-caption');
    expect(captionRules.length).toBeGreaterThan(0);
  });
  it('take no width from the toolbar: out of the flow, one line, clipped with an ellipsis instead of widening the group',()=>{
    const body=captionRules.join(';');
    expect(body).toMatch(/position:absolute/);expect(body).toMatch(/white-space:nowrap/);expect(body).toMatch(/overflow:hidden/);expect(body).toMatch(/text-overflow:ellipsis/);
    expect(body).toMatch(/clip-path:none/);expect(body).not.toMatch(/clip-path:inset/);expect(body).not.toMatch(/white-space:normal|white-space:wrap/);
  });
  it('sit inside their group, which is the positioning box, and cost no height: the group keeps its row',()=>{
    expect(bodies(':is(.transport-loop,.transport-click,.transport-speed)').some(body=>/^\s*position:relative;?\s*$/.test(body))).toBe(true);
  });
});

describe('the display controls folded at small heights (THE-196, friction 8)',()=>{
  it('hides a folded group even though the row sets display:flex on it',()=>{
    expect(bodies("[aria-label='Score display'][hidden]").join(';')).toMatch(/display:none/);
  });
  it('lays the folded menu out as a popover below its button, wrapping its controls',()=>{
    const body=bodies('.score-display-host[data-compact]>').join(';');
    expect(body).toMatch(/position:absolute/);expect(body).toMatch(/z-index:40/);expect(body).toMatch(/flex-wrap:wrap/);expect(body).toMatch(/max-width:min\(/);
  });
  it('gives the button a row-height box, and the open state the pressed colour',()=>{
    expect(bodies('.score-display-toggle').join(';')).toMatch(/min-height:28px/);expect(css).toMatch(/\.score-display-toggle\[aria-expanded=true\]/);
  });
  it('lets the button share the edit and view row in narrow windows instead of taking a row of its own',()=>{
    const narrow=css.slice(css.indexOf('/* A short window'));
    expect(narrow).toMatch(/\[data-compact-height=true\][^{]*\.gp-toolbar\s*\{[^}]*grid-template-areas:'transport transport transport' 'left display right'/);
  });
  it('is switched by the app\'s own height test, the same one that folds the controls, so the two cannot disagree',()=>{
    expect(css).not.toMatch(/@media[^{]*max-height/);expect(compactWindowHeight).toBe(610);
    expect(readFileSync('src/App.tsx','utf8')).toMatch(/data-compact-height=\{compactHeight\}/);
  });
});
