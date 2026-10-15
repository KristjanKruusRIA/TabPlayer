import type {BackingSettings} from '../edit-types';
import type {BackingGridLine,BackingScoreSelection,BackingTimeline} from './backing-waveform-types';

type BackingMapSettings=Pick<BackingSettings,'offsetMs'|'anchors'>;
function finite(value:number):number {
  if(!Number.isFinite(value))throw new Error('Backing timing must be finite.');
  return value;
}
function nonnegative(value:number):boolean {return Number.isFinite(value)&&value>=0;}
function indexValue(value:number):boolean {return Number.isSafeInteger(value)&&value>=0;}

function tempoTimeline(timeline:BackingTimeline):(tick:number)=>number {
  const invalid=()=>new Error('Invalid backing score timeline.');
  if(!nonnegative(timeline.durationTick)||timeline.tempos[0]?.tick!==0)throw invalid();
  let previousTick=-1,previousSeconds=0,previousRate=0;
  const segments=timeline.tempos.map(tempo=>{
    const rate=60/(tempo.bpm*960);
    if(!nonnegative(tempo.tick)||tempo.tick<=previousTick||tempo.tick>timeline.durationTick||!Number.isFinite(tempo.bpm)||tempo.bpm<=0||!Number.isFinite(rate)||rate<=0)throw invalid();
    const seconds=previousTick<0?0:previousSeconds+(tempo.tick-previousTick)*previousRate;
    if(!nonnegative(seconds))throw invalid();
    previousTick=tempo.tick;previousSeconds=seconds;previousRate=rate;
    return {tick:tempo.tick,seconds,rate};
  });
  const tickToMs=(tick:number)=>{
    tick=Math.max(0,finite(tick));
    let low=0,high=segments.length;
    while(low<high){const middle=(low+high)>>>1;if(segments[middle].tick<=tick)low=middle+1;else high=middle;}
    const segment=segments[Math.max(0,low-1)];
    return finite((segment.seconds+(tick-segment.tick)*segment.rate)*1000);
  };
  let previousEnd=0;
  const counts=new Map<number,number>();
  for(const occurrence of timeline.occurrences) {
    const {bar,startTick,endTick,meterNumerator,meterDenominator}=occurrence;
    if(!indexValue(bar)||occurrence.occurrence!==(counts.get(bar)??0)||!indexValue(meterNumerator)||meterNumerator===0||![1,2,4,8,16,32,64,128,256].includes(meterDenominator)||!nonnegative(startTick)||startTick<previousEnd||!nonnegative(endTick)||endTick<=startTick||endTick>timeline.durationTick)throw invalid();
    if(!nonnegative(occurrence.startMs)||!nonnegative(occurrence.endMs)||occurrence.endMs<=occurrence.startMs||Math.abs(tickToMs(startTick)-occurrence.startMs)>0.01||Math.abs(tickToMs(endTick)-occurrence.endMs)>0.01)throw invalid();
    if(occurrence.clickTicks!==undefined) {
      if(occurrence.clickTicks[0]!==startTick||occurrence.clickTicks.some((tick,index)=>!Number.isFinite(tick)||tick<startTick||tick>=endTick||(index>0&&tick<=occurrence.clickTicks![index-1])))throw invalid();
    }
    counts.set(bar,occurrence.occurrence+1);previousEnd=endTick;
  }
  return tickToMs;
}

function projection(timeline:BackingTimeline,backing:BackingMapSettings) {
  const tickToMs=tempoTimeline(timeline);
  finite(backing.offsetMs);
  const points=backing.anchors.map(anchor=>{
    if(!indexValue(anchor.bar)||!indexValue(anchor.occurrence)||!nonnegative(anchor.ratio)||anchor.ratio>1||!nonnegative(anchor.audioMs))throw new Error('Invalid backing synchronization anchor.');
    const occurrence=timeline.occurrences.find(value=>value.bar===anchor.bar&&value.occurrence===anchor.occurrence);
    if(!occurrence)throw new Error('Backing anchor refers to missing score music.');
    return {scoreMs:tickToMs(occurrence.startTick+(occurrence.endTick-occurrence.startTick)*anchor.ratio),audioMs:anchor.audioMs};
  }).sort((a,b)=>a.scoreMs-b.scoreMs);
  if(points.some((point,index)=>index>0&&(point.scoreMs<=points[index-1].scoreMs||point.audioMs<=points[index-1].audioMs)))throw new Error('Backing anchors must have distinct score positions and increasing audio times in playback order.');
  const sourceAtMs=(scoreMs:number)=>{
    finite(scoreMs);
    let audioMs=scoreMs;
    if(points.length===1)audioMs=scoreMs-points[0].scoreMs+points[0].audioMs;
    else if(points.length>1) {
      let low=0,high=points.length;
      while(low<high){const middle=(low+high)>>>1;if(points[middle].scoreMs<=scoreMs)low=middle+1;else high=middle;}
      const index=Math.max(0,Math.min(low-1,points.length-2)),a=points[index],b=points[index+1];
      audioMs=a.audioMs+(scoreMs-a.scoreMs)*(b.audioMs-a.audioMs)/(b.scoreMs-a.scoreMs);
    }
    return finite(audioMs-backing.offsetMs);
  };
  return {sourceAtMs,sourceAtTick:(tick:number)=>sourceAtMs(tickToMs(tick))};
}

export function scoreTimeToAudioMs(timeline:BackingTimeline,backing:BackingMapSettings,scoreTimeMs:number):number {
  return projection(timeline,backing).sourceAtMs(scoreTimeMs);
}
export function scoreTickToAudioMs(timeline:BackingTimeline,backing:BackingMapSettings,tick:number):number {
  return projection(timeline,backing).sourceAtTick(tick);
}
export function projectBackingGrid(timeline:BackingTimeline,backing:BackingMapSettings,startMs:number,endMs:number):BackingGridLine[] {
  if(finite(startMs)>finite(endMs))throw new Error('Invalid backing source window.');
  const {sourceAtTick}=projection(timeline,backing),lines:BackingGridLine[]=[];
  const rounding=8*Number.EPSILON*Math.max(1,Math.abs(startMs),Math.abs(endMs));
  const minimum=startMs-rounding,maximum=endMs+rounding;
  for(const occurrence of timeline.occurrences) {
    const {bar,startTick,endTick}=occurrence;
    if(sourceAtTick(endTick)<minimum||sourceAtTick(startTick)>maximum)continue;
    const append=(tick:number)=>{
      if(tick>=endTick)return;
      const audioMs=sourceAtTick(tick);
      if(audioMs>=minimum&&audioMs<=maximum)lines.push({key:`${bar}:${occurrence.occurrence}:${tick}`,bar,occurrence:occurrence.occurrence,ratio:(tick-startTick)/(endTick-startTick),tick,audioMs,kind:tick===startTick?'bar':'beat'});
    };
    if(occurrence.clickTicks!==undefined)for(const tick of occurrence.clickTicks)append(tick);
    else {
      const step=3840/occurrence.meterDenominator;
      const count=Math.ceil((endTick-startTick)/step);
      if(!Number.isSafeInteger(count))throw new Error('Backing grid pulse count is not representable.');
      const bound=(value:number,inclusive:boolean)=>{
        let low=0,high=count;
        while(low<high) {
          const middle=low+Math.floor((high-low)/2),audioMs=sourceAtTick(startTick+middle*step);
          if(inclusive?audioMs<=value:audioMs<value)low=middle+1;else high=middle;
        }
        return low;
      };
      const first=bound(minimum,false),last=bound(maximum,true);
      for(let index=first;index<last;index++)append(startTick+index*step);
    }
  }
  return lines;
}
export function projectBackingSelection(timeline:BackingTimeline,backing:BackingMapSettings,selection:BackingScoreSelection):{points:number[];spans:{startMs:number;endMs:number}[]} {
  const {sourceAtTick}=projection(timeline,backing);
  const sourceAtSelectionTick=(tick:number)=>{
    if(!nonnegative(tick)||tick>timeline.durationTick)throw new Error('Invalid backing score selection.');
    return sourceAtTick(tick);
  };
  return {
    points:selection.points.map(point=>sourceAtSelectionTick(point.tick)),
    spans:selection.spans.map(span=>{
      if(span.endTick<=span.startTick)throw new Error('Invalid backing score selection.');
      return {startMs:sourceAtSelectionTick(span.startTick),endMs:sourceAtSelectionTick(span.endTick)};
    }),
  };
}
export function moveBackingAnchor(backing:BackingSettings,index:number,sourceMs:number,timeline:BackingTimeline,durationMs:number):BackingSettings {
  if(!indexValue(index)||index>=backing.anchors.length||!nonnegative(durationMs)||!nonnegative(sourceMs)||sourceMs>durationMs)throw new Error('Backing anchor must stay within the source audio.');
  const audioMs=finite(sourceMs+backing.offsetMs);
  if(audioMs<0)throw new Error('Backing synchronization audio time must be nonnegative.');
  const candidate={...backing,mix:{...backing.mix},anchors:backing.anchors.map((anchor,anchorIndex)=>({...anchor,audioMs:anchorIndex===index?audioMs:anchor.audioMs}))};
  projection(timeline,candidate);
  return candidate;
}
