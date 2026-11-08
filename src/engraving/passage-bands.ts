import type {model} from '@coderline/alphatab';
import type {ScreenBounds,ScreenSystem} from './screen-pages';

/** One bar of a passage. `from` is the first beat of the bar the passage includes and `to` the last; left out, the passage takes the bar's own edge. */
export interface PassageBar {bar:number;from?:model.Beat|null;to?:model.Beat|null}
/** A band of one system, in the renderer's own coordinates: map it with the same function as every other overlay (live offset, or the page layout's mapScreenRect with `system`). */
export interface PassageBand {system:ScreenSystem;x:number;y:number;w:number;h:number;firstBar:number;lastBar:number}

/**
 * The bands that shade a passage: one per system it touches, and one per run of neighbouring bars, so a passage across a line break is drawn twice and a loop that skips bars is not drawn over the bars it skips.
 * The edges follow the renderer's own selection: a beat opening its bar starts at the bar's edge, one closing its bar ends at the bar's edge, and a beat in between at its own edge. Bars the renderer did not place (a multi-bar rest closes over them) are left out.
 */
export function passageBands(lookup:ScreenBounds,bars:readonly PassageBar[]):PassageBand[] {
  const wanted=new Map<number,PassageBar>();
  for(const bar of bars)wanted.set(bar.bar,{...wanted.get(bar.bar),...bar});
  const bands:PassageBand[]=[];
  let open:{band:PassageBand;bottom:number}|null=null;
  for(const bar of [...wanted.values()].sort((a,b)=>a.bar-b.bar)){
    const master=lookup.findMasterBarByIndex(bar.bar),system=master?.staffSystemBounds;
    if(!master||!system){open=null;continue;}
    const beatBox=(beat:model.Beat|null|undefined)=>beat?lookup.findBeats(beat)?.find(bounds=>bounds.beat===beat)?.realBounds:undefined;
    const startBox=beatBox(bar.from),endBox=beatBox(bar.to);
    let left=master.realBounds.x,right=master.realBounds.x+master.realBounds.w;
    if(bar.from&&startBox&&bar.from.index>0)left=startBox.x;
    if(bar.to&&endBox&&bar.to.index<bar.to.voice.beats.length-1)right=endBox.x+endBox.w;
    if(!(right>left)||![left,right,master.visualBounds.y,master.visualBounds.h].every(Number.isFinite)){open=null;continue;}
    const top=master.visualBounds.y,bottom=top+master.visualBounds.h;
    if(open&&open.band.system===system&&open.band.lastBar+1===bar.bar){
      const joined=open.band;joined.w=right-joined.x;joined.lastBar=bar.bar;joined.y=Math.min(joined.y,top);open.bottom=Math.max(open.bottom,bottom);joined.h=open.bottom-joined.y;
    }else{
      const band:PassageBand={system,x:left,y:top,w:right-left,h:bottom-top,firstBar:bar.bar,lastBar:bar.bar};
      bands.push(band);open={band,bottom};
    }
  }
  return bands;
}
