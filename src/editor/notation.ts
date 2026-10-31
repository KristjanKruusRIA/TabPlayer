import { model } from '@coderline/alphatab';
import { setTimeSignatureIntent } from './time-signature-source';
import type { EditCommand } from '../edit-types';
import { buildTempo, isTempoUnit, quarterUnit, type TempoUnit } from './tempo-unit';
import { beatAt, durationValues, enumValue, integer, rhythmTicks, staffAt, validateCapacity } from './common';

export function applyNotationEdit(score:model.Score,command:EditCommand,editIndex:number):boolean {
  switch(command.type) {
    case 'setBeatRhythm': {
      const beat=beatAt(score,command.target);
      if(!durationValues.includes(command.duration as never)||!integer(command.dots,0,3)||!integer(command.tupletNumerator,1)||!integer(command.tupletDenominator,1))throw new Error('Invalid rhythm or tuplet.');enumValue(command.graceType,model.GraceType,'grace type');
      const previous={duration:beat.duration,dots:beat.dots,tupletNumerator:beat.tupletNumerator,tupletDenominator:beat.tupletDenominator,graceType:beat.graceType,overrideDisplayDuration:beat.overrideDisplayDuration};
      beat.duration=command.duration;beat.dots=command.dots;beat.tupletNumerator=command.tupletNumerator;beat.tupletDenominator=command.tupletDenominator;beat.graceType=command.graceType;beat.overrideDisplayDuration=undefined;
      try {validateCapacity(beat.voice);}catch(error){Object.assign(beat,previous);throw error;}
      if(beat.dots===3&&beat.graceType===model.GraceType.None)beat.overrideDisplayDuration=rhythmTicks(beat);beat.updateDurations();return true;
    }
    case 'setMeasureSettings': {
      const master=score.masterBars[command.bar];if(!integer(command.bar)||!master||!integer(command.numerator,1)||![1,2,4,8,16,32,64,128,256].includes(command.denominator)||!integer(command.repeatCount)||typeof command.section!=='string')throw new Error('Invalid measure settings.');
      if([command.pickup,command.freeTime,command.repeatStart].some(v=>typeof v!=='boolean')||!Array.isArray(command.endings)||command.endings.some(n=>!integer(n,1,8)))throw new Error('Invalid repeat or measure state.');
      const measureTicks=command.numerator*3840/command.denominator;
      for(const track of score.tracks)for(const staff of track.staves)for(const voice of staff.bars[command.bar].voices)validateCapacity(voice,measureTicks,command.freeTime);
      const reference=score.tracks[0].staves[0].bars[command.bar].voices[0];let previous=-1;
      if(!Array.isArray(command.tempos))throw new Error('Invalid tempo points.');
      const tempos=command.tempos.map(point=>{if(!integer(point.beat,0,reference.beats.length-1)||point.beat<=previous||!Number.isFinite(point.bpm)||point.bpm<=0||typeof point.linear!=='boolean'||point.unit!==undefined&&!isTempoUnit(point.unit))throw new Error('Use ordered beat positions and positive tempo values.');previous=point.beat;
        const start=reference.beats.slice(0,point.beat).reduce((sum,b)=>sum+rhythmTicks(b,measureTicks),0);return buildTempo(point.linear,start/measureTicks,point.bpm,(point.unit??quarterUnit) as TempoUnit);
      });
      // Common time (C) and a section's own marker survive when the time and section text are unchanged.
      const common=master.timeSignatureCommon&&master.timeSignatureNumerator===command.numerator&&master.timeSignatureDenominator===command.denominator;
      master.timeSignatureNumerator=command.numerator;master.timeSignatureDenominator=command.denominator;master.timeSignatureCommon=common;master.isAnacrusis=command.pickup;master.isFreeTime=command.freeTime;master.isRepeatStart=command.repeatStart;master.repeatCount=command.repeatCount;master.alternateEndings=command.endings.reduce((bits,n)=>bits|(1<<(n-1)),0);master.tempoAutomations=tempos;
      if(!command.section)master.section=null;else if(master.section?.text!==command.section){master.section=new model.Section();master.section.text=command.section;master.section.marker=command.section;}setTimeSignatureIntent(master,common);return true;
    }
    case 'setBarNotation': {
      const staff=staffAt(score,command.track,command.staff),bar=staff.bars[command.bar];if(!integer(command.bar)||!bar||!integer(command.keySignature,-7,7))throw new Error('Invalid key signature.');enumValue(command.keyMode,model.KeySignatureType,'key mode');enumValue(command.clef,model.Clef,'clef');
      bar.keySignature=command.keySignature;bar.keySignatureType=command.keyMode;bar.clef=command.clef;return true;
    }
    case 'setBeatAnnotation': {
      const beat=beatAt(score,command.target),staff=beat.voice.bar.staff;if(typeof command.text!=='string')throw new Error('Invalid beat text.');
      if(command.chord&&(typeof command.chord.name!=='string'||!integer(command.chord.firstFret)||!Array.isArray(command.chord.frets)||command.chord.frets.length!==staff.tuning.length||command.chord.frets.some(n=>!integer(n,-1,127))))throw new Error('Use one open, muted or fretted position for each string.');
      beat.text=command.text||null;
      if(command.chord){const chord=new model.Chord();chord.name=command.chord.name;chord.firstFret=command.chord.firstFret;chord.strings=[...command.chord.frets];chord.showName=true;chord.showDiagram=true;const id=`edit/${editIndex}/${command.target.bar}/${command.target.voice}/${command.target.beat}`;staff.addChord(id,chord);beat.chordId=id;}else beat.chordId=null;return true;
    }
    default:return false;
  }
}
