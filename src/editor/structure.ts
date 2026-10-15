import { model, Settings } from '@coderline/alphatab';
import type { EditCommand, StaffSettings } from '../edit-types';
import { enumValue, integer, staffAt, trackAt, validateCapacity } from './common';
import { captureNoteLinks, detachNote, restoreNoteLinks } from './links';
import { scoreFromJson } from '../model-clone';

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
export function applyStructureEdit(score:model.Score,command:EditCommand,_editIndex:number):boolean {
  switch(command.type) {
    case 'setTrackInfo': {
      const track=trackAt(score,command.track);if(typeof command.name!=='string'||typeof command.shortName!=='string'||!integer(command.program,0,127))throw new Error('Invalid track name or MIDI instrument.');
      track.name=command.name;track.shortName=command.shortName;track.playbackInfo.program=command.program;
      for(const staff of track.staves)for(const voice of staff.bars[0]?.voices??[])for(const automation of voice.beats[0]?.automations??[])if(automation.type===model.AutomationType.Instrument&&automation.ratioPosition===0)automation.value=command.program;
      return true;
    }
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
