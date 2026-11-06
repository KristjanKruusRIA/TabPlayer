import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { integer, locationAt, noteAt, validateCapacity } from './common';
import { detachNote } from './links';
import { resolvePercussionArticulation } from './percussion-catalog';
import { applyNoteLink, applyNoteTechniques } from './techniques';

function addTrack(score:model.Score,name:string,program:number,percussion:boolean) {
  if(typeof name!=='string'||!integer(program,0,127))throw new Error('Invalid track name or MIDI instrument.');
  const track=new model.Track();track.name=name||'Instrument';track.shortName=track.name;track.playbackInfo.program=program;
  const used=new Set(score.tracks.flatMap(t=>[t.playbackInfo.primaryChannel,t.playbackInfo.secondaryChannel]));
  const channel=()=>{let value=0;while(value===9||used.has(value))value++;used.add(value);return value;};
  track.playbackInfo.primaryChannel=percussion?9:channel();track.playbackInfo.secondaryChannel=percussion?9:channel();
  const staff=new model.Staff();staff.showTablature=false;staff.showStandardNotation=true;staff.isPercussion=percussion;track.addStaff(staff);score.addTrack(track);
  for(const master of score.masterBars){const bar=new model.Bar();bar.clef=percussion?model.Clef.Neutral:model.Clef.G2;const voice=new model.Voice();for(let i=0;i<master.timeSignatureNumerator;i++){const beat=new model.Beat();beat.duration=master.timeSignatureDenominator;beat.isEmpty=false;voice.addBeat(beat);}bar.addVoice(voice);staff.addBar(bar);}
}
/** The notes tied to `note`, first to last. */
export function tieChain(note:model.Note) {
  const seen=new Set<model.Note>();while(note.tieOrigin&&!seen.has(note)){seen.add(note);note=note.tieOrigin;}
  const result:model.Note[]=[];seen.clear();for(let current:model.Note|null=note;current&&!seen.has(current);current=current.tieDestination){seen.add(current);result.push(current);}return result;
}
function validatePitch(staff:model.Staff,pitch:number) {
  if(staff.isPercussion||staff.tuning.length)throw new Error('Select a pitched staff without tablature strings.');
  if(!integer(pitch,0,127)||!integer(pitch-staff.transpositionPitch,0,127))throw new Error('That written pitch is outside the playable MIDI pitch range.');
}
function validateArticulation(staff:model.Staff,articulation:number) {
  if(!staff.isPercussion)throw new Error('Select a percussion staff.');
  if(!resolvePercussionArticulation(staff.track,articulation))throw new Error('Select a playable registered percussion articulation.');
}
function collision(beat:model.Beat,value:number,percussion:boolean,except?:model.Note) {
  if(beat.notes.some(n=>n!==except&&(percussion?n.isPercussion&&n.percussionArticulation===value:n.isPiano&&n.octave*12+n.tone===value)))throw new Error('This beat already contains that note.');
}
export function applyNonTabEdit(score:model.Score,edit:EditCommand):boolean {
  switch(edit.type){
    case 'addPitchedTrack':case 'addPercussionTrack':addTrack(score,edit.name,edit.program,edit.type==='addPercussionTrack');return true;
    case 'addPitchedNote':case 'addPercussionNote':{
      const {staff,voice}=locationAt(score,edit.target),beat=voice.beats[edit.target.beat];if(!beat)throw new Error('Select an existing beat.');
      const percussion=edit.type==='addPercussionNote',value=percussion?edit.articulation:edit.pitch;
      if(percussion)validateArticulation(staff,value);else validatePitch(staff,value);collision(beat,value,percussion);
      const empty=beat.isEmpty;beat.isEmpty=false;try{validateCapacity(voice);}finally{beat.isEmpty=empty;}
      const note=new model.Note();if(percussion)note.percussionArticulation=value;else{note.octave=Math.floor(value/12);note.tone=value%12;}beat.addNote(note);beat.isEmpty=false;return true;
    }
    case 'setPitchedNote':case 'setPercussionNote':{
      const note=noteAt(score,{target:edit.target,noteIndex:edit.noteIndex}),percussion=edit.type==='setPercussionNote',value=percussion?edit.articulation:edit.pitch;
      const chain=tieChain(note);for(const member of chain){const staff=member.beat.voice.bar.staff;if(percussion){validateArticulation(staff,value);if(!member.isPercussion)throw new Error('Select a percussion note.');}else{validatePitch(staff,value);if(!member.isPiano)throw new Error('Select a pitched note.');}collision(member.beat,value,percussion,member);}
      for(const member of chain)if(percussion)member.percussionArticulation=value;else{member.octave=Math.floor(value/12);member.tone=value%12;}return true;
    }
    case 'removeNoteByIndex':{
      const note=noteAt(score,{target:edit.target,noteIndex:edit.noteIndex}),beat=note.beat;detachNote(note);beat.removeNote(note);beat.notes.forEach((n,index)=>n.index=index);beat.isEmpty=false;return true;
    }
    case 'setNoteTechniquesByIndex':applyNoteTechniques(score,{target:edit.target,noteIndex:edit.noteIndex},edit.patch);return true;
    case 'setNoteLinkByIndex':applyNoteLink(score,edit.from,edit.to,edit.kind);return true;
    default:return false;
  }
}
