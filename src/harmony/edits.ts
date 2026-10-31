import { model } from '@coderline/alphatab';
import type { HarmonyCommand } from '../editor/harmony-types';
import { durationValues,integer,locationAt,rhythmTicks,validateCapacity } from '../editor/common';
import { getHarmonyChord,setHarmonyChordSource } from './chord-source';

export function applyHarmonyEdit(score:model.Score,command:HarmonyCommand,editIndex:number):boolean {
  if(command.type!=='setBeatText'&&command.type!=='setHarmonyChord')return false;
  const {staff,voice}=locationAt(score,command.target),beat=voice.beats[command.target.beat];if(!beat)throw new Error('Select an existing beat.');
  if(command.type==='setBeatText'){
    if(typeof command.text!=='string')throw new Error('Invalid beat text.');beat.text=command.text||null;return true;
  }
  if(typeof command.fillEmptyBeat!=='boolean'||!integer(editIndex,0,0xffffffff))throw new Error('Invalid harmony edit.');
  if(command.chord===null){beat.chordId=null;return true;}
  const value=command.chord,chord=new model.Chord();setHarmonyChordSource(chord,value);
  if(value.frets.length!==staff.tuning.length)throw new Error('Use one open, muted or fretted position for each staff string.');
  Object.assign(chord,{staff,name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});
  if(value.nameMode==='theory'&&getHarmonyChord(chord).nameMode!=='theory')throw new Error('The diagram must contain exactly the formula tones and bass in this sounding context.');
  const notes:model.Note[]=[];
  if(command.fillEmptyBeat&&value.showDiagram&&beat.notes.length===0&&value.frets.some(fret=>fret>=0)){
    if(staff.isPercussion||staff.tuning.length===0||staff.tuning.some(pitch=>!integer(pitch,0,127))||!integer(staff.capo,0,127)||!integer(staff.transpositionPitch,-127,127))throw new Error('Choose a tuned melodic staff to fill diagram notes.');
    if(beat.duration<=0||!durationValues.includes(beat.duration as never))throw new Error('Choose an explicit usable rhythm before filling this beat.');
    const candidateVoice=new model.Voice();candidateVoice.bar=voice.bar;
    const candidate=Object.assign(new model.Beat(),beat,{voice:candidateVoice,notes,isEmpty:false});
    for(let index=0;index<value.frets.length;index++){
      const fret=value.frets[index];if(fret<0)continue;
      const note=new model.Note();note.beat=candidate;note.string=value.frets.length-index;note.fret=fret;note.dynamics=beat.dynamics;
      if(!integer(note.realValueWithoutHarmonic,0,127)||!integer(note.realValue,0,127))throw new Error('The diagram contains a note outside the MIDI pitch range.');notes.push(note);
    }
    candidateVoice.beats=voice.beats.map(item=>item===beat?candidate:item);
    if(!Number.isFinite(rhythmTicks(candidate))||rhythmTicks(candidate)<=0)throw new Error('Choose an explicit usable rhythm before filling this beat.');validateCapacity(candidateVoice);
  }
  const {track,staff:staffIndex,bar,voice:voiceIndex,beat:beatIndex}=command.target,id=`harmony/${editIndex}/${track}/${staffIndex}/${bar}/${voiceIndex}/${beatIndex}`;
  staff.addChord(id,chord);beat.chordId=id;for(const note of notes)beat.addNote(note);if(notes.length)beat.isEmpty=false;return true;
}
