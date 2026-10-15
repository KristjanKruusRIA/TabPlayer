import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { applyPitchTargets,applyRangeEdit } from './range-edits';
import { captureNoteLinks } from './links';
import { exportMidi } from '../export/midi';
import type { MusicSelection } from './range-types';
import type { PitchTarget } from './harmony-types';

const at=(beat=0,noteIndex=0,bar=0)=>({target:{...target,bar,beat},noteIndex});
const notes=(...addresses:ReturnType<typeof at>[]):MusicSelection=>({kind:'notes',notes:addresses});
const beatAt=(score:model.Score,beat=0)=>score.tracks[0].staves[0].bars[0].voices[0].beats[beat];
function piano(){const score=music(),staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[];for(const bar of staff.bars)for(const beat of bar.voices[0].beats)for(const note of beat.notes){note.string=-1;note.fret=-1;note.octave=5;note.tone=0;}return score;}
function chord(score:model.Score,string=2,fret=0){const note=new model.Note();note.string=string;note.fret=fret;beatAt(score).addNote(note);return note;}
const fingerprint=(score:model.Score)=>JSON.stringify([model.JsonConverter.scoreToJson(score),captureNoteLinks(score)]);
function tie(a:model.Note,b:model.Note){a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;}
// Independent SMF byte traversal: decode positive-velocity note-ons without alphaTab's reader.
function midiNotes(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),output:number[][]=[];let p=14;
  const variable=()=>{let value=0,byte=0;do{byte=bytes[p++];value=(value<<7)|(byte&127);}while(byte&128);return value;};
  while(p<bytes.length){const length=view.getUint32(p+4),end=p+8+length;p+=8;let running=0;while(p<end){variable();let status=bytes[p++];if(status<128){p--;status=running;}else if(status<240)running=status;
    if(status===255){p++;const length=variable();p+=length;}else if(status===240||status===247){const length=variable();p+=length;}else{const kind=status&240,key=bytes[p++],value=kind===192||kind===208?0:bytes[p++];if(kind===144&&value>0)output.push([key,value]);}}
  }return output;
}
it('erase_only_member_and_preserve_beat and both directions of its links',()=>{
  const score=music(),beat=beatAt(score),removed=beat.notes[0],kept=chord(score);beat.text='Keep text';beat.chordId='shape';beat.fade=model.FadeType.FadeIn;
  const automation=new model.Automation();automation.type=model.AutomationType.Volume;automation.value=3;automation.ratioPosition=.25;beat.automations.push(automation);
  const destination=beatAt(score,1).notes[0];destination.string=removed.string;destination.fret=removed.fret;tie(removed,destination);removed.slurDestination=destination;destination.slurOrigin=removed;destination.isSlurDestination=true;
  expect(applyRangeEdit(score,{type:'eraseSelection',selection:notes(at())})).toBe(true);
  expect(beat.notes).toEqual([kept]);expect(kept.index).toBe(0);expect(beat).toMatchObject({duration:4,text:'Keep text',chordId:'shape',fade:model.FadeType.FadeIn,isEmpty:false});expect(beat.automations).toContain(automation);
  expect(destination.tieOrigin).toBeNull();expect(destination.isTieDestination).toBe(false);expect(destination.slurOrigin).toBeNull();
  applyRangeEdit(score,{type:'eraseSelection',selection:notes(at())});expect(beat.notes).toEqual([]);expect(beat.isRest).toBe(true);expect(beat.isEmpty).toBe(false);
});
it('invalid final erase target leaves earlier notes and links unchanged',()=>{
  const score=music();tie(beatAt(score).notes[0],beatAt(score,1).notes[0]);const before=fingerprint(score);
  expect(()=>applyRangeEdit(score,{type:'eraseSelection',selection:notes(at(),at(99))})).toThrow();expect(fingerprint(score)).toBe(before);
});
it('transpose_literal_pitches_and_boundary_tie shifts trills and resets forced spelling',()=>{
  const score=piano(),beat=beatAt(score),second=new model.Note();second.octave=5;second.tone=4;beat.addNote(second);beat.notes[0].trillValue=62;beat.notes[0].accidentalMode=model.NoteAccidentalMode.ForceFlat;beat.notes[0].dynamics=3;
  const outside=beatAt(score,1).notes[0];tie(beat.notes[0],outside);beat.notes[0].slurDestination=outside;outside.slurOrigin=beat.notes[0];outside.isSlurDestination=true;
  applyRangeEdit(score,{type:'transposeSelection',selection:notes(at(),at(0,1)),semitones:1});
  expect(beat.notes.map(n=>n.realValue)).toEqual([61,65]);expect(beat.notes[0]).toMatchObject({trillValue:63,accidentalMode:model.NoteAccidentalMode.Default,dynamics:3,tieDestination:null});expect(outside.realValue).toBe(60);expect(outside.tieOrigin).toBeNull();expect(beat.notes[0].slurDestination).toBe(outside);
  const octave=piano();octave.tracks[0].staves[0].bars[0].voices[0].beats[0].addNote(Object.assign(new model.Note(),{octave:5,tone:4}));applyRangeEdit(octave,{type:'transposeSelection',selection:notes(at(),at(0,1)),semitones:12});expect(beatAt(octave).notes.map(n=>n.realValue)).toEqual([72,76]);
  const transposed=piano();transposed.tracks[0].staves[0].transpositionPitch=12;expect(beatAt(transposed).notes[0].realValue).toBe(48);applyRangeEdit(transposed,{type:'transposeSelection',selection:notes(at()),semitones:1});expect(beatAt(transposed).notes[0].realValue).toBe(49);
});
it('keeps internal equal-pitch ties connected and rejects an invalid final pitch or percussion atomically',()=>{
  const score=piano(),a=beatAt(score).notes[0],b=beatAt(score,1).notes[0];tie(a,b);applyRangeEdit(score,{type:'transposeSelection',selection:notes(at(),at(1)),semitones:1});expect(a.realValue).toBe(61);expect(b.realValue).toBe(61);expect(a.tieDestination).toBe(b);
  b.octave=10;b.tone=7;let before=fingerprint(score);expect(()=>applyRangeEdit(score,{type:'transposeSelection',selection:notes(at(),at(1)),semitones:1})).toThrow(/pitch/i);expect(fingerprint(score)).toBe(before);
  b.percussionArticulation=38;before=fingerprint(score);expect(()=>applyRangeEdit(score,{type:'transposeSelection',selection:notes(at(),at(1)),semitones:-1})).toThrow(/percussion/i);expect(fingerprint(score)).toBe(before);
});
it('prefers fret transposition and uses collision-free fallback without changing bend intervals',()=>{
  const score=music(),a=beatAt(score).notes[0];a.string=1;a.fret=5;a.dynamics=3;a.addBendPoint(new model.BendPoint(0,0));a.addBendPoint(new model.BendPoint(60,4));const points=a.bendPoints;
  applyRangeEdit(score,{type:'transposeSelection',selection:notes(at()),semitones:1});expect(a).toMatchObject({string:1,fret:6,dynamics:3});expect(a.realValue).toBe(46);expect(a.bendPoints).toBe(points);
  a.fret=0;expect(()=>applyRangeEdit(score,{type:'transposeSelection',selection:notes(at()),semitones:-1})).toThrow();expect(a.fret).toBe(0);
});
it('string_move_refinger_and_sustain use adjacent open pitch order and selected chord members',()=>{
  const score=music(),a=beatAt(score).notes[0];a.string=1;a.fret=5;a.dynamics=3;const id=a.id;
  applyRangeEdit(score,{type:'moveSelectionStrings',selection:notes(at()),direction:'higher'});expect(a).toMatchObject({string:2,fret:0,id,dynamics:3});expect(a.realValue).toBe(45);
  applyRangeEdit(score,{type:'moveSelectionStrings',selection:notes(at()),direction:'lower'});expect(a).toMatchObject({string:1,fret:5});
  const kept=chord(score,3,0);applyRangeEdit(score,{type:'setSelectionSustain',selection:notes(at()),strings:[1],kind:'letRing',enabled:true});expect(a.isLetRing).toBe(true);expect(kept.isLetRing).toBe(false);
  applyRangeEdit(score,{type:'setSelectionSustain',selection:notes(at(),at(0,1)),strings:[3],kind:'palmMute',enabled:true});expect(a.isPalmMute).toBe(false);expect(kept.isPalmMute).toBe(true);
  const selection=notes(at(),at(0,1));applyRangeEdit(score,{type:'refingerSelection',selection,maxFret:24});const positions=beatAt(score).notes.map(n=>[n.string,n.fret,n.realValue]);applyRangeEdit(score,{type:'refingerSelection',selection,maxFret:24});expect(beatAt(score).notes.map(n=>[n.string,n.fret,n.realValue])).toEqual(positions);expect(a.id).toBe(id);
});
it('rejects occupied adjacent strings, equal-open ambiguity and external same-string relationships atomically',()=>{
  for(const scenario of ['occupied','duplicate','tie','hammer','slide'] as const){
    const score=music(),a=beatAt(score).notes[0];a.string=1;a.fret=5;
    if(scenario==='occupied')chord(score,2,0);
    if(scenario==='duplicate')score.tracks[0].staves[0].stringTuning.tunings=[64,59,55,50,40,40];
    const b=beatAt(score,1).notes[0];b.string=1;b.fret=5;
    if(scenario==='tie')tie(a,b);if(scenario==='hammer'){a.hammerPullDestination=b;a.isHammerPullOrigin=true;b.hammerPullOrigin=a;}if(scenario==='slide'){a.slideTarget=b;a.slideOutType=model.SlideOutType.Shift;b.slideOrigin=a;}
    const before=fingerprint(score);expect(()=>applyRangeEdit(score,{type:'moveSelectionStrings',selection:notes(at()),direction:'higher'}),scenario).toThrow();expect(fingerprint(score),scenario).toBe(before);
  }
});
it('moves an internally linked passage together and locks it during re-fingering',()=>{
  const score=music(),a=beatAt(score).notes[0],b=beatAt(score,1).notes[0];for(const note of [a,b]){note.string=1;note.fret=5;}tie(a,b);
  applyRangeEdit(score,{type:'moveSelectionStrings',selection:notes(at(),at(1)),direction:'higher'});expect([a.string,b.string]).toEqual([2,2]);expect(a.tieDestination).toBe(b);
  applyRangeEdit(score,{type:'refingerSelection',selection:notes(at(),at(1)),maxFret:24});expect([a.string,b.string]).toEqual([2,2]);expect([a.realValue,b.realValue]).toEqual([45,45]);
});
it('rejects impossible natural harmonics, invalid trills and non-stringed sustain lanes without mutation',()=>{
  const score=music(),a=beatAt(score).notes[0];a.string=1;a.fret=12;a.harmonicType=model.HarmonicType.Natural;a.harmonicValue=12;
  let before=fingerprint(score);for(const command of [{type:'moveSelectionStrings',selection:notes(at()),direction:'higher'},{type:'transposeSelection',selection:notes(at()),semitones:1}] as const){expect(()=>applyRangeEdit(score,command)).toThrow();expect(fingerprint(score)).toBe(before);}
  const keys=piano();beatAt(keys).notes[0].trillValue=127;before=fingerprint(keys);expect(()=>applyRangeEdit(keys,{type:'transposeSelection',selection:notes(at()),semitones:1})).toThrow(/trill/i);expect(fingerprint(keys)).toBe(before);
  expect(()=>applyRangeEdit(keys,{type:'setSelectionSustain',selection:notes(at()),strings:[1],kind:'letRing',enabled:true})).toThrow(/string/i);
});
it('rejects malformed recognized commands and returns false for unrelated commands',()=>{
  const score=music(),before=fingerprint(score);for(const command of [
    {type:'transposeSelection',selection:notes(at()),semitones:0},
    {type:'transposeSelection',selection:notes(at()),semitones:128},
    {type:'setSelectionSustain',selection:notes(at()),strings:[1,1],kind:'letRing',enabled:true},
    {type:'setSelectionSustain',selection:notes(at()),strings:[7],kind:'letRing',enabled:true},
    {type:'refingerSelection',selection:notes(at()),maxFret:0},
    {type:'eraseSelection',selection:notes(at()),extra:true},
  ])expect(()=>applyRangeEdit(score,command as never)).toThrow();expect(fingerprint(score)).toBe(before);expect(applyRangeEdit(score,{type:'other'} as never)).toBe(false);
});
it('validates the final fingering destination and every selected sustain note before mutation',()=>{
  const score=music(),a=beatAt(score).notes[0],b=beatAt(score,1).notes[0];a.string=1;a.fret=0;b.string=6;b.fret=24;
  let before=fingerprint(score);expect(()=>applyRangeEdit(score,{type:'refingerSelection',selection:notes(at(),at(1)),maxFret:1})).toThrow();expect(fingerprint(score)).toBe(before);
  const unstringed=chord(score);unstringed.string=-1;unstringed.fret=-1;unstringed.octave=5;unstringed.tone=0;before=fingerprint(score);
  expect(()=>applyRangeEdit(score,{type:'setSelectionSustain',selection:notes(at(),at(0,1)),strings:[1],kind:'letRing',enabled:true})).toThrow(/string/i);expect(fingerprint(score)).toBe(before);
});
it.each(['pitched','percussion'])('rejects selected empty %s lanes before changing guitar sustain',kind=>{
  for(const carrier of ['empty beats','empty voice'])for(const shape of ['range','bars']){
    const score=music(),other=music().tracks[0];score.addTrack(other);const staff=other.staves[0];staff.stringTuning.tunings=[];staff.isPercussion=kind==='percussion';
    for(const bar of staff.bars)for(const voice of bar.voices){for(const beat of voice.beats){beat.notes=[];beat.isEmpty=true;}if(carrier==='empty voice')voice.beats=[];}
    score.finish(new Settings());
    const selection:MusicSelection=shape==='range'?{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:960},lanes:[{track:0,staff:0,voice:0},{track:1,staff:0,voice:0}]}}:{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0};
    const before=fingerprint(score);expect(()=>applyRangeEdit(score,{type:'setSelectionSustain',selection,strings:[6],kind:'letRing',enabled:true}),`${carrier}, ${shape}`).toThrow(/string/i);expect(fingerprint(score)).toBe(before);expect(beatAt(score).notes[0].isLetRing).toBe(false);
    applyRangeEdit(score,{type:'setSelectionSustain',selection:notes(at()),strings:[6],kind:'letRing',enabled:true});expect(beatAt(score).notes[0].isLetRing).toBe(true);
  }
});
it('emits literal MIDI pitches and retained dynamics after transposition and refingering',()=>{
  const score=piano(),beat=beatAt(score);beat.notes[0].dynamics=3;beat.addNote(Object.assign(new model.Note(),{octave:5,tone:4,dynamics:3}));
  applyRangeEdit(score,{type:'transposeSelection',selection:notes(at(),at(0,1)),semitones:1});expect(midiNotes(exportMidi(score,{tracks:[0],range:{first:0,last:0}})).slice(0,2)).toEqual([[61,63],[65,63]]);
  const guitar=music(),a=beatAt(guitar).notes[0];a.string=1;a.fret=5;a.dynamics=3;applyRangeEdit(guitar,{type:'refingerSelection',selection:notes(at()),maxFret:24});expect(midiNotes(exportMidi(guitar,{tracks:[0],range:{first:0,last:0}}))[0]).toEqual([45,63]);
  const offset=piano();offset.tracks[0].staves[0].transpositionPitch=12;applyRangeEdit(offset,{type:'transposeSelection',selection:notes(at()),semitones:1});expect(midiNotes(exportMidi(offset,{tracks:[0],range:{first:0,last:0}}))[0][0]).toBe(49);
  const octave=piano();beatAt(octave).addNote(Object.assign(new model.Note(),{octave:5,tone:4}));applyRangeEdit(octave,{type:'transposeSelection',selection:notes(at(),at(0,1)),semitones:12});expect(midiNotes(exportMidi(octave,{tracks:[0],range:{first:0,last:0}})).slice(0,2).map(note=>note[0])).toEqual([72,76]);
});

it('pitch_targets_move_chord_simultaneously without colliding with yet-unmoved chord members',()=>{
  const score=piano(),beat=beatAt(score);for(const tone of [4,7])beat.addNote(Object.assign(new model.Note(),{octave:5,tone,dynamics:3}));beat.notes[0].dynamics=3;
  const targets:PitchTarget[]=[{address:at(),pitch:64},{address:at(0,1),pitch:67},{address:at(0,2),pitch:71}],before=JSON.stringify(targets),ids=beat.notes.map(note=>note.id);
  applyPitchTargets(score,targets);expect(beat.notes.map(note=>[note.realValue,note.dynamics])).toEqual([[64,3],[67,3],[71,3]]);expect(beat.notes.map(note=>note.id)).toEqual(ids);expect(JSON.stringify(targets)).toBe(before);
  expect(midiNotes(exportMidi(score,{tracks:[0],range:{first:0,last:0}})).slice(0,3)).toEqual([[64,63],[67,63],[71,63]]);
});
it('pitch_targets_reject_invalid_final_pitch_address_and_new_collisions_without_mutation',()=>{
  for(const invalid of [-1,128,NaN,1.5]){const score=piano(),before=fingerprint(score);expect(()=>applyPitchTargets(score,[{address:at(),pitch:64},{address:at(1),pitch:invalid}])).toThrow();expect(fingerprint(score)).toBe(before);}
  for(const targets of [
    [{address:at(),pitch:64},{address:at(),pitch:67}],
    [{address:at(),pitch:64},{address:at(99),pitch:67}],
    [{address:at(),pitch:64,extra:true}],
    [{address:{...at(),extra:true},pitch:64}],
  ]){const score=piano(),before=fingerprint(score);expect(()=>applyPitchTargets(score,targets as PitchTarget[])).toThrow();expect(fingerprint(score)).toBe(before);}
  const score=piano();beatAt(score).addNote(Object.assign(new model.Note(),{octave:5,tone:4}));const before=fingerprint(score);expect(()=>applyPitchTargets(score,[{address:at(),pitch:64}])).toThrow(/collision|already|duplicate/i);expect(fingerprint(score)).toBe(before);
});
it('pitch_targets_use_sounding_offsets_and_preserve_trill_bend_intervals_and_dynamics',()=>{
  const score=piano(),staff=score.tracks[0].staves[0],note=beatAt(score).notes[0];staff.transpositionPitch=12;note.trillValue=62;note.dynamics=3;note.accidentalMode=model.NoteAccidentalMode.ForceFlat;
  applyPitchTargets(score,[{address:at(),pitch:52}]);expect(note).toMatchObject({octave:5,tone:4,trillValue:66,dynamics:3,accidentalMode:model.NoteAccidentalMode.Default});expect(note.realValue).toBe(52);expect(midiNotes(exportMidi(score,{tracks:[0],range:{first:0,last:0}}))[0]).toEqual([52,63]);
  const guitar=music(),g=beatAt(guitar).notes[0];g.string=1;g.fret=5;g.addBendPoint(new model.BendPoint(0,0));g.addBendPoint(new model.BendPoint(60,4));g.trillValue=47;g.dynamics=3;const bend=g.bendPoints,points=bend?.map(point=>[point.offset,point.value]);
  applyPitchTargets(guitar,[{address:at(),pitch:49}]);expect(g.realValue).toBe(49);expect(g.trillValue).toBe(51);expect(g.dynamics).toBe(3);expect(g.bendPoints).toBe(bend);expect(g.bendPoints?.map(point=>[point.offset,point.value])).toEqual(points);
});
it('pitch_targets_assign_nonmonotonic_strings_with_capo_and_offset_and_reserve_unselected_strings',()=>{
  const score=music(),staff=score.tracks[0].staves[0],beat=beatAt(score),note=beat.notes[0];staff.stringTuning.tunings=[64,45,59,40,55,50,35,60,30];staff.capo=2;staff.transpositionPitch=12;note.string=4;note.fret=0;
  const fixed=chord(score,6,0),fixedBefore=[fixed.string,fixed.fret,fixed.realValue,fixed.id];expect(note.realValue).toBe(40);
  applyPitchTargets(score,[{address:at(),pitch:39}]);expect(note.realValue).toBe(39);expect(note.string).not.toBe(4);expect(note.string).not.toBe(6);expect([fixed.string,fixed.fret,fixed.realValue,fixed.id]).toEqual(fixedBefore);
  expect(note.realValue).toBe(staff.tuning[staff.tuning.length-note.string]+staff.capo-staff.transpositionPitch+note.fret);
  expect(midiNotes(exportMidi(score,{tracks:[0],range:{first:0,last:0}})).slice(0,2).map(value=>value[0])).toEqual([39,30]);
});
it('pitch_targets_keep_equal_internal_ties_and_reject_unequal_mappings_or_lost_continued_bends',()=>{
  const score=piano(),a=beatAt(score).notes[0],b=beatAt(score,1).notes[0];tie(a,b);let before=fingerprint(score);
  expect(()=>applyPitchTargets(score,[{address:at(),pitch:64},{address:at(1),pitch:65}])).toThrow(/relationship|tie/i);expect(fingerprint(score)).toBe(before);
  applyPitchTargets(score,[{address:at(),pitch:64},{address:at(1),pitch:64}]);expect(a.tieDestination).toBe(b);expect(b.tieOrigin).toBe(a);expect([a.realValue,b.realValue]).toEqual([64,64]);
  const guitar=music(),from=beatAt(guitar).notes[0],to=beatAt(guitar,1).notes[0];tie(from,to);from.addBendPoint(new model.BendPoint(0,0));from.addBendPoint(new model.BendPoint(60,4));to.bendOrigin=from;to.isContinuedBend=true;before=fingerprint(guitar);
  expect(()=>applyPitchTargets(guitar,[{address:at(1),pitch:68}])).toThrow(/bend/i);expect(fingerprint(guitar)).toBe(before);
});
function duplicatePitchTies(stringed=false){
  const score=stringed?music():piano(),origin=beatAt(score).notes[0],first=beatAt(score,1).notes[0],last=new model.Note();
  Object.assign(last,stringed?{string:first.string,fret:first.fret}:{octave:first.octave,tone:first.tone});beatAt(score,1).addNote(last);tie(origin,first);tie(origin,last);return {score,origin,first,last};
}
it.each([false,true])('pitch_targets_preserve_duplicate_incoming_ties and canonical pointer (stringed=%s)',stringed=>{
  const {score,origin,first,last}=duplicatePitchTies(stringed),expected=origin.realValue+2;applyPitchTargets(score,[{address:at(),pitch:expected},{address:at(1),pitch:expected},{address:at(1,1),pitch:expected}]);
  expect([origin.realValue,first.realValue,last.realValue]).toEqual([expected,expected,expected]);expect(origin.tieDestination).toBe(last);expect(first.tieOrigin).toBe(origin);expect(last.tieOrigin).toBe(origin);
  expect(captureNoteLinks(score).filter(link=>link.kind==='tie')).toEqual([{from:origin.id,to:first.id,kind:'tie'},{from:origin.id,to:last.id,kind:'tie'}]);
});
it.each([0,1])('pitch_targets_detach_only_boundary_destination_%s_and_retain_surviving_canonical_edge',index=>{
  const {score,origin,first,last}=duplicatePitchTies(),removed=index===0?first:last,survivor=index===0?last:first;
  applyPitchTargets(score,[{address:at(1,index),pitch:64}]);expect(removed.realValue).toBe(64);expect(removed.tieOrigin).toBeNull();expect(removed.isTieDestination).toBe(false);expect(removed.bendOrigin).toBeNull();expect(removed.isContinuedBend).toBe(false);
  expect(origin.realValue).toBe(60);expect(survivor.realValue).toBe(60);expect(survivor.tieOrigin).toBe(origin);expect(survivor.isTieDestination).toBe(true);expect(origin.tieDestination).toBe(survivor);
});
it('pitch_targets_detach_all_boundary_destinations_when_only_origin_moves_and_reject_drums_or_impossible_harmonics',()=>{
  const {score,origin,first,last}=duplicatePitchTies();applyPitchTargets(score,[{address:at(),pitch:64}]);expect(origin.tieDestination).toBeNull();expect([first.realValue,last.realValue]).toEqual([60,60]);expect([first.tieOrigin,last.tieOrigin]).toEqual([null,null]);
  const guitar=music(),note=beatAt(guitar).notes[0];note.string=1;note.fret=12;note.harmonicType=model.HarmonicType.Natural;note.harmonicValue=12;let before=fingerprint(guitar);expect(()=>applyPitchTargets(guitar,[{address:at(),pitch:note.realValue+1}])).toThrow();expect(fingerprint(guitar)).toBe(before);
  const drums=piano();beatAt(drums,1).notes[0].percussionArticulation=38;before=fingerprint(drums);expect(()=>applyPitchTargets(drums,[{address:at(),pitch:64},{address:at(1),pitch:40}])).toThrow(/percussion/i);expect(fingerprint(drums)).toBe(before);
});
it('pitch_targets_validate_every_harmonic_member_after_a_shared_duplicate_fingering_plan',()=>{
  const score=music(),natural=beatAt(score).notes[0];natural.string=1;natural.fret=0;natural.harmonicType=model.HarmonicType.Natural;natural.harmonicValue=12;
  const artificial=chord(score,1,0);artificial.harmonicType=model.HarmonicType.Artificial;artificial.harmonicValue=12;chord(score,6,20);
  expect([natural.realValue,artificial.realValue]).toEqual([52,52]);const before=fingerprint(score);
  expect(()=>applyPitchTargets(score,[{address:at(),pitch:57},{address:at(0,1),pitch:57}])).toThrow(/harmonic|pitch/i);expect(fingerprint(score)).toBe(before);
});
it('pitch_targets_reject_intervening_attack_that_would_break_an_untouched_later_duplicate_tie',()=>{
  const score=piano(),origin=beatAt(score).notes[0],intervening=beatAt(score,1).notes[0],untied=beatAt(score,2).notes[0],destination=new model.Note();intervening.tone=1;destination.octave=5;destination.tone=0;beatAt(score,2).addNote(destination);tie(origin,destination);
  expect([origin.realValue,intervening.realValue,untied.realValue,destination.realValue]).toEqual([60,61,60,60]);const before=fingerprint(score);
  expect(()=>applyPitchTargets(score,[{address:at(1),pitch:60}])).toThrow(/relationship|tie/i);expect(fingerprint(score)).toBe(before);expect(origin.tieDestination).toBe(destination);
  applyPitchTargets(score,[{address:at(1),pitch:62}]);expect(intervening.realValue).toBe(62);expect(origin.tieDestination).toBe(destination);expect(destination.tieOrigin).toBe(origin);expect(untied.tieOrigin).toBeNull();
});
