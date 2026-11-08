import type {model} from '@coderline/alphatab';
import type {ScreenBounds,ScreenSystem} from './screen-pages';

/** One bar of a passage. `from` is the first beat of the bar the passage includes and `to` the last; left out, the passage takes the bar's own edge. */
export interface PassageBar {bar:number;from?:model.Beat|null;to?:model.Beat|null}
/** A band of one system, in the renderer's own coordinates: map it with the same function as every other overlay (live offset, or the page layout's mapScreenRect with `system`). */
export interface PassageBand {
  system:ScreenSystem;x:number;y:number;w:number;h:number;firstBar:number;lastBar:number;
  /** The passage goes on from the previous line into this band's left edge, or on from its right edge to the next line, so a drawing leaves that side open instead of ending it. */
  continuesBefore:boolean;continuesAfter:boolean;
}

/**
 * The bands that shade a passage: one per system it touches, and one per run of neighbouring bars, so a passage across a line break is drawn twice and a loop that skips bars is not drawn over the bars it skips.
 * A bar that ends the passage inside it (`to`) or begins it inside (`from`) is not joined to its neighbour, whose own edge would otherwise swallow it.
 * The edges follow the renderer's own selection: a beat opening its bar starts at the bar's edge, one closing its bar ends at the bar's edge, and a beat in between at its own edge. Bars the renderer did not place (a multi-bar rest closes over them) are left out.
 */
export function passageBands(lookup:ScreenBounds,bars:readonly PassageBar[]):PassageBand[] {
  const wanted=new Map<number,PassageBar>();
  for(const bar of bars)wanted.set(bar.bar,{...wanted.get(bar.bar),...bar});
  const bands:PassageBand[]=[];
  let open:{band:PassageBand;bottom:number;innerEnd:boolean}|null=null;
  for(const bar of [...wanted.values()].sort((a,b)=>a.bar-b.bar)){
    const master=lookup.findMasterBarByIndex(bar.bar),system=master?.staffSystemBounds;
    if(!master||!system){open=null;continue;}
    const beatBox=(beat:model.Beat|null|undefined)=>beat?lookup.findBeats(beat)?.find(bounds=>bounds.beat===beat)?.realBounds:undefined;
    const startBox=beatBox(bar.from),endBox=beatBox(bar.to);
    let left=master.realBounds.x,right=master.realBounds.x+master.realBounds.w,innerStart=false,innerEnd=false;
    if(bar.from&&startBox&&bar.from.index>0){left=startBox.x;innerStart=true;}
    if(bar.to&&endBox&&bar.to.index<bar.to.voice.beats.length-1){right=endBox.x+endBox.w;innerEnd=true;}
    if(!(right>left)||![left,right,master.visualBounds.y,master.visualBounds.h].every(Number.isFinite)){open=null;continue;}
    const top=master.visualBounds.y,bottom=top+master.visualBounds.h;
    if(open&&!open.innerEnd&&!innerStart&&open.band.system===system&&open.band.lastBar+1===bar.bar){
      const joined=open.band;joined.w=right-joined.x;joined.lastBar=bar.bar;joined.y=Math.min(joined.y,top);open.bottom=Math.max(open.bottom,bottom);joined.h=open.bottom-joined.y;open.innerEnd=innerEnd;
    }else{
      const band:PassageBand={system,x:left,y:top,w:right-left,h:bottom-top,firstBar:bar.bar,lastBar:bar.bar,continuesBefore:false,continuesAfter:false};
      bands.push(band);open={band,bottom,innerEnd};
    }
  }
  // A band continues across a line break where the neighbouring bar is part of the passage, sits on another system, and the passage does not stop short inside this bar.
  const systemOf=(bar:number)=>lookup.findMasterBarByIndex(bar)?.staffSystemBounds??null;
  const insideStart=(bar:number)=>{const entry=wanted.get(bar);return !!entry?.from&&entry.from.index>0;};
  const insideEnd=(bar:number)=>{const entry=wanted.get(bar);return !!entry?.to&&entry.to.index<entry.to.voice.beats.length-1;};
  for(const band of bands){
    const before=band.firstBar-1,after=band.lastBar+1;
    band.continuesBefore=wanted.has(before)&&!insideStart(band.firstBar)&&!insideEnd(before)&&systemOf(before)!==null&&systemOf(before)!==band.system;
    band.continuesAfter=wanted.has(after)&&!insideEnd(band.lastBar)&&!insideStart(after)&&systemOf(after)!==null&&systemOf(after)!==band.system;
  }
  return bands;
}
