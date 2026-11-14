import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactWindowHeight } from './small-window';
import { keyFoldQuery,toolbarFit,toolbarMeasured } from './toolbar-fit';

// jsdom applies no stylesheet, so these pin the CSS text that the layout rests on. They say what the rules are, not how they render:
// nothing here measures a pixel. The widths and heights in the comments are arithmetic from the stylesheet, not measurements.
const css=readFileSync('src/workstation/gp-shell.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'');
const exact=(selector:string)=>[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].trim()===selector).map(match=>match[2]);
/** The declaration blocks of every rule whose selector text contains `fragment`, . */
const bodies=(fragment:string,source=css)=>[...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].includes(fragment)).map(match=>match[2]);

describe('Loop, Click and Speed captions (THE-196, friction 4)',()=>{
  const captionRules=bodies(">.transport-caption").filter(body=>body.includes('position:absolute'));
  it('are still hidden by the general toolbar rule, apart from the bar position',()=>{
    expect(bodies('.gp-toolbar .transport-caption:not(.transport-bar-number)').join(';')).toMatch(/clip-path:inset\(50%\)/);
  });
  it('stay visible for the three groups, in one rule that names each of them',()=>{
    const selector=css.match(/([^{}]*\.transport-loop[^{}]*)\{[^{}]*position:absolute[^{}]*text-overflow:ellipsis/)?.[1]??'';
    expect(selector).toContain('.transport-loop');expect(selector).toContain('.transport-click');expect(selector).toContain('.transport-speed');expect(selector).toContain('.transport-key');expect(selector).toContain('>.transport-caption');
    expect(captionRules.length).toBeGreaterThan(0);
  });
  it('take no width from the toolbar: out of the flow, one line, clipped with an ellipsis instead of widening the group',()=>{
    const body=captionRules.join(';');
    expect(body).toMatch(/position:absolute/);expect(body).toMatch(/white-space:nowrap/);expect(body).toMatch(/overflow:hidden/);expect(body).toMatch(/text-overflow:ellipsis/);
    expect(body).toMatch(/clip-path:none/);expect(body).not.toMatch(/clip-path:inset/);expect(body).not.toMatch(/white-space:normal|white-space:wrap/);
  });
  it('sit inside their group, which is the positioning box, and cost no height: the group keeps its row',()=>{
    expect(bodies(':is(.transport-loop,.transport-click,.transport-speed,.transport-key)').some(body=>/^\s*position:relative;?\s*$/.test(body))).toBe(true);
  });
});

describe('the display controls folded at small heights (THE-196, friction 8)',()=>{
  it('hides a folded group even though the row sets display:flex on it',()=>{
    expect(bodies("[aria-label='Score display'][hidden]").join(';')).toMatch(/display:none/);
  });
  it('lays the folded menu out as a popover below its button, wrapping its controls',()=>{
    const body=bodies('.score-display-host[data-compact]>').join(';');
    expect(body).toMatch(/position:fixed/);expect(body).toMatch(/z-index:40/);expect(body).toMatch(/flex-wrap:wrap/);expect(body).toMatch(/max-width:calc\(/);
  });
  it('gives the button a row-height box, and the open state the pressed colour',()=>{
    expect(bodies('.score-display-toggle').join(';')).toMatch(/min-height:28px/);expect(css).toMatch(/\.score-display-toggle\[aria-expanded=true\]/);
  });
  it('lets the button share the edit and view row in narrow windows instead of taking a row of its own',()=>{
    const narrow=css.slice(css.indexOf('[data-compact-height=true]'));
    expect(narrow).toMatch(/\[data-compact-height=true\][^{]*\.gp-toolbar\s*\{[^}]*grid-template-areas:'transport transport transport' 'left display right'/);
  });
  it('is switched by the app\'s own height test, the same one that folds the controls, so the two cannot disagree',()=>{
    expect(css).not.toMatch(/@media[^{]*max-height/);expect(compactWindowHeight).toBe(610);
    expect(readFileSync('src/App.tsx','utf8')).toMatch(/data-compact-height=\{compactHeight\}/);
  });
});

describe('where the display messages and the captions sit (THE-196)',()=>{
  it('keeps the page error visible below the host whether or not the menu is folded',()=>{
    expect(bodies('.score-display-messages>p:not(.muted)').join(';')).toMatch(/position:absolute/);
    expect(bodies('.score-display-messages>p.muted').join(';')).toMatch(/clip-path:inset\(50%\)/);
    expect(css).not.toMatch(/\[aria-label='Score display'\]>p/);
  });
  // Numbers read from the stylesheet, not measured: the transport box is min-height 48px with its groups centred; the groups are 28px (the control min-height).
  const num=(text:string,pattern:RegExp)=>Number(text.match(pattern)?.[1]);
  const caption=bodies(':is(.transport-loop,.transport-click,.transport-speed,.transport-key)>.transport-caption').join(';');
  const toolbarPaddingTop=num(exact('.gp-toolbar')[0],/padding:(\d+)px/);
  it('lies inside the transport box or, at most, in the toolbar padding above it: it paints over no other row and is not clipped',()=>{
    const transportHeight=num(exact('.app-shell .gp-toolbar .transport')[0],/min-height:(\d+)px/),groupHeight=28;
    const top=num(caption,/top:(-?\d+)px/),lineHeight=num(caption,/line-height:(\d+)px/);
    const boxTopInTransport=(transportHeight-groupHeight)/2+top,boxBottomInTransport=boxTopInTransport+lineHeight;
    expect(toolbarPaddingTop).toBe(2);expect(transportHeight).toBe(48);
    expect(boxTopInTransport).toBeGreaterThanOrEqual(-toolbarPaddingTop);
    expect(boxBottomInTransport).toBeLessThanOrEqual((transportHeight-groupHeight)/2);
  });
  it('is no smaller than the own caption size of the transport',()=>{
    const own=num(readFileSync('src/shell/transport.css','utf8').match(/\.transport-caption \{[^}]*\}/)![0],/font-size:(\d+)px/);
    expect(num(caption,/font-size:(\d+)px/)).toBeGreaterThanOrEqual(own);
  });
});

describe('after looking at the real window (THE-196)',()=>{
  const transport=readFileSync('src/shell/transport.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  it('sets the speed value and its percent sign on one row: the global label rule makes a label a column',()=>{
    const rule=[...transport.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].trim()==='.transport-speed-field').map(match=>match[2]).join(';');
    expect(rule).toMatch(/flex-direction:row/);
  });
  it('separates the tempo readout from the Speed caption',()=>{
    expect(bodies('.transport-speed>.transport-caption .transport-tempo').join(';')).toMatch(/margin-left:\d+px/);
  });
  it('keeps the opened menu inside the window: fixed, wrapping, never wider than the window, with its position set by the component',()=>{
    const body=bodies(".score-display-host[data-compact]>[aria-label='Score display']").join(';');
    expect(body).toMatch(/position:fixed/);expect(body).toMatch(/flex-wrap:wrap/);expect(body).toMatch(/max-width:calc\(100vw - 16px\)/);expect(body).not.toMatch(/position:absolute/);expect(body).not.toMatch(/left:0/);
  });
  it('has no selector that repeats the shell prefix, which would never match (a comment once split one in two)',()=>{
    expect(css).not.toMatch(/\.app-shell \.gp-toolbar\s+\.app-shell/);
  });
});

describe('the toolbar rows follow the measured widths (the Key group made the transport row 1003px wide)',()=>{
  // The numbers come from src/shell/toolbar-fit.ts, which holds the measured widths and the margin; these tests tie the stylesheet and the Key fold to them.
  const flat=css.replace(/\s+/g,' ');
  const areas={two:"'left transport right' 'display display display'",row:"'transport transport transport' 'left display right'"};
  const mediaBlock=(query:string)=>{const start=flat.indexOf(`@media (${query}) {`);expect(start,`no @media (${query})`).toBeGreaterThanOrEqual(0);let depth=0,end=start;for(let i=flat.indexOf('{',start);i<flat.length;i++){if(flat[i]==='{')depth++;if(flat[i]==='}'&&--depth===0){end=i;break;}}return flat.slice(start,end);};
  it('measures every width with a margin of at least 20px',()=>{
    expect(toolbarMeasured.margin).toBeGreaterThanOrEqual(20);
    for(const language of ['en','et','de'] as const){
      const fit=toolbarFit[language];
      expect(fit.transportRowBelow).toBeGreaterThanOrEqual(toolbarMeasured.twoRowKeyClean+toolbarMeasured.margin);
      expect(fit.singleRowFrom).toBeGreaterThanOrEqual(toolbarMeasured.singleRowClean[language]+toolbarMeasured.margin);
      expect(fit.keyInRowFrom).toBeGreaterThanOrEqual(toolbarMeasured.singleRowKeyClean[language]+toolbarMeasured.margin);
      expect(fit.keyInRowFrom).toBeGreaterThan(fit.singleRowFrom);
    }
  });
  it('gives the transport a row of its own below the width that holds the row with the Key group',()=>{
    const block=mediaBlock(`width < ${toolbarFit.en.transportRowBelow}px`);expect(block).toContain(areas.row);
    for(const language of ['et','de'] as const)expect(toolbarFit[language].transportRowBelow).toBe(toolbarFit.en.transportRowBelow);
  });
  it('keeps the display controls on a second row until the single row holds them, per language',()=>{
    expect(mediaBlock(`width < ${toolbarFit.en.singleRowFrom}px`)).toContain(areas.two);
    for(const language of ['et','de'] as const){
      const block=mediaBlock(`width >= ${toolbarFit.en.singleRowFrom}px) and (width < ${toolbarFit[language].singleRowFrom}px`);
      expect(block).toContain(`.app-shell:lang(${language}) .gp-toolbar {`);expect(block).toContain(areas.two);
    }
  });
  it('folds the Key group exactly where the single row does not hold it, in each language',()=>{
    for(const language of ['en','et','de'] as const){
      const { singleRowFrom,keyInRowFrom }=toolbarFit[language];
      expect(keyFoldQuery(language)).toBe(`(max-width: 1100px), (width >= ${singleRowFrom}px) and (width < ${keyInRowFrom}px)`);
      expect(keyInRowFrom).toBeGreaterThanOrEqual(singleRowFrom+1);
    }
    // At 1920 wide, the width most windows are maximised to, English has one row with the Key group in More playback.
    expect(toolbarFit.en.singleRowFrom).toBeLessThanOrEqual(1920);expect(toolbarFit.en.keyInRowFrom).toBeGreaterThan(1920);
  });
});
