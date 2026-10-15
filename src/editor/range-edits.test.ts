import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { applyRangeEdit } from './range-edits';
import { captureNoteLinks } from './links';
import { exportMidi } from '../export/midi';
import type { MusicSelection } from './range-types';

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
