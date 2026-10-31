import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { MusicPoint,MusicSelection,VoiceAddress } from '../editor/range-types';
import { validateMusicSelection } from '../editor/range-selection';
import { validatePlaybackPlan } from './plan';
import type { MeasureOccurrence,PlaybackPlan } from './types';
import type { CursorPlaybackChoice,PassagePlaybackChoice,PerformedBeat } from './selection-playback-types';

const index=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const keys=['track','staff','bar','voice','beat'] as const;
function fields(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid selected playback fields.');
}
const sameTarget=(a:BeatTarget,b:BeatTarget)=>keys.every(key=>a[key]===b[key]);
const sameLane=(a:VoiceAddress,b:VoiceAddress)=>a.track===b.track&&a.staff===b.staff&&a.voice===b.voice;
function masterAt(score:model.Score,bar:number) {
  if(!index(bar)||!score.masterBars[bar])throw new Error('Select an existing measure.');return score.masterBars[bar];
}
function voiceAt(score:model.Score,lane:VoiceAddress,bar:number) {
  masterAt(score,bar);
  if(!index(lane.track)||!index(lane.staff)||!index(lane.voice)||lane.voice>=4)throw new Error('Select an existing voice lane.');
  const voice=score.tracks[lane.track]?.staves[lane.staff]?.bars[bar]?.voices[lane.voice];
  if(!voice)throw new Error('Select an existing staff and voice throughout every addressed measure.');return voice;
}
function beatAt(score:model.Score,target:BeatTarget) {
  fields(target,keys);if(!Object.values(target).every(index))throw new Error('Invalid beat address.');
  const beat=voiceAt(score,target,target.bar).beats[target.beat];if(!beat)throw new Error('Select an existing beat.');return beat;
}
function preparedRows(score:model.Score,plan:PlaybackPlan):PerformedBeat[] {
  if(!(score instanceof model.Score))throw new Error('Select an existing score.');
  validatePlaybackPlan(plan);
  if(!Object.hasOwn(plan,'performedBeats'))throw new Error('Selected playback is unavailable for this prepared score.');
  for(const occurrence of plan.occurrences)masterAt(score,occurrence.bar);
  for(const row of plan.performedBeats!)beatAt(score,row.target);
  return plan.performedBeats!;
}
function rowsIn(rows:ReadonlyMap<string,PerformedBeat[]>,occurrence:MeasureOccurrence) {
  return rows.get(`${occurrence.bar}/${occurrence.occurrence}`)??[];
}
export function cursorPlaybackChoices(score:model.Score,plan:PlaybackPlan,target:BeatTarget):CursorPlaybackChoice[] {
  const rows=preparedRows(score,plan);beatAt(score,target);
  const matching=new Map<number,PerformedBeat>();
  for(const row of rows)if(sameTarget(row.target,target)&&!matching.has(row.occurrence))matching.set(row.occurrence,row);
  const choices:CursorPlaybackChoice[]=[];
  plan.occurrences.forEach((occurrence,occurrenceIndex)=>{
    const row=occurrence.bar===target.bar?matching.get(occurrence.occurrence):undefined;
    if(row&&row.leadInTick<plan.durationTick)choices.push({generation:plan.generation,occurrenceIndex,startTick:row.leadInTick});
  });
  if(!choices.length)throw new Error('This score position has no performed playback location.');return choices;
}
// Playback ranges use the public measure clock, including unrepresented free-time tails.
// Editing ranges intentionally retain their separate written-lane duration policy.
function playbackRange(score:model.Score,selection:Extract<MusicSelection,{kind:'range'}>) {
  fields(selection,['kind','range']);const range=selection.range;fields(range,['start','end','lanes']);
  for(const point of [range.start,range.end]){
    fields(point,['bar','tick']);const duration=masterAt(score,point.bar).calculateDuration();
    if(!index(point.tick)||point.tick>duration)throw new Error('The selected tick is outside this measure duration.');
  }
  if(range.start.bar>range.end.bar||range.start.bar===range.end.bar&&range.start.tick>=range.end.tick)throw new Error('Choose a nonempty forward tick range.');
  if(!Array.isArray(range.lanes)||!range.lanes.length)throw new Error('Choose at least one voice lane.');
  const seen=new Set<string>();for(const lane of range.lanes){
    fields(lane,['track','staff','voice']);const key=JSON.stringify([lane.track,lane.staff,lane.voice]);if(seen.has(key))throw new Error('Duplicate voice lane.');seen.add(key);
    for(let bar=range.start.bar;bar<=range.end.bar;bar++)voiceAt(score,lane,bar);
  }
  const start={...range.start},end={...range.end};
  if(start.tick===masterAt(score,start.bar).calculateDuration()&&start.bar<end.bar){start.bar++;start.tick=0;}
  // Normalize the exclusive written seam before comparing with the performed route.
  if(end.tick===0&&end.bar>start.bar){end.bar--;end.tick=masterAt(score,end.bar).calculateDuration();}
  if(start.bar>end.bar||start.bar===end.bar&&start.tick>=end.tick)throw new Error('Choose a nonempty forward tick range.');
  for(let bar=start.bar;bar<=end.bar;bar++)for(const lane of range.lanes){
    const measure=voiceAt(score,lane,bar).bar;
    if(measure.simileMark!==model.SimileMark.None&&(bar===start.bar&&start.tick!==0||bar===end.bar&&end.tick!==masterAt(score,bar).calculateDuration()))throw new Error('Select the complete simile measure for playback.');
  }
  return {start,end,lanes:range.lanes};
}
function rangePoint(score:model.Score,point:MusicPoint,lane:VoiceAddress,occurrence:MeasureOccurrence,rows:PerformedBeat[],edge:'start'|'end'):number {
  const voice=voiceAt(score,lane,point.bar),duration=masterAt(score,point.bar).calculateDuration();
  const bodies=rows.filter(row=>sameLane(row.target,lane)).flatMap(row=>{
    const beat=beatAt(score,row.target);if(beat.graceType!==model.GraceType.None||row.endTick<=row.startTick)return [];
    const whole=beat.isFullBarRest||voice.beats.length===1&&beat.isEmpty||voice.bar.simileMark!==model.SimileMark.None;
    return [{row,start:whole?0:beat.displayStart,end:whole?duration:beat.displayStart+beat.displayDuration}];
  });
  const boundary=bodies.filter(body=>edge==='start'?body.start===point.tick:body.end===point.tick);
  if(boundary.length)return edge==='start'?Math.min(...boundary.map(body=>body.row.leadInTick)):Math.max(...boundary.map(body=>body.row.endTick));
  const interior=bodies.filter(body=>body.start<point.tick&&point.tick<body.end);
  if(interior.length){const ticks=interior.map(body=>body.row.startTick+(point.tick-body.start)/(body.end-body.start)*(body.row.endTick-body.row.startTick));return edge==='start'?Math.min(...ticks):Math.max(...ticks);}
  return Math.min(occurrence.endTick,occurrence.startTick+point.tick);
}
export function selectionPlaybackChoices(score:model.Score,plan:PlaybackPlan,selection:MusicSelection):PassagePlaybackChoice[] {
  const rows=preparedRows(score,plan);
  let start:MusicPoint,end:MusicPoint,lanes:VoiceAddress[]=[],targets:BeatTarget[]=[];
  if(selection?.kind==='range')({start,end,lanes}=playbackRange(score,selection));
  else {
    validateMusicSelection(score,selection);
    if(selection.kind==='notes'){
      for(const {target} of selection.notes)if(!targets.some(other=>sameTarget(other,target)))targets.push(target);
      start={bar:Math.min(...targets.map(target=>target.bar)),tick:0};end={bar:Math.max(...targets.map(target=>target.bar)),tick:0};
    }else {start={bar:selection.firstBar,tick:0};end={bar:selection.lastBar,tick:0};}
  }
  const requiredBars=targets.length?new Set(targets.map(target=>target.bar)):new Set(Array.from({length:end.bar-start.bar+1},(_,i)=>start.bar+i));
  const grouped=new Map<string,PerformedBeat[]>();
  for(const row of rows){const key=`${row.target.bar}/${row.occurrence}`,group=grouped.get(key);if(group)group.push(row);else grouped.set(key,[row]);}
  const choices:PassagePlaybackChoice[]=[];
  for(let first=0;first<plan.occurrences.length;first++){
    const firstOccurrence=plan.occurrences[first];if(firstOccurrence.bar!==start.bar)continue;
    const seenBars=new Set<number>(),seenTargets=new Set<BeatTarget>(),selectedRows:PerformedBeat[]=[];
    for(let last=first;last<plan.occurrences.length;last++){
      const occurrence=plan.occurrences[last],currentRows=rowsIn(grouped,occurrence);seenBars.add(occurrence.bar);
      for(const row of currentRows)for(const target of targets)if(sameTarget(row.target,target)){seenTargets.add(target);selectedRows.push(row);}
      if(occurrence.bar!==end.bar||[...requiredBars].some(bar=>!seenBars.has(bar))||targets.some(target=>!seenTargets.has(target)))continue;
      let startTick:number,endTick:number;
      if(selection.kind==='notes'){
        // A candidate must actually begin at a selected beat in its start occurrence.
        if(!rowsIn(grouped,firstOccurrence).some(row=>targets.some(target=>sameTarget(row.target,target))))break;
        startTick=Math.min(...selectedRows.map(row=>row.leadInTick));endTick=Math.max(...selectedRows.map(row=>row.endTick));
      }else if(selection.kind==='bars'){
        const leadIns=rowsIn(grouped,firstOccurrence).filter(row=>selection.tracks.includes(row.target.track)).map(row=>row.leadInTick);
        startTick=Math.min(firstOccurrence.startTick,...leadIns);endTick=occurrence.endTick;
      }else {
        startTick=Math.min(...lanes.map(lane=>rangePoint(score,start,lane,firstOccurrence,rowsIn(grouped,firstOccurrence),'start')));
        endTick=Math.max(...lanes.map(lane=>rangePoint(score,end,lane,occurrence,currentRows,'end')));
      }
      if(Number.isFinite(startTick)&&Number.isFinite(endTick)&&startTick>=0&&endTick>startTick&&endTick<=plan.durationTick)choices.push({generation:plan.generation,startOccurrence:first,endOccurrence:last,startTick,endTick});
      // Later passes must not turn an invalid nearest passage into an arbitrary multi-pass span.
      break;
    }
  }
  if(!choices.length)throw new Error('This selection has no performed playback passage.');return choices;
}
function validChoice(choice:unknown,keys:readonly string[],passage:boolean):void {
  fields(choice,keys);
  if(!Number.isSafeInteger(choice.generation)||Number(choice.generation)<0||keys.some(key=>typeof choice[key]!=='number'||!Number.isFinite(choice[key])||Number(choice[key])<0))throw new Error('Invalid selected playback choice.');
  if(passage){if(!index(choice.startOccurrence)||!index(choice.endOccurrence)||Number(choice.endOccurrence)<Number(choice.startOccurrence)||Number(choice.endTick)<=Number(choice.startTick))throw new Error('Invalid selected playback choice.');}
  else if(!index(choice.occurrenceIndex))throw new Error('Invalid selected playback choice.');
}
export function requireCursorChoice(choices:readonly CursorPlaybackChoice[],choice:CursorPlaybackChoice):CursorPlaybackChoice {
  const keys=['generation','occurrenceIndex','startTick'];if(!Array.isArray(choices))throw new Error('Invalid selected playback choices.');
  validChoice(choice,keys,false);for(const candidate of choices)validChoice(candidate,keys,false);
  if(!choices.some(candidate=>candidate.generation===choice.generation&&candidate.occurrenceIndex===choice.occurrenceIndex&&candidate.startTick===choice.startTick))throw new Error('Choose a current performed occurrence.');return {...choice};
}
export function requirePassageChoice(choices:readonly PassagePlaybackChoice[],choice:PassagePlaybackChoice):PassagePlaybackChoice {
  const keys=['generation','startOccurrence','endOccurrence','startTick','endTick'];if(!Array.isArray(choices))throw new Error('Invalid selected playback choices.');
  validChoice(choice,keys,true);for(const candidate of choices)validChoice(candidate,keys,true);
  if(!choices.some(candidate=>candidate.generation===choice.generation&&candidate.startOccurrence===choice.startOccurrence&&candidate.endOccurrence===choice.endOccurrence&&candidate.startTick===choice.startTick&&candidate.endTick===choice.endTick))throw new Error('Choose a current performed occurrence.');return {...choice};
}
