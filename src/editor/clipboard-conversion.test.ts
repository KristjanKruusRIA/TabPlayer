import { describe,expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { convertClipboardBeat } from './clipboard-conversion';
import { resolvePercussionArticulation } from './percussion-catalog';

const settings=new Settings(),guitar=[64,59,55,50,45,40];
function fixture(family:'strings'|'piano'|'drums',values:number[]=[60],tuning=guitar) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff(),bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();
  score.addMasterBar(new model.MasterBar());score.addTrack(track);track.addStaff(staff);staff.isPercussion=family==='drums';staff.stringTuning.tunings=family==='strings'?tuning:[];
  staff.addBar(bar);bar.addVoice(voice);voice.addBeat(beat);beat.duration=model.Duration.Quarter;beat.isEmpty=false;
  for(const value of values){const note=new model.Note();if(family==='strings'){note.string=1;note.fret=value;}else if(family==='piano'){note.octave=Math.floor(value/12);note.tone=value%12;}else note.percussionArticulation=value;beat.addNote(note);}
  score.finish(settings);for(const note of beat.notes)note.dynamics=model.DynamicValue.P;
  return {score,track,staff,bar,voice,beat};
}
function detached(source:ReturnType<typeof fixture>,destination:ReturnType<typeof fixture>) {
  const clone=scoreFromJson(model.JsonConverter.scoreToJson(source.score),settings),beat=clone.tracks[0].staves[0].bars[0].voices[0].beats[0];
  beat.voice=destination.voice;destination.voice.beats=[beat];return beat;
}
function midiKeys(score:model.Score) {
  const file=new midi.MidiFile(),generator=new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true));generator.applyTranspositionPitches=true;generator.generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n)),u16=()=>{const n=view.getUint16(p);p+=2;return n;},u32=()=>{const n=view.getUint32(p);p+=4;return n;};
  const variable=()=>{let n=0,b;do{b=bytes[p++];n=n*128+(b&127);}while(b&128);return n;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();u16();const keys:number[]=[];
  for(let t=0;t<tracks;t++){expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let status=0;
    while(p<end){variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}else if(code===240||code===247){const length=variable();p+=length;}else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===144&&b)keys.push(a);}
    }
  }return keys;
}
function articulation(pitch=82,symbol=model.MusicFontSymbol.NoteheadXBlack,id=7) {
  return new model.InstrumentArticulation('Custom shaker',-4,pitch,symbol,model.MusicFontSymbol.NoteheadDiamondWhite,model.MusicFontSymbol.NoteheadWhole,model.MusicFontSymbol.StringsUpBow,model.TechniqueSymbolPlacement.Outside,id);
}

describe('clipboard instrument conversion',()=>{
  it('reads a source guitar pitch after the detached beat has already moved to a piano hierarchy',()=>{
    const source=fixture('strings',[5]),destination=fixture('piano'),before=model.JsonConverter.scoreToJson(source.score),beat=detached(source,destination);
    convertClipboardBeat(beat,source.staff,destination.staff);
    expect(beat.notes[0]).toMatchObject({string:-1,fret:-1,octave:3,tone:9,percussionArticulation:-1,dynamics:model.DynamicValue.P});
    expect(midiKeys(destination.score)).toEqual([45]);expect(model.JsonConverter.scoreToJson(source.score)).toBe(before);
  });
  it('preserves source capo and sounding offsets while using the destination pitched offset',()=>{
    const source=fixture('strings',[5]),destination=fixture('piano');source.staff.capo=2;source.staff.transpositionPitch=12;source.staff.displayTranspositionPitch=24;destination.staff.transpositionPitch=-5;
    const beat=detached(source,destination);convertClipboardBeat(beat,source.staff,destination.staff);
    expect(beat.notes[0]).toMatchObject({octave:2,tone:6});expect(midiKeys(destination.score)).toEqual([35]);
  });
  it('assigns piano chords to distinct playable guitar strings without changing sounding pitch',()=>{
    const source=fixture('piano',[60,64]),destination=fixture('strings',[0]);destination.staff.capo=1;destination.staff.transpositionPitch=-2;
    const beat=detached(source,destination);convertClipboardBeat(beat,source.staff,destination.staff);
    expect(new Set(beat.notes.map(note=>note.string)).size).toBe(2);expect(beat.notes.every(note=>note.isStringed&&note.fret>=0)).toBe(true);
    expect(midiKeys(destination.score).sort((a,b)=>a-b)).toEqual([60,64]);expect(beat.notes.map(note=>note.dynamics)).toEqual([model.DynamicValue.P,model.DynamicValue.P]);
  });
  it('accepts a preferred source string beyond the destination string count',()=>{
    const source=fixture('strings',[0],Array(9).fill(60)),destination=fixture('strings',[0]);source.beat.notes[0].string=9;
    const beat=detached(source,destination);convertClipboardBeat(beat,source.staff,destination.staff);expect(midiKeys(destination.score)).toEqual([60]);expect(beat.notes[0].string).toBeLessThanOrEqual(6);
  });
  it('keeps compatible string harmonic and bend placements and mutable effect isolation',()=>{
    const source=fixture('strings',[12]),destination=fixture('strings',[0]),note=source.beat.notes[0];note.harmonicType=model.HarmonicType.Natural;note.harmonicValue=12;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,2));
    const beat=detached(source,destination);convertClipboardBeat(beat,source.staff,destination.staff);
    expect(beat.notes[0]).toMatchObject({string:1,fret:12,harmonicType:model.HarmonicType.Natural,harmonicValue:12});expect(beat.notes[0].realValue).toBe(note.realValue);
    expect(beat.notes[0].bendPoints).toEqual(note.bendPoints);expect(beat.notes[0].bendPoints?.[0]).not.toBe(note.bendPoints?.[0]);
  });
  it.each([
    ['harmonic',(beat:model.Beat)=>{beat.notes[0].harmonicType=model.HarmonicType.Artificial;beat.notes[0].harmonicValue=12;}],
    ['bend',(beat:model.Beat)=>beat.notes[0].addBendPoint(new model.BendPoint(60,4))],
    ['slide',(beat:model.Beat)=>{beat.notes[0].slideOutType=model.SlideOutType.OutUp;}],
    ['hammer',(beat:model.Beat)=>{beat.notes[0].isHammerPullOrigin=true;}],
    ['rasgueado',(beat:model.Beat)=>{beat.rasgueado=model.Rasgueado.Ii;}],
    ['palm mute',(beat:model.Beat)=>{beat.notes[0].isPalmMute=true;}],
    ['whammy',(beat:model.Beat)=>beat.addWhammyBarPoint(new model.BendPoint(60,4))],
  ] as const)('rejects cross-family active %s instead of flattening it',(_label,decorate)=>{
    const source=fixture('strings',[5]),destination=fixture('piano'),beat=detached(source,destination);decorate(beat);const before=model.JsonConverter.scoreToJson(destination.score);
    expect(()=>convertClipboardBeat(beat,source.staff,destination.staff)).toThrow(/technique|string|gesture/i);expect(model.JsonConverter.scoreToJson(destination.score)).toBe(before);
  });
  it('rejects incompatible active string placements atomically',()=>{
    const source=fixture('strings',[5]),destination=fixture('strings',[0],[65,60,56,51,46,41]);source.beat.notes[0].isPalmMute=true;
    const beat=detached(source,destination),before=model.JsonConverter.scoreToJson(destination.score);expect(()=>convertClipboardBeat(beat,source.staff,destination.staff)).toThrow(/playable|technique|fingering/i);expect(model.JsonConverter.scoreToJson(destination.score)).toBe(before);
  });
  it('does not convert earlier notes when a later pitch is impossible on the destination',()=>{
    const source=fixture('piano',[60,0]),destination=fixture('strings',[0]),beat=detached(source,destination),before=model.JsonConverter.scoreToJson(destination.score);
    expect(()=>convertClipboardBeat(beat,source.staff,destination.staff)).toThrow(/playable|fingering/i);expect(model.JsonConverter.scoreToJson(destination.score)).toBe(before);
  });
  it.each([['strings','drums'],['drums','piano']] as const)('transfers %s to %s as a true rhythmic rest', (from,to)=>{
    const source=fixture(from,[from==='strings'?5:38]),destination=fixture(to),beat=detached(source,destination);beat.dots=1;beat.tupletNumerator=3;beat.tupletDenominator=2;beat.text='Keep annotation';beat.showTimer=true;beat.deadSlapped=true;
    convertClipboardBeat(beat,source.staff,destination.staff);expect(beat.notes).toEqual([]);expect(beat.isRest).toBe(true);expect(beat.isEmpty).toBe(false);expect(beat.deadSlapped).toBe(false);
    expect(beat).toMatchObject({duration:model.Duration.Quarter,dots:1,tupletNumerator:3,tupletDenominator:2,text:'Keep annotation',showTimer:true});expect(midiKeys(destination.score)).toEqual([]);
  });
  it('remaps colliding custom drum indexes by complete identity and deep copies an appended entry',()=>{
    const source=fixture('drums',[0]),destination=fixture('drums',[0]);source.track.percussionArticulations=[articulation()];destination.track.percussionArticulations=[articulation(38)];const old=destination.track.percussionArticulations[0],before={...old},beat=detached(source,destination);
    convertClipboardBeat(beat,source.staff,destination.staff);expect(beat.notes[0].percussionArticulation).toBe(1);expect(destination.track.percussionArticulations[0]).toBe(old);expect(old).toMatchObject(before);
    const copied=resolvePercussionArticulation(destination.track,1)!;expect(copied).toEqual(source.track.percussionArticulations[0]);expect(copied).not.toBe(source.track.percussionArticulations[0]);expect(midiKeys(destination.score)).toEqual([82]);
    copied.staffLine=99;expect(source.track.percussionArticulations[0].staffLine).toBe(-4);
  });
  it('reuses a complete equivalent custom drum articulation without growing the registry',()=>{
    const source=fixture('drums',[0]),destination=fixture('drums',[0]);source.track.percussionArticulations=[articulation()];destination.track.percussionArticulations=[articulation(38),articulation()];const beat=detached(source,destination);
    convertClipboardBeat(beat,source.staff,destination.staff);expect(beat.notes[0].percussionArticulation).toBe(1);expect(destination.track.percussionArticulations).toHaveLength(2);
  });
  it('does not equate articulation labels and pitches when notation symbols differ',()=>{
    const source=fixture('drums',[0]),destination=fixture('drums',[0]);source.track.percussionArticulations=[articulation()];destination.track.percussionArticulations=[articulation(82,model.MusicFontSymbol.NoteheadBlack)];const beat=detached(source,destination);
    convertClipboardBeat(beat,source.staff,destination.staff);expect(beat.notes[0].percussionArticulation).toBe(1);expect(resolvePercussionArticulation(destination.track,1)?.noteHeadDefault).toBe(model.MusicFontSymbol.NoteheadXBlack);
  });
  it('keeps standard registry entries valid when appending would shadow their fallback IDs',()=>{
    const source=fixture('drums',[0]),destination=fixture('drums',[29]);source.track.percussionArticulations=[articulation()];destination.track.percussionArticulations=Array.from({length:29},(_,id)=>articulation(38,model.MusicFontSymbol.NoteheadBlack,id));
    const oldFallback=resolvePercussionArticulation(destination.track,29),beat=detached(source,destination);convertClipboardBeat(beat,source.staff,destination.staff);
    expect(resolvePercussionArticulation(destination.track,29)).toEqual(oldFallback);expect(resolvePercussionArticulation(destination.track,beat.notes[0].percussionArticulation)).toEqual(source.track.percussionArticulations[0]);
  });
  it('resolves standard drums despite destination numeric custom collisions',()=>{
    const source=fixture('drums',[38]),destination=fixture('drums',[0]);destination.track.percussionArticulations=Array.from({length:39},(_,id)=>articulation(82,model.MusicFontSymbol.NoteheadBlack,id));const beat=detached(source,destination),old=destination.track.percussionArticulations[38];
    convertClipboardBeat(beat,source.staff,destination.staff);expect(beat.notes[0].percussionArticulation).not.toBe(38);expect(resolvePercussionArticulation(destination.track,beat.notes[0].percussionArticulation)).toEqual(resolvePercussionArticulation(source.track,38));expect(destination.track.percussionArticulations[38]).toBe(old);expect(midiKeys(destination.score)).toEqual([38]);
  });
  it('rejects an unresolved drum articulation without changing either registry or earlier notes',()=>{
    const source=fixture('drums',[38,999]),destination=fixture('drums',[0]),beat=detached(source,destination),before=model.JsonConverter.scoreToJson(destination.score);
    expect(()=>convertClipboardBeat(beat,source.staff,destination.staff)).toThrow(/articulation/i);expect(model.JsonConverter.scoreToJson(destination.score)).toBe(before);
  });
  it('resets explicit accidentals when destination display offset changes their pitch class',()=>{
    const source=fixture('piano',[61]),destination=fixture('piano');source.beat.notes[0].accidentalMode=model.NoteAccidentalMode.ForceSharp;destination.staff.displayTranspositionPitch=1;const beat=detached(source,destination);
    convertClipboardBeat(beat,source.staff,destination.staff);expect(beat.notes[0].accidentalMode).toBe(model.NoteAccidentalMode.Default);expect(midiKeys(destination.score)).toEqual([61]);
    destination.staff.displayTranspositionPitch=12;const sameClass=detached(source,destination);convertClipboardBeat(sameClass,source.staff,destination.staff);expect(sameClass.notes[0].accidentalMode).toBe(model.NoteAccidentalMode.ForceSharp);
  });
});
