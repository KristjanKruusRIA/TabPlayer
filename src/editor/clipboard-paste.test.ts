import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { preparePasteMusic } from './clipboard-paste';
import { makeMusicClip } from './clipboard-source';
import { music } from './fixtures';
import { captureNoteLinks,restoreNoteLinks } from './links';
import { scoreFromJson } from '../model-clone';
import { setLyricsSource,getLyricsSource } from './lyrics-source';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import { unzipSync,zipSync,strToU8 } from 'fflate';
import { rhythmTicks } from './common';
import type { ClipboardCommand,MusicClip,PasteFilters } from './clipboard-types';
import { getHarmonyChord,setHarmonyChordSource } from '../harmony/chord-source';
import type { HarmonyChord } from './harmony-types';
import { buildDocument,previewEdit } from '../engine';
import { blankProject } from '../project';

const all:PasteFilters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false};
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
function rebuild(score:model.Score){const result=scoreFromJson(json(score),new Settings());restoreNoteLinks(result,captureNoteLinks(score));return result;}
function command(clip:MusicClip,bar=1):ClipboardCommand{return {type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:clip.kind==='bars'?'beforeBar':'currentBar',filters:{...all}}};}
function bars(score=music(),mode:'singleTrack'|'multiTrack'='singleTrack'){return makeMusicClip(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:1},mode);}
function phrase(score=music(),last=1){return makeMusicClip(score,{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:(last+1)*960},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack');}
function rests(score:model.Score,bar:number,from=0){for(const beat of score.tracks[0].staves[0].bars[bar].voices[0].beats.slice(from)){beat.notes=[];beat.isEmpty=false;}return rebuild(score);}
const auto=(type:model.AutomationType,value:number,ratioPosition=0)=>Object.assign(new model.Automation(),{type,value,ratioPosition});
function richChord(staff:model.Staff,value:HarmonyChord={name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true}) {const chord=Object.assign(new model.Chord(),{name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});staff.addChord('rich',chord);staff.bars[0].voices[0].beats[0].chordId='rich';setHarmonyChordSource(chord,value);return value;}
function pianoMusic() {const score=music(),staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[];for(const bar of staff.bars)for(const beat of bar.voices[0].beats)for(const note of beat.notes){note.string=-1;note.fret=-1;note.octave=5;note.tone=0;}return rebuild(score);}
it('v2 matching-context repeated paste preserves rich metadata with detached fresh chord IDs',()=>{
  const source=music(),value=richChord(source.tracks[0].staves[0]),clip=bars(source),edit=command(clip);expect(clip.version).toBe(2);edit.options.count=2;const destination=music(),before=json(destination),result=preparePasteMusic(destination,edit).score,staff=result.tracks[0].staves[0],first=staff.bars[1].voices[0].beats[0],second=staff.bars[3].voices[0].beats[0];
  expect(first.chordId).not.toBe(second.chordId);expect(getHarmonyChord(staff.getChord(first.chordId!)!)).toEqual(value);expect(getHarmonyChord(staff.getChord(second.chordId!)!)).toEqual(value);expect(json(destination)).toBe(before);
  staff.getChord(first.chordId!)!.strings[0]=12;expect(getHarmonyChord(staff.getChord(second.chordId!)!)).toEqual(value);expect(clip.version===2&&clip.harmony[0].chord).toEqual(value);
  const restarted=JSON.parse(JSON.stringify(edit)) as ClipboardCommand;expect(getHarmonyChord(preparePasteMusic(destination,restarted).score.tracks[0].staves[0].getChord(first.chordId!)!)).toEqual(value);
});
it('v2 rich diagrams reject mismatched tuning, capo, sounding offset, string count and family atomically',()=>{
  const source=music();richChord(source.tracks[0].staves[0]);const clip=bars(source);
  for(const mismatch of ['tuning','capo','offset','strings','piano'] as const){const destination=mismatch==='piano'?pianoMusic():music(),staff=destination.tracks[0].staves[0];if(mismatch==='tuning')staff.stringTuning.tunings[0]--;if(mismatch==='capo')staff.capo=1;if(mismatch==='offset')staff.transpositionPitch=1;if(mismatch==='strings')staff.stringTuning.tunings.push(35);const before=json(destination),snapshot=structuredClone(clip);expect(()=>preparePasteMusic(destination,command(clip))).toThrow(/diagram|context|tuning/i);expect(json(destination)).toBe(before);expect(clip).toEqual(snapshot);}
});
it('diagrams off keeps v2 note conversion and v1 public-only diagrams keep their old meaning',()=>{
  const source=music();richChord(source.tracks[0].staves[0]);const clip=bars(source),edit=command(clip);edit.options.filters.diagrams=false;const result=preparePasteMusic(pianoMusic(),edit).score;expect(result.tracks[0].staves[0].bars[1].voices[0].beats[0].chordId).toBeNull();expect(result.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].isPiano).toBe(true);
  richChord(source.tracks[0].staves[0],{...getHarmonyChord(source.tracks[0].staves[0].getChord('rich')!),nameMode:'manual',recipe:null,fingers:Array(6).fill(-2)});const legacy=bars(source);expect(legacy.version).toBe(1);const copied=preparePasteMusic(pianoMusic(),command(legacy)).score.tracks[0].staves[0];expect(copied.getChord(copied.bars[1].voices[0].beats[0].chordId!)!.strings).toEqual([0,1,0,2,3,-1]);
});
it('v2 manual zero-string name-only records paste between matching untuned contexts',()=>{
  const source=pianoMusic(),value:HarmonyChord={name:'Label only',nameMode:'manual',recipe:null,firstFret:0,frets:[],fingers:[],barreFrets:[],showName:false,showDiagram:false,showFingering:false};richChord(source.tracks[0].staves[0],value);const clip:MusicClip={...bars(source),version:2,harmony:[{track:0,staff:0,chordId:'rich',chord:value}]},destination=pianoMusic(),result=preparePasteMusic(destination,command(clip)).score.tracks[0].staves[0];expect(getHarmonyChord(result.getChord(result.bars[1].voices[0].beats[0].chordId!)!)).toEqual(value);
  destination.tracks[0].staves[0].capo=1;expect(()=>preparePasteMusic(destination,command(clip))).toThrow(/diagram|context|capo/i);
});
it('v2 native-style command history replays rich diagrams with an empty app clipboard and one undo step',()=>{
  const source=music(),value=richChord(source.tracks[0].staves[0]),edit=command(bars(source));edit.options.count=2;const base=blankProject(),pasted=previewEdit(base,edit),saved=JSON.parse(JSON.stringify(pasted.project)),restarted=buildDocument(saved),staff=restarted.score.tracks[0].staves[0];
  expect(pasted.project.edits).toHaveLength(1);expect(restarted.score.masterBars).toHaveLength(8);for(const bar of [1,3])expect(getHarmonyChord(staff.getChord(staff.bars[bar].voices[0].beats[0].chordId!)!)).toEqual(value);
  expect(buildDocument({...saved,edits:saved.edits.slice(0,-1)}).score.masterBars).toHaveLength(4);const redone=buildDocument(JSON.parse(JSON.stringify(saved))).score.tracks[0].staves[0];expect(getHarmonyChord(redone.getChord(redone.bars[1].voices[0].beats[0].chordId!)!)).toEqual(value);expect(base.edits).toHaveLength(0);
});
it('preserves destination rich definitions and permissive imported manual values through paste cloning',()=>{
  const destination=music(),original=richChord(destination.tracks[0].staves[0]),source=music(),manual:HarmonyChord={...original,name:'exact manual name',nameMode:'manual',recipe:null,firstFret:0,frets:[0,23,-1,2,15,0],fingers:[-2,4,-1,1,3,0],barreFrets:[0,2,2,23],showName:false,showDiagram:false,showFingering:false};richChord(source.tracks[0].staves[0],manual);
  const result=preparePasteMusic(destination,command(bars(source))).score.tracks[0].staves[0],copied=result.getChord(result.bars[1].voices[0].beats[0].chordId!)!;expect(getHarmonyChord(result.getChord('rich')!)).toEqual(original);expect(getHarmonyChord(copied)).toEqual(manual);copied.barreFrets.push(9);expect(getHarmonyChord(source.tracks[0].staves[0].getChord('rich')!)).toEqual(manual);
});

it('inserts repeated bars globally with disjoint IDs and detached effects',()=>{
  const source=music();source.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].dynamics=3;
  const clip=bars(source),destination=music(),before=json(destination),edit=command(clip);edit.options.count=3;
  const result=preparePasteMusic(destination,edit);
  expect(result.barMap).toEqual({oldToNew:[0,7,8,9],inserted:[1,2,3,4,5,6]});expect(json(destination)).toBe(before);
  const voices=result.score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices),beats=voices.flatMap(voice=>voice.beats),notes=beats.flatMap(beat=>beat.notes);
  for(const objects of [voices,beats,notes])expect(new Set(objects.map(item=>item.id)).size).toBe(objects.length);
  expect(notes[4].dynamics).toBe(3);notes[4].fret=20;expect(notes[12].fret).toBe(3);expect(clip).toEqual(bars(source));
});

it('keeps destination single-track meter and rejects overflow atomically',()=>{
  const destination=music();destination.masterBars[0].timeSignatureNumerator=3;const before=json(destination),edit=command(bars());
  expect(()=>preparePasteMusic(destination,edit)).toThrow(/fit|overfill|meter/i);expect(json(destination)).toBe(before);
});

it('copies multitrack master structure and restores original suffix tempo',()=>{
  const source=music();source.masterBars[0].timeSignatureNumerator=3;source.tracks[0].staves[0].bars[0].voices[0].beats.pop();source.masterBars[0].tempoAutomations=[auto(model.AutomationType.Tempo,160)];source.masterBars[0].isRepeatStart=true;source.masterBars[1].repeatCount=2;
  const clip=bars(rebuild(source),'multiTrack'),edit=command(clip);edit.options.filters.masterAutomations=true;edit.options.filters.sections=true;
  const destination=music(),result=preparePasteMusic(destination,edit).score;
  expect(result.masterBars[1].timeSignatureNumerator).toBe(3);expect(result.masterBars[1].isRepeatStart).toBe(true);expect(result.masterBars[2].repeatCount).toBe(2);
  expect(result.masterBars[1].tempoAutomations[0].value).toBe(160);expect(result.masterBars[3].tempoAutomations.at(-1)?.value).toBe(destination.tempo);
});

it('fills a rest suffix, reuses a rest bar, and inserts once before untouched music',()=>{
  let destination=rests(music(),0,1);destination=rests(destination,1);const oldNotes=destination.tracks[0].staves[0].bars[2].voices[0].beats.map(beat=>beat.notes[0].id),edit=command(phrase(),0);edit.options.target.beat=1;edit.options.count=5;
  const result=preparePasteMusic(destination,edit);
  expect(result.barMap).toEqual({oldToNew:[0,1,3,4],inserted:[2]});expect(result.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].id).toBe(destination.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].id);
  expect(result.score.tracks[0].staves[0].bars[3].voices[0].beats.map(beat=>beat.notes[0].id)).toEqual(oldNotes);
  expect(result.score.tracks[0].staves[0].bars[2].voices[0].beats.at(-1)?.notes).toHaveLength(0);
});

it('rejects free time, too-long beat and absent mappings without mutation',()=>{
  for(const change of ['free','long','mapping'] as const){let destination=rests(music(),0);const edit=command(phrase(),0);if(change==='free')destination.masterBars[0].isFreeTime=true;if(change==='long'){const source=music(),voice=source.tracks[0].staves[0].bars[0].voices[0];source.masterBars[0].timeSignatureNumerator=8;voice.beats.splice(1);voice.beats[0].duration=-2;edit.clip=makeMusicClip(rebuild(source),{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:7680},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack');}if(change==='mapping')edit.options.destinations[0].staffMap=[9];const before=json(destination);expect(()=>preparePasteMusic(destination,edit)).toThrow();expect(json(destination)).toBe(before);}
});

it('overwrites sounding destination notes, preserves prefix and sounding suffix, and detaches severed links',()=>{
  const destination=music();
  const v0=destination.tracks[0].staves[0].bars[0].voices[0];
  const prefixNoteId=v0.beats[0].notes[0].id;
  const suffixNote2Id=v0.beats[2].notes[0].id;
  const suffixNote3Id=v0.beats[3].notes[0].id;
  v0.beats[0].notes[0].tieDestination=v0.beats[1].notes[0];
  v0.beats[1].notes[0].tieOrigin=v0.beats[0].notes[0];
  v0.beats[1].notes[0].isTieDestination=true;
  v0.beats[2].notes[0].tieDestination=v0.beats[3].notes[0];
  v0.beats[3].notes[0].tieOrigin=v0.beats[2].notes[0];
  v0.beats[3].notes[0].isTieDestination=true;

  const source=music();
  source.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=9;
  const edit=command(phrase(source,0),0);
  edit.options.target.beat=1;

  const result=preparePasteMusic(destination,edit).score;
  const pastedVoice=result.tracks[0].staves[0].bars[0].voices[0];
  expect(pastedVoice.beats).toHaveLength(4);
  expect(pastedVoice.beats[0].notes[0].id).toBe(prefixNoteId);
  expect(pastedVoice.beats[0].notes[0].tieDestination).toBeNull();
  expect(pastedVoice.beats[1].notes[0].fret).toBe(9);
  expect(pastedVoice.beats[2].notes[0].id).toBe(suffixNote2Id);
  expect(pastedVoice.beats[3].notes[0].id).toBe(suffixNote3Id);
  expect(pastedVoice.beats[2].notes[0].tieDestination).toBe(pastedVoice.beats[3].notes[0]);
});

it('preserves excluded destination annotations only at exact retained onsets',()=>{
  let destination=rests(music(),0);destination.tracks[0].staves[0].bars[0].voices[0].beats[1].text='keep';const source=music();source.tracks[0].staves[0].bars[0].voices[0].beats[0].text='source';const edit=command(phrase(source),0);edit.options.filters.texts=false;
  expect(preparePasteMusic(destination,edit).score.tracks[0].staves[0].bars[0].voices[0].beats[1].text).toBe('keep');
  source.tracks[0].staves[0].bars[0].voices[0].beats[0].duration=2;source.tracks[0].staves[0].bars[0].voices[0].beats.splice(1);edit.clip=phrase(rebuild(source));const before=json(destination);expect(()=>preparePasteMusic(destination,edit)).toThrow(/onset|annotation/i);expect(json(destination)).toBe(before);
});

it('remaps fractional DSP independently of its source beat carrier and restores suffix state',()=>{
  const source=music(),beat=source.tracks[0].staves[0].bars[0].voices[0].beats[3];beat.automations.push(Object.assign(auto(model.AutomationType.Volume,5,.25),{text:'quarter',isLinear:true,isVisible:false}));beat.automations.push(auto(model.AutomationType.Instrument,30));
  const edit=command(bars(source)),destination=music(),result=preparePasteMusic(destination,edit).score;
  const inserted=result.tracks[0].staves[0].bars[1],mix=inserted.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations)).find(value=>value.type===model.AutomationType.Volume)!;
  expect([mix.ratioPosition,mix.text,mix.isLinear,mix.isVisible]).toEqual([.25,'quarter',true,false]);
  const suffix=result.tracks[0].staves[0].bars[3].voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations));expect(suffix.find(value=>value.type===model.AutomationType.Instrument)?.value).toBe(25);expect(suffix.find(value=>value.type===model.AutomationType.Volume)?.value).toBe(destination.tracks[0].playbackInfo.volume);
});

it('keeps raw destination lyrics and backing bytes without aliases and maps starts once',()=>{
  const destination=music();setLyricsSource(destination.tracks[0],{visible:false,lines:[{startBar:1,text:'a\r\n[comment]  b'},{startBar:0,text:''}]},true);destination.backingTrack=new model.BackingTrack();destination.backingTrack.rawAudioFile=new Uint8Array([1,2,3]);
  const result=preparePasteMusic(destination,command(bars())).score;
  expect(getLyricsSource(result.tracks[0])).toEqual({value:{visible:false,lines:[{startBar:3,text:'a\r\n[comment]  b'},{startBar:0,text:''}]},managed:true});expect([...result.backingTrack!.rawAudioFile!]).toEqual([1,2,3]);result.backingTrack!.rawAudioFile![0]=9;expect(destination.backingTrack.rawAudioFile[0]).toBe(1);
});

it('keeps phrase fractional controllers and sustain at written positions across reflow',()=>{
  const source=music(),staff=source.tracks[0].staves[0],carrier=staff.bars[0].voices[0].beats[3];carrier.automations.push(auto(model.AutomationType.Volume,5,.25));staff.bars[0].sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{pedalType:model.SustainPedalMarkerType.Down,ratioPosition:.25}));
  const destination=rests(music(),0,1),edit=command(phrase(source),0);edit.options.target.beat=1;
  const result=preparePasteMusic(destination,edit).score,inserted=result.tracks[0].staves[0].bars[0],values=inserted.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations));
  expect(values.find(value=>value.type===model.AutomationType.Volume&&value.value===5)?.ratioPosition).toBe(.5);expect(inserted.sustainPedals.map(marker=>[marker.pedalType,marker.ratioPosition])).toEqual([[model.SustainPedalMarkerType.Down,.5],[model.SustainPedalMarkerType.Up,.75]]);
  expect(values.find(value=>value.type===model.AutomationType.Volume&&value.value===destination.tracks[0].playbackInfo.volume)?.ratioPosition).toBe(.75);
});

it('preserves phrase full-rest written duration under a different destination meter',()=>{
  const source=rests(music(),0);source.masterBars[0].timeSignatureNumerator=3;const voice=source.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(1);voice.beats[0].duration=1;
  const clip=makeMusicClip(rebuild(source),{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack');
  const destination=rests(music(),0),edit=command(clip,0),result=preparePasteMusic(destination,edit).score.tracks[0].staves[0].bars[0].voices[0];
  expect(result.beats.map(beat=>[beat.duration,beat.dots])).toEqual([[2,1],[4,0]]);
});

it('preserves later destination DSP on a replaced rest carrier and keeps link copies internal',()=>{
  const source=music(),from=source.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0],to=source.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0];from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;
  const destination=rests(music(),0);destination.tracks[0].staves[0].bars[0].voices[0].beats[3].automations.push(auto(model.AutomationType.Balance,12,.875));const edit=command(phrase(source),0);edit.options.count=2;
  const result=preparePasteMusic(destination,edit).score,voice=result.tracks[0].staves[0].bars[0].voices[0];expect(voice.beats[0].notes[0].tieDestination).toBe(voice.beats[1].notes[0]);expect(voice.beats[2].notes[0].tieDestination).toBe(voice.beats[3].notes[0]);expect(voice.beats[0].notes[0].tieDestination).not.toBe(voice.beats[3].notes[0]);
  expect(voice.beats.flatMap(beat=>beat.automations).find(value=>value.type===model.AutomationType.Balance)?.ratioPosition).toBe(.875);
});

it('applies every extra filter independently without deleting destination data',()=>{
  const source=music(),bar=source.tracks[0].staves[0].bars[0],beat=bar.voices[0].beats[0],chord=new model.Chord();chord.name='Selected';chord.strings=[0,1,2,3,4,5];source.tracks[0].staves[0].addChord('source',chord);beat.chordId='source';beat.text='copied text';beat.showTimer=true;beat.fade=model.FadeType.FadeIn;beat.automations.push(auto(model.AutomationType.Volume,4,.5));source.masterBars[0].tempoAutomations.push(auto(model.AutomationType.Tempo,170));source.masterBars[0].section=Object.assign(new model.Section(),{text:'Copied section',marker:'A'});
  const clip=bars(source,'multiTrack');for(const field of Object.keys(all) as (keyof PasteFilters)[]){const destination=music();destination.masterBars[1].section=Object.assign(new model.Section(),{text:'Keep suffix',marker:'B'});const edit=command(clip);edit.options.filters={...all,masterAutomations:true,sections:true,[field]:false};const result=preparePasteMusic(destination,edit).score,inserted=result.tracks[0].staves[0].bars[1].voices[0].beats[0];expect(inserted.fade).toBe(model.FadeType.FadeIn);expect(result.masterBars[3].section?.text).toBe('Keep suffix');if(field==='diagrams')expect(inserted.chordId).toBeNull();if(field==='texts')expect(inserted.text).toBeNull();if(field==='timers')expect(inserted.showTimer).toBe(false);if(field==='trackAutomations')expect(result.tracks[0].staves[0].bars[1].voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations))).toHaveLength(0);if(field==='masterAutomations')expect(result.masterBars[1].tempoAutomations).toHaveLength(0);if(field==='sections')expect(result.masterBars[1].section).toBeNull();}
});

it('over-budget expansion leaves input score and clip untouched',()=>{
  const source=music(),clip=bars(source),destination=music();destination.masterBars[0].timeSignatureNumerator=3;const edit=command(clip);edit.options.count=1000;const before=json(destination),snapshot=structuredClone(clip);expect(()=>preparePasteMusic(destination,edit)).toThrow();expect(json(destination)).toBe(before);expect(clip).toEqual(snapshot);
});

it('restores phrase program at its exact midbar end and honors an explicit boundary override',()=>{
  const source=music();source.tracks[0].staves[0].bars[0].voices[0].beats[0].automations=[auto(model.AutomationType.Instrument,30)];const clip=phrase(source);
  let destination=rests(music(),0),edit=command(clip,0),result=preparePasteMusic(destination,edit).score.tracks[0].staves[0].bars[0].voices[0];
  expect(result.beats[0].automations.filter(value=>value.type===model.AutomationType.Instrument).map(value=>value.value)).toEqual([25,30]);expect(result.beats[2].automations.find(value=>value.type===model.AutomationType.Instrument)?.value).toBe(25);
  destination.tracks[0].staves[0].bars[0].voices[0].beats[2].automations.push(auto(model.AutomationType.Instrument,40));result=preparePasteMusic(destination,edit).score.tracks[0].staves[0].bars[0].voices[0];expect(result.beats[2].automations.filter(value=>value.type===model.AutomationType.Instrument).map(value=>value.value)).toEqual([40]);
});

it('new blank and pasted IDs cannot collide with persisted IDs ahead of constructors',()=>{
  const destination=music(),beatBase=new model.Beat().id,voiceBase=new model.Voice().id,barBase=new model.Bar().id;
  destination.tracks[0].staves[0].bars.forEach((bar,index)=>{bar.id=barBase+1+index;bar.voices[0].id=voiceBase+1+index;bar.voices[0].beats.forEach((beat,beatIndex)=>beat.id=beatBase+index*4+beatIndex+1);});
  const result=preparePasteMusic(destination,command(bars())).score,measures=result.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars)),voices=measures.flatMap(bar=>bar.voices),all=voices.flatMap(voice=>voice.beats);for(const objects of [measures,voices,all])expect(new Set(objects.map(value=>value.id)).size).toBe(objects.length);
});

it('default filters retain destination annotations outside the copied span or reject lost onsets',()=>{
  const destination=rests(music(),0),voice=destination.tracks[0].staves[0].bars[0].voices[0];voice.beats[2].text='Unchanged outside';voice.beats[2].showTimer=true;voice.beats[2].lyrics=['raw outside'];const edit=command(phrase(),0);
  const result=preparePasteMusic(destination,edit).score.tracks[0].staves[0].bars[0].voices[0];expect(result.beats[2].text).toBe('Unchanged outside');expect(result.beats[2].showTimer).toBe(true);expect(result.beats[2].lyrics).toEqual(['raw outside']);
  voice.beats[3].text='No retained onset';const before=json(destination);expect(()=>preparePasteMusic(destination,edit)).toThrow(/onset|annotation/i);expect(json(destination)).toBe(before);
});

it('single-track bar sustain markers follow written time under inherited destination meter',()=>{
  const source=music();source.masterBars[0].timeSignatureNumerator=3;source.tracks[0].staves[0].bars[0].voices[0].beats.pop();source.tracks[0].staves[0].bars[0].sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{pedalType:model.SustainPedalMarkerType.Down,ratioPosition:1/3}));
  const result=preparePasteMusic(music(),command(bars(rebuild(source)))).score;expect(result.tracks[0].staves[0].bars[1].sustainPedals[0].ratioPosition).toBe(.25);
});

it('does not duplicate controllers whose untouched voice carrier survives phrase fill',()=>{
  const destination=music(),staff=destination.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice();bar.addVoice(voice);for(let index=0;index<4;index++)voice.addBeat(Object.assign(new model.Beat(),{duration:4,isEmpty:false}));}staff.bars[0].voices[0].beats[3].automations.push(auto(model.AutomationType.Volume,5,.75));
  const edit=command(phrase(),0);edit.options.target.voice=1;const result=preparePasteMusic(rebuild(destination),edit).score.tracks[0].staves[0].bars[0];expect(result.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations)).filter(value=>value.type===model.AutomationType.Volume&&value.value===5&&value.ratioPosition===.75)).toHaveLength(1);
});

it('finds an exact supported rest decomposition when greedy dotted rests leave a gap',()=>{
  const source=music(),voice=source.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(1);voice.beats[0].tupletNumerator=192;voice.beats[0].tupletDenominator=88;
  const clip=makeMusicClip(rebuild(source),{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:440},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack'),destination=rests(music(),0);destination.masterBars[0].timeSignatureNumerator=1;destination.masterBars[0].timeSignatureDenominator=8;
  const result=preparePasteMusic(destination,command(clip,0)).score.tracks[0].staves[0].bars[0].voices[0];expect(result.beats.slice(1).map(beat=>[beat.duration,beat.dots])).toEqual([[256,2],[256,0]]);
});

it('rejects contradictory copied and untouched-lane programs before public MIDI can suppress them',()=>{
  const source=music();source.tracks[0].staves[0].bars[0].voices[0].beats[0].automations=[auto(model.AutomationType.Instrument,30)];let destination=rests(music(),0);for(const bar of destination.tracks[0].staves[0].bars){const voice=new model.Voice();bar.addVoice(voice);voice.addBeat(Object.assign(new model.Beat(),{duration:4,isEmpty:false}));}destination.tracks[0].staves[0].bars[0].voices[1].beats[0].automations.push(auto(model.AutomationType.Instrument,40));destination=rebuild(destination);
  const before=json(destination);expect(()=>preparePasteMusic(destination,command(phrase(source,0),0))).toThrow(/program|bank|lane/i);expect(json(destination)).toBe(before);
});

it('a failure in the final repeated phrase leaves destination and embedded clip unchanged',()=>{
  const source=music(),voice=source.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(1);voice.beats[0].duration=1;const clip=makeMusicClip(rebuild(source),{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:3840},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack');let destination=rests(rests(music(),0),1);destination.masterBars[1].timeSignatureNumerator=3;
  const edit=command(clip,0);edit.options.count=2;const before=json(destination),snapshot=structuredClone(clip);expect(()=>preparePasteMusic(destination,edit)).toThrow(/longer|measure/i);expect(json(destination)).toBe(before);expect(edit.clip).toEqual(snapshot);
});

it('unmapped tracks inherit copied multitrack meter without overfilled blank bars',()=>{
  const source=music();source.masterBars[0].timeSignatureNumerator=3;source.tracks[0].staves[0].bars[0].voices[0].beats.pop();const destination=music(),extra=music().tracks[0];destination.addTrack(extra);
  const result=preparePasteMusic(rebuild(destination),command(bars(rebuild(source),'multiTrack'))).score,voice=result.tracks[1].staves[0].bars[1].voices[0];expect(voice.beats.every(beat=>beat.notes.length===0)).toBe(true);expect(voice.beats.reduce((sum,beat)=>sum+rhythmTicks(beat),0)).toBe(2880);expect(()=>rebuild(result)).not.toThrow();
});

it('keeps destination archive siblings through candidate GP output',()=>{
  const entries=unzipSync(exportGpInterchange(music(),new Settings())),path='Content/tabplayer-clipboard-sentinel.txt';entries[path]=strToU8('destination-only sibling');const destination=loadInterchangeScore(zipSync(entries),new Settings()),before=json(destination);
  const result=preparePasteMusic(destination,command(bars())).score;
  expect(unzipSync(exportGpInterchange(result,new Settings()))[path]).toEqual(entries[path]);expect(json(destination)).toBe(before);
});

it('later-bar source phrases do not acquire a synthetic source program on paste',()=>{
  const source=music(),clip=makeMusicClip(source,{kind:'range',range:{start:{bar:1,tick:0},end:{bar:1,tick:960},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack');let destination=rests(music(),1);const staff=destination.tracks[0].staves[0];staff.stringTuning.tunings=[];destination.tracks[0].playbackInfo.program=0;
  for(const bar of staff.bars)for(const beat of bar.voices[0].beats){beat.automations=[];for(const note of beat.notes){note.string=-1;note.fret=-1;note.octave=5;note.tone=0;}}destination=rebuild(destination);
  const result=preparePasteMusic(destination,command(clip)).score;expect(result.tracks[0].playbackInfo.program).toBe(0);expect(result.tracks[0].staves[0].bars[1].voices[0].beats.flatMap(beat=>beat.automations).filter(value=>value.type===model.AutomationType.Instrument)).toHaveLength(0);
});

it('retains legal bar-end sustain markers when mapped exactly to destination bar end',()=>{
  const source=music(),bar=source.tracks[0].staves[0].bars[0];bar.sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{pedalType:model.SustainPedalMarkerType.Down,ratioPosition:0}),Object.assign(new model.SustainPedalMarker(),{pedalType:model.SustainPedalMarkerType.Up,ratioPosition:1}));const result=preparePasteMusic(music(),command(bars(source))).score;
  expect(result.tracks[0].staves[0].bars[1].sustainPedals.map(marker=>[marker.pedalType,marker.ratioPosition])).toEqual([[model.SustainPedalMarkerType.Down,0],[model.SustainPedalMarkerType.Up,1]]);
});

it('pastes a multi-voice phrase overwriting multiple destination voices simultaneously',()=>{
  const source=music(),staff=source.tracks[0].staves[0];
  for(const bar of staff.bars){
    const voice1=new model.Voice();
    for(let i=0;i<4;i++){
      const beat=new model.Beat(),note=new model.Note();
      beat.duration=4;note.string=2;note.fret=10+i;beat.addNote(note);voice1.addBeat(beat);
    }
    bar.addVoice(voice1);
  }
  source.finish(new Settings());
  const clip=makeMusicClip(source,{
    kind:'range',
    range:{start:{bar:0,tick:0},end:{bar:0,tick:1920},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]},
  },'singleTrack');

  const destination=music(),destStaff=destination.tracks[0].staves[0];
  for(const bar of destStaff.bars){
    const voice1=new model.Voice();
    for(let i=0;i<4;i++){
      const beat=new model.Beat(),note=new model.Note();
      beat.duration=4;note.string=3;note.fret=1;beat.addNote(note);voice1.addBeat(beat);
    }
    bar.addVoice(voice1);
  }
  const rebuiltDest=rebuild(destination);
  const edit:ClipboardCommand={
    type:'pasteMusic',
    clip,
    options:{
      target:{track:0,staff:0,bar:1,voice:0,beat:0},
      destinations:[{sourceTrack:0,track:0,staffMap:[0]}],
      count:1,
      placement:'currentBar',
      filters:{...all},
    },
  };

  const result=preparePasteMusic(rebuiltDest,edit).score;
  const bar1=result.tracks[0].staves[0].bars[1];
  expect(bar1.voices).toHaveLength(2);
  expect(bar1.voices[0].beats[0].notes[0].fret).toBe(source.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret);
  expect(bar1.voices[0].beats[1].notes[0].fret).toBe(source.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].fret);
  expect(bar1.voices[1].beats[0].notes[0].fret).toBe(10);
  expect(bar1.voices[1].beats[1].notes[0].fret).toBe(11);
  expect(bar1.voices[1].beats[2].notes[0].fret).toBe(1);
  expect(bar1.voices[1].beats[3].notes[0].fret).toBe(1);
});

function twoVoices(fret:(beat:number)=>number,string=2){
  const score=music();
  for(const bar of score.tracks[0].staves[0].bars){
    const voice=new model.Voice();
    for(let i=0;i<4;i++){const beat=new model.Beat(),note=new model.Note();beat.duration=4;note.string=string;note.fret=fret(i);beat.addNote(note);voice.addBeat(beat);}
    bar.addVoice(voice);
  }
  score.finish(new Settings());return score;
}
const noteAt=(voice:number,beat:number)=>({target:{track:0,staff:0,bar:0,voice,beat},noteIndex:0});
const onsets=(voice:model.Voice)=>{let tick=0;return voice.beats.map(beat=>{const at=tick;tick+=rhythmTicks(beat);return {at,beat};});};
it('keeps the offset between copied voices that start on different beats',()=>{
  const clip=makeMusicClip(twoVoices(i=>10+i),{kind:'notes',notes:[noteAt(0,0),noteAt(0,1),noteAt(1,1)]},'singleTrack');
  const edit=command(clip);
  const bar=preparePasteMusic(rebuild(twoVoices(()=>1,3)),edit).score.tracks[0].staves[0].bars[1];
  const second=onsets(bar.voices[1]);
  // The second voice was copied from its second beat, so its note lands one beat after the paste start.
  expect(second.find(item=>item.at===960)!.beat.notes.map(note=>note.fret)).toEqual([11]);
  expect(second.find(item=>item.at===0)!.beat.notes).toHaveLength(0);
  expect(second.at(-1)!.at+rhythmTicks(second.at(-1)!.beat)).toBe(3840);
});
it('moves a multi-voice phrase to the next bar when a later voice is the longest',()=>{
  const clip=makeMusicClip(twoVoices(i=>10+i),{kind:'notes',notes:[noteAt(0,0),noteAt(1,0),noteAt(1,1)]},'singleTrack');
  const edit=command(clip);edit.options.target.beat=3;
  const staff=preparePasteMusic(rebuild(twoVoices(()=>1,3)),edit).score.tracks[0].staves[0];
  for(const bar of staff.bars)for(const voice of bar.voices)expect(voice.beats.reduce((sum,beat)=>sum+rhythmTicks(beat),0)).toBeLessThanOrEqual(3840);
  expect(onsets(staff.bars[2].voices[1]).filter(item=>item.beat.notes.some(note=>note.fret>=10)).map(item=>[item.at,item.beat.notes[0].fret])).toEqual([[0,10],[960,11]]);
});
it('keeps the text of a later-voice rest that the paste does not reach',()=>{
  const clip=makeMusicClip(twoVoices(i=>10+i),{kind:'notes',notes:[noteAt(0,0),noteAt(1,0)]},'singleTrack');
  const destination=twoVoices(()=>1,3),voices=destination.tracks[0].staves[0].bars[1].voices;
  // Eighth notes in the first voice put its fifth beat on the third quarter, so the second voice's last rest has a lower index than the paste target.
  voices[0].beats.splice(0);for(let i=0;i<8;i++){const beat=new model.Beat(),note=new model.Note();beat.duration=8;note.string=6;note.fret=3;beat.addNote(note);voices[0].addBeat(beat);}
  for(const beat of voices[1].beats.slice(2))beat.notes=[];voices[1].beats[3].text='Keep';
  const edit=command(clip);edit.options.target.beat=4;
  const bar=preparePasteMusic(rebuild(destination),edit).score.tracks[0].staves[0].bars[1],second=onsets(bar.voices[1]);
  expect(second.find(item=>item.at===1920)!.beat.notes.map(note=>note.fret)).toEqual([10]);
  expect(second.find(item=>item.at===2880)!.beat.text).toBe('Keep');
});
it('still pastes a phrase recorded at the position just past the last beat',()=>{
  const destination=rests(music(),2),edit=command(phrase());edit.options.target.beat=4;
  const staff=preparePasteMusic(destination,edit).score.tracks[0].staves[0];
  expect(staff.bars[1].voices[0].beats.map(beat=>beat.notes.length)).toEqual([1,1,1,1]);
  expect(staff.bars[2].voices[0].beats.slice(0,2).map(beat=>beat.notes.length)).toEqual([1,1]);
});
it('appends a track when every free MIDI channel is taken',()=>{
  const source=music(),extra=music().tracks[0];extra.name='Second';source.addTrack(extra);source.finish(new Settings());
  const clip=makeMusicClip(source,{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0},'multiTrack');
  const destination=music(),channels=[0,1,2,3,4,5,6,7,8,10,11,12,13,14,15];
  for(let index=1;index<8;index++)destination.addTrack(music().tracks[0]);
  destination.tracks.forEach((track,index)=>{track.playbackInfo.primaryChannel=channels[index*2];track.playbackInfo.secondaryChannel=channels[index*2+1]??channels[14];});
  const used=new Set(destination.tracks.flatMap(track=>[track.playbackInfo.primaryChannel,track.playbackInfo.secondaryChannel]));
  expect([...Array(16).keys()].filter(channel=>channel!==9&&!used.has(channel))).toEqual([]);
  const edit:ClipboardCommand={type:'pasteMusic',clip,options:{target:{track:7,staff:0,bar:0,voice:0,beat:0},destinations:[{sourceTrack:0,track:7,staffMap:[0]},{sourceTrack:1,track:8,staffMap:[0]}],count:1,placement:'beforeBar',filters:{...all,masterAutomations:true,sections:true}}};
  const result=preparePasteMusic(rebuild(destination),edit);
  expect(result.addedTracks).toBe(1);
  const added=result.score.tracks[8].playbackInfo;
  expect(added.primaryChannel).toBeGreaterThanOrEqual(0);expect(added.primaryChannel).toBeLessThanOrEqual(15);expect(added.primaryChannel).not.toBe(9);
  expect(added.secondaryChannel).toBeLessThanOrEqual(15);expect(added.secondaryChannel).not.toBe(9);
});
it('rejects pasting a multi-voice phrase when destination lacks the required voices',()=>{
  const source=music(),staff=source.tracks[0].staves[0];
  for(const bar of staff.bars){
    const voice1=new model.Voice();
    for(let i=0;i<4;i++){
      const beat=new model.Beat(),note=new model.Note();
      beat.duration=4;note.string=2;note.fret=10+i;beat.addNote(note);voice1.addBeat(beat);
    }
    bar.addVoice(voice1);
  }
  source.finish(new Settings());
  const clip=makeMusicClip(source,{
    kind:'range',
    range:{start:{bar:0,tick:0},end:{bar:0,tick:1920},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]},
  },'singleTrack');

  const destination=music();
  const edit:ClipboardCommand={
    type:'pasteMusic',
    clip,
    options:{
      target:{track:0,staff:0,bar:1,voice:0,beat:0},
      destinations:[{sourceTrack:0,track:0,staffMap:[0]}],
      count:1,
      placement:'currentBar',
      filters:{...all},
    },
  };

  expect(()=>preparePasteMusic(destination,edit)).toThrow('The destination must already contain every copied voice.');
});
