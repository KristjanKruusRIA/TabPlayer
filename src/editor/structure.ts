import { model, Settings } from '@coderline/alphatab';
import type { EditCommand, StaffSettings, StringCountKeep } from '../edit-types';
import { getHarmonyChord, setHarmonyChordSource, validateHarmonyChord } from '../harmony/chord-source';
import { enumValue, integer, staffAt, trackAt, validateCapacity } from './common';
import { allNotes, captureNoteLinks, detachNote, restoreNoteLinks } from './links';
import { scoreFromJson } from '../model-clone';
import { parseTrackColor } from '../track-color';
import { droneShift, droneString, droneTuningOk, fretExists, getBanjoDrone, rebaseDroneTrills, setBanjoDrone, validateBanjoDrone } from './banjo-drone';
import { getPartialCapo, partialLift, rebaseTrills, remapPartialCapo, setPartialCapo, validatePartialCapo } from './partial-capo';
import { refingerStaff } from './refinger';

const xmlText=/^(?:[\t\n\r\u0020-\uD7FF\uE000-\uFFFD]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;
/** An omitted name is valid; a present one must be a string of XML 1.0 characters (empty allowed). */
export function validateTuningName(name:unknown):asserts name is string|undefined {
  if(name!==undefined&&(typeof name!=='string'||!xmlText.test(name)))throw new Error('A tuning name may contain only XML text characters.');
}
export const holds=(from:model.Note,to:model.Note,stringOf:(note:model.Note)=>number)=>{
  const staff=from.beat.voice.bar.staff,voice=from.beat.voice.index;
  let next:model.Note|undefined;
  for(let bar=from.beat.voice.bar.index;bar<staff.bars.length&&!next;bar++)for(let beat=bar===from.beat.voice.bar.index?from.beat.index+1:0;beat<(staff.bars[bar].voices[voice]?.beats.length??0)&&!next;beat++)
    next=staff.bars[bar].voices[voice].beats[beat].notes.find(note=>!note.isDead&&stringOf(note)===stringOf(from));
  return next===to&&stringOf(from)===stringOf(to);
};
function validateStaff(staff:model.Staff|null,settings:StaffSettings) {
  validateTuningName(settings.tuningName);
  if(!Array.isArray(settings.tuning)||settings.tuning.some(p=>!integer(p,0,127))||(!settings.tuning.length&&settings.showTab&&!staff?.isPercussion))throw new Error('Use MIDI tuning pitches from 0 to 127.');
  if(staff&&staff.tuning.length!==settings.tuning.length)throw new Error('Retuning must keep the current string count.');
  if(!integer(settings.capo,0,127)||!integer(settings.transposition,-127,127)||!integer(settings.displayTransposition,-127,127))throw new Error('Invalid capo or transposition.');
  enumValue(settings.clef,model.Clef,'clef');if(typeof settings.showTab!=='boolean'||typeof settings.showNotation!=='boolean'||(!settings.showTab&&!settings.showNotation))throw new Error('Show tablature or standard notation.');
  // An omitted partial capo keeps the staff's own.
  if(settings.partialCapo!==undefined)validatePartialCapo(settings.partialCapo,settings.tuning.length);
  const partial=settings.partialCapo===undefined?staff?getPartialCapo(staff):null:settings.partialCapo;
  if(settings.droneFret!==undefined)validateBanjoDrone(settings.droneFret,settings.tuning.length,settings.tuning);
  const drone=settings.droneFret===undefined?staff?getBanjoDrone(staff):0:settings.droneFret;
  if(drone>0&&!droneTuningOk(settings.tuning))throw new Error("The banjo drone is string 1, which must be tuned higher than string 2.");
  // Keep pitch moves the notes of a strung staff; refinger.ts checks their new pitches. Every other note is checked here.
  const refingers=!!settings.keepPitch&&!!staff&&!staff.isPercussion&&staff.tuning.length>0;
  {
  for(const bar of staff?.bars??[])for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes) {
    if(staff?.isPercussion||(refingers&&note.string>0))continue;
    if(note.string===droneString&&!note.isDead&&!fretExists(staff!,note.string,note.fret,drone))throw new Error(`The banjo drone string has no frets 1 to ${drone}: bar ${bar.index+1} has fret ${note.fret} on it.`);
    if(note.string===droneString&&note.trillValue>=0){const shift=droneShift(staff!,note.string,note.fret,drone)-droneShift(staff!,note.string,note.fret),moved=note.trillValue+shift;if(shift&&(moved<0||moved>127))throw new Error('Staff settings put a trill outside the playable MIDI pitch range.');}
    const capo=partial?.strings.includes(note.string)?Math.max(settings.capo,partial.fret):settings.capo;
    const pitch=note.string>0?settings.tuning[settings.tuning.length-note.string]+note.fret+capo+droneShift(staff!,note.string,note.fret,drone)-settings.transposition+note.harmonicPitch:note.octave*12+note.tone-settings.transposition;
    if(!Number.isFinite(pitch)||pitch<0||pitch>127)throw new Error('Staff settings put a note outside the playable MIDI pitch range.');
  }
  }
}
/** The name alphaTab gives an unnamed tuning it recognises; routes that omit a name keep it, as before S15. */
export function defaultTuningName(tuning:readonly number[]):string {return model.Tuning.findTuning([...tuning])?.name??'';}
/** `refingered`: the notes were moved to keep their sounding pitch, so a trill (an absolute pitch) already has the right interval and must not be rebased. */
function configure(staff:model.Staff,settings:StaffSettings,refingered=false) {
  const oldCapo=staff.capo;staff.stringTuning.tunings=[...settings.tuning];staff.capo=settings.capo;staff.transpositionPitch=settings.transposition;staff.displayTranspositionPitch=settings.displayTransposition;staff.showTablature=settings.showTab;staff.showStandardNotation=settings.showNotation;
  if(settings.partialCapo!==undefined){const before=getPartialCapo(staff);setPartialCapo(staff,settings.partialCapo);if(!refingered)rebaseTrills(staff,oldCapo,before,getPartialCapo(staff));}
  if(settings.droneFret!==undefined){const before=getBanjoDrone(staff);setBanjoDrone(staff,settings.droneFret);if(!refingered)rebaseDroneTrills(staff,before,settings.droneFret);}
  for(const bar of staff.bars)bar.clef=settings.clef;
  // An omitted name keeps the current one, and an empty one gets alphaTab's label as it did before S15.
  if(settings.tuningName!==undefined)staff.stringTuning.name=settings.tuningName;else if(!staff.stringTuning.name)staff.stringTuning.name=defaultTuningName(settings.tuning);
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
export const maxRelocatedFret=24;
export type Place={string:number;fret:number};
export const linked=(note:model.Note)=>!!(note.harmonicType||note.tieOrigin||note.tieDestination||note.slideTarget||note.slideOrigin||note.hammerPullOrigin||note.hammerPullDestination||note.slurOrigin||note.slurDestination);
/** Places one beat's notes on the new strings, or returns null. A note stays on its kept string when the refretted
 * fret is playable: up to fret 24, or its own fret if already higher. Other notes take a free string at the same
 * pitch, the lowest fret first; dead notes have no pitch and keep their fret. With `flexible`, notes on kept strings
 * may also move so that every note fits; linked and harmonic notes never move. */
export function placeBeat(notes:model.Note[],kept:(note:model.Note)=>Place|null,choices:(note:model.Note)=>Place[],flexible:boolean,where:string):Map<model.Note,Place>|null {
  const planned=new Map<model.Note,Place>(),options=new Map<model.Note,Place[]>();
  for(const note of notes){
    const place=kept(note),stays=place!==null&&place.fret>=0&&place.fret<=Math.max(maxRelocatedFret,note.fret)&&(!note.harmonicType||place.fret===note.fret);
    if(stays&&(!flexible||linked(note))){planned.set(note,place);continue;}
    if(linked(note))throw new Error(`The linked or harmonic note at ${where} would have to move to another string.`);
    options.set(note,[...(stays?[place]:[]),...choices(note).filter(choice=>choice.string!==place?.string)]);
  }
  const used=new Set([...planned.values()].map(place=>place.string)),assigned=new Map<number,model.Note>();
  const assign=(note:model.Note,visited:Set<number>):boolean=>{
    for(const choice of options.get(note)!){
      if(used.has(choice.string)||visited.has(choice.string))continue;visited.add(choice.string);
      const previous=assigned.get(choice.string);
      if(previous&&!assign(previous,visited))continue;
      assigned.set(choice.string,note);planned.set(note,choice);return true;
    }
    return false;
  };
  for(const note of options.keys())if(!assign(note,new Set()))return null;
  return planned;
}
/** Changes a track's string count. Notes keep their sounding pitch: on their kept string when the fret stays
 * playable, otherwise on a free string of the same beat; chord diagrams follow the kept strings. Everything is
 * planned and checked before the score changes. */
function setStringCount(track:model.Track,tuning:number[],keep:StringCountKeep,tuningName?:string) {
  validateStringCount(tuning,keep);validateTuningName(tuningName);
  const staves=track.staves;
  if(track.isPercussion||staves.some(staff=>staff.isPercussion||!staff.tuning.length))throw new Error('Only stringed guitar or bass tracks have strings to add or remove.');
  if(staves.some(staff=>getBanjoDrone(staff)>0))throw new Error('Remove the banjo drone in the staff settings before changing the string count.');
  if(staves.some(staff=>staff.tuning.length===tuning.length))throw new Error('The string count is unchanged; use Apply tuning to retune.');
  const moves:({note:model.Note}&Place)[]=[],to=tuning.length,remapped=new Map<model.Staff,ReturnType<typeof getPartialCapo>>();
  for(const staff of staves){
    // Fret and pitch are compared under the capo each string has before and after; a staff without a partial capo lifts nothing, as before.
    const from=staff.tuning.length,after=remapPartialCapo(getPartialCapo(staff),from,to,keep),before=getPartialCapo(staff);remapped.set(staff,after);
    const open=(string:number)=>tuning[to-string]+partialLift(staff,string,after),pitch=(note:model.Note)=>staff.tuning[from-note.string]+note.fret+partialLift(staff,note.string,before);
    const kept=(note:model.Note):Place|null=>{const index=keptIndex(from-note.string,from,to,keep);if(index===null)return null;const string=to-index;return {string,fret:note.isDead?note.fret:pitch(note)-open(string)};};
    const choices=(note:model.Note)=>Array.from({length:to},(_,i)=>to-i).map(string=>({string,fret:note.isDead?Math.min(note.fret,maxRelocatedFret):pitch(note)-open(string)})).filter(choice=>choice.fret>=0&&choice.fret<=maxRelocatedFret).sort((a,b)=>a.fret-b.fret);
    for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats){
      const notes=beat.notes.filter(note=>note.string>0),where=`bar ${bar.index+1}, beat ${beat.index+1}`;
      const planned=placeBeat(notes,kept,choices,false,where)??placeBeat(notes,kept,choices,true,where);
      if(!planned)throw new Error(`A note at ${where} has no playable string in the new tuning.`);
      for(const [note,place] of planned)moves.push({note,...place});
    }
  }
  // A tie, slide or hammer-on joins a note to the next note on its string. The change is refused only for a link that
  // holds now and would not afterwards, so a link a file already held some other way is left as it was.
  const proposed=new Map(moves.map(move=>[move.note,move])),lookup=new Map(allNotes(track.score).map(note=>[note.id,note]));
  for(const link of captureNoteLinks(track.score)){
    if(link.kind==='slur')continue;
    const from=lookup.get(link.from)!,to=lookup.get(link.to)!;
    if(holds(from,to,note=>note.string)&&!holds(from,to,note=>proposed.get(note)?.string??note.string))
      throw new Error(`The edit would break the next-note relationship from bar ${from.beat.voice.bar.index+1}, beat ${from.beat.index+1} on its string.`);
  }
  const chords:{chord:model.Chord;strings:number[];source:ReturnType<typeof getHarmonyChord>}[]=[];
  for(const staff of staves){
    const from=staff.tuning.length;
    for(const chord of staff.chords?.values()??[]){
      if(chord.strings.length!==from)continue;
      const value=getHarmonyChord(chord),remap=<T,>(values:T[],empty:T)=>Array.from({length:to},(_,index)=>{const old=keep==='high'?index:index-to+from;return old>=0&&old<from?values[old]:empty;});
      const strings=remap(chord.strings,-1),source={...value,frets:[...strings],fingers:remap(value.fingers,-2)};
      validateHarmonyChord(source);chords.push({chord,strings,source});
    }
  }
  for(const {note,string,fret} of moves){note.string=string;note.fret=fret;}
  for(const {chord,strings,source} of chords){chord.strings=strings;setHarmonyChordSource(chord,source);}
  for(const staff of staves){staff.stringTuning.tunings=[...tuning];staff.stringTuning.name=tuningName??defaultTuningName(tuning);setPartialCapo(staff,remapped.get(staff)??null);}
}
export function applyStructureEdit(score:model.Score,command:EditCommand,_editIndex:number):boolean {
  switch(command.type) {
    case 'setTrackInfo': {
      const track=trackAt(score,command.track);if(typeof command.name!=='string'||typeof command.shortName!=='string'||!integer(command.program,0,127))throw new Error('Invalid track name or MIDI instrument.');
      track.name=command.name;track.shortName=command.shortName;track.playbackInfo.program=command.program;
      for(const staff of track.staves)for(const voice of staff.bars[0]?.voices??[])for(const automation of voice.beats[0]?.automations??[])if(automation.type===model.AutomationType.Instrument&&automation.ratioPosition===0)automation.value=command.program;
      return true;
    }
    case 'setStringCount': {setStringCount(trackAt(score,command.track),command.tuning,command.keep,command.tuningName);return true;}
    case 'setTrackColor': {const track=trackAt(score,command.track);track.color=parseTrackColor(command.color);return true;}
    case 'setStaffSettings': {
      const staff=staffAt(score,command.track,command.staff);
      validateStaff(staff,command.settings);
      const refingered=!!command.settings.keepPitch;
      if(refingered)refingerStaff(staff,command.settings);
      configure(staff,command.settings,refingered);
      return true;
    }
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
