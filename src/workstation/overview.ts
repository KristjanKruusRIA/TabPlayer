import type {model} from '@coderline/alphatab';

export type OverviewCell='empty'|'rest'|'music';
export interface ScoreOverviewModel {
  barCount:number;
  sections:readonly {bar:number;text:string}[];
  tracks:readonly {index:number;name:string;cells:readonly OverviewCell[]}[];
}
export function projectScoreOverview(score:model.Score):ScoreOverviewModel {
  const barCount=score.masterBars.length;
  return {
    barCount,
    sections:score.masterBars.flatMap((bar,index)=>bar.section?.text?[{bar:index,text:bar.section.text}]:[]),
    tracks:score.tracks.map(track=>({index:track.index,name:track.name,cells:Array.from({length:barCount},(_,bar)=>{
      const beats=track.staves.flatMap(staff=>staff.bars[bar]?.voices.flatMap(voice=>voice.beats.filter(beat=>!beat.isEmpty)) ?? []);
      return !beats.length?'empty':beats.every(beat=>beat.isRest)?'rest':'music';
    })})),
  };
}
export function overviewWindow(offset:number,extent:number,count:number,cellSize:number,overscan:number):{first:number;last:number} {
  return {first:Math.min(count,Math.max(0,Math.floor(offset/cellSize)-overscan)),last:Math.min(count,Math.max(0,Math.ceil((offset+extent)/cellSize)+overscan))};
}
