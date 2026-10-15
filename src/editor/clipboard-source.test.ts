import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { music,target,noteAt } from './fixtures';
import { makeMusicClip,musicClipSelection,readMusicClip,scoreFromMusicClip } from './clipboard-source';
import { captureNoteLinks } from './links';
import { scoreFromJson } from '../model-clone';
import { getLyricsSource,setLyricsSource } from './lyrics-source';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import type { MusicSelection } from './range-types';
import { getHarmonyChord,setHarmonyChordSource } from '../harmony/chord-source';
import type { HarmonyChord } from './harmony-types';
import type { MusicClip } from './clipboard-types';

const notes=(...beats:number[]):MusicSelection=>({kind:'notes',notes:beats.map(beat=>({target:{...target,beat},noteIndex:0}))});
const bars=(firstBar=0,lastBar=firstBar):MusicSelection=>({kind:'bars',tracks:[0],firstBar,lastBar});
const decode=(clip:ReturnType<typeof makeMusicClip>)=>scoreFromJson(clip.scoreJson,new Settings());
function richDefinition():HarmonyChord {return {name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true};}
function attachRich(staff:model.Staff,value=richDefinition(),id='rich') {const chord=Object.assign(new model.Chord(),{name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});staff.addChord(id,chord);staff.bars[0].voices[0].beats[0].chordId=id;setHarmonyChordSource(chord,value);return chord;}
it('clipboard v2 keeps only referenced effective theory and finger metadata',()=>{
  const score=music(),staff=score.tracks[0].staves[0],value=richDefinition(),chord=attachRich(staff,value);const unused=attachRich(staff,{...value,name:'Private manual',nameMode:'manual',recipe:null},'unused');staff.bars[0].voices[0].beats[0].chordId='rich';
  const before=model.JsonConverter.scoreToJson(score),original=getHarmonyChord(chord),clip=makeMusicClip(score,notes(0),'singleTrack');expect(clip.version).toBe(2);if(clip.version!==2)throw new Error('Expected rich snapshot');
  expect(clip.harmony).toEqual([{track:0,staff:0,chordId:'rich',chord:value}]);expect(JSON.stringify(clip)).not.toContain(unused.name);expect(getHarmonyChord(scoreFromMusicClip(clip).tracks[0].staves[0].getChord('rich')!)).toEqual(value);
  clip.harmony[0].chord.fingers[1]=4;expect(getHarmonyChord(chord)).toEqual(original);expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('public-only legacy and owned unknown manual chords preserve the v1 snapshot envelope',()=>{
  const score=music(),value:HarmonyChord={...richDefinition(),name:' untouched ',nameMode:'manual',recipe:null,firstFret:0,frets:[0,23,-1,2,15,0],fingers:Array(6).fill(-2),barreFrets:[0,2,2,23],showName:false,showDiagram:false,showFingering:false},chord=attachRich(score.tracks[0].staves[0],value);
  const clip=makeMusicClip(score,notes(0),'singleTrack');expect(clip.version).toBe(1);expect(Object.hasOwn(clip,'harmony')).toBe(false);expect(getHarmonyChord(scoreFromMusicClip(clip).tracks[0].staves[0].getChord('rich')!)).toEqual(value);
  setHarmonyChordSource(chord,{...value,fingers:[-2,4,-1,1,3,0]});const rich=makeMusicClip(score,notes(0),'singleTrack');expect(rich.version).toBe(2);if(rich.version===2)expect(rich.harmony[0].chord).toEqual({...value,fingers:[-2,4,-1,1,3,0]});
});
it('v2 snapshots rebase selected track and staff indices without unrelated chord data',()=>{
  const score=music(),track=music().tracks[0];score.addTrack(track);track.addStaff(music().tracks[0].staves[0]);attachRich(track.staves[1]);
  const clip=makeMusicClip(score,{kind:'notes',notes:[{target:{...target,track:1,staff:1},noteIndex:0}]},'singleTrack');expect(clip.version).toBe(2);if(clip.version===2)expect(clip.harmony.map(record=>[record.track,record.staff,record.chordId])).toEqual([[0,0,'rich']]);
});
it('stale theory is copied as its effective manual snapshot without changing authored provenance',()=>{
  const score=music(),staff=score.tracks[0].staves[0],chord=attachRich(staff);staff.capo=1;const clip=makeMusicClip(score,notes(0),'singleTrack');expect(clip.version).toBe(2);if(clip.version===2){expect(clip.harmony[0].chord.nameMode).toBe('manual');expect(clip.harmony[0].chord.recipe).toBeNull();expect(clip.harmony[0].chord.name).toBe('C');}
  staff.capo=0;expect(getHarmonyChord(chord).nameMode).toBe('theory');
});
it('v2 read validates record identity, public data, dense arrays and effective source context',()=>{
  const score=music();attachRich(score.tracks[0].staves[0]);const clip=makeMusicClip(score,notes(0),'singleTrack');expect(clip.version).toBe(2);if(clip.version!==2)throw new Error('Expected rich snapshot');
  const accepted=readMusicClip(clip);if(accepted.version!==2)throw new Error('Expected rich snapshot');accepted.harmony[0].chord.recipe!.root.step=1;expect(clip.harmony[0].chord.recipe!.root.step).toBe(0);
  for(const change of ['duplicate','track','staff','id','name','frets','flags','barres','sparse','theory','context'] as const){const invalid=structuredClone(clip);if(change==='duplicate')invalid.harmony.push(structuredClone(invalid.harmony[0]));if(change==='track')invalid.harmony[0].track=9;if(change==='staff')invalid.harmony[0].staff=9;if(change==='id')invalid.harmony[0].chordId='missing';if(change==='name')invalid.harmony[0].chord.name='Different';if(change==='frets')invalid.harmony[0].chord.frets[0]=3;if(change==='flags')invalid.harmony[0].chord.showDiagram=false;if(change==='barres')invalid.harmony[0].chord.barreFrets=[1];if(change==='sparse')delete invalid.harmony[0].chord.fingers[0];if(change==='theory'){const raw=JSON.parse(invalid.scoreJson);raw.tracks[0].staves[0].capo=1;invalid.scoreJson=JSON.stringify(raw);}if(change==='context'){const raw=JSON.parse(invalid.scoreJson);raw.tracks[0].staves[0].stringtuning.tunings.pop();invalid.scoreJson=JSON.stringify(raw);}expect(()=>readMusicClip(invalid)).toThrow();}
});
it('v2 accepts passive empty records and manual unknown metadata but rejects unreferenced definitions',()=>{
  const score=music(),value={...richDefinition(),nameMode:'manual' as const,recipe:null,fingers:Array(6).fill(-2)};attachRich(score.tracks[0].staves[0],value);const legacy=makeMusicClip(score,notes(0),'singleTrack'),empty:MusicClip={...legacy,version:2,harmony:[]};expect(readMusicClip(empty)).toEqual(empty);
  const passive:MusicClip={...empty,harmony:[{track:0,staff:0,chordId:'rich',chord:value}]};expect(readMusicClip(passive)).toEqual(passive);
  const decoded=scoreFromMusicClip(legacy),unused=Object.assign(new model.Chord(),{name:value.name,strings:[...value.frets]});decoded.tracks[0].staves[0].addChord('unreferenced',unused);const invalid:MusicClip={...passive,scoreJson:model.JsonConverter.scoreToJson(decoded),harmony:[{...passive.harmony[0],chordId:'unreferenced'}]};expect(()=>readMusicClip(invalid)).toThrow(/reference/i);
});
it('snapshot_contains_only_selected_music',()=>{
  const source=music(),staff=source.tracks[0].staves[0];source.title='ROOT_SENTINEL';source.artist='PATH_SENTINEL';
  source.tracks[0].name='Selected guitar';staff.bars[1].voices[0].beats[0].text='UNSELECTED_BAR';
  staff.bars[0].voices[0].beats[1].text='UNSELECTED_GAP';staff.bars[0].voices[0].beats[0].text='selected text';
  const sibling=music().tracks[0];sibling.name='UNSELECTED_TRACK';source.addTrack(sibling);
  setLyricsSource(source.tracks[0],{visible:false,lines:[{text:'RAW_LYRIC_SENTINEL',startBar:0}]},true);
  const first=staff.bars[0].voices[0].beats[0];first.lyrics=['DISTRIBUTED_LYRIC'];first.notes[0].dynamics=3;
  const extra=new model.Note();extra.string=5;extra.fret=12;first.addNote(extra);
  const chord=new model.Chord();chord.name='Selected chord';staff.addChord('selected',chord);first.chordId='selected';
  const unused=new model.Chord();unused.name='UNUSED_CHORD';staff.addChord('unused',unused);
  const before=model.JsonConverter.scoreToJson(source),links=captureNoteLinks(source),raw=getLyricsSource(source.tracks[0]);
  const clip=makeMusicClip(source,notes(0,2),'singleTrack'),copy=decode(clip),beats=copy.tracks[0].staves[0].bars[0].voices[0].beats;
  expect(clip.kind).toBe('phrase');expect(copy.tracks).toHaveLength(1);expect(copy.masterBars).toHaveLength(1);
  expect(beats.map(beat=>beat.notes.length)).toEqual([1,0,1]);expect(beats[1].text).toBeNull();expect(beats[0].text).toBe('selected text');
  expect(beats[0].notes[0].dynamics).toBe(3);expect(copy.tracks[0].staves[0].chords?.size).toBe(1);
  for(const sentinel of ['ROOT_SENTINEL','PATH_SENTINEL','UNSELECTED_BAR','UNSELECTED_GAP','UNSELECTED_TRACK','RAW_LYRIC_SENTINEL','DISTRIBUTED_LYRIC','UNUSED_CHORD'])expect(clip.scoreJson).not.toContain(sentinel);
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);expect(captureNoteLinks(source)).toEqual(links);expect(getLyricsSource(source.tracks[0])).toEqual(raw);
});
it('backing bytes and sync payloads never enter selected music or mutate the source',()=>{
  const score=music(),bytes=new TextEncoder().encode('BACKING_SENTINEL');score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=bytes;
  const sync=new model.Automation();sync.type=model.AutomationType.Bank;sync.syncPointValue=new model.SyncPointData();sync.syncPointValue.millisecondOffset=54321;score.masterBars[0].syncPoints=[sync];
  score.tracks[0].staves[0].bars[0].voices[0].beats[1].automations.push(sync);
  const before=model.JsonConverter.scoreToJson(score),clip=makeMusicClip(score,bars(),'singleTrack');
  expect(clip.scoreJson).not.toContain('syncpoint');expect(clip.scoreJson).not.toContain('backingtrack');expect(clip.scoreJson).not.toContain('54321');
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(score.backingTrack.rawAudioFile).toBe(bytes);expect(new TextDecoder().decode(bytes)).toBe('BACKING_SENTINEL');
});
it('archive sibling provenance stays with the original score and never the clipboard',()=>{
  const settings=new Settings(),entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings)),sentinel=strToU8('ARCHIVE_SENTINEL');entries['Content/Assets/private-source-path.bin']=sentinel;
  const bytes=zipSync(entries),before=bytes.slice(),source=loadInterchangeScore(bytes,settings),clip=makeMusicClip(source,notes(0),'singleTrack');
  expect(clip.scoreJson).not.toContain('ARCHIVE_SENTINEL');expect(clip.scoreJson).not.toContain('private-source-path');
  expect(unzipSync(exportGpInterchange(source,settings))['Content/Assets/private-source-path.bin']).toEqual(sentinel);
  expect(unzipSync(exportGpInterchange(scoreFromMusicClip(clip),settings))['Content/Assets/private-source-path.bin']).toBeUndefined();expect(bytes).toEqual(before);
});
it('bar_scope_and_expansion_are_exact',()=>{
  const score=music(),staff=score.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice(),rest=new model.Beat();rest.duration=1;rest.isEmpty=false;voice.addBeat(rest);bar.addVoice(voice);}
  score.masterBars[0].isRepeatStart=true;score.masterBars[2].repeatCount=2;score.masterBars[0].section=new model.Section();score.masterBars[0].section.text='SECTION';
  const single=decode(makeMusicClip(score,bars(),'singleTrack'));expect(single.tracks[0].staves[0].bars[0].voices).toHaveLength(2);expect(single.masterBars[0].isRepeatStart).toBe(false);expect(single.masterBars[0].section).toBeNull();
  score.masterBars[0].isRepeatStart=false;score.masterBars[2].repeatCount=0;
  const expanded=decode(makeMusicClip(score,notes(1),'multiTrack'));expect(expanded.tracks[0].staves[0].bars[0].voices).toHaveLength(2);
  const partial:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:960},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]}};
  expect(()=>makeMusicClip(score,partial,'singleTrack')).toThrow(/lane|voice|scope/i);
  staff.bars[1].voices[0].beats.splice(1);const underfull=decode(makeMusicClip(score,{kind:'notes',notes:[{target:{...target,bar:1},noteIndex:0}]},'singleTrack'));
  expect(underfull.tracks[0].staves[0].bars[0].voices[0].beats.reduce((sum,beat)=>sum+beat.playbackDuration,0)).toBe(960);
  for(const beat of staff.bars[3].voices[0].beats){beat.notes=[];beat.isEmpty=true;}expect(makeMusicClip(score,bars(3),'singleTrack').kind).toBe('bars');
});
it('links_are_internal_and_outward_tie_destinations_sound_independently',()=>{
  const score=music(),a=noteAt(score),b=noteAt(score,0,1);a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
  const both=makeMusicClip(score,notes(0,1),'singleTrack');expect(both.links).toEqual([{from:a.id,to:b.id,kind:'tie',slideOutType:null}]);
  const outward=makeMusicClip(score,notes(1),'singleTrack');expect(outward.links).toEqual([]);expect(decode(outward).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isTieDestination).toBe(false);
  b.isContinuedBend=true;b.bendOrigin=a;expect(()=>makeMusicClip(score,notes(1),'singleTrack')).toThrow(/continued bend|origin/i);
});
it('keeps all four internal links, removes outward links, and keeps solo slide exits',()=>{
  const score=music(),a=noteAt(score),b=noteAt(score,0,1);a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;a.slurDestination=b;b.slurOrigin=a;b.isSlurDestination=true;
  a.slideTarget=b;a.slideOutType=model.SlideOutType.Legato;b.slideOrigin=a;a.hammerPullDestination=b;a.isHammerPullOrigin=true;b.hammerPullOrigin=a;
  const clip=makeMusicClip(score,notes(0,1),'singleTrack');expect(clip.links.map(link=>link.kind)).toEqual(['tie','slur','slide','hammerPull']);expect(captureNoteLinks(scoreFromMusicClip(clip))).toEqual(captureNoteLinks(score));
  const outward=scoreFromMusicClip(makeMusicClip(score,notes(0),'singleTrack')),note=outward.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(captureNoteLinks(outward)).toEqual([]);expect(note.isHammerPullOrigin).toBe(false);expect(note.slideOutType).toBe(model.SlideOutType.None);
  a.slideOutType=model.SlideOutType.OutUp;a.slideTarget=null;b.slideOrigin=null;expect(scoreFromMusicClip(makeMusicClip(score,notes(0),'singleTrack')).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].slideOutType).toBe(model.SlideOutType.OutUp);
});
it('continued bends remain internal and sound from their retained origin',()=>{
  const score=music(),a=noteAt(score),b=noteAt(score,0,1);a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
  a.bendType=model.BendType.Bend;a.addBendPoint(new model.BendPoint(0,0));a.addBendPoint(new model.BendPoint(60,2));
  b.bendType=model.BendType.Hold;b.addBendPoint(new model.BendPoint(0,2));b.addBendPoint(new model.BendPoint(60,2));b.isContinuedBend=true;b.bendOrigin=a;
  const copy=scoreFromMusicClip(makeMusicClip(score,notes(0,1),'singleTrack')),copied=copy.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0]);
  expect(copied[1].isContinuedBend).toBe(true);expect(copied[1].tieOrigin).toBe(copied[0]);
});
it('contextual_similes_and_partial_multitrack_repeats_reject',()=>{
  const score=music();score.tracks[0].staves[0].bars[1].simileMark=model.SimileMark.Simple;
  expect(()=>makeMusicClip(score,bars(1),'singleTrack')).toThrow(/simile/i);
  score.tracks[0].staves[0].bars[1].simileMark=model.SimileMark.None;score.masterBars[0].isRepeatStart=true;score.masterBars[2].repeatCount=2;
  expect(()=>makeMusicClip(score,bars(1),'multiTrack')).toThrow(/repeat/i);
  expect(makeMusicClip(score,bars(0,2),'multiTrack').kind).toBe('bars');expect(()=>makeMusicClip(score,bars(0,2),'singleTrack')).not.toThrow();
  score.masterBars[0].directions=new Set([model.Direction.TargetSegno]);expect(()=>makeMusicClip(score,bars(0,2),'multiTrack')).toThrow(/direction/i);
});
it('reader_validates_ids_links_rhythm_pitch_privacy_and_preserves_note_dynamics',()=>{
  const valid=makeMusicClip(music(),notes(0,1),'singleTrack'),json=JSON.parse(valid.scoreJson),beat=json.tracks[0].staves[0].bars[0].voices[0].beats[0];
  beat.notes[0].id=beat.id;beat.notes[0].dynamics=3;expect(decode(readMusicClip({...valid,scoreJson:JSON.stringify(json)})).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].dynamics).toBe(3);
  const bad=(mutate:(value:typeof json)=>void)=>{const value=JSON.parse(valid.scoreJson);mutate(value);expect(()=>readMusicClip({...valid,scoreJson:JSON.stringify(value)})).toThrow();};
  const beats=(value:typeof json)=>value.tracks[0].staves[0].bars[0].voices[0].beats;
  bad(value=>beats(value)[1].id=beats(value)[0].id);bad(value=>beats(value)[1].notes[0].id=beats(value)[0].notes[0].id);
  bad(value=>beats(value)[0].duration=3);bad(value=>beats(value)[0].notes[0].fret=128);bad(value=>beats(value)[0].notes[0].string=99);
  bad(value=>value.backingtrack={rawAudioFile:[1,2]});bad(value=>value.masterbars[0].syncpoints=[]);bad(value=>beats(value)[0].lyrics=['secret']);
  bad(value=>value.tracks[0].staves[0].bars=[]);bad(value=>beats(value)[0].notes[0].percussionarticulation=999);
  expect(()=>readMusicClip({...valid,links:[{from:1,to:999999,kind:'tie',slideOutType:null}]})).toThrow(/link|note/i);
  expect(()=>readMusicClip({...valid,scoreJson:valid.scoreJson.replace('"duration":4','"duration":1e999')})).toThrow(/finite|number/i);
});
it('DSP ratios follow copied written time rather than carrier beat',()=>{
  const score=music(),staff=score.tracks[0].staves[0],automation=new model.Automation();automation.type=model.AutomationType.Volume;automation.value=7;automation.ratioPosition=.375;
  staff.bars[0].voices[0].beats[3].automations.push(automation);
  const clip=makeMusicClip(score,{kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}},'singleTrack');
  const copied=decode(clip).tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat=>beat.automations).filter(a=>a.type===model.AutomationType.Volume);
  expect(copied).toHaveLength(1);expect(copied[0].ratioPosition).toBe(.125);expect(copied[0].value).toBe(7);
});
it('normalizes full-bar multitrack scope without including an end-at-zero measure',()=>{
  const score=music(),selection:MusicSelection={kind:'range',range:{start:{bar:0,tick:3840},end:{bar:2,tick:0},lanes:[{track:0,staff:0,voice:0}]}};
  expect(musicClipSelection(score,selection,'multiTrack')).toEqual({kind:'bars',tracks:[0],firstBar:1,lastBar:1});
  const exact=notes(1,3),same=musicClipSelection(score,exact,'singleTrack');expect(same).toEqual(exact);expect(same).not.toBe(exact);
  expect(makeMusicClip(score,selection,'multiTrack').scoreJson).toContain('"masterbars"');
});
it('declared empty partial lanes cannot be silently omitted',()=>{
  const score=music(),staff=score.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  const selection:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:960},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]}};
  expect(()=>makeMusicClip(score,selection,'singleTrack')).toThrow(/lane|voice/i);
});
it('accepts complete truly empty bars and registered custom percussion context',()=>{
  const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats=[];expect(makeMusicClip(score,bars(),'singleTrack').kind).toBe('bars');
  const track=score.tracks[0],staff=track.staves[0];staff.isPercussion=true;staff.stringTuning.tunings=[];
  track.percussionArticulations=[new model.InstrumentArticulation('Custom shaker',-3,82,model.MusicFontSymbol.NoteheadXBlack,model.MusicFontSymbol.NoteheadHalf,model.MusicFontSymbol.NoteheadWhole)];
  for(const bar of staff.bars)for(const beat of bar.voices[0].beats)for(const note of beat.notes){note.string=-1;note.fret=-1;note.percussionArticulation=0;}
  const clip=makeMusicClip(score,bars(1),'singleTrack'),copy=decode(clip);expect(copy.tracks[0].percussionArticulations[0]).toMatchObject({elementType:'Custom shaker',outputMidiNumber:82,staffLine:-3});
});
it('rejects non-boolean flags, invalid effects, malformed tuplets, and unpinned inner fields',()=>{
  const clip=makeMusicClip(music(),notes(0),'singleTrack');
  for(const mutate of [
    (beat:Record<string,unknown>)=>beat.pop='false',
    (beat:Record<string,unknown>)=>beat.fade=100,
    (beat:Record<string,unknown>)=>beat.tupletnumerator=0,
    (beat:Record<string,unknown>)=>beat.secretDocument='unrelated',
    (beat:Record<string,unknown>)=>(beat.notes as Record<string,unknown>[])[0].harmonicvalue=-2,
    (beat:Record<string,unknown>)=>(beat.notes as Record<string,unknown>[])[0].bendpoints=[{offset:60,value:0},{offset:0,value:2}],
    (beat:Record<string,unknown>)=>(beat.notes as Record<string,unknown>[])[0].bendtype=999,
  ]){const raw=JSON.parse(clip.scoreJson);mutate(raw.tracks[0].staves[0].bars[0].voices[0].beats[0]);expect(()=>readMusicClip({...clip,scoreJson:JSON.stringify(raw)})).toThrow();}
});
it('does not invent a source program when copying later music but keeps selected program events',()=>{
  const source=music(),selection:MusicSelection={kind:'notes',notes:[{target:{...target,bar:2},noteIndex:0}]};
  const original=source.tracks[0].staves[0].bars[2].voices[0].beats[0];expect(original.automations).toEqual([]);
  const clip=makeMusicClip(source,selection,'singleTrack');const read=(clip:ReturnType<typeof makeMusicClip>)=>JSON.parse(clip.scoreJson).tracks[0].staves[0].bars[0].voices[0].beats[0].automations;
  expect(read(clip)).toEqual([]);
  original.automations.push(model.Automation.buildInstrumentAutomation(false,0,30));expect(read(makeMusicClip(source,selection,'singleTrack'))).toMatchObject([{type:model.AutomationType.Instrument,value:30}]);
});
it('partial phrases exclude global and pedal annotations outside selected attacks or in plain gaps',()=>{
  const source=music(),master=source.masterBars[0],bar=source.tracks[0].staves[0].bars[0];
  for(let index=0;index<4;index++){master.addFermata(index*960,Object.assign(new model.Fermata(),{type:model.FermataType.Short,length:index+1}));bar.sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{ratioPosition:index/4,pedalType:model.SustainPedalMarkerType.Down}));}
  const copy=scoreFromMusicClip(makeMusicClip(source,notes(1,3),'singleTrack'));
  expect([...copy.masterBars[0].fermata!.entries()].map(([offset,value])=>[offset,value.length])).toEqual([[0,2],[1920,4]]);
  expect(copy.tracks[0].staves[0].bars[0].sustainPedals.map(marker=>marker.ratioPosition)).toEqual([0,.5]);
});
it('sparse note gaps retain the exact supported rhythm override',()=>{
  const source=music(),voice=source.tracks[0].staves[0].bars[0].voices[0];voice.beats[1].overrideDisplayDuration=480;source.finish(new Settings());
  const before=model.JsonConverter.scoreToJson(source),copy=scoreFromMusicClip(makeMusicClip(source,notes(0,2),'singleTrack')),beats=copy.tracks[0].staves[0].bars[0].voices[0].beats;
  expect(beats.map(beat=>[beat.displayStart,beat.displayDuration])).toEqual([[0,960],[960,480],[1440,960]]);expect(beats[1].overrideDisplayDuration).toBe(480);expect(beats[1].notes).toEqual([]);
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);
});
it.each([
  ['simile',(raw:Record<string,any>)=>raw.tracks[0].staves[0].bars[0].similemark=999],
  ['fermata type',(raw:Record<string,any>)=>raw.masterbars[0].fermata={'0':{type:999,length:1}}],
  ['fermata length',(raw:Record<string,any>)=>raw.masterbars[0].fermata={'0':{type:model.FermataType.Short,length:-1}}],
  ['note duration',(raw:Record<string,any>)=>raw.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].durationpercent=-1],
  ['rhythm override',(raw:Record<string,any>)=>raw.tracks[0].staves[0].bars[0].voices[0].beats[0].overridedisplayduration=0],
  ['orphan tie',(raw:Record<string,any>)=>raw.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].istiedestination=true],
  ['instrument program',(raw:Record<string,any>)=>raw.tracks[0].staves[0].bars[0].voices[0].beats[0].automations[0].value=1000],
  ['beat tempo',(raw:Record<string,any>)=>raw.tracks[0].staves[0].bars[0].voices[0].beats[0].automations[0].type=model.AutomationType.Tempo],
])('rejects invalid pinned %s before normalizing the model',(_name,mutate)=>{
  const clip=makeMusicClip(music(),bars(),'singleTrack'),raw=JSON.parse(clip.scoreJson);mutate(raw);expect(()=>readMusicClip({...clip,scoreJson:JSON.stringify(raw)})).toThrow();
});
it('retains track-wide DSP on an existing voice when the first voice has no beats',()=>{
  const source=music(),staff=source.tracks[0].staves[0];staff.bars[0].voices[0].beats=[];
  for(const bar of staff.bars){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=bar.index!==0;beat.duration=1;voice.addBeat(beat);bar.addVoice(voice);}
  staff.bars[0].voices[1].beats[0].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:4,ratioPosition:.25}));source.finish(new Settings());
  const before=model.JsonConverter.scoreToJson(source),copy=scoreFromMusicClip(makeMusicClip(source,bars(),'singleTrack')),bar=copy.tracks[0].staves[0].bars[0];
  expect(bar.voices[0].beats).toEqual([]);expect(bar.voices[1].beats).toHaveLength(1);expect(bar.voices[1].beats[0].automations.filter(value=>value.type===model.AutomationType.Volume)).toMatchObject([{value:4,ratioPosition:.25}]);
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);
});
it('complete free-time bars retain fermatas beyond the nominal meter capacity',()=>{
  const source=music(),master=source.masterBars[0],voice=source.tracks[0].staves[0].bars[0].voices[0];master.isFreeTime=true;
  for(let index=0;index<2;index++){const beat=new model.Beat(),note=new model.Note();beat.duration=4;beat.isEmpty=false;note.string=6;note.fret=3;beat.addNote(note);voice.addBeat(beat);}
  master.addFermata(4800,Object.assign(new model.Fermata(),{type:model.FermataType.Short,length:1}));source.finish(new Settings());
  const copy=scoreFromMusicClip(makeMusicClip(source,bars(),'multiTrack'));expect(copy.masterBars[0].isFreeTime).toBe(true);expect(copy.masterBars[0].fermata?.get(4800)?.length).toBe(1);
});
