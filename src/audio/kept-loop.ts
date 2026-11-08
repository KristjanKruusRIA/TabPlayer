import type {BarIndexMap} from '../editor/measures-types';
import type {PracticeLoop} from './practice-types';
import type {MeasureOccurrence} from './types';

/**
 * A running loop is kept across a rebuild of the playback plan by the bars it covers, not by ticks: an edit inside the bars moves their ticks, but the player still means the same bars. An edge names a bar, which pass of it (a repeat plays a bar more than once) and how far into that pass (0 is its start, 1 its end, so a whole-bar loop follows a bar that grows or shrinks).
 * `occurrence` is null for an edge that was trimmed onto a neighbouring bar; it only resolves where that bar plays once.
 */
export interface LoopEdge {bar:number;occurrence:number|null;ratio:number}
/** `barCount` is the score's number of bars the edges are numbered in, so a change of bars that was not mapped cannot silently move the loop. */
export interface KeptLoop {start:LoopEdge;end:LoopEdge;barCount:number}

/** The loop as bars, or null when its ticks do not sit on the plan. */
export function keptLoopOf(loop:PracticeLoop,occurrences:readonly MeasureOccurrence[],barCount:number):KeptLoop|null {
  const first=occurrences.find(o=>o.endTick>o.startTick&&loop.startTick>=o.startTick&&loop.startTick<o.endTick);
  const last=[...occurrences].reverse().find(o=>o.endTick>o.startTick&&loop.endTick>o.startTick&&loop.endTick<=o.endTick);
  if(!first||!last||loop.endTick<=loop.startTick)return null;
  const edge=(o:MeasureOccurrence,tick:number):LoopEdge=>({bar:o.bar,occurrence:o.occurrence,ratio:(tick-o.startTick)/(o.endTick-o.startTick)});
  return {start:edge(first,loop.startTick),end:edge(last,loop.endTick),barCount};
}

/** The loop's bars after an edit moved, inserted or removed bars; null when no bar of it is left. A removed edge bar trims the loop to the nearest bar that remains inside it. */
export function mapKeptLoop(kept:KeptLoop,map:BarIndexMap):KeptLoop|null {
  if(map.oldToNew.length!==kept.barCount)return null;
  const to=map.oldToNew;
  let start:LoopEdge|null=null,end:LoopEdge|null=null;
  const first=to[kept.start.bar],last=to[kept.end.bar];
  if(first!=null)start={...kept.start,bar:first};
  else for(let bar=kept.start.bar+1;bar<=kept.end.bar&&!start;bar++)if(to[bar]!=null)start={bar:to[bar]!,occurrence:null,ratio:0};
  if(last!=null)end={...kept.end,bar:last};
  else for(let bar=kept.end.bar-1;bar>=kept.start.bar&&!end;bar--)if(to[bar]!=null)end={bar:to[bar]!,occurrence:null,ratio:1};
  if(!start||!end||start.bar>end.bar||start.bar===end.bar&&start.ratio>=end.ratio)return null;
  return {start,end,barCount:to.filter(bar=>bar!==null).length+map.inserted.length};
}

/** The loop's ticks on a rebuilt plan, or null when it cannot be placed without guessing. */
export function resolveKeptLoop(kept:KeptLoop,occurrences:readonly MeasureOccurrence[],barCount:number):PracticeLoop|null {
  if(kept.barCount!==barCount)return null;
  const place=(edge:LoopEdge)=>{
    const passes=occurrences.filter(o=>o.bar===edge.bar);
    // The pass it was set on, or the bar's only pass when a repeat was edited away.
    const pass=(edge.occurrence===null?undefined:passes.find(o=>o.occurrence===edge.occurrence))??(passes.length===1?passes[0]:undefined);
    return pass&&pass.endTick>pass.startTick?Math.round(pass.startTick+(pass.endTick-pass.startTick)*edge.ratio):null;
  };
  const startTick=place(kept.start),endTick=place(kept.end);
  return startTick===null||endTick===null||endTick<=startTick?null:{startTick,endTick};
}
