import { expect, it } from 'vitest';
import { exporter, importer, midi, model, Settings } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { scoreFromJson } from '../model-clone';
import { applyNonTabEdit } from './non-tab';
import { percussionChoices, resolvePercussionArticulation, standardPercussionCatalog } from './percussion-catalog';
import { applyNoteLink, applyNoteTechniques, applyBeatTechniques } from './techniques';
import { noteAt } from './common';
import { music, target } from './fixtures';

const settings=new Settings();
const edit=(score:model.Score,command:unknown)=>applyNonTabEdit(score,command as EditCommand);
function blank(percussion=false) {
  const score=new model.Score();score.addMasterBar(new model.MasterBar());
  edit(score,{type:percussion?'addPercussionTrack':'addPitchedTrack',name:percussion?'Drums':'Piano',program:0});
  score.finish(settings);return score;
}
const beat=(score:model.Score,index=0)=>score.tracks[0].staves[0].bars[0].voices[0].beats[index];
const address=(index=0,noteIndex=0)=>({target:{...target,beat:index},noteIndex});
function notesFromSmf(score:model.Score) {
  score.finish(settings);const file=new midi.MidiFile(),handler=new midi.AlphaSynthMidiFileHandler(file,true),generator=new midi.MidiFileGenerator(score,settings,handler);generator.applyTranspositionPitches=true;generator.generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const u16=()=>{const value=view.getUint16(p);p+=2;return value;},u32=()=>{const value=view.getUint32(p);p+=4;return value;},ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n));
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=(value<<7)|(byte&127);}while(byte&128);return value;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();u16();const result:Array<{key:number;channel:number;velocity:number}>=[];
  for(let i=0;i<tracks;i++){expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let status=0;while(p<end){variable();let type=bytes[p++];if(type<128){p--;type=status;}else if(type<240)status=type;if(type===255){p++;const length=variable();p+=length;}else if(type===240||type===247){const length=variable();p+=length;}else{const kind=type&240,data=[...bytes.slice(p,p+=(kind===192||kind===208?1:2))];if(kind===144&&data[1]>0)result.push({key:data[0],channel:type&15,velocity:data[1]});}}}
  return result;
}

it('creates notation tracks with all measures and more than fifteen distinct melodic channels',()=>{
  const score=new model.Score();score.addMasterBar(new model.MasterBar());score.addMasterBar(new model.MasterBar());
  for(let i=0;i<20;i++)expect(edit(score,{type:'addPitchedTrack',name:`Piano ${i}`,program:i})).toBe(true);
  const channels=score.tracks.flatMap(t=>[t.playbackInfo.primaryChannel,t.playbackInfo.secondaryChannel]);expect(new Set(channels).size).toBe(40);expect(channels).not.toContain(9);
  expect(score.tracks[19].staves[0].bars).toHaveLength(2);expect(score.tracks[0].staves[0].tuning).toEqual([]);expect(score.tracks[0].staves[0].showTablature).toBe(false);expect(score.tracks[0].staves[0].showStandardNotation).toBe(true);
  edit(score,{type:'addPercussionTrack',name:'Kit',program:1});const drums=score.tracks[20];expect(drums.playbackInfo.primaryChannel).toBe(9);expect(drums.playbackInfo.secondaryChannel).toBe(9);expect(drums.staves[0].bars[0].clef).toBe(model.Clef.Neutral);
  expect(edit(score,{type:'setScoreInfo',title:'',artist:'',tempo:120})).toBe(false);
  for(const program of [-1,128,1.5])expect(()=>edit(score,{type:'addPitchedTrack',name:'',program})).toThrow();
});
it('adds piano chords by written MIDI pitch and emits literal boundary pitches',()=>{
  const score=blank();for(const pitch of [60,69,127,0])edit(score,{type:'addPitchedNote',target,pitch});
  expect(beat(score).notes.map(n=>[n.string,n.fret,n.octave,n.tone])).toEqual([[-1,-1,5,0],[-1,-1,5,9],[-1,-1,10,7],[-1,-1,0,0]]);
  expect(notesFromSmf(score).map(n=>n.key)).toEqual([60,69,127,0]);
  expect(()=>edit(score,{type:'addPitchedNote',target,pitch:60})).toThrow(/already|duplicate/i);
  expect(()=>edit(score,{type:'setPitchedNote',target,noteIndex:1,pitch:60})).toThrow(/already|duplicate/i);expect(beat(score).notes[1].realValue).toBe(69);
});
it('sounding transposition changes playback while display transposition does not',()=>{
  const score=blank(),staff=score.tracks[0].staves[0];staff.transpositionPitch=12;staff.displayTranspositionPitch=24;edit(score,{type:'addPitchedNote',target,pitch:60});
  expect(notesFromSmf(score).map(n=>n.key)).toEqual([48]);expect(beat(score).notes[0].octave).toBe(5);
  for(const pitch of [-1,128,1.5,NaN,0])expect(()=>edit(score,{type:'addPitchedNote',target,pitch})).toThrow();
  expect(beat(score).notes).toHaveLength(1);
});
it('maps named public drum IDs to MIDI keys on channel nine and honors custom indices first',()=>{
  const score=blank(true);for(const [index,articulation] of [91,92,114,124].entries())edit(score,{type:'addPercussionNote',target:{...target,beat:index},articulation});
  expect(notesFromSmf(score).map(n=>[n.key,n.channel])).toEqual([[38,9],[46,9],[43,9],[62,9]]);
  const custom=new model.InstrumentArticulation('Custom shaker',-1,82,model.MusicFontSymbol.NoteheadXBlack,undefined,undefined,undefined,undefined,91);
  score.tracks[0].percussionArticulations=[custom];edit(score,{type:'setPercussionNote',target,noteIndex:0,articulation:0});
  expect(resolvePercussionArticulation(score.tracks[0],0)?.outputMidiNumber).toBe(82);expect(resolvePercussionArticulation(score.tracks[0],91)?.outputMidiNumber).toBe(38);
  expect(notesFromSmf(score)[0]).toMatchObject({key:82,channel:9});expect(percussionChoices(score.tracks[0])[0]).toMatchObject({id:0,label:expect.stringContaining('Custom shaker')});
  expect(new Set(standardPercussionCatalog.map(a=>a.id)).size).toBe(94);expect(standardPercussionCatalog).toHaveLength(95);
  const large=Array.from({length:92},()=>custom);large[91]=new model.InstrumentArticulation('Overridden snare',3,82);score.tracks[0].percussionArticulations=large;
  expect(percussionChoices(score.tracks[0]).filter(a=>a.id===91)).toHaveLength(1);expect(resolvePercussionArticulation(score.tracks[0],91)?.outputMidiNumber).toBe(82);
});
it('resolves complete standard drum notation symbols for owned GP export without sharing mutable entries',()=>{
  const track=blank(true).tracks[0],rim=resolvePercussionArticulation(track,91)!;expect(rim.noteHeadDefault).toBe(model.MusicFontSymbol.NoteheadDiamondWhite);expect(resolvePercussionArticulation(track,92)?.noteHeadHalf).toBe(model.MusicFontSymbol.NoteheadCircleSlash);
  const choke=resolvePercussionArticulation(track,29)!;expect(choke.techniqueSymbol).toBe(model.MusicFontSymbol.ArticStaccatoAbove);expect(choke.techniqueSymbolPlacement).toBe(model.TechniqueSymbolPlacement.Outside);
  rim.outputMidiNumber=1;expect(resolvePercussionArticulation(track,91)?.outputMidiNumber).toBe(38);
});
it('rejects invalid staff types, articulation IDs, note indices and collisions without changing siblings',()=>{
  const piano=blank(),drums=blank(true);edit(piano,{type:'addPitchedNote',target,pitch:60});edit(drums,{type:'addPercussionNote',target,articulation:91});edit(drums,{type:'addPercussionNote',target,articulation:92});
  for(const articulation of [-1,0,128,1.5,NaN])expect(()=>edit(drums,{type:'addPercussionNote',target,articulation})).toThrow();
  expect(()=>edit(drums,{type:'addPercussionNote',target,articulation:91})).toThrow(/already|duplicate/i);
  expect(()=>edit(drums,{type:'setPercussionNote',target,noteIndex:1,articulation:91})).toThrow(/already|duplicate/i);
  for(const noteIndex of [-1,1.5,2,NaN])expect(()=>edit(drums,{type:'removeNoteByIndex',target,noteIndex})).toThrow();
  expect(()=>edit(piano,{type:'addPercussionNote',target,articulation:91})).toThrow();expect(()=>edit(drums,{type:'addPitchedNote',target,pitch:60})).toThrow();expect(()=>edit(music(),{type:'addPitchedNote',target,pitch:60})).toThrow();
  expect(beat(drums).notes.map(n=>n.percussionArticulation)).toEqual([91,92]);
  drums.tracks[0].percussionArticulations=[new model.InstrumentArticulation('Silent',0,-1)];expect(()=>edit(drums,{type:'addPercussionNote',target,articulation:0})).toThrow();
});
it('indexed removal detaches both relationship ends, reindexes siblings and leaves a rest',()=>{
  const score=blank();for(const index of [0,1])for(const pitch of [60,64])edit(score,{type:'addPitchedNote',target:{...target,beat:index},pitch});
  applyNoteLink(score,address() as never,address(1) as never,'tie');applyNoteLink(score,address(0,1) as never,address(1) as never,'slur');
  const destination=beat(score,1).notes[0];edit(score,{type:'removeNoteByIndex',target:{...target,beat:1},noteIndex:0});
  expect(beat(score).notes[0].tieDestination).toBeNull();expect(beat(score).notes[1].slurDestination).toBeNull();expect(destination.tieOrigin).toBeNull();expect(beat(score,1).notes[0].index).toBe(0);
  edit(score,{type:'removeNoteByIndex',target:{...target,beat:1},noteIndex:0});expect(beat(score,1).isRest).toBe(true);expect(beat(score,1).isEmpty).toBe(false);
});
it('indexed techniques and links address chord members and tie pitch changes preserve the chain',()=>{
  const score=blank();for(const index of [0,1,2])for(const pitch of [60,64])edit(score,{type:'addPitchedNote',target:{...target,beat:index},pitch});
  edit(score,{type:'setNoteTechniquesByIndex',target,noteIndex:1,patch:{ghost:true,dynamics:3,leftFinger:4}});expect(noteAt(score,address(0,1) as never).isGhost).toBe(true);expect(beat(score).notes[0].isGhost).toBe(false);
  for(const index of [0,1])edit(score,{type:'setNoteLinkByIndex',from:address(index,1),to:address(index+1,1),kind:'tie'});
  const middle=beat(score,1).notes[1];edit(score,{type:'setPitchedNote',target:{...target,beat:1},noteIndex:1,pitch:67});
  expect([0,1,2].map(i=>beat(score,i).notes[1].realValue)).toEqual([67,67,67]);expect(middle.tieOrigin).toBe(beat(score).notes[1]);expect(middle.isGhost).toBe(false);
  expect(()=>edit(score,{type:'setPitchedNote',target,noteIndex:1,pitch:60})).toThrow(/already|duplicate/i);expect(middle.realValue).toBe(67);
  edit(score,{type:'setNoteLinkByIndex',from:address(),to:address(1,1),kind:'slur'});expect(beat(score).notes[0].slurDestination).toBe(middle);
  expect(()=>applyNoteLink(score,address(1) as never,address() as never,'slur')).toThrow();
});
it('generic techniques reject unsupported guitar effects atomically and preserve legacy string addressing',()=>{
  const piano=blank(),drums=blank(true);edit(piano,{type:'addPitchedNote',target,pitch:60});edit(drums,{type:'addPercussionNote',target,articulation:91});
  for(const patch of [{palmMute:true},{letRing:true},{dead:true},{leftHandTapped:true},{slideOut:4},{slideIn:1},{bend:{type:2,style:0,points:[{offset:0,value:0},{offset:60,value:4}]}},{harmonic:{type:1,value:12}}])expect(()=>applyNoteTechniques(piano,address() as never,{accent:2,...patch})).toThrow(/string|guitar/i);
  expect(beat(piano).notes[0].accentuated).toBe(0);expect(()=>applyNoteLink(piano,address() as never,address(1) as never,'hammerPull')).toThrow();
  for(const patch of [{leftFinger:1},{rightFinger:1},{trill:{pitch:62,speed:16}},{vibrato:1},{ornament:1}])expect(()=>applyNoteTechniques(drums,address() as never,patch)).toThrow(/percussion/i);
  for(const patch of [{pickStroke:1},{brushType:1},{whammy:{type:1,style:0,points:[{offset:0,value:0},{offset:60,value:-4}]}}])expect(()=>applyBeatTechniques(piano,target,patch)).toThrow(/string|guitar/i);
  const guitar=music();applyNoteTechniques(guitar,{target,string:6},{palmMute:true});expect(noteAt(guitar,{target,string:6}).isPalmMute).toBe(true);
});
it('indexed techniques and relationships survive JSON reconstruction with independent chord pitches',()=>{
  const score=blank();for(const index of [0,1])for(const pitch of [60,64])edit(score,{type:'addPitchedNote',target:{...target,beat:index},pitch});
  edit(score,{type:'setNoteTechniquesByIndex',target,noteIndex:1,patch:{ghost:true,dynamics:3,leftFinger:4}});edit(score,{type:'setNoteLinkByIndex',from:address(),to:address(1),kind:'tie'});edit(score,{type:'setNoteLinkByIndex',from:address(0,1),to:address(1,1),kind:'slur'});
  const rebuilt=scoreFromJson(model.JsonConverter.scoreToJson(score),settings),first=beat(rebuilt).notes;
  expect(first[1].dynamics).toBe(3);expect(first[1].isGhost).toBe(true);expect(first[1].leftHandFinger).toBe(4);expect(first[0].tieDestination).toBe(beat(rebuilt,1).notes[0]);expect(first[1].slurDestination).toBe(beat(rebuilt,1).notes[1]);
});
it('tie edits validate every destination before changing any member for piano and percussion',()=>{
  const piano=blank();for(const index of [0,1])edit(piano,{type:'addPitchedNote',target:{...target,beat:index},pitch:60});edit(piano,{type:'addPitchedNote',target:{...target,beat:1},pitch:64});edit(piano,{type:'setNoteLinkByIndex',from:address(),to:address(1),kind:'tie'});
  expect(()=>edit(piano,{type:'setPitchedNote',target,noteIndex:0,pitch:64})).toThrow(/already|duplicate/i);expect(beat(piano).notes[0].realValue).toBe(60);expect(beat(piano,1).notes[0].realValue).toBe(60);
  const drums=blank(true);for(const index of [0,1])edit(drums,{type:'addPercussionNote',target:{...target,beat:index},articulation:91});edit(drums,{type:'setNoteLinkByIndex',from:address(),to:address(1),kind:'tie'});edit(drums,{type:'setPercussionNote',target,noteIndex:0,articulation:92});expect([beat(drums),beat(drums,1)].map(b=>b.notes[0].percussionArticulation)).toEqual([92,92]);
});
it('preserves capacity when activating an empty beat and rejects an overfull voice',()=>{
  const score=blank(),voice=beat(score).voice;const extra=new model.Beat();extra.isEmpty=true;extra.duration=4;voice.addBeat(extra);
  expect(()=>edit(score,{type:'addPitchedNote',target:{...target,beat:4},pitch:60})).toThrow(/overfill/i);expect(extra.notes).toHaveLength(0);expect(extra.isEmpty).toBe(true);
  voice.beats.splice(3,1);edit(score,{type:'addPitchedNote',target:{...target,beat:3},pitch:60});expect(extra.isEmpty).toBe(false);expect(extra.notes).toHaveLength(1);
});
it('retains edited pitches through JSON and characterizes the public GP standard drum mapping loss',()=>{
  const score=blank();for(const [i,pitch] of [0,60,69,127].entries())edit(score,{type:'addPitchedNote',target:{...target,beat:i},pitch});
  edit(score,{type:'addPercussionTrack',name:'Drums',program:0});for(const [i,articulation] of [91,92,114,124].entries())edit(score,{type:'addPercussionNote',target:{...target,track:1,beat:i},articulation});
  const json=scoreFromJson(model.JsonConverter.scoreToJson(score),settings),gp=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,settings),settings);
  const notes=notesFromSmf(json);expect(notes.filter(n=>n.channel===0).map(n=>n.key)).toEqual([0,60,69,127]);expect(notes.filter(n=>n.channel===9).map(n=>n.key)).toEqual([38,46,43,62]);
  const gpNotes=notesFromSmf(gp);expect(gpNotes.filter(n=>n.channel===0).map(n=>n.key)).toEqual([0,60,69,127]);
  // The public exporter writes standard IDs against a newly indexed InstrumentSet.
  // The owned interchange adapter corrects this; retain the upstream characterization.
  expect(gpNotes.filter(n=>n.channel===9).map(n=>n.key)).toEqual([59,49,43,62]);
});
