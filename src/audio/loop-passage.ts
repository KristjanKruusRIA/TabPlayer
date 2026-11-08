import type {PracticeLoop} from './practice-types';
import type {MeasureOccurrence} from './types';

/** One bar the loop plays. `from` and `to` are ticks into the bar (its first pass and its last), `length` the bar's own length, so `from===0&&to===length` is a whole bar. */
export interface LoopBar {bar:number;from:number;to:number;length:number}
/** The bars a running loop covers, however many times a repeat plays them. Drawing, the overview and the position display all read this one shape. */
export interface LoopPassage {first:number;last:number;bars:LoopBar[]}

/** The bars the loop covers, or null when it does not sit on the plan. A bar played several times (a repeat) is one entry, spanning the most of it any pass plays. */
export function loopPassage(loop:PracticeLoop|null,occurrences:readonly MeasureOccurrence[]):LoopPassage|null {
  if(!loop||loop.endTick<=loop.startTick)return null;
  const bars=new Map<number,LoopBar>();
  for(const o of occurrences){
    if(o.endTick<=o.startTick||o.startTick>=loop.endTick||o.endTick<=loop.startTick)continue;
    const from=Math.max(loop.startTick,o.startTick)-o.startTick,to=Math.min(loop.endTick,o.endTick)-o.startTick,known=bars.get(o.bar);
    bars.set(o.bar,known?{bar:o.bar,from:Math.min(known.from,from),to:Math.max(known.to,to),length:Math.max(known.length,o.endTick-o.startTick)}:{bar:o.bar,from,to,length:o.endTick-o.startTick});
  }
  const list=[...bars.values()].sort((a,b)=>a.bar-b.bar);
  return list.length?{first:list[0].bar,last:list[list.length-1].bar,bars:list}:null;
}

/** Runs of neighbouring bars (zero-based, inclusive), such as a loop that covers bars 2 to 4 and 7. */
export function loopRunsOf(passage:LoopPassage):{first:number;last:number}[] {
  const runs:{first:number;last:number}[]=[];
  for(const {bar} of passage.bars){const run=runs[runs.length-1];if(run&&run.last+1===bar)run.last=bar;else runs.push({first:bar,last:bar});}
  return runs;
}

/** The loop's first and last bar as the player counts them, from 1. */
export function loopText(passage:LoopPassage):{first:number;last:number} {
  return {first:passage.first+1,last:passage.last+1};
}

/** Where the loop lies along the piece's own clock, as fractions of its length (0 to 1), or null when it cannot be placed. The position display draws it under the progress line. */
export function loopFractions(loop:PracticeLoop|null,occurrences:readonly MeasureOccurrence[]):{from:number;to:number}|null {
  if(!loop||loop.endTick<=loop.startTick||!occurrences.length)return null;
  const total=occurrences[occurrences.length-1].endMs;if(!(total>0))return null;
  const at=(tick:number):number|null=>{
    const o=occurrences.find(candidate=>candidate.endTick>candidate.startTick&&tick>=candidate.startTick&&tick<=candidate.endTick);
    return o?(o.startMs+(tick-o.startTick)/(o.endTick-o.startTick)*(o.endMs-o.startMs))/total:null;
  };
  const from=at(loop.startTick),to=at(loop.endTick);
  return from===null||to===null||to<=from?null:{from:Math.max(0,from),to:Math.min(1,to)};
}
