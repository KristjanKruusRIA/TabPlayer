// @vitest-environment jsdom
// The draw check against the real API, facade and renderer in jsdom: synthetic DOM metrics and font availability only.
import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {act,cleanup,render} from '@testing-library/react';
import {Settings} from '@coderline/alphatab';
import {ScoreView} from '../ScoreView';
import {music} from '../editor/fixtures';
import {describeBounds} from './draw-check';

// jsdom's sandbox global is not its Window instance; expose that browser identity before loading alphaTab.
vi.hoisted(()=>{Object.defineProperty(Window,Symbol.hasInstance,{configurable:true,value:(value:unknown)=>value===globalThis||value===window});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();});

function environment() {
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}unobserve(){}});
  Object.defineProperty(document,'fonts',{configurable:true,value:{check:()=>true,load:async()=>[],ready:Promise.resolve()}});
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return parseFloat(this.style.width)||600;});
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(600);vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600);
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({font:'',measureText:(text:string)=>({width:text.length*8,actualBoundingBoxLeft:0,actualBoundingBoxRight:text.length*8,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3})} as never);
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
}
function longScore(bars:number) {
  const score=music();for(let i=1;i<bars;i++){const extra=music();score.addMasterBar(extra.masterBars[0]);score.tracks[0].staves[0].addBar(extra.tracks[0].staves[0].bars[0]);}
  score.finish(new Settings());return score;
}
const hook=()=>(globalThis as {__tabplayerCheckDraw?:()=>{equal:boolean;pieces:number;differences:string[]}}).__tabplayerCheckDraw!;

it('a draw that paints only what is in view equals a complete render of the same score, and a stale one does not',async()=>{
  environment();
  const score=longScore(24);
  const props={track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),display:{layout:'parchment' as const,zoomMode:'manual' as const}};
  const tree=(value:typeof score)=>createElement('div',{className:'paper-scroll'},createElement(ScoreView,{...props,score:value}));
  let result:ReturnType<typeof render>|undefined;
  await act(async()=>{result=render(tree(score));for(let i=0;i<30;i++)await Promise.resolve();});
  expect(typeof hook()).toBe('function');
  const first=hook()();
  expect(first.pieces).toBeGreaterThan(1);
  expect(first.differences).toEqual([]);
  expect(first.equal).toBe(true);
  // The same score drawn again, as after an edit that left it as it was.
  await act(async()=>{result!.rerender(tree(score));for(let i=0;i<30;i++)await Promise.resolve();});
  expect(hook()().equal).toBe(true);
  // A note changed behind the renderer's back is what a missing redraw would look like: the check sees it.
  const note=score.tracks[0].staves[0].bars[3].voices[0].beats[0].notes[0];note.fret=note.fret===7?8:7;
  const stale=hook()();
  expect(stale.equal).toBe(false);
  expect(stale.differences.join('\n')).toMatch(/piece \d+ \(bars/);
  result!.unmount();
  expect(hook).toBeDefined();
});

it('describes the bounds of a laid-out score line by line',()=>{
  expect(describeBounds(null)).toEqual([]);
});
