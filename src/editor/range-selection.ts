import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { BeatRange,MusicPoint,MusicSelection,VoiceAddress } from './range-types';
import { rhythmTicks } from './common';

const index=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=0xffffffff;
function fields(value:unknown,keys:string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid music selection fields.');
}
const compare=(a:MusicPoint,b:MusicPoint)=>a.bar-b.bar||a.tick-b.tick;
function trackAt(score:model.Score,track:number) {
  if(!index(track)||!score.tracks[track])throw new Error('Select an existing track.');return score.tracks[track];
}
function barAt(score:model.Score,bar:number) {
  if(!index(bar)||!score.masterBars[bar])throw new Error('Select an existing measure.');return score.masterBars[bar];
}
function voiceAt(score:model.Score,lane:VoiceAddress,bar:number) {
  const track=trackAt(score,lane.track);barAt(score,bar);
  const staff=index(lane.staff)?track.staves[lane.staff]:undefined,voice=index(lane.voice)&&lane.voice<4?staff?.bars[bar]?.voices[lane.voice]:undefined;
  if(!voice)throw new Error('Select an existing staff and voice throughout every addressed measure.');return voice;
}
function lanesAt(score:model.Score,lanes:VoiceAddress[],first:number,last:number) {
  if(!Array.isArray(lanes)||!lanes.length)throw new Error('Choose at least one voice lane.');
  const seen=new Set<string>();for(const lane of lanes){fields(lane,['track','staff','voice']);const key=JSON.stringify([lane.track,lane.staff,lane.voice]);if(seen.has(key))throw new Error('Duplicate voice lane.');seen.add(key);for(let bar=first;bar<=last;bar++)voiceAt(score,lane,bar);}
}
function duration(score:model.Score,bar:number,lanes:VoiceAddress[]) {
  const master=barAt(score,bar),nominal=master.calculateDuration(false);
  return master.isFreeTime?Math.max(0,...lanes.map(lane=>voiceAt(score,lane,bar).beats.reduce((sum,beat)=>sum+rhythmTicks(beat,nominal),0))):nominal;
}
function noteAt(score:model.Score,address:Extract<MusicSelection,{kind:'notes'}>['notes'][number]) {
  fields(address,['target','noteIndex']);fields(address.target,['track','staff','bar','voice','beat']);
  const target=address.target;if(!Object.values(target).every(index))throw new Error('Invalid note address.');
  const beat=voiceAt(score,target,target.bar).beats[target.beat];
  if(!beat||beat.isEmpty||!index(address.noteIndex)||!beat.notes[address.noteIndex])throw new Error('Select an existing note.');return beat.notes[address.noteIndex];
}
export function validateMusicSelection(score:model.Score,selection:MusicSelection):void {
  if(!selection||typeof selection!=='object')throw new Error('Choose a music selection.');
  switch(selection.kind){
    case 'notes':{
      fields(selection,['kind','notes']);if(!Array.isArray(selection.notes)||!selection.notes.length)throw new Error('Choose at least one note.');
      const seen=new Set<model.Note>();for(const address of selection.notes){const note=noteAt(score,address);if(seen.has(note))throw new Error('Duplicate note address.');seen.add(note);}return;
    }
    case 'bars':{
      fields(selection,['kind','tracks','firstBar','lastBar']);barAt(score,selection.firstBar);barAt(score,selection.lastBar);
      if(selection.firstBar>selection.lastBar||!Array.isArray(selection.tracks)||!selection.tracks.length)throw new Error('Choose a forward measure selection and tracks.');
      const seen=new Set<number>();for(const index of selection.tracks){const track=trackAt(score,index);if(seen.has(index))throw new Error('Duplicate track.');seen.add(index);
        for(const staff of track.staves)for(let bar=selection.firstBar;bar<=selection.lastBar;bar++){const measure=staff.bars[bar];if(!measure||measure.voices.length<1||measure.voices.length>4)throw new Error('Select existing staff measures and voices.');}}
      return;
    }
    case 'range':{
      fields(selection,['kind','range']);const range=selection.range;fields(range,['start','end','lanes']);fields(range.start,['bar','tick']);fields(range.end,['bar','tick']);
      barAt(score,range.start.bar);barAt(score,range.end.bar);
      if(!index(range.start.tick)||!index(range.end.tick)||compare(range.start,range.end)>=0)throw new Error('Choose a nonempty forward tick range.');
      lanesAt(score,range.lanes,range.start.bar,range.end.bar);
      if(range.start.tick>duration(score,range.start.bar,range.lanes)||range.end.tick>duration(score,range.end.bar,range.lanes))throw new Error('The selected tick is outside this measure duration.');
      const canonical=(point:MusicPoint)=>point.tick===duration(score,point.bar,range.lanes)&&score.masterBars[point.bar+1]?{bar:point.bar+1,tick:0}:point;
      if(compare(canonical(range.start),canonical(range.end))>=0)throw new Error('Choose a nonempty forward tick range.');return;
    }
    default:throw new Error('Invalid music selection kind.');
  }
}
function ordered(beats:Iterable<model.Beat>) {
  return [...new Set(beats)].sort((a,b)=>a.voice.bar.staff.track.index-b.voice.bar.staff.track.index||a.voice.bar.staff.index-b.voice.bar.staff.index||a.voice.bar.index-b.voice.bar.index||a.voice.index-b.voice.index||a.index-b.index);
}
export function writtenPositions(score:model.Score,lane:VoiceAddress) {
  const staff=trackAt(score,lane.track).staves[lane.staff],points=new Map<model.Beat,MusicPoint>();
  for(const bar of staff.bars){let tick=0;for(const beat of bar.voices[lane.voice]?.beats??[]){if(!beat.isEmpty&&beat.graceType===model.GraceType.None)points.set(beat,{bar:bar.index,tick});tick+=rhythmTicks(beat,bar.masterBar.calculateDuration(false));}}
  for(const [beat,point] of points)for(const grace of beat.graceGroup?.beats??[])if(!grace.isEmpty)points.set(grace,point);
  for(const bar of staff.bars)for(const beat of bar.voices[lane.voice]?.beats??[])if(!beat.isEmpty&&beat.graceType!==model.GraceType.None&&!points.has(beat)){
    let attack=beat.nextBeat;const seen=new Set<model.Beat>([beat]);while(attack&&attack.graceType!==model.GraceType.None&&!seen.has(attack)){seen.add(attack);attack=attack.nextBeat;}
    if(attack&&points.has(attack))points.set(beat,points.get(attack)!);
  }
  return points;
}
export function resolveSelectionBeats(score:model.Score,selection:MusicSelection):model.Beat[] {
  validateMusicSelection(score,selection);
  if(selection.kind==='notes')return ordered(selection.notes.map(address=>noteAt(score,address).beat));
  if(selection.kind==='bars')return ordered(selection.tracks.flatMap(track=>score.tracks[track].staves.flatMap(staff=>staff.bars.slice(selection.firstBar,selection.lastBar+1).flatMap(bar=>bar.voices.flatMap(voice=>voice.beats)))));
  const {start,end,lanes}=selection.range,beats:model.Beat[]=[];
  for(const lane of lanes)for(const [beat,point] of writtenPositions(score,lane))if(compare(point,start)>=0&&compare(point,end)<0)beats.push(beat);
  return ordered(beats);
}
/**
 * How far through its last attacked beat a range ends, as a fraction above 0 and below 1, when the end edge falls inside that beat; undefined when the range ends where its last beat ends.
 * The first lane stands for the range, as the selection band does.
 */
export function rangeEndFraction(score:model.Score,range:BeatRange):number|undefined {
  const lane=range.lanes[0];if(!lane)return undefined;
  let found:{beat:model.Beat;point:MusicPoint}|null=null;
  for(const [beat,point] of writtenPositions(score,lane))if(beat.graceType===model.GraceType.None&&compare(point,range.start)>=0&&compare(point,range.end)<0&&(!found||compare(point,found.point)>0))found={beat,point};
  if(!found||found.point.bar!==range.end.bar)return undefined;
  const length=rhythmTicks(found.beat,found.beat.voice.bar.masterBar.calculateDuration(false)),inside=range.end.tick-found.point.tick;
  return length>0&&inside>0&&inside<length?inside/length:undefined;
}
export function resolveSelectionNotes(score:model.Score,selection:MusicSelection):model.Note[] {
  if(selection.kind!=='notes')return resolveSelectionBeats(score,selection).flatMap(beat=>beat.notes);
  validateMusicSelection(score,selection);const selected=new Set(selection.notes.map(address=>noteAt(score,address)));
  return ordered([...selected].map(note=>note.beat)).flatMap(beat=>beat.notes.filter(note=>selected.has(note)));
}
export function rangeFromBeats(score:model.Score,from:BeatTarget,to:BeatTarget,lanes:VoiceAddress[]):BeatRange {
  const endpoint=(target:BeatTarget)=>{
    fields(target,['track','staff','bar','voice','beat']);if(!Object.values(target).every(index))throw new Error('Invalid beat address.');
    const beat=voiceAt(score,target,target.bar).beats[target.beat];if(!beat||beat.isEmpty)throw new Error('Select a nonempty beat endpoint.');
    const point=writtenPositions(score,target).get(beat);if(!point)throw new Error('Select a beat with a written attack.');
    const attack=voiceAt(score,target,point.bar).beats.find(candidate=>candidate.graceType===model.GraceType.None&&writtenPositions(score,target).get(candidate)?.tick===point.tick)!;
    return {point,length:rhythmTicks(attack,attack.voice.bar.masterBar.calculateDuration(false))};
  };
  const a=endpoint(from),b=endpoint(to),first=compare(a.point,b.point)<=0?a:b,last=first===a?b:a;
  const start={...first.point},end={bar:last.point.bar,tick:last.point.tick+last.length};
  lanesAt(score,lanes,start.bar,end.bar);if(end.tick===duration(score,end.bar,lanes)&&score.masterBars[end.bar+1]){end.bar++;end.tick=0;}
  const range={start,end,lanes:lanes.map(lane=>({...lane}))};validateMusicSelection(score,{kind:'range',range});return range;
}
export function selectionForBars(score:model.Score,tracks:number[],first:number,last:number):MusicSelection {
  const selection:MusicSelection={kind:'bars',tracks:[...tracks],firstBar:first,lastBar:last};validateMusicSelection(score,selection);return selection;
}
export function selectionForTrack(score:model.Score,track:number):MusicSelection {
  trackAt(score,track);return selectionForBars(score,[track],0,score.masterBars.length-1);
}
/** What a plain click on a beat of the score selects: that one beat in its voice, or its whole bar when the beat cannot be a range (an empty beat, say). */
export function singleBeatSelection(score:model.Score,point:BeatTarget):MusicSelection {
  try{return {kind:'range',range:rangeFromBeats(score,point,point,[{track:point.track,staff:point.staff,voice:point.voice}])};}
  catch{return selectionForBars(score,[point.track],point.bar,point.bar);}
}
