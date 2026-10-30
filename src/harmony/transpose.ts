import { model,Settings } from '@coderline/alphatab';
import type { HarmonyChord,HarmonyCommand,HarmonyInterval,SpelledPitchClass } from '../editor/harmony-types';
import type { MusicSelection } from '../editor/range-types';
import { integer,rhythmTicks } from '../editor/common';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { fretExists,neckFret,plainFret } from '../editor/banjo-drone';
import { resolveSelectionBeats,resolveSelectionNotes } from '../editor/range-selection';
import { applyPitchTargets } from '../editor/range-edits';
import { scoreFromJson } from '../model-clone';
import { copyGpInterchangeSource } from '../interchange/gp';
import { copyHarmonySources,getHarmonyChord,setHarmonyChordSource } from './chord-source';
import { findChordShapes,formatChordName } from './chords';
import { applyHarmonyEdit } from './edits';

type TransposeCommand=Extract<HarmonyCommand,{type:'transposeHarmony'}>;
const natural=[0,2,4,5,7,9,11],minor=[0,2,3,5,7,8,10];
const mod=(value:number,base=12)=>((value%base)+base)%base;
function fields(value:unknown,keys:string[]):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid harmony transpose fields.');
}
function intervalPlan(interval:HarmonyInterval) {
  if(!interval||typeof interval!=='object')throw new Error('Choose a transposition interval.');
  if(interval.kind==='diatonic'){
    fields(interval,['kind','steps']);if(!integer(interval.steps,-70,70)||interval.steps===0)throw new Error('Choose nonzero diatonic steps from −70 to 70.');return {steps:interval.steps,delta:0,letters:null};
  }
  if(interval.kind==='semitones'){
    fields(interval,['kind','semitones']);if(!integer(interval.semitones,-127,127)||interval.semitones===0)throw new Error('Choose nonzero semitones from −127 to 127.');return {steps:null,delta:interval.semitones,letters:null};
  }
  fields(interval,['kind','number','quality','direction','octaves']);
  if(interval.kind!=='chromatic'||!integer(interval.number,1,7)||!integer(interval.octaves,0,9)||!['up','down'].includes(interval.direction))throw new Error('Choose a valid chromatic interval.');
  const perfect=[1,4,5].includes(interval.number),quality=interval.quality;
  if(!['perfect','major','minor','augmented','diminished'].includes(quality)||(quality==='perfect'&&!perfect)||(['major','minor'].includes(quality)&&perfect)||(interval.number===1&&quality==='diminished'))throw new Error('That quality is unavailable for this interval.');
  const alteration=quality==='minor'?-1:quality==='augmented'?1:quality==='diminished'?(perfect?-1:-2):0,sign=interval.direction==='up'?1:-1;
  const delta=sign*(natural[interval.number-1]+alteration+12*interval.octaves);
  if(!integer(delta,-127,127)||delta===0)throw new Error('Choose a nonzero interval within 127 semitones.');return {steps:null,delta,letters:sign*(interval.number-1+7*interval.octaves)};
}
function sourceKey(bar:model.Bar) {
  if(!integer(bar.keySignature,-7,7)||!integer(bar.keySignatureType,0,1))throw new Error('Choose an established major or natural-minor key.');
  const minorKey=bar.keySignatureType===model.KeySignatureType.Minor,step=mod(4*bar.keySignature+(minorKey?5:0),7),pitch=mod(7*bar.keySignature+(minorKey?9:0));
  return {step,alteration:mod(pitch-natural[step]+6)-6};
}
function shiftedSpelling(source:SpelledPitchClass,delta:number,letters:number|null,flats:boolean):SpelledPitchClass {
  const pitch=mod(natural[source.step]+source.alteration+delta);
  if(letters!==null){const step=mod(source.step+letters,7),alteration=mod(pitch-natural[step]+6)-6;if(Math.abs(alteration)>2)throw new Error('The transposed spelling exceeds double accidentals.');return {step,alteration};}
  const step=natural.indexOf(pitch);if(step>=0)return {step,alteration:0};
  return flats?{step:natural.indexOf(pitch+1),alteration:-1}:{step:natural.indexOf(pitch-1),alteration:1};
}
function diatonicPitch(note:model.Note,steps:number) {
  const staff=note.beat.voice.bar.staff,bar=note.beat.voice.bar,key=sourceKey(bar),tonic=mod(natural[key.step]+key.alteration),scale=bar.keySignatureType===model.KeySignatureType.Minor?minor:natural,written=note.realValue+staff.transpositionPitch,degree=scale.indexOf(mod(written-tonic));
  if(degree<0)throw new Error('A selected written note is outside its bar key scale.');
  const shifted=degree+steps;return tonic+12*(Math.floor((written-tonic)/12)+Math.floor(shifted/7))+scale[mod(shifted,7)]-staff.transpositionPitch;
}
function completeBars(score:model.Score,selection:MusicSelection) {
  if(selection.kind==='notes')throw new Error('Key changes require complete bars covering every track.');
  if(selection.kind==='bars'){
    if(selection.tracks.length!==score.tracks.length||score.tracks.some(track=>!selection.tracks.includes(track.index)))throw new Error('Key changes require complete bars covering every track.');return {first:selection.firstBar,last:selection.lastBar};
  }
  const {start,end,lanes}=selection.range;
  const master=score.masterBars[end.bar],duration=master.isFreeTime?Math.max(0,...lanes.map(lane=>score.tracks[lane.track].staves[lane.staff].bars[end.bar].voices[lane.voice].beats.reduce((sum,beat)=>sum+rhythmTicks(beat,master.calculateDuration(false)),0))):master.calculateDuration(false);
  if(start.tick!==0||(end.tick!==0&&end.tick!==duration))throw new Error('Key changes require complete bars covering every track.');
  const first=start.bar,last=end.tick===0?end.bar-1:end.bar,keys=new Set(lanes.map(lane=>`${lane.track}/${lane.staff}/${lane.voice}`)),required=new Set<string>();
  for(const track of score.tracks)for(const staff of track.staves)for(let index=first;index<=last;index++)for(const voice of staff.bars[index].voices)required.add(`${track.index}/${staff.index}/${voice.index}`);
  if(last<first||keys.size!==required.size||[...required].some(key=>!keys.has(key)))throw new Error('Key changes require complete bars covering every track, staff and voice.');return {first,last};
}
function destinationKey(bar:model.Bar,delta:number,letters:number|null):model.KeySignature {
  const source=sourceKey(bar),destination=shiftedSpelling(source,delta,letters,bar.keySignature<0),pitch=mod(natural[destination.step]+destination.alteration),candidates:number[]=[];
  for(let key=-7;key<=7;key++){
    const minorKey=bar.keySignatureType===model.KeySignatureType.Minor,step=mod(4*key+(minorKey?5:0),7),tonic=mod(7*key+(minorKey?9:0)),alteration=mod(tonic-natural[step]+6)-6;
    if(tonic===pitch&&(letters===null||(step===destination.step&&alteration===destination.alteration)))candidates.push(key);
  }
  if(!candidates.length)throw new Error('The transposed key signature cannot represent this key spelling.');
  return candidates.sort((a,b)=>Math.abs(a)-Math.abs(b)||Number(bar.keySignature<0?a>0:a<0)-Number(bar.keySignature<0?b>0:b<0))[0];
}
function validDiagram(staff:model.Staff,value:HarmonyChord) {
  const chord=new model.Chord();Object.assign(chord,{staff,name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});
  setHarmonyChordSource(chord,value);return getHarmonyChord(chord).nameMode==='theory';
}
function transposedChord(staff:model.Staff,value:HarmonyChord,delta:number,letters:number|null,key:number):HarmonyChord {
  const recipe=structuredClone(value.recipe!);recipe.root=shiftedSpelling(recipe.root,delta,letters,key<0);if(recipe.bass)recipe.bass=shiftedSpelling(recipe.bass,delta,letters,key<0);
  const renamed={...value,recipe,name:formatChordName(recipe)};
  if(value.frets.every(fret=>fret<0))return renamed;
  const frets=value.frets.map((fret,index)=>fret<0?-1:neckFret(staff,value.frets.length-index,plainFret(staff,value.frets.length-index,fret)+delta)),barreFrets=value.barreFrets.map(fret=>fret+delta).filter(fret=>fret>0),positive=frets.filter(fret=>fret>0),firstFret=positive.length?Math.min(...positive):1;
  const fingers=value.fingers.map((finger,index)=>frets[index]<=0&&frets[index]!==value.frets[index]?-2:finger);
  if(frets.every(fret=>integer(fret,-1,127))&&barreFrets.every(fret=>integer(fret,0,127))&&integer(firstFret,0,127)){
    const shifted={...renamed,frets,fingers,barreFrets,firstFret};if(frets.every((fret,index)=>fret<0||fretExists(staff,frets.length-index,fret))&&validDiagram(staff,shifted))return shifted;
  }
  const shape=findChordShapes(staff,recipe,{maxFret:24,maxSpan:4,limit:12})[0];
  if(!shape)throw new Error('No playable transposed chord diagram shape was found in the search window.');
  const result={...shape,showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering};if(!validDiagram(staff,result))throw new Error('The transposed diagram does not match the formula and bass.');return result;
}
export function prepareHarmonyTranspose(score:model.Score,command:TransposeCommand,editIndex:number):model.Score {
  fields(command,['type','selection','interval','includeKeySignatures','includeChords']);
  if(command.type!=='transposeHarmony'||typeof command.includeKeySignatures!=='boolean'||typeof command.includeChords!=='boolean'||!integer(editIndex,0,0xffffffff))throw new Error('Invalid harmony transposition.');
  const plan=intervalPlan(command.interval);if(plan.steps!==null&&(command.includeChords||command.includeKeySignatures))throw new Error('Diatonic transposition does not update chord definitions or key signatures.');
  const candidate=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());
  copyGpInterchangeSource(score,candidate);copyHarmonySources(score,candidate);restoreNoteLinks(candidate,captureNoteLinks(score));
  const beats=resolveSelectionBeats(candidate,command.selection),notes=resolveSelectionNotes(candidate,command.selection),selected=new Set(notes),melodic=notes.filter(note=>!note.isPercussion&&!note.beat.voice.bar.staff.isPercussion);
  const keyChanges=new Map<model.Bar,model.KeySignature>();
  if(command.includeKeySignatures){const {first,last}=completeBars(candidate,command.selection);for(const track of candidate.tracks)for(const staff of track.staves)if(!staff.isPercussion)for(let index=first;index<=last;index++){const bar=staff.bars[index];keyChanges.set(bar,destinationKey(bar,plan.delta,plan.letters));}}
  const chordChanges:Array<{beat:model.Beat;value:HarmonyChord}>=[];
  if(command.includeChords)for(const beat of beats){
    const staff=beat.voice.bar.staff;if(staff.isPercussion)continue;
    if(beat.notes.some(note=>!selected.has(note)))throw new Error('Chord transposition requires complete selected beats, including every chord member.');
    const existing=beat.chordId?staff.getChord(beat.chordId):undefined;if(!existing)continue;
    const value=getHarmonyChord(existing);if(value.nameMode!=='theory'||!value.recipe)continue;
    const result=transposedChord(staff,value,plan.delta,plan.letters,keyChanges.get(beat.voice.bar)??beat.voice.bar.keySignature);
    if(JSON.stringify(result)!==JSON.stringify(value))chordChanges.push({beat,value:result});
  }
  const targets=melodic.map(note=>({address:{target:{track:note.beat.voice.bar.staff.track.index,staff:note.beat.voice.bar.staff.index,bar:note.beat.voice.bar.index,voice:note.beat.voice.index,beat:note.beat.index},noteIndex:note.index},pitch:plan.steps===null?note.realValue+plan.delta:diatonicPitch(note,plan.steps)}));
  if(!targets.some((target,index)=>target.pitch!==melodic[index].realValue)&&!chordChanges.length&&![...keyChanges].some(([bar,key])=>bar.keySignature!==key))throw new Error('No melodic note, chord or key would change.');
  applyPitchTargets(candidate,targets);
  for(const [bar,key]of keyChanges)bar.keySignature=key;
  for(const {beat,value}of chordChanges)applyHarmonyEdit(candidate,{type:'setHarmonyChord',target:{track:beat.voice.bar.staff.track.index,staff:beat.voice.bar.staff.index,bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index},chord:value,fillEmptyBeat:false},editIndex);
  return candidate;
}
