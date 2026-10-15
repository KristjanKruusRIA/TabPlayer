import { model } from '@coderline/alphatab';
import type { FingeringPlacement,RangeCommand } from './range-types';
import { integer } from './common';
import { allNotes,captureNoteLinks,detachNote } from './links';
import { planFingering } from './fingering';
import { resolveSelectionBeats,resolveSelectionNotes } from './range-selection';

function fields(value:object,keys:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid range command fields.');
}
function pitch(value:number,label='pitch') {if(!integer(value,0,127))throw new Error(`The ${label} is outside the playable MIDI pitch range.`);}
function candidate(note:model.Note,string:number,fret:number) {
  const value=new model.Note();value.beat=note.beat;value.string=string;value.fret=fret;value.harmonicType=note.harmonicType;value.harmonicValue=note.harmonicValue;return value;
}
function stringed(note:model.Note) {
  const staff=note.beat.voice.bar.staff;
  if(staff.isPercussion||!staff.tuning.length||!note.isStringed)throw new Error('Select stringed guitar or bass notes.');
  if(staff.tuning.length>12||!integer(note.string,1,staff.tuning.length)||!integer(note.fret,0,127))throw new Error('Invalid string or fret.');return staff;
}
function detachTie(from:model.Note,to:model.Note) {
  from.tieDestination=null;to.tieOrigin=null;to.isTieDestination=false;to.bendOrigin=null;to.isContinuedBend=false;
}
type Proposal={string?:number;fret?:number;octave?:number;tone?:number;trillValue?:number;accidentalMode?:model.NoteAccidentalMode};
function validateRelationships(score:model.Score,selected:Set<model.Note>,proposals:Map<model.Note,Proposal>,transpose:boolean) {
  const notes=allNotes(score),lookup=new Map(notes.map(note=>[note.id,note])),detached:{from:model.Note;to:model.Note}[]=[];
  const noteString=(note:model.Note)=>proposals.get(note)?.string??note.string;
  const notePitch=(note:model.Note)=>{
    const proposed=proposals.get(note);if(!proposed)return note.realValue;
    return note.isStringed?candidate(note,proposed.string??note.string,proposed.fret??note.fret).realValue:(proposed.octave??note.octave)*12+(proposed.tone??note.tone)-note.beat.voice.bar.staff.transpositionPitch;
  };
  const next=(from:model.Note,proposed:boolean)=>{
    const staff=from.beat.voice.bar.staff,voice=from.beat.voice.index;
    for(let bar=from.beat.voice.bar.index;bar<staff.bars.length;bar++)for(let beat=bar===from.beat.voice.bar.index?from.beat.index+1:0;beat<(staff.bars[bar].voices[voice]?.beats.length??0);beat++){
      const found=staff.bars[bar].voices[voice].beats[beat].notes.find(note=>!note.isDead&&(from.isStringed?(proposed?noteString(note):note.string)===(proposed?noteString(from):from.string):note.isPiano===from.isPiano&&note.isPercussion===from.isPercussion&&(proposed?notePitch(note):note.realValue)===(proposed?notePitch(from):from.realValue)));
      if(found)return found;
    }return null;
  };
  for(const link of captureNoteLinks(score)){
    if(link.kind==='slur')continue;const from=lookup.get(link.from)!,to=lookup.get(link.to)!,a=selected.has(from),b=selected.has(to);
    if(transpose&&link.kind==='tie'&&a!==b){detached.push({from,to});continue;}
    const changed=(note:model.Note)=>noteString(note)!==note.string;
    if(a!==b&&((a&&changed(from))||(b&&changed(to))))throw new Error('A linked note outside the selection prevents changing this string.');
    const sameLane=from.beat.voice.bar.staff===to.beat.voice.bar.staff&&from.beat.voice.index===to.beat.voice.index;
    const forward=to.beat.voice.bar.index>from.beat.voice.bar.index||(to.beat.voice.bar===from.beat.voice.bar&&to.beat.index>from.beat.index);
    const valid=sameLane&&forward&&(!from.isStringed||noteString(from)===noteString(to))&&(link.kind!=='tie'||notePitch(from)===notePitch(to))&&next(from,true)===to;
    if((a||b||next(from,false)===to)&&!valid)throw new Error('The edit would break a forward, next-note relationship on this string or staff.');
  }
  return detached;
}
function validatePlacements(placements:FingeringPlacement[]) {
  const strings=new Set<number>();for(const placement of placements){if(strings.has(placement.string))throw new Error('The destination string is occupied.');strings.add(placement.string);const note=candidate(placement.note,placement.string,placement.fret);pitch(note.realValueWithoutHarmonic);pitch(note.realValue);}
}
export function applyRangeEdit(score:model.Score,command:RangeCommand):boolean {
  if(!['eraseSelection','transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain'].includes(command.type))return false;
  const keys={eraseSelection:[],transposeSelection:['semitones'],moveSelectionStrings:['direction'],refingerSelection:['maxFret'],setSelectionSustain:['strings','kind','enabled']}[command.type];fields(command,['type','selection',...keys]);
  const beats=resolveSelectionBeats(score,command.selection),notes=resolveSelectionNotes(score,command.selection),selected=new Set(notes);
  if(command.type==='eraseSelection'){
    for(const note of notes){const beat=note.beat;detachNote(note);beat.removeNote(note);beat.notes.forEach((member,index)=>member.index=index);beat.isEmpty=false;}return true;
  }
  if(command.type==='setSelectionSustain'){
    if(!Array.isArray(command.strings)||!command.strings.length||new Set(command.strings).size!==command.strings.length||!['letRing','palmMute'].includes(command.kind)||typeof command.enabled!=='boolean')throw new Error('Choose unique strings and a sustain setting.');
    const selection=command.selection,staves=selection.kind==='range'?selection.range.lanes.map(lane=>score.tracks[lane.track].staves[lane.staff]):selection.kind==='bars'?selection.tracks.flatMap(track=>score.tracks[track].staves):notes.map(note=>note.beat.voice.bar.staff);
    for(const staff of new Set(staves))if(staff.isPercussion||!staff.tuning.length||command.strings.some(value=>!integer(value,1,staff.tuning.length)))throw new Error('Choose existing strings on stringed guitar or bass lanes.');
    for(const note of notes)stringed(note);
    for(const note of notes)if(command.strings.includes(note.string))note[command.kind==='letRing'?'isLetRing':'isPalmMute']=command.enabled;return true;
  }
  const proposals=new Map<model.Note,Proposal>();
  if(command.type==='transposeSelection'){
    if(!integer(command.semitones,-127,127)||command.semitones===0)throw new Error('Choose nonzero semitones from −127 to 127.');
    const delta=command.semitones;
    for(const note of notes){
      if(note.isPercussion||note.beat.voice.bar.staff.isPercussion)throw new Error('Percussion notes cannot be transposed.');
      pitch(note.realValueWithoutHarmonic+delta);pitch(note.realValue+delta);
      if(note.isTrill)pitch(note.trillValue+delta,'trill pitch');
      proposals.set(note,{accidentalMode:model.NoteAccidentalMode.Default,...note.isTrill?{trillValue:note.trillValue+delta}:{}});
      if(!note.isStringed){if(!note.isPiano)throw new Error('Select a pitched note.');const written=note.octave*12+note.tone+delta;pitch(written,'written pitch');Object.assign(proposals.get(note)!,{octave:Math.floor(written/12),tone:written%12});}
    }
    for(const beat of beats){const moved=beat.notes.filter(note=>selected.has(note)&&note.isStringed);if(!moved.length)continue;const staff=stringed(moved[0]);for(const note of moved)stringed(note);
      let placements=beat.notes.map(note=>({note,string:note.string,fret:note.fret+(selected.has(note)?delta:0)}));
      if(placements.some(placement=>!integer(placement.fret,0,127)||candidate(placement.note,placement.string,placement.fret).realValue!==placement.note.realValue+(selected.has(placement.note)?delta:0))||new Set(placements.map(placement=>placement.string)).size!==placements.length)
        placements=planFingering(staff,beat.notes.map(note=>({note,pitch:note.realValue+(selected.has(note)?delta:0),preferredString:note.string,fixedString:selected.has(note)?null:note.string})),127);
      validatePlacements(placements);for(const placement of placements)if(selected.has(placement.note))Object.assign(proposals.get(placement.note)!,{string:placement.string,fret:placement.fret});
    }
  }else if(command.type==='moveSelectionStrings'){
    if(!['higher','lower'].includes(command.direction))throw new Error('Choose a string move direction.');
    for(const note of notes){const staff=stringed(note),strings=staff.tuning.map((_,index)=>({string:index+1,open:model.Note.getStringTuning(staff,index+1)+staff.capo-staff.transpositionPitch})).sort((a,b)=>a.open-b.open||a.string-b.string);
      const current=strings.findIndex(value=>value.string===note.string),destination=strings[current+(command.direction==='higher'?1:-1)];
      if(!destination)throw new Error('There is no adjacent string in that direction.');
      if(strings.some(value=>value.string!==note.string&&value.open===strings[current].open)||strings.some(value=>value.string!==destination.string&&value.open===destination.open))throw new Error('Equal open pitches make the adjacent string ambiguous.');
      const fret=note.fret+strings[current].open-destination.open,test=candidate(note,destination.string,fret);
      if(!integer(fret,0,127)||test.realValue!==note.realValue)throw new Error('The adjacent string cannot preserve this pitch and harmonic.');
      proposals.set(note,{string:destination.string,fret});
    }
    for(const beat of beats)validatePlacements(beat.notes.map(note=>({note,string:proposals.get(note)?.string??note.string,fret:proposals.get(note)?.fret??note.fret})));
  }else{
    if(!integer(command.maxFret,1,127))throw new Error('Choose a maximum fret from 1 to 127.');
    for(const beat of [...beats].sort((a,b)=>a.voice.bar.index-b.voice.bar.index||a.index-b.index||a.voice.bar.staff.track.index-b.voice.bar.staff.track.index||a.voice.index-b.voice.index)){
      if(!beat.notes.length)continue;const staff=stringed(beat.notes[0]);for(const note of beat.notes)stringed(note);
      const linked=(note:model.Note)=>!!(note.tieOrigin||note.tieDestination||note.hammerPullOrigin||note.hammerPullDestination||note.slideOrigin||note.slideTarget);
      const placements=planFingering(staff,beat.notes.map(note=>({note,pitch:note.realValue,preferredString:note.string,fixedString:!selected.has(note)||linked(note)?note.string:null})),command.maxFret);
      validatePlacements(placements);for(const placement of placements)if(selected.has(placement.note))proposals.set(placement.note,{string:placement.string,fret:placement.fret});
    }
  }
  const detached=validateRelationships(score,selected,proposals,command.type==='transposeSelection');
  for(const [note,proposal] of proposals)Object.assign(note,proposal);for(const {from,to} of detached)detachTie(from,to);return true;
}
