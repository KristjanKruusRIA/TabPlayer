import { model } from '@coderline/alphatab';
import type { ChordDegree,ChordFormulaId,ChordMatch,ChordRecipe,ChordShapeSearch,HarmonyChord,SpelledPitchClass } from '../editor/harmony-types';

const integer=(value:number,min:number,max:number)=>Number.isInteger(value)&&value>=min&&value<=max;
const pc=(value:number)=>((value%12)+12)%12;
const natural=[0,2,4,5,7,9,11];
const degreeBase:Record<ChordDegree,number>={1:0,2:2,3:4,4:5,5:7,6:9,7:11,9:14,11:17,13:21};
const formulaOrder:ChordFormulaId[]=['major','minor','dim','aug','sus2','sus4','power','6','m6','7','maj7','m7','mMaj7','m7b5','dim7','9','maj9','m9','11','m11','13','7sus4'];
const formulas:Record<ChordFormulaId,Array<[ChordDegree,number]>>={
  major:[[1,0],[3,4],[5,7]],minor:[[1,0],[3,3],[5,7]],dim:[[1,0],[3,3],[5,6]],aug:[[1,0],[3,4],[5,8]],
  sus2:[[1,0],[2,2],[5,7]],sus4:[[1,0],[4,5],[5,7]],power:[[1,0],[5,7]],
  '6':[[1,0],[3,4],[5,7],[6,9]],m6:[[1,0],[3,3],[5,7],[6,9]],'7':[[1,0],[3,4],[5,7],[7,10]],maj7:[[1,0],[3,4],[5,7],[7,11]],
  m7:[[1,0],[3,3],[5,7],[7,10]],mMaj7:[[1,0],[3,3],[5,7],[7,11]],m7b5:[[1,0],[3,3],[5,6],[7,10]],dim7:[[1,0],[3,3],[5,6],[7,9]],
  '9':[[1,0],[3,4],[5,7],[7,10],[9,14]],maj9:[[1,0],[3,4],[5,7],[7,11],[9,14]],m9:[[1,0],[3,3],[5,7],[7,10],[9,14]],
  '11':[[1,0],[3,4],[5,7],[7,10],[9,14],[11,17]],m11:[[1,0],[3,3],[5,7],[7,10],[9,14],[11,17]],
  '13':[[1,0],[3,4],[5,7],[7,10],[9,14],[11,17],[13,21]],'7sus4':[[1,0],[4,5],[5,7],[7,10]],
};
function pitchClass(value:SpelledPitchClass) {
  if(!value||!integer(value.step,0,6)||!integer(value.alteration,-2,2))throw new Error('Invalid spelled pitch class.');return pc(natural[value.step]+value.alteration);
}
const spell=(value:SpelledPitchClass)=>'CDEFGAB'[value.step]+(value.alteration<0?'b'.repeat(-value.alteration):'#'.repeat(value.alteration));
function fromPc(value:number):SpelledPitchClass {
  const step=natural.indexOf(value);return step>=0?{step,alteration:0}:{step:natural.indexOf(value-1),alteration:1};
}
export function chordTones(recipe:ChordRecipe):Array<{degree:ChordDegree;pitchClass:number}> {
  const root=pitchClass(recipe.root);if(recipe.bass!==null)pitchClass(recipe.bass);
  if(!formulaOrder.includes(recipe.formula)||!Array.isArray(recipe.alterations)||!Array.isArray(recipe.omissions))throw new Error('Invalid chord formula.');
  const tones=new Map(formulas[recipe.formula]),altered=new Set<ChordDegree>();
  for(const {degree,shift} of recipe.alterations){
    if(![5,9,11,13].includes(degree)||(shift!==-1&&shift!==1)||altered.has(degree)||(!tones.has(degree)&&degree===5)||(tones.has(degree)&&tones.get(degree)!==degreeBase[degree]))throw new Error('Invalid or contradictory chord alteration.');
    altered.add(degree);tones.set(degree,degreeBase[degree]+shift);
  }
  const omitted=new Set<ChordDegree>();
  for(const degree of recipe.omissions){if(omitted.has(degree)||!tones.has(degree))throw new Error('A chord omission must name a distinct present degree.');omitted.add(degree);tones.delete(degree);}
  if(tones.size===0)throw new Error('A chord must retain at least one tone.');
  const seen=new Set<number>();return [...tones].sort(([a],[b])=>a-b).flatMap(([degree,semitones])=>{
    const value=pc(root+semitones);if(seen.has(value))return [];seen.add(value);return [{degree,pitchClass:value}];
  });
}
export function formatChordName(recipe:ChordRecipe):string {
  chordTones(recipe);
  const suffix=recipe.formula==='major'?'':recipe.formula==='minor'?'m':recipe.formula==='power'?'5':recipe.formula;
  const modifiers=[...recipe.alterations].sort((a,b)=>a.degree-b.degree).map(({degree,shift})=>(shift<0?'b':'#')+degree);
  modifiers.push(...[...recipe.omissions].sort((a,b)=>a-b).map(degree=>'no'+degree));
  return spell(recipe.root)+suffix+(modifiers.length?'('+modifiers.join(',')+')':'')+(recipe.bass===null?'':'/'+spell(recipe.bass));
}
export function recognizeChords(pitches:readonly number[],preferredRoot:SpelledPitchClass|null):ChordMatch[] {
  if(pitches.some(pitch=>!integer(pitch,0,127)))throw new Error('Selected pitches must be MIDI pitches from 0 to 127.');
  const preferred=preferredRoot===null?null:pitchClass(preferredRoot);if(pitches.length===0)return [];
  const pitchClasses=[...new Set(pitches.map(pc))].sort((a,b)=>a-b),mask=pitchClasses.reduce((bits,value)=>bits|1<<value,0),bass=Math.min(...pitches),bassPc=pc(bass);
  const matches:Array<{match:ChordMatch;root:number;order:number}>=[];
  for(let order=0;order<formulaOrder.length;order++)for(let root=0;root<12;root++){
    const recipe:ChordRecipe={root:preferred===root?{...preferredRoot!}:fromPc(root),formula:formulaOrder[order],alterations:[],omissions:[],bass:root===bassPc?null:fromPc(bassPc)};
    const tones=chordTones(recipe);if(tones.reduce((bits,tone)=>bits|1<<tone.pitchClass,0)!==mask)continue;
    matches.push({match:{recipe,name:formatChordName(recipe),bass,pitchClasses:[...pitchClasses]},root,order});
  }
  return matches.sort((a,b)=>Number(b.root===preferred)-Number(a.root===preferred)||Number(b.root===bassPc)-Number(a.root===bassPc)||a.match.pitchClasses.length-b.match.pitchClasses.length||a.order-b.order||a.root-b.root).map(value=>value.match);
}

interface ShapeState {frets:number[];mask:number;bass:number;muted:number;min:number;max:number;sum:number}
function compareShapes(a:ShapeState,b:ShapeState) {
  const rank=a.muted-b.muted||(a.max?a.max-a.min:0)-(b.max?b.max-b.min:0)||a.max-b.max||a.sum-b.sum;if(rank)return rank;
  for(let index=0;index<a.frets.length;index++)if(a.frets[index]!==b.frets[index])return a.frets[index]-b.frets[index];return 0;
}
function fingersFor(frets:number[]) {
  const fingers=frets.map(()=>-2),barreFrets:number[]=[],positive=[...new Set(frets.filter(fret=>fret>0))].sort((a,b)=>a-b);let finger=0;
  for(const fret of positive){
    const positions=frets.flatMap((value,index)=>value===fret?[index]:[]),barre=positions.length>1&&frets.slice(positions[0],positions.at(-1)!+1).every(value=>value>=fret);
    if(barre){finger++;for(const index of positions)fingers[index]=finger;barreFrets.push(fret);}
    else for(const index of positions)fingers[index]=++finger;
  }
  return finger>4?null:{fingers,barreFrets};
}
const bitCount=(value:number)=>{let count=0;for(;value;value&=value-1)count++;return count;};
export function findChordShapes(staff:model.Staff,recipe:ChordRecipe,search:ChordShapeSearch):HarmonyChord[] {
  const tones=chordTones(recipe),name=formatChordName(recipe),strings=staff.tuning.length,{maxFret,maxSpan,limit}=search;
  if(staff.isPercussion||!integer(strings,1,12)||staff.tuning.some(pitch=>!integer(pitch,0,127))||!integer(staff.capo,0,127)||!integer(staff.transpositionPitch,-127,127))throw new Error('Choose a tuned melodic staff with one to twelve strings.');
  if(!integer(maxFret,1,127)||!integer(maxSpan,0,4)||!integer(limit,1,12))throw new Error('Choose a maximum fret from 1 to 127, span from 0 to 4 and result limit from 1 to 12.');
  const bassPc=recipe.bass===null?null:pitchClass(recipe.bass),required=tones.reduce((mask,tone)=>mask|1<<tone.pitchClass,bassPc===null?0:1<<bassPc);
  if(bitCount(required)>strings)return [];
  // A detached hierarchy lets public getters apply the staff's exact sounding context.
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();bar.staff=staff;voice.bar=bar;beat.voice=voice;note.beat=beat;
  const pitches=staff.tuning.map((_,index)=>{
    note.string=strings-index;return Array.from({length:maxFret+1},(_,fret)=>{note.fret=fret;const pitch=note.realValue;return integer(note.realValueWithoutHarmonic,0,127)&&integer(pitch,0,127)?pitch:-1;});
  });
  const found=new Map<string,ShapeState>();
  for(let first=1;first<=maxFret;first++){
    const options=pitches.map(values=>[-1,0,...Array.from({length:Math.min(maxSpan,maxFret-first)+1},(_,index)=>first+index)].filter(fret=>fret<0||(values[fret]>=0&&(required&1<<pc(values[fret]))!==0)));
    const remaining=Array(strings+1).fill(0) as number[];
    for(let index=strings-1;index>=0;index--)remaining[index]=options[index].reduce((mask,fret)=>fret<0?mask:mask|1<<pc(pitches[index][fret]),remaining[index+1]);
    if(remaining[0]!==required)continue;
    let states:ShapeState[]=[{frets:[],mask:0,bass:Infinity,muted:0,min:Infinity,max:0,sum:0}];
    for(let index=0;index<strings;index++){
      const next:ShapeState[]=[];
      for(const state of states)for(const fret of options[index]){
        const pitch=fret<0?-1:pitches[index][fret],mask=fret<0?state.mask:state.mask|1<<pc(pitch);
        if((mask|remaining[index+1])!==required||bitCount(required&~mask)>strings-index-1)continue;
        const candidate:ShapeState={frets:[...state.frets,fret],mask,bass:fret<0?state.bass:Math.min(state.bass,pitch),muted:state.muted+Number(fret<0),min:fret>0?Math.min(state.min,fret):state.min,max:Math.max(state.max,fret),sum:state.sum+Math.max(0,fret)};
        if(index===strings-1&&((bassPc!==null&&pc(candidate.bass)!==bassPc)||!fingersFor(candidate.frets)))continue;
        next.push(candidate);
      }
      // Coverage precedes the final shape rank only while choosing the bounded beam.
      states=next.sort((a,b)=>bitCount(b.mask)-bitCount(a.mask)||compareShapes(a,b)).slice(0,256);
      if(states.length===0)break;
    }
    for(const state of states)if(state.frets.length===strings&&state.mask===required)found.set(state.frets.join(','),state);
  }
  return [...found.values()].sort(compareShapes).slice(0,limit).map(state=>({
    name,nameMode:'theory',recipe:structuredClone(recipe),firstFret:state.max?state.min:1,frets:[...state.frets],...fingersFor(state.frets)!,showName:true,showDiagram:true,showFingering:true,
  }));
}
