import { model } from '@coderline/alphatab';
import type { HarmonyChord } from '../editor/harmony-types';
import { chordTones,formatChordName } from './chords';

const sources=new WeakMap<model.Chord,HarmonyChord>();
const integer=(value:number,min:number,max:number)=>Number.isInteger(value)&&value>=min&&value<=max;
const pc=(value:number)=>((value%12)+12)%12;
const exact=(value:object,keys:string[])=>value!==null&&typeof value==='object'&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const dense=(values:readonly unknown[])=>{for(let index=0;index<values.length;index++)if(!Object.hasOwn(values,index))return false;return true;};
export function validateHarmonyChord(input:unknown):asserts input is HarmonyChord {
  const value=input as HarmonyChord;
  if(!exact(value,['name','nameMode','recipe','firstFret','frets','fingers','barreFrets','showName','showDiagram','showFingering'])||typeof value.name!=='string'||!integer(value.firstFret,0,127)||!Array.isArray(value.frets)||!Array.isArray(value.fingers)||value.frets.length>12||value.frets.length!==value.fingers.length||!dense(value.frets)||!dense(value.fingers)||value.frets.some(fret=>!integer(fret,-1,127))||value.fingers.some(finger=>!integer(finger,-2,4))||!Array.isArray(value.barreFrets)||!dense(value.barreFrets)||value.barreFrets.some(fret=>!integer(fret,0,127))||[value.showName,value.showDiagram,value.showFingering].some(flag=>typeof flag!=='boolean'))throw new Error('Invalid harmony chord definition.');
  if(value.nameMode==='manual'&&value.recipe===null)return;
  const recipe=value.recipe;
  if(value.nameMode!=='theory'||!recipe||!exact(recipe,['root','formula','alterations','omissions','bass'])||!exact(recipe.root,['step','alteration'])||(recipe.bass!==null&&!exact(recipe.bass,['step','alteration']))||!Array.isArray(recipe.alterations)||!dense(recipe.alterations)||recipe.alterations.some(alteration=>!exact(alteration,['degree','shift']))||!Array.isArray(recipe.omissions)||!dense(recipe.omissions)||formatChordName(recipe)!==value.name)throw new Error('A theory chord requires its exact formula name.');
}
function matchesContext(chord:model.Chord,value:HarmonyChord):boolean {
  if(value.recipe===null||value.name!==formatChordName(value.recipe))return false;
  if(value.frets.every(fret=>fret<0))return true;
  const staff=chord.staff;
  if(!staff||staff.isPercussion||staff.tuning.length!==value.frets.length||staff.tuning.length===0||staff.tuning.some(pitch=>!integer(pitch,0,127))||!integer(staff.capo,0,127)||!integer(staff.transpositionPitch,-127,127))return false;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();bar.staff=staff;voice.bar=bar;beat.voice=voice;note.beat=beat;
  const pitches=value.frets.flatMap((fret,index)=>{
    if(fret<0)return [];note.string=value.frets.length-index;note.fret=fret;
    return integer(note.realValueWithoutHarmonic,0,127)&&integer(note.realValue,0,127)?[note.realValue]:[NaN];
  });
  if(pitches.some(pitch=>!Number.isFinite(pitch)))return false;
  const bass=value.recipe.bass===null?null:pc([0,2,4,5,7,9,11][value.recipe.bass.step]+value.recipe.bass.alteration);
  const required=new Set(chordTones(value.recipe).map(tone=>tone.pitchClass));if(bass!==null)required.add(bass);
  const actual=new Set(pitches.map(pc));return actual.size===required.size&&[...actual].every(pitch=>required.has(pitch))&&(bass===null||pc(Math.min(...pitches))===bass);
}

/** A deep effective snapshot; a stale context never rewrites authored provenance. */
export function getHarmonyChord(chord:model.Chord):HarmonyChord {
  const source=sources.get(chord),value:HarmonyChord={name:chord.name,nameMode:source?.nameMode??'manual',recipe:source?.recipe?structuredClone(source.recipe):null,firstFret:chord.firstFret,frets:[...chord.strings],fingers:chord.strings.map((_,index)=>source?.fingers[index]??-2),barreFrets:[...chord.barreFrets],showName:chord.showName,showDiagram:chord.showDiagram,showFingering:chord.showFingering};
  if(value.nameMode==='theory'&&!matchesContext(chord,value)){value.nameMode='manual';value.recipe=null;}return value;
}
/** Record authored metadata after assigning the public shape. This does not edit it. */
export function setHarmonyChordSource(chord:model.Chord,value:HarmonyChord):void {
  validateHarmonyChord(value);sources.set(chord,structuredClone(value));
}
/** Explicit clones with new chord IDs retain raw provenance, even in stale contexts. */
export function copyHarmonyChord(source:model.Chord,destination:model.Chord):void {
  const value=sources.get(source);if(value)sources.set(destination,structuredClone(value));else sources.delete(destination);
}
/** Call immediately after a full clone, before deleting or reordering tracks. */
export function copyHarmonySources(source:model.Score,destination:model.Score):void {
  destination.tracks.forEach((track,trackIndex)=>track.staves.forEach((staff,staffIndex)=>{
    const original=source.tracks[trackIndex]?.staves[staffIndex];for(const [id,chord]of staff.chords??[]){const previous=original?.getChord(id);if(previous)copyHarmonyChord(previous,chord);else sources.delete(chord);}
  }));
}
