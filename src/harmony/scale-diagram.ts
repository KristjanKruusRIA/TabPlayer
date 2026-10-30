import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { MusicSelection } from '../editor/range-types';
import { locationAt } from '../editor/common';
import { resolveSelectionNotes } from '../editor/range-selection';

export type ScaleMarkShape='circle'|'square'|'diamond'|'triangle'|'cross';
export interface ScaleMark {string:number;fret:number;shape:ScaleMarkShape;color:string;text:string;textColor:string}
/** A fretboard window with marks. `string` counts from 1 for the highest-pitched string, as notes do; fret 0 is an open string. */
export interface ScaleDiagram {
  name:string;strings:number;frets:number;firstFret:number;orientation:'horizontal'|'vertical';showFretMarkers:boolean;marks:ScaleMark[];
}
export type ScaleDiagramCommand={type:'setScaleDiagram';target:BeatTarget;diagram:ScaleDiagram|null};
export const scaleMarkShapes:readonly ScaleMarkShape[]=['circle','square','diamond','triangle','cross'];
export const defaultMarkColor='#2f6fed',defaultRootColor='#b5df73',defaultTextColor='#ffffff',darkTextColor='#161c24';

const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const color=(value:unknown)=>typeof value==='string'&&/^#[0-9a-fA-F]{6}$/.test(value);
const exact=(value:unknown,keys:string[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
/** The same rules as the native `ScaleDiagram::validate`. */
export function validateScaleDiagram(input:unknown):asserts input is ScaleDiagram {
  const value=input as ScaleDiagram;
  if(!exact(value,['name','strings','frets','firstFret','orientation','showFretMarkers','marks'])||typeof value.name!=='string'||[...value.name].length>64||!integer(value.strings,3,10)||!integer(value.frets,4,24)||!integer(value.firstFret,1,127)||value.firstFret+value.frets-1>127||!['horizontal','vertical'].includes(value.orientation)||typeof value.showFretMarkers!=='boolean'||!Array.isArray(value.marks)||value.marks.length>value.strings*(value.frets+1))throw new Error('Invalid scale diagram.');
  const last=value.firstFret+value.frets-1,seen=new Set<string>();
  for(const mark of value.marks){
    if(!exact(mark,['string','fret','shape','color','text','textColor'])||!integer(mark.string,1,value.strings)||!integer(mark.fret,0,127)||(mark.fret!==0&&(mark.fret<value.firstFret||mark.fret>last))||!scaleMarkShapes.includes(mark.shape)||typeof mark.text!=='string'||[...mark.text].length>3||!color(mark.color)||!color(mark.textColor)||seen.has(`${mark.string}/${mark.fret}`))throw new Error('Invalid scale diagram mark.');
    seen.add(`${mark.string}/${mark.fret}`);
  }
}

const sources=new WeakMap<model.Beat,ScaleDiagram>();
const owners=new WeakMap<model.Score,Set<model.Beat>>();
const scoreOf=(beat:model.Beat)=>beat.voice.bar.staff.track.score;
/** A snapshot of the diagram on a beat, or null. */
export function getScaleDiagram(beat:model.Beat|undefined|null):ScaleDiagram|null {
  const value=beat?sources.get(beat):undefined;return value?structuredClone(value):null;
}
export function setScaleDiagram(beat:model.Beat,diagram:ScaleDiagram|null):void {
  const score=scoreOf(beat);
  if(diagram===null){sources.delete(beat);owners.get(score)?.delete(beat);return;}
  validateScaleDiagram(diagram);sources.set(beat,structuredClone(diagram));
  const set=owners.get(score)??new Set<model.Beat>();owners.set(score,set);set.add(beat);
}
/** All diagrams, with the position of their beat, in score order. */
export function listScaleDiagrams(score:model.Score):Array<{target:BeatTarget;diagram:ScaleDiagram}> {
  const found:Array<{target:BeatTarget;diagram:ScaleDiagram}>=[];
  for(const beat of owners.get(score)??[]){
    const voice=beat.voice,bar=voice.bar,staff=bar.staff;
    if(voice.beats[beat.index]!==beat||bar.voices[voice.index]!==voice||staff.bars[bar.index]!==bar)continue;
    found.push({target:{track:staff.track.index,staff:staff.index,bar:bar.index,voice:voice.index,beat:beat.index},diagram:structuredClone(sources.get(beat)!)});
  }
  const key=(t:BeatTarget)=>[t.track,t.staff,t.bar,t.voice,t.beat];
  return found.sort((a,b)=>{const x=key(a.target),y=key(b.target);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;});
}
/** Call after any full clone that keeps the score's structure, as for chord sources. */
export function copyScaleDiagrams(source:model.Score,destination:model.Score):void {
  if(source===destination)return;
  const found=listScaleDiagrams(source);owners.delete(destination);
  for(const {target,diagram}of found){
    const beat=destination.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
    if(beat)setScaleDiagram(beat,diagram);
  }
}

/** Replay of `setScaleDiagram`. A diagram marks a written beat of a pitched, stringed or keyboard staff, never a drum staff. */
export function applyScaleDiagramEdit(score:model.Score,command:ScaleDiagramCommand):boolean {
  if(command.type!=='setScaleDiagram')return false;
  const {staff,voice}=locationAt(score,command.target),beat=voice.beats[command.target.beat];
  if(!beat||beat.isEmpty)throw new Error('Select an existing beat.');
  if(staff.isPercussion)throw new Error('A drum staff cannot hold a scale diagram.');
  if(command.diagram!==null)validateScaleDiagram(command.diagram);
  setScaleDiagram(beat,command.diagram);return true;
}

const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const pitchClassName=(pitch:number)=>noteNames[((pitch%12)+12)%12];
export function blankScaleDiagram(strings:number):ScaleDiagram {
  return {name:'',strings:Math.min(10,Math.max(3,strings)),frets:12,firstFret:1,orientation:'horizontal',showFretMarkers:true,marks:[]};
}
export const newMark=(string:number,fret:number,shape:ScaleMarkShape='circle',markColor=defaultMarkColor,text='',textColor=defaultTextColor):ScaleMark=>({string,fret,shape,color:markColor,text,textColor});
/** Builds a diagram from the selected fretted notes, one mark per distinct string and fret, labelled with the sounding note name. */
export function scaleDiagramFromSelection(score:model.Score,selection:MusicSelection,staff:model.Staff):ScaleDiagram {
  if(staff.isPercussion||!staff.tuning.length)throw new Error('Select notes on a stringed staff.');
  const notes=resolveSelectionNotes(score,selection).filter(note=>note.beat.voice.bar.staff===staff&&note.isStringed&&!note.isPercussion&&!note.isDead);
  if(!notes.length)throw new Error('Select notes on this staff to build a diagram.');
  const seen=new Set<string>(),marks:ScaleMark[]=[];
  for(const note of notes){
    const key=`${note.string}/${note.fret}`;if(seen.has(key)||note.string>10||note.fret>127)continue;seen.add(key);
    marks.push(newMark(note.string,note.fret,'circle',defaultMarkColor,pitchClassName(note.realValue),defaultTextColor));
  }
  const fretted=marks.map(mark=>mark.fret).filter(fret=>fret>0),low=fretted.length?Math.min(...fretted):1,high=fretted.length?Math.max(...fretted):1;
  if(high-low+1>24)throw new Error('The selection spans more than 24 frets.');
  const frets=Math.min(24,Math.max(5,high-low+1)),firstFret=Math.min(low,128-frets);
  return {name:'',strings:Math.min(10,Math.max(3,staff.tuning.length)),frets,firstFret,orientation:'horizontal',showFretMarkers:true,marks};
}
/** Every position of the given pitch classes inside the diagram window; the root is drawn in the root colour and labelled. */
export function scaleDiagramFromPitchClasses(staff:model.Staff,root:number,classes:ReadonlySet<number>,name:string,firstFret=1,frets=12):ScaleDiagram {
  if(staff.isPercussion||!staff.tuning.length||staff.tuning.length>10)throw new Error('Choose a stringed staff.');
  const base:ScaleDiagram={name,strings:Math.max(3,staff.tuning.length),frets,firstFret,orientation:'horizontal',showFretMarkers:true,marks:[]};
  const probe=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();probe.staff=staff;voice.bar=probe;beat.voice=voice;note.beat=beat;
  for(let string=1;string<=staff.tuning.length;string++)for(const fret of [0,...Array.from({length:frets},(_,i)=>firstFret+i)]){
    note.string=string;note.fret=fret;const pitch=note.realValue;
    if(!Number.isInteger(pitch)||pitch<0||pitch>127||!classes.has(((pitch%12)+12)%12)||base.marks.some(mark=>mark.string===string&&mark.fret===fret))continue;
    const isRoot=((pitch%12)+12)%12===root;
    base.marks.push(newMark(string,fret,'circle',isRoot?defaultRootColor:defaultMarkColor,pitchClassName(pitch),isRoot?darkTextColor:defaultTextColor));
  }
  return base;
}

/** Editing helpers keep every diagram valid, so Apply can always send it. */
export const markAt=(diagram:ScaleDiagram,string:number,fret:number)=>diagram.marks.find(mark=>mark.string===string&&mark.fret===fret);
export function withMark(diagram:ScaleDiagram,mark:ScaleMark):ScaleDiagram {
  return {...diagram,marks:[...diagram.marks.filter(item=>!(item.string===mark.string&&item.fret===mark.fret)),mark]};
}
export function withoutMark(diagram:ScaleDiagram,string:number,fret:number):ScaleDiagram {
  return {...diagram,marks:diagram.marks.filter(item=>!(item.string===string&&item.fret===fret))};
}
/** Resizes the window; marks that fall outside it (other than open strings) or off a removed string are dropped. */
export function resized(diagram:ScaleDiagram,change:Partial<Pick<ScaleDiagram,'strings'|'frets'|'firstFret'>>):ScaleDiagram {
  const strings=Math.min(10,Math.max(3,change.strings??diagram.strings)),frets=Math.min(24,Math.max(4,change.frets??diagram.frets));
  const firstFret=Math.min(128-frets,Math.max(1,change.firstFret??diagram.firstFret)),last=firstFret+frets-1;
  return {...diagram,strings,frets,firstFret,marks:diagram.marks.filter(mark=>mark.string<=strings&&(mark.fret===0||(mark.fret>=firstFret&&mark.fret<=last)))};
}
