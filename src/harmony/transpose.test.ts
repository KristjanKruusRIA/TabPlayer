import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import type { HarmonyChord,HarmonyCommand,HarmonyInterval } from '../editor/harmony-types';
import type { MusicSelection } from '../editor/range-types';
import { music,target } from '../editor/fixtures';
import { allNotes,captureNoteLinks } from '../editor/links';
import { getLyricsSource,setLyricsSource } from '../editor/lyrics-source';
import { exportMidi } from '../export/midi';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import { applyHarmonyEdit } from './edits';
import { getHarmonyChord } from './chord-source';
import { prepareHarmonyTranspose } from './transpose';

const settings=new Settings();
const address=(beat=0,noteIndex=0,bar=0,track=0)=>({target:{...target,track,beat,bar},noteIndex});
const selected=(...notes:ReturnType<typeof address>[]):MusicSelection=>({kind:'notes',notes});
const bars=(tracks=[0],firstBar=0,lastBar=0):MusicSelection=>({kind:'bars',tracks,firstBar,lastBar});
const beat=(score:model.Score,index=0,bar=0,track=0)=>score.tracks[track].staves[0].bars[bar].voices[0].beats[index];
function piano(pitches=[60]){const score=music(),staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[];for(const bar of staff.bars)for(const beat of bar.voices[0].beats)for(const note of beat.notes){note.string=-1;note.fret=-1;note.octave=5;note.tone=0;}const first=beat(score);first.notes=[];for(const pitch of pitches)first.addNote(Object.assign(new model.Note(),{octave:Math.floor(pitch/12),tone:pitch%12,dynamics:3}));return score;}
const command=(selection:MusicSelection,interval:HarmonyInterval={kind:'semitones',semitones:1},includeKeySignatures=false,includeChords=false):Extract<HarmonyCommand,{type:'transposeHarmony'}>=>({type:'transposeHarmony',selection,interval,includeKeySignatures,includeChords});
const fingerprint=(score:model.Score)=>JSON.stringify([model.JsonConverter.scoreToJson(score),captureNoteLinks(score),score.tracks.map(track=>getLyricsSource(track)),score.tracks.map(track=>track.staves.map(staff=>[...(staff.chords??[])].map(([id,chord])=>[id,getHarmonyChord(chord)])))]);
const chromatic=(number:number,quality:Extract<HarmonyInterval,{kind:'chromatic'}>['quality'],direction:'up'|'down'='up',octaves=0):HarmonyInterval=>({kind:'chromatic',number,quality,direction,octaves});
function midiNotes(bytes:Uint8Array){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),result:number[][]=[];let p=14;const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=(value<<7)|(byte&127);}while(byte&128);return value;};while(p<bytes.length){const end=p+8+view.getUint32(p+4);p+=8;let running=0;while(p<end){variable();let status=bytes[p++];if(status<128){p--;status=running;}else if(status<240)running=status;if(status===255){p++;const length=variable();p+=length;}else if(status===240||status===247){const length=variable();p+=length;}else{const kind=status&240,key=bytes[p++],value=kind===192||kind===208?0:bytes[p++];if(kind===144&&value>0)result.push([key,value]);}}}return result;}
const definition=():HarmonyChord=>({name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false});
function install(score:model.Score,value=definition(),index=0){applyHarmonyEdit(score,{type:'setHarmonyChord',target:{...target,beat:index},chord:value,fillEmptyBeat:false},17+index);return beat(score,index).chordId!;}
function tie(a:model.Note,b:model.Note){a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;}

it('chromatic_interval_literals_and_spelling produce independent MIDI notes without changing source',()=>{
  for(const [interval,pitch]of [[chromatic(3,'major'),64],[chromatic(3,'minor'),63],[chromatic(5,'perfect'),67],[chromatic(5,'diminished'),66],[chromatic(4,'augmented'),66],[chromatic(7,'diminished'),69],[chromatic(3,'major','up',1),76],[chromatic(3,'major','down',1),44],[chromatic(3,'minor','down'),57],[{kind:'semitones',semitones:-12},48]] as Array<[HarmonyInterval,number]>){
    const score=piano(),before=fingerprint(score),result=prepareHarmonyTranspose(score,command(selected(address()),interval),4);expect(beat(result).notes[0].realValue).toBe(pitch);expect(midiNotes(exportMidi(result,{tracks:[0],range:{first:0,last:0}}))[0]).toEqual([pitch,63]);expect(fingerprint(score)).toBe(before);
  }
  const score=music();install(score);const result=prepareHarmonyTranspose(score,command(selected(address()),chromatic(3,'minor'),false,true),9),chord=result.tracks[0].staves[0].getChord(beat(result).chordId!)!;
  expect(getHarmonyChord(chord).recipe?.root).toEqual({step:2,alteration:-1});expect(chord.name).toBe('Eb');
});
it('rejects invalid interval envelopes, out-of-range final notes and impossible key spellings atomically',()=>{
  const source=piano([60,127]);for(const interval of [{kind:'semitones',semitones:0},{kind:'semitones',semitones:128},chromatic(1,'diminished'),chromatic(3,'perfect'),chromatic(5,'major'),{kind:'diatonic',steps:0},{kind:'diatonic',steps:71},{...chromatic(3,'major'),unknown:true}]){const before=fingerprint(source);expect(()=>prepareHarmonyTranspose(source,command(selected(address()),interval as HarmonyInterval),4)).toThrow();expect(fingerprint(source)).toBe(before);}
  const before=fingerprint(source);expect(()=>prepareHarmonyTranspose(source,command(selected(address(),address(0,1))),4)).toThrow(/pitch|range/i);expect(fingerprint(source)).toBe(before);
  const key=piano();key.tracks[0].staves[0].bars[0].keySignature=model.KeySignature.CSharp;const keyBefore=fingerprint(key);expect(()=>prepareHarmonyTranspose(key,command(bars(),chromatic(3,'major'),true),4)).toThrow(/key|signature/i);expect(fingerprint(key)).toBe(keyBefore);
});
it('diatonic_per_bar_keys_and_simultaneous_chords use written major and natural-minor scales',()=>{
  for(const [pitches,key,mode,steps,want]of [
    [[60,64,67],0,0,2,[64,67,71]],[[67,69,65],0,0,2,[71,72,69]],[[69,72,76],0,1,2,[72,76,79]],[[60,64,67],0,0,-2,[57,60,64]],
  ] as Array<[number[],number,number,number,number[]]>){const score=piano(pitches);score.tracks[0].staves[0].bars[0].keySignature=key;score.tracks[0].staves[0].bars[0].keySignatureType=mode;
    const result=prepareHarmonyTranspose(score,command(selected(...pitches.map((_,index)=>address(0,index))),{kind:'diatonic',steps}),6);expect(beat(result).notes.map(note=>note.realValue)).toEqual(want);expect(midiNotes(exportMidi(result,{tracks:[0],range:{first:0,last:0}})).slice(0,pitches.length).map(event=>event[0])).toEqual(want);
  }
  const score=piano(),staff=score.tracks[0].staves[0];staff.transpositionPitch=12;staff.bars[1].keySignature=model.KeySignature.G;beat(score,0,1).notes[0].tone=6;
  const result=prepareHarmonyTranspose(score,command(selected(address(),address(0,0,1)),{kind:'diatonic',steps:2}),6);expect([beat(result).notes[0].realValue,beat(result,0,1).notes[0].realValue]).toEqual([52,57]);
});
it('rejects out-of-key notes, unequal mapped ties and diatonic include flags without source mutation',()=>{
  const score=piano([60,66]),before=fingerprint(score);expect(()=>prepareHarmonyTranspose(score,command(selected(address(),address(0,1)),{kind:'diatonic',steps:2}),2)).toThrow(/key|scale/i);expect(fingerprint(score)).toBe(before);
  const tied=piano(),a=beat(tied,0,0).notes[0],b=beat(tied,0,1).notes[0];a.tone=4;b.tone=4;tie(a,b);tied.tracks[0].staves[0].bars[1].keySignature=model.KeySignature.F;const tiedBefore=fingerprint(tied);
  expect(()=>prepareHarmonyTranspose(tied,command(selected(address(),address(0,0,1)),{kind:'diatonic',steps:4}),2)).toThrow(/relationship|tie/i);expect(fingerprint(tied)).toBe(tiedBefore);
  for(const flags of [[true,false],[false,true]])expect(()=>prepareHarmonyTranspose(piano(),command(bars(),{kind:'diatonic',steps:1},...flags as [boolean,boolean]),2)).toThrow();
});
it('key_scope_and_mixed_guitar_piano_drum_arrangement preserve drum music and links exactly',()=>{
  const score=music();score.addTrack(piano([60,64,67]).tracks[0]);const drums=piano().tracks[0];score.addTrack(drums);drums.staves[0].isPercussion=true;drums.staves[0].showTablature=false;drums.playbackInfo.program=0;
  for(const bar of drums.staves[0].bars){bar.keySignature=model.KeySignature.Bb;bar.keySignatureType=model.KeySignatureType.Minor;for(const note of bar.voices[0].beats.flatMap(beat=>beat.notes)){note.octave=-1;note.tone=-1;note.percussionArticulation=38;}}
  tie(beat(score,0,0,2).notes[0],beat(score,1,0,2).notes[0]);const drumJson=JSON.stringify(JSON.parse(model.JsonConverter.scoreToJson(score)).tracks[2]),links=captureNoteLinks(score).filter(link=>link.kind==='tie'),before=fingerprint(score);
  const result=prepareHarmonyTranspose(score,command(bars([0,1,2]),{kind:'semitones',semitones:2},true),8);
  expect(beat(result).notes[0].realValue).toBe(69);expect(beat(result,0,0,1).notes.map(note=>note.realValue)).toEqual([62,66,69]);expect(result.tracks.slice(0,2).map(track=>track.staves[0].bars[0].keySignature)).toEqual([2,2]);
  expect(JSON.parse(model.JsonConverter.scoreToJson(result)).tracks[2]).toEqual(JSON.parse(drumJson));expect(captureNoteLinks(result).filter(link=>link.kind==='tie')).toEqual(links);expect(fingerprint(score)).toBe(before);
});
it('requires full bars and every declared track for key changes and preserves minor mode/sign policy',()=>{
  const score=piano();score.addTrack(piano().tracks[0]);for(const selection of [bars([0]),selected(address()),{kind:'range',range:{start:{bar:0,tick:960},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0},{track:1,staff:0,voice:0}]}} as MusicSelection])expect(()=>prepareHarmonyTranspose(score,command(selection,{kind:'semitones',semitones:2},true),5)).toThrow(/bar|track|complete/i);
  const range:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0},{track:1,staff:0,voice:0}]}};expect(prepareHarmonyTranspose(score,command(range,{kind:'semitones',semitones:2},true),5).tracks[1].staves[0].bars[0].keySignature).toBe(2);
  const minor=piano();minor.tracks[0].staves[0].bars[0].keySignatureType=model.KeySignatureType.Minor;const result=prepareHarmonyTranspose(minor,command(bars(),chromatic(3,'minor'),true),5);expect(result.tracks[0].staves[0].bars[0]).toMatchObject({keySignature:-3,keySignatureType:model.KeySignatureType.Minor});
  const flat=piano();flat.tracks[0].staves[0].bars[0].keySignature=-1;expect(prepareHarmonyTranspose(flat,command(bars(),{kind:'semitones',semitones:1},true),5).tracks[0].staves[0].bars[0].keySignature).toBe(-6);
});
it('skips percussion in every interval mode and rejects an all-percussion no-op',()=>{
  for(const interval of [{kind:'semitones',semitones:1},chromatic(3,'major'),{kind:'diatonic',steps:2}] as HarmonyInterval[]){const score=piano(),drums=piano().tracks[0];score.addTrack(drums);drums.staves[0].isPercussion=true;for(const note of allNotes(score).filter(note=>note.beat.voice.bar.staff.track===drums)){note.octave=-1;note.tone=-1;note.percussionArticulation=38;}
    const result=prepareHarmonyTranspose(score,command(bars([0,1]),interval),6);expect(beat(result,0,0,1).notes[0].percussionArticulation).toBe(38);
    const only=score.tracks[1];score.tracks=[only];only.index=0;expect(()=>prepareHarmonyTranspose(score,command(bars(),interval),6)).toThrow(/no.*change|nothing|melodic/i);
  }
});
it('transposes only effective theory chords and clones shared definitions for selected beats',()=>{
  const score=music(),id=install(score);beat(score,1).chordId=id;const before=fingerprint(score),result=prepareHarmonyTranspose(score,command(selected(address()),{kind:'semitones',semitones:2},false,true),31),staff=result.tracks[0].staves[0],changed=staff.getChord(beat(result).chordId!)!;
  expect(beat(result).chordId).toBe('harmony/31/0/0/0/0/0');expect(beat(result,1).chordId).toBe(id);expect(getHarmonyChord(staff.getChord(id)!)).toEqual(definition());expect(changed.name).toBe('D');expect(getHarmonyChord(changed)).toMatchObject({recipe:{root:{step:1,alteration:0},formula:'major'},firstFret:2,frets:[2,3,2,4,5,-1],showName:false,showDiagram:true,showFingering:false});expect(fingerprint(score)).toBe(before);
  const partial=music();install(partial);const extra=new model.Note();extra.string=5;extra.fret=0;beat(partial).addNote(extra);expect(()=>prepareHarmonyTranspose(partial,command(selected(address()),{kind:'semitones',semitones:2},false,true),31)).toThrow(/whole|complete|chord/i);
  const manual=music();install(manual,{...definition(),name:' manual ',nameMode:'manual',recipe:null});const manualResult=prepareHarmonyTranspose(manual,command(selected(address()),{kind:'semitones',semitones:2},false,true),31);expect(getHarmonyChord(manualResult.tracks[0].staves[0].getChord(beat(manualResult).chordId!)!)).toMatchObject({name:' manual ',nameMode:'manual',recipe:null});
  const stale=music();const staleId=install(stale);stale.tracks[0].staves[0].capo=1;const staleResult=prepareHarmonyTranspose(stale,command(selected(address()),{kind:'semitones',semitones:2},false,true),31);expect(beat(staleResult).chordId).toBe(staleId);expect(getHarmonyChord(staleResult.tracks[0].staves[0].getChord(staleId)!).nameMode).toBe('manual');
});
it('preserves slash bass/modifiers and supports all-muted names without fabricating played shapes',()=>{
  const recipe={root:{step:0,alteration:0},formula:'7' as const,alterations:[{degree:9 as const,shift:-1 as const}],omissions:[5 as const],bass:{step:2,alteration:0}},value:HarmonyChord={...definition(),name:'C7(b9,no5)/E',recipe,frets:[-1,-1,-1,-1,-1,-1],fingers:[-2,-2,-2,-2,-2,-2]};
  const score=music();install(score,value);const result=prepareHarmonyTranspose(score,command(selected(address()),chromatic(3,'minor'),false,true),12),transposed=getHarmonyChord(result.tracks[0].staves[0].getChord(beat(result).chordId!)!);
  expect(transposed.name).toBe('Eb7(b9,no5)/G');expect(transposed.recipe).toEqual({...recipe,root:{step:2,alteration:-1},bass:{step:4,alteration:0}});expect(transposed.frets).toEqual(value.frets);
});
it('rejects unplayable final diagrams without mutating source and falls back to a valid bounded shape',()=>{
  const score=music();install(score);const result=prepareHarmonyTranspose(score,command(selected(address()),{kind:'semitones',semitones:-1},false,true),19),chord=getHarmonyChord(result.tracks[0].staves[0].getChord(beat(result).chordId!)!);expect(chord.name).toBe('B');expect(chord.nameMode).toBe('theory');
  const impossible=music(),staff=impossible.tracks[0].staves[0];staff.stringTuning.tunings=[127];beat(impossible).notes=[];for(const bar of staff.bars)for(const current of bar.voices[0].beats){current.notes=[];current.isEmpty=false;}
  const singleton:HarmonyChord={...definition(),name:'G5(no5)',recipe:{root:{step:4,alteration:0},formula:'power',alterations:[],omissions:[5],bass:null},frets:[0],fingers:[-2]};install(impossible,singleton);const before=fingerprint(impossible);expect(()=>prepareHarmonyTranspose(impossible,command(bars(),{kind:'semitones',semitones:1},false,true),19)).toThrow(/shape|diagram/i);expect(fingerprint(impossible)).toBe(before);
});
it('preserves fully selected duplicate ties and canonical promotion at a single selected boundary destination',()=>{
  for(const selectedIndex of [null,0,1]){const score=piano(),origin=beat(score).notes[0],first=beat(score,1).notes[0],last=new model.Note();last.octave=5;last.tone=0;beat(score,1).addNote(last);tie(origin,first);tie(origin,last);
    const selection=selectedIndex===null?selected(address(),address(1),address(1,1)):selected(address(1,selectedIndex)),result=prepareHarmonyTranspose(score,command(selection,{kind:'semitones',semitones:2}),23),a=beat(result).notes[0],b=beat(result,1).notes[0],c=beat(result,1).notes[1];
    if(selectedIndex===null){expect([a.realValue,b.realValue,c.realValue]).toEqual([62,62,62]);expect(a.tieDestination).toBe(c);expect(b.tieOrigin).toBe(a);expect(c.tieOrigin).toBe(a);}else{const moved=selectedIndex===0?b:c,survivor=selectedIndex===0?c:b;expect(moved.tieOrigin).toBeNull();expect(a.tieDestination).toBe(survivor);expect(survivor.tieOrigin).toBe(a);}
    expect(origin.tieDestination).toBe(last);expect(first.tieOrigin).toBe(origin);expect(last.tieOrigin).toBe(origin);
  }
});
it('transpose_preserves_nonpitch_sources backing archives raw hidden lyrics fractional DSP bends and dynamics',()=>{
  const original=music();original.backingTrack=new model.BackingTrack();original.backingTrack.rawAudioFile=new Uint8Array([82,73,70,70,11,22,33,44]);original.applyFlatSyncPoints([{barIndex:0,barOccurence:0,barPosition:.25,millisecondOffset:250},{barIndex:2,barOccurence:0,barPosition:.5,millisecondOffset:3500}]);
  const archive=unzipSync(exportGpInterchange(original,settings));archive['Content/Assets/preserved.txt']=strToU8('exact sibling');const bytes=zipSync(archive),input=bytes.slice(),score=loadInterchangeScore(bytes,settings),note=beat(score).notes[0];note.dynamics=3;note.trillValue=note.realValue+2;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));note.accidentalMode=model.NoteAccidentalMode.ForceFlat;
  const raw={visible:false,lines:[{startBar:0,text:'[VERSE]\r\nHel-lo  world+today'}]};setLyricsSource(score.tracks[0],raw,true);beat(score,3).automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,ratioPosition:.25,value:4}));install(score);const before=fingerprint(score),result=prepareHarmonyTranspose(score,command(selected(address()),{kind:'semitones',semitones:1}),44),after=beat(result).notes[0];
  expect(after).toMatchObject({dynamics:3,trillValue:note.trillValue+1,accidentalMode:model.NoteAccidentalMode.Default});expect(after.bendPoints?.map(point=>[point.offset,point.value])).toEqual([[0,0],[60,4]]);expect(getLyricsSource(result.tracks[0])).toEqual({value:raw,managed:true});expect(beat(result,3).automations.some(automation=>automation.type===model.AutomationType.Volume&&automation.ratioPosition===.25&&automation.value===4)).toBe(true);
  expect(result.exportFlatSyncPoints()).toEqual(score.exportFlatSyncPoints());expect(result.backingTrack?.rawAudioFile).toEqual(score.backingTrack?.rawAudioFile);expect(result.backingTrack?.rawAudioFile).not.toBe(score.backingTrack?.rawAudioFile);expect(unzipSync(exportGpInterchange(result,settings))['Content/Assets/preserved.txt']).toEqual(strToU8('exact sibling'));expect(getHarmonyChord(result.tracks[0].staves[0].getChord(beat(result).chordId!)!)).toEqual(definition());expect(fingerprint(score)).toBe(before);expect(bytes).toEqual(input);
  result.backingTrack!.rawAudioFile![0]=0;expect(score.backingTrack!.rawAudioFile![0]).toBe(82);
});
it('uses destination key sign for semitone chord names and rejects triple-accidental spellings',()=>{
  for(const [includeKeySignatures,name]of [[false,'C#'],[true,'Db']] as const){const score=music();install(score);const result=prepareHarmonyTranspose(score,command(bars(),{kind:'semitones',semitones:1},includeKeySignatures,true),3);expect(result.tracks[0].staves[0].getChord(beat(result).chordId!)?.name).toBe(name);}
  const score=music(),value:HarmonyChord={...definition(),name:'D##',recipe:{root:{step:1,alteration:2},formula:'major',alterations:[],omissions:[],bass:null},frets:[-1,-1,-1,-1,-1,-1],fingers:[-2,-2,-2,-2,-2,-2]};install(score,value);const before=fingerprint(score);expect(()=>prepareHarmonyTranspose(score,command(selected(address()),chromatic(1,'augmented'),false,true),3)).toThrow(/double accidental|spelling/i);expect(fingerprint(score)).toBe(before);
});
it('permits key-only changes on rests and rejects incomplete staff or voice range coverage',()=>{
  const score=piano();for(const current of score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats))current.notes=[];
  const result=prepareHarmonyTranspose(score,command(bars(),{kind:'semitones',semitones:2},true),2);expect(result.tracks[0].staves[0].bars[0].keySignature).toBe(model.KeySignature.D);expect(allNotes(result)).toEqual([]);
  const other=piano().tracks[0].staves[0];score.tracks[0].addStaff(other);for(const bar of other.bars){const voice=new model.Voice(),empty=new model.Beat();voice.addBeat(empty);bar.addVoice(voice);}
  const range:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}};
  expect(()=>prepareHarmonyTranspose(score,command(range,{kind:'semitones',semitones:2},true),2)).toThrow(/staff|voice|complete/i);range.range.lanes.push({track:0,staff:1,voice:0});expect(()=>prepareHarmonyTranspose(score,command(range,{kind:'semitones',semitones:2},true),2)).toThrow(/staff|voice|complete/i);
});
it('records the existing public transposed-trill alternate-pitch limitation separately from primary MIDI success',()=>{
  const score=piano(),staff=score.tracks[0].staves[0],note=beat(score).notes[0];staff.transpositionPitch=12;note.trillValue=62;
  const result=prepareHarmonyTranspose(score,command(selected(address()),{kind:'semitones',semitones:1}),2),notes=midiNotes(exportMidi(result,{tracks:[0],range:{first:0,last:0}}));expect(beat(result).notes[0].realValue).toBe(49);expect(beat(result).notes[0].trillValue).toBe(63);expect(notes[0][0]).toBe(49);expect(notes.some(event=>event[0]===63)).toBe(true);
});
it('clears newly open fingers and nonpositive shifted barres while keeping the original definition exact',()=>{
  const score=music(),value:HarmonyChord={...definition(),name:'F',recipe:{root:{step:3,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},frets:[1,1,2,3,3,1],fingers:[1,1,2,3,4,1],barreFrets:[1]};
  const originalId=install(score,value),before=fingerprint(score),result=prepareHarmonyTranspose(score,command(selected(address()),{kind:'semitones',semitones:-1},false,true),8),staff=result.tracks[0].staves[0],chord=getHarmonyChord(staff.getChord(beat(result).chordId!)!);
  expect(chord).toMatchObject({name:'E',frets:[0,0,1,2,2,0],fingers:[-2,-2,2,3,4,-2],barreFrets:[]});expect(getHarmonyChord(staff.getChord(originalId)!)).toEqual(value);expect(fingerprint(score)).toBe(before);
});
