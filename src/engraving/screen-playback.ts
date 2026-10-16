import type {AlphaTabApi,model} from '@coderline/alphatab';
import {mapScreenRect,type ScreenPagination,type ScreenPageArrangement,type ScreenRect,type ScreenBounds} from './screen-pages';
export type ScreenPlaybackContext={renderedScore:model.Score;wrapper:HTMLElement|null;scrollHost:HTMLElement|null;physical:{pagination:ScreenPagination;arrangement:ScreenPageArrangement;roots:ReadonlyMap<string,HTMLElement>}|null;barElement:HTMLElement|null;beatElement:HTMLElement|null};
type CursorHandler=NonNullable<AlphaTabApi['customCursorHandler']>;
type BeatBounds=Parameters<CursorHandler['placeBeatCursor']>[1];
type Container=Parameters<CursorHandler['placeBeatCursor']>[0];

export function installScreenPlayback(api:AlphaTabApi,getContext:()=>ScreenPlaybackContext){
 let active=true,completed:ScreenBounds|null=null,gate:BeatBounds|null=null;
 let bar:BeatBounds|null=null,beat:{bounds:BeatBounds;x:number;end:number;duration:number;at:number}|null=null;
 let sourceBar:Container|null=null,sourceBeat:Container|null=null;
 const groups=new Map<string,number>(),touched=new Set<Element>(),facade=api.uiFacade;
 const highlight=facade.highlightElements,remove=facade.removeHighlights;
 const highlightDescriptor=Object.getOwnPropertyDescriptor(facade,'highlightElements'),removeDescriptor=Object.getOwnPropertyDescriptor(facade,'removeHighlights');
 const valid=(bounds:BeatBounds)=>active&&completed!==null&&completed===api.boundsLookup&&bounds.beat.voice.bar.staff.track.score===getContext().renderedScore&&completed.findBeats(bounds.beat)?.includes(bounds)===true;
 const clearNodes=()=>{for(const node of touched)node.classList.remove('at-highlight');touched.clear();};
 const hide=()=>{const c=getContext();for(const element of [c.barElement,c.beatElement])if(element){element.style.transition='none';element.hidden=true;}};
 const map=(bounds:BeatBounds,rect:ScreenRect)=>{const c=getContext(),system=bounds.barBounds.masterBarBounds.staffSystemBounds;return c.physical&&system?mapScreenRect(c.physical.pagination,c.physical.arrangement,system,rect):null;};
 const place=(element:HTMLElement|null,rect:ScreenRect|null)=>{if(!element)return;element.style.transition='none';element.hidden=!rect;if(rect)Object.assign(element.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.w}px`,height:`${rect.h}px`});};
 const paint=()=>{
  const c=getContext();
  if(!bar||!valid(bar)||!c.physical){hide();return;}
  place(c.barElement,map(bar,bar.barBounds.masterBarBounds.visualBounds));
  if(!beat||!valid(beat.bounds)){place(c.beatElement,null);return;}
  const rect=beat.bounds.barBounds.masterBarBounds.visualBounds,elapsed=Math.max(0,performance.now()-beat.at),fraction=beat.duration?Math.min(1,elapsed/beat.duration):0;
  const x=beat.x+(beat.end-beat.x)*fraction,start=map(beat.bounds,{x,y:rect.y,w:1,h:rect.h});
  place(c.beatElement,start);
  if(start&&c.beatElement&&beat.duration>elapsed){
   // Flush only at publication/callback: continue the API's visual interval, never start a clock.
   void c.beatElement.offsetWidth;
   const end=map(beat.bounds,{x:beat.end,y:rect.y,w:1,h:rect.h});
   if(end){c.beatElement.style.transition=`left ${beat.duration-elapsed}ms linear`;c.beatElement.style.left=`${end.x}px`;}
  }
 };
 const mirror=()=>{
  clearNodes();const c=getContext();if(!active||!c.physical)return;
  for(const [id,index]of groups)for(const block of c.physical.pagination.blocks){
   if(index<block.chunk.firstMasterBarIndex||index>block.chunk.lastMasterBarIndex)continue;
   const root=c.physical.roots.get(block.chunk.id);if(!root)continue;
   for(const node of root.getElementsByClassName(id)){node.classList.add('at-highlight');touched.add(node);}
  }
 };
 function highlightWrapper(this:typeof facade,...args:Parameters<typeof highlight>){
  const result=highlight.apply(this,args);
  if(gate&&valid(gate)){groups.set(args[0],args[1]);mirror();}return result;
 }
 function removeWrapper(this:typeof facade,...args:Parameters<typeof remove>){
  const result=remove.apply(this,args);if(gate&&valid(gate)){groups.clear();clearNodes();}return result;
 }
 facade.highlightElements=highlightWrapper;facade.removeHighlights=removeWrapper;
 const cursor:CursorHandler={
  onAttach(){},onDetach(){sourceBar=null;sourceBeat=null;hide();},
  placeBarCursor(container,bounds){
   gate=valid(bounds)?bounds:null;if(!gate)return;
   if(bar!==bounds){beat=null;if(bar&&bar.barBounds.masterBarBounds.staffSystemBounds!==bounds.barBounds.masterBarBounds.staffSystemBounds)sourceBeat?.stopAnimation();}bar=bounds;sourceBar=container;
   const rect=bounds.barBounds.masterBarBounds.visualBounds;container.setBounds(rect.x,rect.y,rect.w,rect.h);paint();
  },
  placeBeatCursor(container,bounds,x){
   if(!valid(bounds)||gate!==bounds)return;sourceBeat=container;
   const rect=bounds.barBounds.masterBarBounds.visualBounds;container.transitionToX(0,x);container.setBounds(x,rect.y,1,rect.h);
   beat={bounds,x,end:x,duration:0,at:performance.now()};paint();
  },
  transitionBeatCursor(container,bounds,x,end,duration,mode){
   if(!valid(bounds)||gate!==bounds||bar!==bounds)return;sourceBeat=container;
   // Match the public source container's next-beat overscan, while the page cursor stays inside its system.
   const factor=mode===1?2:1;container.transitionToX(duration*factor,x+(end-x)*factor);
   beat={bounds,x,end,duration,at:performance.now()};paint();
  }
 };
 const reveal=(bounds:BeatBounds)=>{
  if(!valid(bounds))return;const c=getContext(),host=c.scrollHost;if(!host||!c.wrapper)return;
  const source=bounds.barBounds.masterBarBounds.visualBounds;
  let rect=map(bounds,source);
  if(!c.physical){const canvas=facade.getOffset(null,api.canvasElement),wrapper=c.wrapper.getBoundingClientRect();rect={...source,x:source.x+canvas.x-wrapper.left-window.scrollX,y:source.y+canvas.y-wrapper.top-window.scrollY};}
  if(!rect)return;
  const outer=host.getBoundingClientRect(),inner=c.wrapper.getBoundingClientRect();
  const x=rect.x+inner.left-outer.left-host.clientLeft+host.scrollLeft,y=rect.y+inner.top-outer.top-host.clientTop+host.scrollTop;
  const scroll=(start:number,size:number,current:number,viewport:number)=>size>viewport?(current<start||current>start+size-viewport?start:current):start<current?start:start+size>current+viewport?start+size-viewport:current;
  host.scrollLeft=scroll(x,rect.w,host.scrollLeft,host.clientWidth);host.scrollTop=scroll(y,rect.h,host.scrollTop,host.clientHeight);
 };
 const scroll:NonNullable<AlphaTabApi['customScrollHandler']>={forceScrollTo:reveal,onBeatCursorUpdating:reveal,[Symbol.dispose](){}};
 api.customCursorHandler=cursor;api.customScrollHandler=scroll;
 return {
  renderStarted(){completed=null;gate=null;bar=null;beat=null;groups.clear();clearNodes();sourceBeat?.stopAnimation();sourceBar?.stopAnimation();hide();},
  renderCompleted(){if(active)completed=api.boundsLookup??null;},
  presentationChanged(){paint();mirror();},
  dispose(){if(!active)return;active=false;completed=null;gate=null;bar=null;beat=null;groups.clear();clearNodes();hide();sourceBeat?.stopAnimation();sourceBar=null;sourceBeat=null;
   if(api.customCursorHandler===cursor)api.customCursorHandler=undefined;if(api.customScrollHandler===scroll)api.customScrollHandler=undefined;
   if(facade.highlightElements===highlightWrapper){if(highlightDescriptor)Object.defineProperty(facade,'highlightElements',highlightDescriptor);else Reflect.deleteProperty(facade,'highlightElements');}
   if(facade.removeHighlights===removeWrapper){if(removeDescriptor)Object.defineProperty(facade,'removeHighlights',removeDescriptor);else Reflect.deleteProperty(facade,'removeHighlights');}
  }
 };
}
