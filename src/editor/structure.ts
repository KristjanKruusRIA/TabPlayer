import { model, Settings } from '@coderline/alphatab';
import type { EditCommand, StaffSettings, StringCountKeep } from '../edit-types';
import { getHarmonyChord, setHarmonyChordSource } from '../harmony/chord-source';
import { enumValue, integer, staffAt, trackAt, validateCapacity } from './common';
import { allNotes, captureNoteLinks, detachNote, restoreNoteLinks } from './links';
import { scoreFromJson } from '../model-clone';
import { parseTrackColor } from '../track-color';

function validateStaff(staff:model.Staff|null,settings:StaffSettings) {
  if(!Array.isArray(settings.tuning)||settings.tuning.some(p=>!integer(p,0,127))||(!settings.tuning.length&&settings.showTab&&!staff?.isPercussion))throw new Error('Use MIDI tuning pitches from 0 to 127.');
  if(staff&&staff.tuning.length!==settings.tuning.length)throw new Error('Retuning must keep the current string count.');
  if(!integer(settings.capo,0,127)||!integer(settings.transposition,-127,127)||!integer(settings.displayTransposition,-127,127))throw new Error('Invalid capo or transposition.');
  enumValue(settings.clef,model.Clef,'clef');if(typeof settings.showTab!=='boolean'||typeof settings.showNotation!=='boolean'||(!settings.showTab&&!settings.showNotation))throw new Error('Show tablature or standard notation.');
  for(const bar of staff?.bars??[])for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes) {
    if(staff?.isPercussion)continue;
    const pitch=note.string>0?settings.tuning[settings.tuning.length-note.string]+note.fret+settings.capo-settings.transposition+note.harmonicPitch:note.octave*12+note.tone-settings.transposition;
    if(!Number.isFinite(pitch)||pitch<0||pitch>127)throw new Error('Staff settings put a note outside the playable MIDI pitch range.');
  }
}
function configure(staff:model.Staff,settings:StaffSettings) {
  staff.stringTuning.tunings=[...settings.tuning];staff.capo=settings.capo;staff.transpositionPitch=settings.transposition;staff.displayTranspositionPitch=settings.displayTransposition;staff.showTablature=settings.showTab;staff.showStandardNotation=settings.showNotation;
  for(const bar of staff.bars)bar.clef=settings.clef;
}
function emptyVoice() {const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);return voice;}
function detachVoice(voice:model.Voice) {for(const beat of voice.beats)for(const note of beat.notes)detachNote(note);}
export function validateStringCount(tuning:unknown,keep:unknown):asserts tuning is number[] {
  if(!Array.isArray(tuning)||tuning.length<1||tuning.length>12||tuning.some(pitch=>!integer(pitch,0,127)))throw new Error('Use 1 to 12 MIDI tuning pitches from 0 to 127.');
  if(keep!=='high'&&keep!=='low')throw new Error('Choose whether to keep the high or the low strings.');
}
/** Index from the highest string in the new tuning for an old index, or null for a removed string. */
function keptIndex(index:number,from:number,to:number,keep:StringCountKeep) {
  const mapped=keep==='high'?index:index+to-from;return mapped>=0&&mapped<to?mapped:null;
}
const maxRelocatedFret=24;
/** Changes a track's string count. Notes keep their sounding pitch: on their kept string when the fret stays
 * playable, otherwise on a free string of the same beat; chord diagrams follow the kept strings. */
function setStringCount(track:model.Track,tuning:number[],keep:StringCountKeep) {
  validateStringCount(tuning,keep);
  const staves=track.staves;
  if(track.isPercussion||staves.some(staff=>staff.isPercussion||!staff.tuning.length))throw new Error('Only stringed guitar or bass tracks have strings to add or remove.');
  if(staves.some(staff=>staff.tuning.length===tuning.length))throw new Error('The string count is unchanged; use Apply tuning to retune.');
  const moves:{note:model.Note;string:number;fret:number}[]=[];
  for(const staff of staves){
    const from=staff.tuning.length,to=tuning.length,open=(string:number)=>tuning[to-string];
    for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats){
      const planned=new Map<model.Note,{string:number;fret:number}>(),used=new Set<number>();
      const notes=beat.notes.filter(note=>note.string>0);
      for(const note of notes){
        const index=keptIndex(from-note.string,from,to,keep);if(index===null)continue;
        const string=to-index,fret=note.fret+staff.tuning[from-note.string]-open(string);
        if(fret>=0&&fret<=127&&(!note.harmonicType||fret===note.fret)){planned.set(note,{string,fret});used.add(string);}
      }
      const displaced=new Map<model.Note,{string:number;fret:number}[]>();
      for(const note of notes){
        if(planned.has(note))continue;
        const where=`bar ${bar.index+1}, beat ${beat.index+1}`;
        if(note.harmonicType||note.tieOrigin||note.tieDestination||note.slideTarget||note.slideOrigin||note.hammerPullOrigin||note.hammerPullDestination||note.slurOrigin||note.slurDestination)throw new Error(`The linked or harmonic note at ${where} would have to move to another string.`);
        const pitch=staff.tuning[from-note.string]+note.fret;
        displaced.set(note,Array.from({length:to},(_,i)=>to-i).filter(string=>!used.has(string)).map(string=>({string,fret:pitch-open(string)})).filter(choice=>choice.fret>=0&&choice.fret<=maxRelocatedFret).sort((a,b)=>a.fret-b.fret));
      }
      // Augment a matching of movable notes only; retained placements stay fixed.
      const assigned=new Map<number,model.Note>();
      const assign=(note:model.Note,visited:Set<number>):boolean=>{
        for(const choice of displaced.get(note)!){
          if(visited.has(choice.string))continue;visited.add(choice.string);
          const previous=assigned.get(choice.string);
          if(previous&&!assign(previous,visited))continue;
          assigned.set(choice.string,note);planned.set(note,choice);return true;
        }
        return false;
      };
      for(const note of displaced.keys())if(!assign(note,new Set()))throw new Error(`The note at bar ${bar.index+1}, beat ${beat.index+1} has no playable string in the new tuning.`);
      for(const [note,place] of planned)moves.push({note,...place});
    }
  }
  const proposed=new Map(moves.map(move=>[move.note,move])),lookup=new Map(allNotes(track.score).map(note=>[note.id,note]));
  const noteString=(note:model.Note)=>proposed.get(note)?.string??note.string;
  for(const link of captureNoteLinks(track.score)){
    if(link.kind==='slur')continue;
    const from=lookup.get(link.from)!,to=lookup.get(link.to)!;
    if(!proposed.has(from)&&!proposed.has(to))continue;
    const staff=from.beat.voice.bar.staff,voice=from.beat.voice.index;
    let next:model.Note|undefined;
    for(let bar=from.beat.voice.bar.index;bar<staff.bars.length&&!next;bar++)for(let beat=bar===from.beat.voice.bar.index?from.beat.index+1:0;beat<(staff.bars[bar].voices[voice]?.beats.length??0)&&!next;beat++)
      next=staff.bars[bar].voices[voice].beats[beat].notes.find(note=>!note.isDead&&noteString(note)===noteString(from));
    if(next!==to||noteString(from)!==noteString(to)||link.kind==='tie'&&from.realValue!==to.realValue)throw new Error('The edit would break a forward, next-note relationship on this string or staff.');
  }
  for(const {note,string,fret} of moves){note.string=string;note.fret=fret;}
  for(const staff of staves){
    const from=staff.tuning.length,to=tuning.length;
    for(const chord of staff.chords?.values()??[]){
      if(chord.strings.length!==from)continue;
      const value=getHarmonyChord(chord),remap=<T,>(values:T[],empty:T)=>Array.from({length:to},(_,index)=>{const old=keep==='high'?index:index-to+from;return old>=0&&old<from?values[old]:empty;});
      chord.strings=remap(chord.strings,-1);
      setHarmonyChordSource(chord,{...value,frets:[...chord.strings],fingers:remap(value.fingers,-2)});
    }
    staff.stringTuning.tunings=[...tuning];staff.stringTuning.name='';
  }
}
export function applyStructureEdit(score:model.Score,command:EditCommand,_editIndex:number):boolean {
  switch(command.type) {
    case 'setTrackInfo': {
      const track=trackAt(score,command.track);if(typeof command.name!=='string'||typeof command.shortName!=='string'||!integer(command.program,0,127))throw new Error('Invalid track name or MIDI instrument.');
      track.name=command.name;track.shortName=command.shortName;track.playbackInfo.program=command.program;
      for(const staff of track.staves)for(const voice of staff.bars[0]?.voices??[])for(const automation of voice.beats[0]?.automations??[])if(automation.type===model.AutomationType.Instrument&&automation.ratioPosition===0)automation.value=command.program;
      return true;
    }
    case 'setStringCount': {setStringCount(trackAt(score,command.track),command.tuning,command.keep);return true;}
    case 'setTrackColor': {const track=trackAt(score,command.track);track.color=parseTrackColor(command.color);return true;}
    case 'setStaffSettings': {const staff=staffAt(score,command.track,command.staff);validateStaff(staff,command.settings);configure(staff,command.settings);return true;}
    case 'addStaff': {
      const track=trackAt(score,command.track);validateStaff(null,command.settings);const staff=new model.Staff();configure(staff,command.settings);track.addStaff(staff);
      for(const master of score.masterBars){const bar=new model.Bar();bar.clef=command.settings.clef;bar.addVoice(emptyVoice());staff.addBar(bar);bar.index=master.index;}return true;
    }
    case 'removeStaff': {
      const staff=staffAt(score,command.track,command.staff);if(staff.track.staves.length===1)throw new Error('Keep at least one staff.');
      for(const bar of staff.bars)for(const voice of bar.voices)detachVoice(voice);staff.track.staves.splice(command.staff,1);staff.track.staves.forEach((s,i)=>s.index=i);return true;
    }
    case 'addVoice': {
      const staff=staffAt(score,command.track,command.staff);if(staff.bars.some(b=>b.voices.length>=4))throw new Error('A staff supports one to four voices.');
      const count=Math.max(...staff.bars.map(b=>b.voices.length))+1;for(const bar of staff.bars)while(bar.voices.length<count)bar.addVoice(emptyVoice());return true;
    }
    case 'removeVoice': {
      const staff=staffAt(score,command.track,command.staff);if(!integer(command.voice)||staff.bars.some(b=>!b.voices[command.voice]))throw new Error('Select an existing voice.');if(staff.bars.some(b=>b.voices.length===1))throw new Error('Keep at least one voice.');
      for(const bar of staff.bars){detachVoice(bar.voices[command.voice]);bar.voices.splice(command.voice,1);bar.voices.forEach((v,i)=>v.index=i);}return true;
    }
    case 'copyVoice': {
      const staff=staffAt(score,command.track,command.staff);const {sourceVoice,destinationVoice,startBar,endBar}=command;
      if(!integer(startBar)||!integer(endBar,startBar,staff.bars.length-1)||!integer(sourceVoice,0,3)||!integer(destinationVoice,0,3)||sourceVoice===destinationVoice||staff.bars.slice(startBar,endBar+1).some(b=>!b.voices[sourceVoice]||!b.voices[destinationVoice]))throw new Error('Choose different existing voices and an inclusive measure range.');
      for(const bar of staff.bars.slice(startBar,endBar+1))validateCapacity(bar.voices[sourceVoice]);
      const cloned=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());
      const noteIds=new Map<number,number>(),copies:model.Voice[]=[];
      for(let bar=startBar;bar<=endBar;bar++) {
        const voice=cloned.tracks[command.track].staves[command.staff].bars[bar].voices[sourceVoice];voice.id=new model.Voice().id;voice.bar=staff.bars[bar];voice.index=destinationVoice;
        for(const beat of voice.beats){beat.id=new model.Beat().id;beat.voice=voice;for(const note of beat.notes){const oldId=note.id,slide=note.slideOutType;detachNote(note);if(slide>=model.SlideOutType.OutUp)note.slideOutType=slide;note.id=new model.Note().id;noteIds.set(oldId,note.id);}}
        copies.push(voice);
      }
      const links=captureNoteLinks(score).filter(l=>noteIds.has(l.from)&&noteIds.has(l.to)).map(l=>({...l,from:noteIds.get(l.from)!,to:noteIds.get(l.to)!}));
      for(let bar=startBar;bar<=endBar;bar++){detachVoice(staff.bars[bar].voices[destinationVoice]);staff.bars[bar].voices[destinationVoice]=copies[bar-startBar];}
      restoreNoteLinks(score,[...captureNoteLinks(score),...links]);return true;
    }
    case 'setTrackLayout': {
      const track=trackAt(score,command.track);if(!integer(command.barsPerSystem,1)||!Array.isArray(command.lineBreaks)||command.lineBreaks.some(n=>!integer(n,0,score.masterBars.length-1)))throw new Error('Invalid system layout.');
      track.defaultSystemsLayout=command.barsPerSystem;track.systemsLayout=[];track.lineBreaks=new Set(command.lineBreaks);return true;
    }
    default:return false;
  }
}
