import { expect, it } from 'vitest';
import { applyNotationEdit } from './notation';
import { applyStructureEdit } from './structure';
import { music, noteAt, reopened, target } from './fixtures';
it('duration_tuplet_grace_capacity and triple_dots_survive_new_rhythm_controls',()=>{
  const score=music(),voice=noteAt(score).beat.voice;voice.beats.splice(1);
  applyNotationEdit(score,{type:'setBeatRhythm',target,duration:4,dots:3,tupletNumerator:1,tupletDenominator:1,graceType:0},0);expect(noteAt(score).beat.playbackDuration).toBe(1800);expect(noteAt(reopened(score)).beat.playbackDuration).toBe(1800);
  applyNotationEdit(score,{type:'setBeatRhythm',target,duration:8,dots:0,tupletNumerator:3,tupletDenominator:2,graceType:0},1);expect(noteAt(score).beat.playbackDuration).toBe(320);
  applyNotationEdit(score,{type:'setBeatRhythm',target,duration:-4,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:1},2);expect(noteAt(score).beat.graceType).toBe(1);
  expect(()=>applyNotationEdit(score,{type:'setBeatRhythm',target,duration:3,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0},3)).toThrow();
});
it('meter_change_rejects_other_voice_overflow',()=>{
  const score=music();applyStructureEdit(score,{type:'addVoice',track:0,staff:0},0);
  expect(()=>applyNotationEdit(score,{type:'setMeasureSettings',bar:0,numerator:3,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[]},1)).toThrow(/overfill/i);expect(score.masterBars[0].timeSignatureNumerator).toBe(4);
});
it('pickup_free_time_repeat_endings_tempo',()=>{
  const score=music();applyNotationEdit(score,{type:'setMeasureSettings',bar:0,numerator:3,denominator:4,pickup:true,freeTime:true,repeatStart:true,repeatCount:3,endings:[1,3],section:'Verse',tempos:[{beat:0,bpm:90,linear:false},{beat:2,bpm:120,linear:true}]},0);
  const master=score.masterBars[0];expect(master.isAnacrusis).toBe(true);expect(master.alternateEndings).toBe(5);expect(master.tempoAutomations.map(t=>t.value)).toEqual([90,120]);expect(master.tempoAutomations[1].ratioPosition).toBeCloseTo(2/3);
});
it('key_clef_text_chord_reopen and unique diagrams',()=>{
  const score=music();applyNotationEdit(score,{type:'setBarNotation',track:0,staff:0,bar:0,keySignature:-3,keyMode:1,clef:3},0);
  applyNotationEdit(score,{type:'setBeatAnnotation',target,text:'Play softly',chord:{name:'C',firstFret:1,frets:[0,1,0,2,3,-1]}},1);
  applyNotationEdit(score,{type:'setBeatAnnotation',target:{...target,beat:1},text:'',chord:{name:'Cm',firstFret:3,frets:[3,4,5,5,3,-1]}},2);
  const copy=reopened(score);expect(copy.tracks[0].staves[0].bars[0].keySignature).toBe(-3);expect(noteAt(copy).beat.text).toBe('Play softly');expect(noteAt(copy).beat.chord?.name).toBe('C');expect(noteAt(copy,0,1).beat.chord?.name).toBe('Cm');
});
it('capacity respects imported public duration overrides in other voices',()=>{
  const score=music();noteAt(score).beat.overrideDisplayDuration=4000;
  expect(()=>applyNotationEdit(score,{type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[]},0)).toThrow(/overfill/i);
});
it('imported chord nut diagrams remain editable without changing beat music',()=>{
  const score=music();applyNotationEdit(score,{type:'setBeatAnnotation',target,text:'Open chord',chord:{name:'E',firstFret:0,frets:[0,0,1,2,2,0]}},0);expect(noteAt(score).beat.chord?.firstFret).toBe(0);expect(noteAt(score).fret).toBe(3);
});
