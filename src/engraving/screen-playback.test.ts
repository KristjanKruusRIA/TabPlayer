// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {AlphaTabApi,model,rendering} from '@coderline/alphatab';
import {music} from '../editor/fixtures';
import {installScreenPlayback,type ScreenPlaybackContext} from './screen-playback';

function fixture(){
 const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],bounds=new rendering.BeatBounds(),bar=new rendering.BarBounds(),master=new rendering.MasterBarBounds(),system=new rendering.StaffSystemBounds();
 bounds.beat=beat;bounds.realBounds=new rendering.Bounds(20,40,80,60);bounds.barBounds=bar;bar.beats=[bounds];bar.masterBarBounds=master;master.bars=[bar];master.visualBounds=new rendering.Bounds(10,30,200,100);master.staffSystemBounds=system;system.bars=[master];
 const source={setBounds:vi.fn(),transitionToX:vi.fn(),stopAnimation:vi.fn()},originalHighlight=vi.fn(),originalRemove=vi.fn();
 const facade=Object.create({highlightElements:originalHighlight,removeHighlights:originalRemove});facade.getOffset=()=>({x:0,y:0});
 const lookup={staffSystems:[system],findBeats:(b:model.Beat)=>b===beat?[bounds]:[]};
 const api={boundsLookup:lookup,uiFacade:facade} as unknown as AlphaTabApi;
 let context:ScreenPlaybackContext={renderedScore:score,wrapper:document.createElement('div'),scrollHost:document.createElement('div'),physical:null,barElement:document.createElement('div'),beatElement:document.createElement('div')};
 const adapter=installScreenPlayback(api,()=>context);adapter.renderCompleted();
 const mount=()=>{const root=document.createElement('div');root.innerHTML='<svg><g class="opaque-one"/><g class="opaque-two"/></svg>';context={...context,physical:{pagination:{paper:{width:300,height:400,left:10,top:10,right:10,bottom:10},pageCount:1,blocks:[{chunk:{id:'chunk',x:0,y:0,width:220,height:140,firstMasterBarIndex:0,lastMasterBarIndex:3,svg:''},system,page:0,sourceBounds:{x:0,y:0,w:220,h:140},x:10,y:10}]},arrangement:{scale:1.5,width:450,height:600,pages:[{index:0,x:0,y:0,width:450,height:600}]},roots:new Map([['chunk',root]])}};adapter.presentationChanged();return root;};
 return {api,adapter,bounds,source,context:()=>context,mount,originalHighlight,originalRemove,lookup};
}
afterEach(()=>vi.restoreAllMocks());
it('replays a paused exact mid-beat placement and simultaneous opaque groups after SVG mount',()=>{
 const f=fixture(),handler=f.api.customCursorHandler!;
 handler.placeBarCursor(f.source as never,f.bounds);handler.placeBeatCursor(f.source as never,f.bounds,63.5);
 f.api.uiFacade.removeHighlights();f.api.uiFacade.highlightElements('opaque-one',0);f.api.uiFacade.highlightElements('opaque-two',0);
 const root=f.mount();expect(f.context().beatElement!.style.left).toBe('110.25px');expect(root.querySelectorAll('.at-highlight')).toHaveLength(2);
 expect(f.originalHighlight.mock.instances).toEqual([f.api.uiFacade,f.api.uiFacade]);expect(f.originalHighlight.mock.calls).toEqual([['opaque-one',0],['opaque-two',0]]);
 f.adapter.dispose();expect(Object.hasOwn(f.api.uiFacade,'highlightElements')).toBe(false);expect(root.querySelectorAll('.at-highlight')).toHaveLength(0);
});
it('rejects stale queued callbacks and their opaque group gate across render generations',()=>{
 const f=fixture(),handler=f.api.customCursorHandler!,root=f.mount();handler.placeBarCursor(f.source as never,f.bounds);handler.placeBeatCursor(f.source as never,f.bounds,40);
 f.adapter.renderStarted();handler.placeBarCursor(f.source as never,f.bounds);f.api.uiFacade.highlightElements('opaque-one',0);expect(root.querySelectorAll('.at-highlight')).toHaveLength(0);
 f.lookup.findBeats=()=>[];f.adapter.renderCompleted();handler.transitionBeatCursor(f.source as never,f.bounds,40,80,1000,0);expect(f.context().beatElement!.hidden).toBe(true);
});
it('continues running visual motion from elapsed position and preserves source containers',()=>{
 const f=fixture(),handler=f.api.customCursorHandler!;let time=100;vi.spyOn(performance,'now').mockImplementation(()=>time);
 handler.placeBarCursor(f.source as never,f.bounds);handler.placeBeatCursor(f.source as never,f.bounds,20);handler.transitionBeatCursor(f.source as never,f.bounds,20,100,1000,0);
 expect(f.source.transitionToX).toHaveBeenLastCalledWith(1000,100);time=350;f.mount();expect(f.context().beatElement!.style.left).toBe('165px');expect(f.context().beatElement!.style.transition).toContain('750ms');
 f.adapter.renderStarted();expect(f.context().beatElement!.style.transition).toBe('none');f.adapter.dispose();
});
it('restores own descriptors but does not replace a later owner',()=>{
 const f=fixture(),later=vi.fn();f.api.uiFacade.highlightElements=later;f.adapter.dispose();expect(f.api.uiFacade.highlightElements).toBe(later);expect(f.api.customScrollHandler).toBeUndefined();
});

it('does not interrupt the live source animation on an ordinary same-system beat update',()=>{
 const f=fixture(),handler=f.api.customCursorHandler!;
 handler.placeBarCursor(f.source as never,f.bounds);handler.placeBeatCursor(f.source as never,f.bounds,20);
 handler.transitionBeatCursor(f.source as never,f.bounds,20,80,300,1);
 const next=new rendering.BeatBounds();next.beat=f.bounds.beat;next.barBounds=f.bounds.barBounds;f.lookup.findBeats=()=>[f.bounds,next];
 handler.placeBarCursor(f.source as never,next);handler.transitionBeatCursor(f.source as never,next,80,100,300,1);
 expect(f.source.stopAnimation).not.toHaveBeenCalled();expect(f.source.transitionToX).toHaveBeenLastCalledWith(600,120);
});
it('does not oscillate when a scroll target is taller than the host viewport',()=>{
 const f=fixture(),host=f.context().scrollHost!;Object.defineProperty(host,'clientHeight',{value:30});Object.defineProperty(host,'clientWidth',{value:300});
 vi.spyOn(f.context().wrapper!,'getBoundingClientRect').mockImplementation(()=>({left:-host.scrollLeft,top:-host.scrollTop} as DOMRect));
 f.mount();f.api.customScrollHandler!.forceScrollTo(f.bounds);const top=host.scrollTop;f.api.customScrollHandler!.forceScrollTo(f.bounds);expect(host.scrollTop).toBe(top);
 host.scrollTop=top+15;f.api.customScrollHandler!.forceScrollTo(f.bounds);expect(host.scrollTop).toBe(top+15);
});
