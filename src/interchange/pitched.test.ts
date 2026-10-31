// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { exporter,importer,midi,model,Settings } from '@coderline/alphatab';
import { strFromU8,unzipSync } from 'fflate';
import { captureNoteLinks } from '../editor/links';
import { scoreFromJson } from '../model-clone';
import { preparePitchedGpScore } from './pitched';
import { exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings();
function piano(transposition=12,displayTransposition=0,pitches=[60,65]) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  score.addMasterBar(new model.MasterBar());score.addTrack(track);track.addStaff(staff);
  track.name='Piano';staff.stringTuning.tunings=[];staff.showTablature=false;
  staff.transpositionPitch=transposition;staff.displayTranspositionPitch=displayTransposition;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();
  staff.addBar(bar);bar.addVoice(voice);voice.addBeat(beat);beat.duration=model.Duration.Whole;beat.isEmpty=false;
  for(const pitch of pitches){const note=new model.Note();note.string=-1;note.fret=-1;note.octave=Math.floor(pitch/12);note.tone=pitch%12;beat.addNote(note);}
  score.finish(settings);return score;
}
const notes=(score:model.Score)=>score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))));
const roundTrip=(score:model.Score)=>importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,settings),settings);

// Decode Standard MIDI bytes independently of alphaTab's event objects and reader.
function smfKeys(score:model.Score) {
  const file=new midi.MidiFile(),generator=new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true));
  generator.applyTranspositionPitches=true;generator.generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(length:number)=>String.fromCharCode(...bytes.slice(p,p+=length)),u32=()=>{const value=view.getUint32(p);p+=4;return value;},u16=()=>{const value=view.getUint16(p);p+=2;return value;};
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=value*128+(byte&127);}while(byte&128);return value;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const count=u16();u16();const keys:number[]=[];
  for(let track=0;track<count;track++){
    expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let status=0;
    while(p<end){variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}else if(code===240||code===247){const length=variable();p+=length;}else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===144&&b)keys.push(a);}
    }
  }
  expect(p).toBe(bytes.length);return keys;
}

describe('pitched GP transposition interchange',()=>{
  it('characterizes the stock GP loss of sounding transposition',()=>{
    const reopened=roundTrip(piano());
    expect(smfKeys(reopened)).toEqual([60,65]);expect(reopened.tracks[0].staves[0].transpositionPitch).toBe(0);
  });
  it('retains the sounding piano chord through public GP export and import',()=>{
    const source=piano();
    expect(smfKeys(source)).toEqual([48,53]);expect(notes(source).map(note=>note.displayValueWithoutBend)).toEqual([48,53]);
    const reopened=roundTrip(preparePitchedGpScore(source,settings));
    expect(smfKeys(reopened)).toEqual([48,53]);expect(notes(reopened).map(note=>note.displayValueWithoutBend)).toEqual([48,53]);
  });
  it('retains referenced embedded backing audio through pitched normalization without sharing source bytes',()=>{
    const authored=piano(0);authored.backingTrack=new model.BackingTrack();authored.backingTrack.rawAudioFile=new Uint8Array([82,73,70,70,1,2,3,4]);
    const input=new exporter.Gp7Exporter().export(authored,settings),inputBefore=input.slice(),source=loadInterchangeScore(input,settings);
    source.tracks[0].staves[0].transpositionPitch=12;
    const sourceBefore=model.JsonConverter.scoreToJson(source),sourceAudio=source.backingTrack!.rawAudioFile!,output=exportGpInterchange(source,settings),entries=unzipSync(output);
    const doc=new DOMParser().parseFromString(strFromU8(entries['Content/score.gpif']),'application/xml'),assetId=doc.querySelector('GPIF > BackingTrack > AssetId')?.textContent;
    expect(assetId).toBeTruthy();
    const path=doc.querySelector(`GPIF > Assets > Asset[id="${assetId}"] > EmbeddedFilePath`)!.textContent!;
    expect(entries[path]).toEqual(new Uint8Array([82,73,70,70,1,2,3,4]));
    const reopened=importer.ScoreLoader.loadScoreFromBytes(output,settings);
    expect(reopened.backingTrack!.rawAudioFile).toEqual(new Uint8Array([82,73,70,70,1,2,3,4]));expect(smfKeys(reopened)).toEqual([48,53]);
    const prepared=preparePitchedGpScore(source,settings);
    expect(prepared.backingTrack).not.toBe(source.backingTrack);expect(prepared.backingTrack!.rawAudioFile).not.toBe(sourceAudio);
    expect(prepared.backingTrack!.rawAudioFile).toEqual(new Uint8Array([82,73,70,70,1,2,3,4]));prepared.backingTrack!.rawAudioFile![0]=0;
    expect(sourceAudio).toEqual(new Uint8Array([82,73,70,70,1,2,3,4]));expect(source.backingTrack!.rawAudioFile).toBe(sourceAudio);
    expect(input).toEqual(inputBefore);expect(model.JsonConverter.scoreToJson(source)).toBe(sourceBefore);
  });
  it.each([
    {transpose:12,pitches:[12,127],sound:[0,115]},
    {transpose:-12,pitches:[0,115],sound:[12,127]},
  ])('retains valid boundary pitches with sounding offset $transpose',({transpose,pitches,sound})=>{
    const source=piano(transpose,0,pitches),prepared=preparePitchedGpScore(source,settings),reopened=roundTrip(prepared);
    expect(smfKeys(source)).toEqual(sound);expect(smfKeys(prepared)).toEqual(sound);expect(smfKeys(reopened)).toEqual(sound);
    expect(notes(reopened).map(note=>note.displayValueWithoutBend)).toEqual(sound);
  });
  it.each([
    {transpose:12,display:7,sound:[48,53],written:[41,46]},
    {transpose:-12,display:-7,sound:[72,77],written:[79,84]},
  ])('preserves displayed and sounding pitch for $transpose / $display offsets',({transpose,display,sound,written})=>{
    const source=piano(transpose,display),prepared=preparePitchedGpScore(source,settings),reopened=roundTrip(prepared);
    expect(notes(source).map(note=>note.displayValueWithoutBend)).toEqual(written);
    expect(notes(prepared).map(note=>note.displayValueWithoutBend)).toEqual(written);
    expect(notes(reopened).map(note=>note.displayValueWithoutBend)).toEqual(written);expect(smfKeys(reopened)).toEqual(sound);
    expect(prepared.tracks[0].staves[0]).toMatchObject({transpositionPitch:0,displayTranspositionPitch:display});
  });
  it('characterizes the public GP reader applying track display transposition only to the first staff',()=>{
    const source=piano(12,5);source.tracks[0].addStaff(piano(-12,5).tracks[0].staves[0]);source.finish(settings);
    const reopened=roundTrip(preparePitchedGpScore(source,settings));
    expect(reopened.tracks[0].staves.map(staff=>staff.displayTranspositionPitch)).toEqual([5,0]);
  });
  it('normalizes different sounding offsets on two staves independently',()=>{
    const source=piano(12,5),lower=piano(-12,5).tracks[0].staves[0];source.tracks[0].addStaff(lower);source.finish(settings);
    const prepared=preparePitchedGpScore(source,settings),reopened=loadInterchangeScore(new exporter.Gp7Exporter().export(prepared,settings),settings);
    expect(smfKeys(source)).toEqual([48,53,72,77]);expect(smfKeys(reopened)).toEqual([48,53,72,77]);
    expect(notes(prepared).map(note=>note.displayValueWithoutBend)).toEqual([43,48,67,72]);
    expect(notes(reopened).map(note=>note.displayValueWithoutBend)).toEqual([43,48,67,72]);
    expect(prepared.tracks[0].staves.map(staff=>staff.transpositionPitch)).toEqual([0,0]);
  });
  it('preserves chord ties, slurs, per-note dynamics and the source model',()=>{
    const source=piano(),voice=source.tracks[0].staves[0].bars[0].voices[0],first=voice.beats[0],second=new model.Beat();
    first.duration=model.Duration.Half;second.duration=model.Duration.Half;second.isEmpty=false;voice.addBeat(second);
    for(const pitch of [60,65]){const note=new model.Note();note.octave=Math.floor(pitch/12);note.tone=pitch%12;second.addNote(note);}
    source.finish(settings);first.notes[0].tieDestination=second.notes[0];second.notes[0].tieOrigin=first.notes[0];second.notes[0].isTieDestination=true;
    first.notes[1].slurDestination=second.notes[1];second.notes[1].slurOrigin=first.notes[1];second.notes[1].isSlurDestination=true;
    notes(source).forEach((note,index)=>note.dynamics=index%2?6:3);
    const before=model.JsonConverter.scoreToJson(source),links=captureNoteLinks(source),prepared=preparePitchedGpScore(source,settings),copied=notes(prepared);
    expect(prepared).not.toBe(source);expect(captureNoteLinks(prepared)).toEqual(links);expect(copied[0].tieDestination).toBe(copied[2]);expect(copied[1].slurDestination).toBe(copied[3]);
    expect(copied.map(note=>note.dynamics)).toEqual([3,6,3,6]);expect(copied.map(note=>note.calculateRealValue(true,false))).toEqual([48,53,48,53]);
    expect(copied[0]).not.toBe(first.notes[0]);expect(smfKeys(roundTrip(prepared))).toEqual([48,53,53]);
    expect(model.JsonConverter.scoreToJson(source)).toBe(before);expect(first.notes[0].tieDestination).toBe(second.notes[0]);
    const nativeReplay=scoreFromJson(before,settings);expect(nativeReplay.tracks[0].staves[0].transpositionPitch).toBe(12);expect(notes(nativeReplay).map(note=>note.octave*12+note.tone)).toEqual([60,65,60,65]);
  });
  it('returns the source when no pitched staff needs normalization',()=>{
    const plain=piano(0),guitar=piano(),drums=piano();
    guitar.tracks[0].staves[0].stringTuning.tunings=[64,59,55,50,45,40];drums.tracks[0].staves[0].isPercussion=true;
    for(const source of [plain,guitar,drums])expect(preparePitchedGpScore(source,settings)).toBe(source);
  });
  it('leaves stringed and percussion staff transposition unchanged when cloning a mixed score',()=>{
    const source=piano(),guitar=piano(-12).tracks[0],drums=piano(7).tracks[0];
    guitar.staves[0].stringTuning.tunings=[64,59,55,50,45,40];drums.staves[0].isPercussion=true;
    for(const note of guitar.staves[0].bars[0].voices[0].beats[0].notes){note.string=6;note.fret=3;note.octave=-1;note.tone=-1;}
    for(const note of drums.staves[0].bars[0].voices[0].beats[0].notes){note.percussionArticulation=91;note.octave=-1;note.tone=-1;}
    source.addTrack(guitar);source.addTrack(drums);source.finish(settings);
    const before=model.JsonConverter.scoreToJson(source),prepared=preparePitchedGpScore(source,settings);
    expect(prepared.tracks.map(track=>track.staves[0].transpositionPitch)).toEqual([0,-12,7]);
    expect(notes(prepared).slice(0,2).map(note=>note.octave*12+note.tone)).toEqual([48,53]);
    expect(notes(prepared).slice(2).map(note=>[note.string,note.fret,note.percussionArticulation])).toEqual([[6,3,-1],[6,3,-1],[-1,-1,91],[-1,-1,91]]);
    expect(model.JsonConverter.scoreToJson(source)).toBe(before);
  });
  it.each([{transpose:12,sound:[48,50],legacy:[48,62]},{transpose:-12,sound:[72,74],legacy:[72,62]}])('preserves the authored trill interval with sounding offset $transpose',({transpose,sound,legacy})=>{
    const source=piano(transpose,0,[60]),note=notes(source)[0];note.trillValue=62;note.trillSpeed=model.Duration.Sixteenth;
    const prepared=preparePitchedGpScore(source,settings),reopened=roundTrip(prepared);
    // Legacy unprepared public generation applies staff transposition only to the base note.
    expect([...new Set(smfKeys(source))]).toEqual(legacy);expect(smfKeys(source)).toHaveLength(16);
    expect(smfKeys(prepared)).toEqual(Array.from({length:16},(_,i)=>sound[i%2]));expect(smfKeys(reopened)).toEqual(smfKeys(prepared));expect(notes(prepared)[0].trillValue).toBe(sound[1]);expect(note.trillValue).toBe(62);
  });
});
