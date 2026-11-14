import type { model } from '@coderline/alphatab';
import type { MessageKey } from '../i18n/types';
import type { BeatRange,MusicPoint } from './range-types';

/** The length in ticks of one written duration, with its dots: the step a range end moves by. */
export function gridTicks(duration:number,dots:number):number {
  const base=3840/(duration<0?1/-duration:duration);let ticks=base;for(let dot=1;dot<=dots;dot++)ticks+=base/2**dot;
  return Math.max(1,Math.round(ticks));
}

export type EdgeMove={range:BeatRange}|{refusal:MessageKey};

/**
 * Moves the END of a range by `steps` grid lengths (negative to shorten), counted in ticks across bars. The end stops at the end of the score and never reaches
 * the range start: a move that would is not made. A bar's last tick is written as the next bar's first, as every other range is. Free-time bars have no tick grid, so a range touching one is refused.
 */
export function moveRangeEnd(score:model.Score,range:BeatRange,grid:number,steps:number):EdgeMove {
  const bars=score.masterBars,last=bars.length-1;
  const lengths=bars.map(bar=>bar.calculateDuration(false)),starts:number[]=[];lengths.reduce((sum,length,index)=>{starts[index]=sum;return sum+length;},0);
  for(let bar=range.start.bar;bar<=Math.min(last,Math.max(range.end.bar,range.start.bar));bar++)if(bars[bar].isFreeTime)return {refusal:'editor.range_edge_free_time'};
  const absolute=(point:MusicPoint)=>starts[point.bar]+point.tick,total=starts[last]+lengths[last];
  let target=Math.min(total,absolute(range.end)+steps*grid);
  if(target<=absolute(range.start))return {range};
  let bar=0;while(bar<last&&target>=starts[bar+1])bar++;
  if(bars[bar].isFreeTime)return {refusal:'editor.range_edge_free_time'};
  const end:MusicPoint={bar,tick:target-starts[bar]};
  return {range:{...range,start:{...range.start},lanes:range.lanes.map(lane=>({...lane})),end}};
}

const beatNumber=(score:model.Score,point:MusicPoint)=>{
  const unit=3840/(score.masterBars[point.bar]?.timeSignatureDenominator||4),value=point.tick/unit+1;
  return String(Math.round(value*100)/100);
};
/** A range in the words a player counts in: measure and beat, with a fraction where the edge falls between beats. */
export function rangeExtent(score:model.Score,range:BeatRange):{startBar:number;startBeat:string;endBar:number;endBeat:string} {
  return {startBar:range.start.bar+1,startBeat:beatNumber(score,range.start),endBar:range.end.bar+1,endBeat:beatNumber(score,range.end)};
}
