// @vitest-environment jsdom
// Headless external-media oracle: real API/facade/renderer; synthetic DOM metrics and font availability only.
import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {act,cleanup,render} from '@testing-library/react';
import {ScoreView} from '../ScoreView';
import {readFileSync} from 'node:fs';
import {AlphaTabApi,LayoutMode,PlayerMode,Settings,SystemsLayoutMode,synth} from '@coderline/alphatab';
import {music} from '../editor/fixtures';
import {arrangeScreenPages,paginateScreenScore,type ScreenRenderChunk} from './screen-pages';
import {installScreenPlayback,type ScreenPlaybackContext} from './screen-playback';

// jsdom's sandbox global is not its Window instance; expose that browser identity before loading alphaTab.
vi.hoisted(()=>{Object.defineProperty(Window,Symbol.hasInstance,{configurable:true,value:(value:unknown)=>value===globalThis||value===window});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();});
it('headless actual API dispatch preserves current opaque groups and queued cursor through page publication',async()=>{
 const forbidden=vi.fn(()=>{throw new Error('Audio/device/native creation is forbidden in this headless oracle');});
 vi.stubGlobal('AudioContext',forbidden);vi.stubGlobal('webkitAudioContext',forbidden);vi.stubGlobal('Audio',forbidden);
 vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}unobserve(){}});
 Object.defineProperty(document,'fonts',{configurable:true,value:{check:()=>true,load:async()=>[],ready:Promise.resolve()}});
 vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(680);vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(500);
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({font:'',measureText:(text:string)=>({width:text.length*8,actualBoundingBoxLeft:0,actualBoundingBoxRight:text.length*8,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3})} as never);
 const queued:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{queued.push(callback);return queued.length;});vi.stubGlobal('cancelAnimationFrame',()=>{});
 const root=document.createElement('div');document.body.append(root);
 const settings=new Settings();settings.core.useWorkers=false;settings.core.engine='svg';settings.core.includeNoteBounds=true;settings.core.enableLazyLoading=false;settings.core.fontDirectory='/font/';settings.player.playerMode=PlayerMode.EnabledExternalMedia;settings.player.enableCursor=false;settings.player.enableUserInteraction=false;settings.display.layoutMode=LayoutMode.Parchment;settings.display.systemsLayoutMode=SystemsLayoutMode.UseModelLayout;settings.display.padding=[0,0,0,0];
 const api=new AlphaTabApi(root,settings),score=music();score.addTrack(music().tracks[0]);score.finish(settings);
 const context:ScreenPlaybackContext={renderedScore:score,wrapper:root,scrollHost:root,physical:null,barElement:document.createElement('span'),beatElement:document.createElement('span')};
 const adapter=installScreenPlayback(api,()=>context),chunks:ScreenRenderChunk[]=[];
 api.settings.player.enableCursor=true;api.updateSettings();
 api.renderStarted.on(()=>{chunks.length=0;adapter.renderStarted();});
 api.renderer.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string')chunks.push({id:e.id,x:e.x,y:e.y,width:e.width,height:e.height,firstMasterBarIndex:e.firstMasterBarIndex,lastMasterBarIndex:e.lastMasterBarIndex,svg:e.renderResult});});
 api.postRenderFinished.on(()=>adapter.renderCompleted());
 try{
  api.renderScore(score,[0,1]);for(let i=0;i<20;i++)await Promise.resolve();
  expect(api.boundsLookup?.staffSystems.length).toBeGreaterThan(0);expect(chunks.length).toBeGreaterThan(0);
  const output=api.player!.output as synth.IExternalMediaSynthOutput;
  output.handler={backingTrackDuration:100000,playbackRate:1,masterVolume:1,play:vi.fn(),pause:vi.fn(),seekTo:vi.fn()};
  const place=vi.spyOn(api.customCursorHandler!,'placeBarCursor'),transition=vi.spyOn(api.customCursorHandler!,'transitionBeatCursor');
  api.player!.play();output.updatePosition(250);for(let i=0;i<20;i++)await Promise.resolve();
  for(let pass=0;pass<5&&queued.length;pass++){const batch=queued.splice(0);for(const callback of batch)callback(performance.now());}
  expect(place).toHaveBeenCalled();expect(transition).toHaveBeenCalled();
  const sourceGroups=[...root.querySelectorAll('.at-highlight')].map(node=>node.getAttribute('class')!.replace(/\bat-highlight\b/g,'').trim());expect(sourceGroups.length).toBeGreaterThanOrEqual(2);
  const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document' as const},pagination=paginateScreenScore(chunks,api.boundsLookup!,page),roots=new Map<string,HTMLElement>();
  for(const chunk of chunks){const target=document.createElement('div');target.innerHTML=chunk.svg;roots.set(chunk.id,target);}
  context.physical={pagination,arrangement:arrangeScreenPages(pagination,'verticalPage',1,800),roots};adapter.presentationChanged();
  expect(context.beatElement!.hidden).toBe(false);
  for(const group of sourceGroups)expect([...roots.values()].some(node=>[...node.getElementsByClassName(group)].some(element=>element.classList.contains('at-highlight')))).toBe(true);
  // Queue an old generation's real cursor update, then complete a new public render before dispatching it.
  output.updatePosition(750);const stale=queued.splice(0);expect(stale.length).toBeGreaterThan(0);
  context.physical=null;api.render();
  const nextPagination=paginateScreenScore(chunks,api.boundsLookup!,page),nextRoots=new Map<string,HTMLElement>();
  for(const chunk of chunks){const target=document.createElement('div');target.innerHTML=chunk.svg;nextRoots.set(chunk.id,target);}
  context.physical={pagination:nextPagination,arrangement:arrangeScreenPages(nextPagination,'horizontalPage',1.375,800),roots:nextRoots};adapter.presentationChanged();
  for(const callback of stale)callback(performance.now());
  expect([...nextRoots.values()].flatMap(node=>[...node.querySelectorAll('.at-highlight')])).toHaveLength(0);expect(context.beatElement!.hidden).toBe(true);
  for(let pass=0;pass<5&&queued.length;pass++){const batch=queued.splice(0);for(const callback of batch)callback(performance.now());}
  expect(context.beatElement!.hidden).toBe(false);expect([...nextRoots.values()].flatMap(node=>[...node.querySelectorAll('.at-highlight')]).length).toBeGreaterThanOrEqual(2);
  expect(forbidden).not.toHaveBeenCalled();
 }finally{adapter.dispose();api.destroy();}
});

it.each(['manual','fitWidth'] as const)('headless real horizontal %s strip paints paper beyond its host width',async zoomMode=>{
 const forbidden=vi.fn(()=>{throw new Error('Audio/device creation is forbidden');});
 vi.stubGlobal('AudioContext',forbidden);vi.stubGlobal('webkitAudioContext',forbidden);vi.stubGlobal('Audio',forbidden);
 vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}unobserve(){}});
 Object.defineProperty(document,'fonts',{configurable:true,value:{check:()=>true,load:async()=>[],ready:Promise.resolve()}});
 vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return parseFloat(this.style.width)||480;});
 vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(600);
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(480);vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600);
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({font:'',measureText:(text:string)=>({width:text.length*8,actualBoundingBoxLeft:0,actualBoundingBoxRight:text.length*8,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3})} as never);
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
 const score=music();for(let i=0;i<36;i++){const extra=music();score.addMasterBar(extra.masterBars[0]);score.tracks[0].staves[0].addBar(extra.tracks[0].staves[0].bars[0]);}score.finish(new Settings());
 const style=document.createElement('style');// jsdom does not resolve CSS custom properties; substitute only the production paper token fallback.
 const paperCss=readFileSync('src/ScoreView.css','utf8').replaceAll('var(--ws-paper,#fffdf5)','#fffdf5');style.textContent=paperCss;document.head.append(style);
 const status=vi.fn();let result:ReturnType<typeof render>|undefined;
 try{
  await act(async()=>{result=render(createElement('div',{className:'paper-scroll'},createElement(ScoreView,{score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),display:{layout:'horizontalScreen',zoomMode},onDisplayStatus:status})));for(let i=0;i<30;i++)await Promise.resolve();});
  const live=result!.container.querySelector<HTMLElement>('.score-live-paper')!,canvas=live.querySelector<HTMLElement>('.at-surface')!;
  expect(parseFloat(live.style.width)).toBeGreaterThanOrEqual(480);expect(parseFloat(canvas.style.width)).toBeGreaterThan(480);
  expect(canvas.querySelectorAll('svg').length).toBeGreaterThan(0);
  expect(status).toHaveBeenLastCalledWith({zoomPercent:zoomMode==='manual'?100:50,fitLimited:zoomMode==='fitWidth',pageError:null});
  expect(getComputedStyle(canvas).backgroundColor).toBe(getComputedStyle(live).backgroundColor);
  expect(getComputedStyle(canvas).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(forbidden).not.toHaveBeenCalled();
 }finally{result?.unmount();style.remove();}
});
