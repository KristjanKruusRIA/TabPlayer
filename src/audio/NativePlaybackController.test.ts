import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDocument, exportGp, previewEdit, replayDocumentSettings,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge, NativeAudioStatus } from './bridge';
import { buildPlaybackPlan } from './plan';
import type { PlanNote } from './types';
import { DEFAULT_PRACTICE,type PracticeSettings,type PracticeStatus } from './practice-types';
import {defaultEngraving,projectEngraving} from '../engraving/projection';
import {makeMusicClip} from '../editor/clipboard-source';
import {defaultEffects} from '../document-settings';
import type { MusicSelection } from '../editor/range-types';

const defaults=():PracticeSettings=>structuredClone(DEFAULT_PRACTICE);
function practiceStatus(settings=defaults(),change:Partial<PracticeStatus>={}):PracticeStatus{return {settings,phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:settings.tempo.kind==='relative'?settings.tempo.ratio:settings.tempo.kind==='progressive'?settings.tempo.start:1,currentBpm:120,pulse:null,...change};}

function fixture(preparePlan?:ConstructorParameters<typeof NativePlaybackController>[0]['preparePlan']) {
  let receive: (status:NativeAudioStatus)=>void=()=>{};
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const onEdit=vi.fn();const player=new NativePlaybackController({bridge,onEdit,preparePlan});
  const emit=(change:Partial<NativeAudioStatus>={})=>{const settings=defaults();settings.tempo={kind:'relative',ratio:change.speed??1};settings.metronome.enabled=change.metronome??false;receive({generation:player.generation,ready:true,playing:false,tick:0,seconds:0,durationSeconds:8,speed:1,metronome:false,error:null,deviceId:null,range:null,loop:null,practice:practiceStatus(settings,{phase:change.playing?'playing':'paused'}),...change});};
  return {bridge,onEdit,player,emit};
}
async function soundingFixture() {
  const target={track:0,staff:0,bar:0,voice:0,beat:0};let project=blankProject();
  for(const edit of [
    {type:'setNote' as const,target,string:6,fret:5},
    {type:'setNote' as const,target,string:5,fret:7},
    {type:'setNote' as const,target:{...target,bar:1},string:6,fret:7},
    {type:'addTrack' as const,name:'Bass',tuning:[43,38,33,28],program:33},
    {type:'setNote' as const,target:{...target,track:1},string:4,fret:2},
  ])project=previewEdit(project,edit).project;
  const test=fixture(),built=buildDocument(project);await test.player.loadDocument(project,built);
  const plan=vi.mocked(test.bridge.prepare).mock.calls.at(-1)![0];return {...test,project,built,plan};
}
const cursor={track:0,staff:0,bar:0,voice:0,beat:1};
const passage:MusicSelection={kind:'range',range:{start:{bar:0,tick:120},end:{bar:0,tick:1440},lanes:[{track:0,staff:0,voice:0}]}};
async function selectionFixture(repeat=false) {
  let project=blankProject();
  if(repeat)project=previewEdit(project,{type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:true,repeatCount:2,endings:[],section:'',tempos:[]}).project;
  const built=buildDocument(project),test=fixture(async(_,generation)=>{
    const plan=buildPlaybackPlan(built.score,generation);
    return {...plan,performedBeats:plan.occurrences.filter(o=>o.bar===0).flatMap(o=>[
      {target:{...cursor,beat:0},occurrence:o.occurrence,startTick:o.startTick,endTick:o.startTick+960,leadInTick:o.startTick},
      {target:cursor,occurrence:o.occurrence,startTick:o.startTick+960,endTick:o.startTick+1920,leadInTick:o.startTick+960},
    ])};
  });
  await test.player.loadDocument(project,built);test.emit({practice:practiceStatus()});vi.mocked(test.bridge.command).mockClear();
  return {...test,project,built};
}
it('fresh_cursor_resume_loop_precedence',async()=>{
  const {player,bridge,emit}=await selectionFixture();const choice={generation:player.generation,occurrenceIndex:0,startTick:960};
  player.play(cursor);expect(bridge.command).toHaveBeenLastCalledWith({type:'playRange',generation:player.generation,startTick:960,endTick:null});
  const range={startTick:120,endTick:1440};
  emit({range,tick:300,practice:practiceStatus(defaults(),{phase:'paused',countInRemaining:2,completedPasses:3})});
  player.play(cursor,{...choice,generation:0});expect(bridge.command).toHaveBeenLastCalledWith({type:'play',generation:player.generation});
  expect(player.getState()).toMatchObject({range,practice:{countInRemaining:2,completedPasses:3}});
  emit({loop:range,practice:practiceStatus()});player.play({...cursor,beat:999});expect(bridge.command).toHaveBeenLastCalledWith({type:'play',generation:player.generation});
  emit({practice:practiceStatus(defaults(),{phase:'ended'})});player.play(cursor,choice);expect(bridge.command).toHaveBeenLastCalledWith({type:'playRange',generation:player.generation,startTick:960,endTick:null});
  player.play();expect(bridge.command).toHaveBeenLastCalledWith({type:'play',generation:player.generation});
  expect(bridge.command).toHaveBeenCalledTimes(5);player.destroy();
});
it('explicit starts and loop selection resolve exact fresh intervals without autoplay',async()=>{
  const {player,bridge,emit,onEdit}=await selectionFixture();const generation=player.generation;
  const choice={generation,startOccurrence:0,endOccurrence:0,startTick:120,endTick:1440};
  expect(player.selectionPlaybackChoices(passage)).toEqual([choice]);
  const cursorChoice={generation,occurrenceIndex:0,startTick:960};expect(player.cursorPlaybackChoices(cursor)).toEqual([cursorChoice]);
  expect(player.playbackOccurrences()).toHaveLength(4);expect(bridge.command).not.toHaveBeenCalled();expect(bridge.prepare).toHaveBeenCalledTimes(1);
  emit({playing:true,loop:{startTick:0,endTick:3840},practice:practiceStatus(defaults(),{phase:'playing'})});
  player.playSelection(passage,choice);player.playFromCursor(cursor,cursorChoice);player.loopSelection(passage,choice);
  expect(vi.mocked(bridge.command).mock.calls.map(call=>call[0])).toEqual([
    {type:'playRange',generation,startTick:120,endTick:1440},
    {type:'playRange',generation,startTick:960,endTick:null},
    {type:'setLoop',generation,startTick:120,endTick:1440},
  ]);
  expect(player.getState()).toMatchObject({range:null,loop:{startTick:0,endTick:3840}});expect(onEdit).not.toHaveBeenCalled();expect(bridge.prepare).toHaveBeenCalledTimes(1);player.destroy();
});
it('rejects stale generations changed addresses and altered intervals before selected IPC',async()=>{
  const {player,bridge}=await selectionFixture();const choice=player.cursorPlaybackChoices(cursor)[0],selected=player.selectionPlaybackChoices(passage)[0];
  for(const invalid of [{...choice,generation:choice.generation-1},{...choice,startTick:961},{...choice,occurrenceIndex:1}])expect(()=>player.playFromCursor(cursor,invalid)).toThrow();
  expect(()=>player.playFromCursor({...cursor,beat:0},choice)).toThrow();
  expect(()=>player.playSelection(passage,{...selected,endTick:1441})).toThrow();
  expect(()=>player.loopSelection({...passage,range:{...passage.range,end:{bar:0,tick:1500}}},{...selected})).toThrow();
  expect(bridge.command).not.toHaveBeenCalled();player.beforeScoreChange();vi.mocked(bridge.command).mockClear();
  expect(player.cursorPlaybackChoices(cursor)).toEqual([]);expect(player.selectionPlaybackChoices(passage)).toEqual([]);expect(player.playbackOccurrences()).toEqual([]);
  expect(()=>player.playFromCursor(cursor,choice)).toThrow('after playback is ready');expect(()=>player.playSelection(passage,selected)).toThrow('after playback is ready');expect(()=>player.loopSelection(passage,selected)).toThrow('after playback is ready');expect(bridge.command).not.toHaveBeenCalled();player.destroy();
});
it('requires an explicit performed occurrence for ambiguous primary cursor starts',async()=>{
  const {player,bridge}=await selectionFixture(true);const choices=player.cursorPlaybackChoices(cursor);
  expect(choices).toEqual([{generation:player.generation,occurrenceIndex:0,startTick:960},{generation:player.generation,occurrenceIndex:1,startTick:4800}]);
  expect(()=>player.play(cursor)).toThrow();expect(bridge.command).not.toHaveBeenCalled();
  player.play(cursor,choices[1]);expect(bridge.command).toHaveBeenCalledExactlyOnceWith({type:'playRange',generation:player.generation,startTick:4800,endTick:null});player.destroy();
});
it('mid-score native ended hides the next note while paused study remains visible',async()=>{
  const {player,emit,plan}=await soundingFixture();const tick=plan.occurrences[1].startTick;
  player.play();emit({playing:true,tick:tick+1});expect(player.activeNotes('base/0').map(note=>note.key)).toEqual([71]);
  emit({tick,range:{startTick:0,endTick:tick},practice:practiceStatus(defaults(),{phase:'ended'})});expect(player.activeNotes('base/0')).toEqual([]);
  player.play();emit({tick,practice:practiceStatus(defaults(),{phase:'paused'})});expect(player.activeNotes('base/0')).toEqual([]);
  emit({playing:true,tick});emit({tick,practice:practiceStatus(defaults(),{phase:'paused'})});expect(player.activeNotes('base/0').map(note=>note.key)).toEqual([71]);player.destroy();
});
it('a delayed ended status does not retire a repeated restart intent',async()=>{
  const {player,emit}=await soundingFixture();const ended={tick:3840,range:{startTick:0,endTick:3840},practice:practiceStatus(defaults(),{phase:'ended'})};
  player.play();emit({playing:true,tick:100});emit(ended);expect(player.activeNotes('base/0')).toEqual([]);
  player.play();emit(ended);expect(player.activeNotes('base/0')).toEqual([]);
  emit({playing:true,tick:0,range:ended.range});expect(player.activeNotes('base/0')).toHaveLength(2);player.destroy();
});
it('range display follows native status through repeated starts and queue rejection',async()=>{
  const {player,bridge,emit}=await selectionFixture(),choice=player.selectionPlaybackChoices(passage)[0],range={startTick:40,endTick:200};
  emit({range,tick:80,practice:practiceStatus(defaults(),{phase:'paused'})});
  let release!:()=>void;bridge.command=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  player.playSelection(passage,choice);expect(player.getState().range).toEqual(range);release();await Promise.resolve();expect(player.getState().range).toEqual(range);
  bridge.command=vi.fn(async()=>{});emit({range:{startTick:120,endTick:1440}});player.playSelection(passage,choice);player.playSelection(passage,choice);
  await Promise.resolve();expect(bridge.command).toHaveBeenCalledTimes(2);expect(player.getState().range).toEqual({startTick:120,endTick:1440});
  player.playFromCursor(cursor,player.cursorPlaybackChoices(cursor)[0]);await Promise.resolve();expect(player.getState().range).toEqual({startTick:120,endTick:1440});
  emit({range:null});expect(player.getState().range).toBeNull();player.playFromCursor(cursor,player.cursorPlaybackChoices(cursor)[0]);await Promise.resolve();expect(player.getState().range).toBeNull();
  emit({range});bridge.command=vi.fn(async()=>{throw new Error('Audio command queue is full');});player.playSelection(passage,choice);
  await vi.waitFor(()=>expect(player.getState()).toMatchObject({range,error:'Audio command queue is full'}));
  emit({generation:player.generation-1,range:null});expect(player.getState().range).toEqual(range);player.destroy();
});
it('older plans keep ordinary playback but report selected playback unavailable',async()=>{
  const project=blankProject(),built=buildDocument(project),{player,bridge,emit}=fixture(async(_,generation)=>{const plan=buildPlaybackPlan(built.score,generation);delete plan.performedBeats;return plan;});
  await player.loadDocument(project,built);emit({practice:practiceStatus()});vi.mocked(bridge.command).mockClear();
  expect(()=>player.cursorPlaybackChoices(cursor)).toThrow('unavailable');expect(()=>player.selectionPlaybackChoices(passage)).toThrow('unavailable');
  const choice={generation:player.generation,occurrenceIndex:0,startTick:960},selected={generation:player.generation,startOccurrence:0,endOccurrence:0,startTick:120,endTick:1440};
  expect(()=>player.play(cursor,choice)).toThrow('unavailable');expect(()=>player.playFromCursor(cursor,choice)).toThrow('unavailable');expect(()=>player.playSelection(passage,selected)).toThrow('unavailable');expect(()=>player.loopSelection(passage,selected)).toThrow('unavailable');expect(bridge.command).not.toHaveBeenCalled();
  player.play();expect(bridge.command).toHaveBeenCalledExactlyOnceWith({type:'play',generation:player.generation});player.destroy();
});
it('presentation and static mix preserve active range while musical generations clear it',async()=>{
  const {player,bridge,emit,onEdit,project,built}=await selectionFixture(),range={startTick:120,endTick:1440},generation=player.generation,before=JSON.stringify(project);
  emit({playing:true,tick:300,range});const choice=player.selectionPlaybackChoices(passage)[0];
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;const styled=previewEdit(project,{type:'setEngraving',engraving},built);
  await player.loadDocument(styled.project,styled);expect(player.generation).toBe(generation);expect(player.getState().range).toEqual(range);
  const mixed=previewEdit(styled.project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.4,pan:0,mute:false,solo:false}},styled);await player.loadDocument(mixed.project,mixed);
  expect(player.generation).toBe(generation);expect(player.getState().range).toEqual(range);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.setMix).toHaveBeenCalledTimes(1);
  player.playSelection(passage,choice);expect(JSON.stringify(project)).toBe(before);expect(onEdit).not.toHaveBeenCalled();
  const edited=previewEdit(mixed.project,{type:'setNote',target:cursor,string:6,fret:5},mixed);await player.loadDocument(edited.project,edited);
  expect(player.generation).not.toBe(generation);expect(player.getState().range).toBeNull();emit({generation,range,playing:true});expect(player.getState().range).toBeNull();
  emit({practice:practiceStatus()});vi.mocked(bridge.command).mockClear();expect(()=>player.playSelection(passage,choice)).toThrow('current performed occurrence');expect(bridge.command).not.toHaveBeenCalled();player.destroy();
});
it('exposes performed track chords with half-open native tick intervals',async()=>{
  const {player,emit,built,plan}=await soundingFixture();const bass=trackIdentity(built.score.tracks[1]);
  emit();expect(player.activeNotes('base/0')).toEqual([]);player.play();expect(player.activeNotes('base/0')).toEqual([]);
  emit({playing:true,tick:0,seconds:7,speed:.5});expect(player.activeNotes('base/0').map(n=>n.key).sort()).toEqual([66,69]);
  expect(player.activeNotes(bass).map(n=>n.key)).toEqual([45]);expect(player.activeNotes('missing')).toEqual([]);
  const chordEnd=Math.max(...plan.notes.filter(n=>n.trackId==='base/0'&&n.startTick===0).map(n=>n.endTick));
  emit({playing:true,tick:chordEnd,seconds:0,speed:2});expect(player.activeNotes('base/0')).toEqual([]);player.destroy();
});
it('freezes paused study notes and keeps Stop suppressed until Play or acknowledged seek',async()=>{
  const {player,emit,plan}=await soundingFixture();player.play();emit({playing:true,tick:100});const chord=player.activeNotes('base/0');expect(chord).toHaveLength(2);
  player.pause();emit({tick:100});expect(player.activeNotes('base/0')).toEqual(chord);await Promise.resolve();expect(player.activeNotes('base/0')).toEqual(chord);
  player.stop();expect(player.activeNotes('base/0')).toEqual([]);emit({tick:0});emit({playing:true,tick:100});expect(player.activeNotes('base/0')).toEqual([]);
  player.seekToMeasure(1);emit({tick:0});expect(player.activeNotes('base/0')).toEqual([]);
  const seek=plan.occurrences.find(o=>o.bar===1)!.startTick;emit({tick:seek});expect(player.activeNotes('base/0').map(n=>n.key)).toEqual([71]);
  player.stop();player.play();expect(player.activeNotes('base/0')).toEqual([]);emit({playing:true,tick:0});expect(player.activeNotes('base/0')).toHaveLength(2);
  emit({tick:plan.durationTick,seconds:plan.durationMs/1000});expect(player.activeNotes('base/0')).toEqual([]);player.destroy();
});
it('uses repeated performed occurrences and native seek/loop ticks without a second clock',async()=>{
  const {player,emit,project}=await soundingFixture();
  let repeated=previewEdit(project,{type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:true,repeatCount:0,endings:[],section:'',tempos:[]}).project;
  repeated=previewEdit(repeated,{type:'setMeasureSettings',bar:1,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:2,endings:[],section:'',tempos:[]}).project;
  await player.loadDocument(repeated,buildDocument(repeated));const prepared=buildPlaybackPlan(buildDocument(repeated).score,player.generation);
  const repeatedNote=prepared.notes.find(n=>n.trackId==='base/0'&&n.key===69&&n.occurrence===1)!;expect(repeatedNote).toBeDefined();
  player.play();emit({playing:true,tick:repeatedNote.startTick+1,seconds:0,speed:.25});expect(player.activeNotes('base/0').filter(n=>n.key===69)).toEqual([expect.objectContaining({occurrence:1,startTick:repeatedNote.startTick})]);
  emit({playing:true,tick:0,seconds:99,speed:2});expect(player.activeNotes('base/0').every(n=>n.occurrence===0)).toBe(true);player.destroy();
});
it('keeps settings-only notes but clears stale generations, faults, musical replacement and New',async()=>{
  const {player,bridge,emit,project,built}=await soundingFixture();player.play();emit({playing:true,tick:100});const chord=player.activeNotes('base/0'),generation=player.generation;
  const mixed=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.4,pan:0,mute:false,solo:false}},built);await player.loadDocument(mixed.project,mixed);expect(player.activeNotes('base/0')).toEqual(chord);
  emit({generation:generation-1,ready:false,error:'stale'});expect(player.activeNotes('base/0')).toEqual(chord);
  emit({playing:true,tick:100,error:'Device lost'});expect(player.activeNotes('base/0')).toEqual([]);
  player.play();emit({playing:true,tick:100});expect(player.activeNotes('base/0')).toHaveLength(2);
  emit({ready:false,tick:100});expect(player.activeNotes('base/0')).toEqual([]);
  player.beforeScoreChange();expect(player.activeNotes('base/0')).toEqual([]);emit({generation,playing:true,tick:100});expect(player.activeNotes('base/0')).toEqual([]);
  const next=previewEdit(mixed.project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:9});await player.loadDocument(next.project,next);emit();expect(player.activeNotes('base/0')).toEqual([]);
  player.play();emit({playing:true,tick:100});expect(player.activeNotes('base/0').map(n=>n.key).sort()).toEqual([66,73]);
  const fresh=blankProject();await player.loadDocument(fresh,buildDocument(fresh),0,1);emit();expect(player.activeNotes('base/0')).toEqual([]);expect(bridge.prepare).toHaveBeenCalledTimes(3);player.destroy();expect(player.activeNotes('base/0')).toEqual([]);
});
async function largeNoteFixture() {
  const source=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});
  const template=buildPlaybackPlan(source.score,1).notes[0];const notes:PlanNote[]=Array.from({length:100000},(_,index)=>({...template,id:`display/${index}`,trackId:index%2?'other':'base/0',startTick:index*120,endTick:index*120+240}));
  const {player,emit}=fixture(async(_,generation)=>({...buildPlaybackPlan(source.score,generation),durationTick:12000240,notes}));await player.loadDocument(source.project,source);player.play();emit({playing:true,tick:6000001});
  return {player,emit};
}
it('returns only the selected track from a large prepared plan',async()=>{
  const {player}=await largeNoteFixture();
  expect(player.activeNotes('base/0').map(note=>note.id)).toEqual(['display/50000']);
  expect(player.activeNotes('other').map(note=>note.id)).toEqual(['display/49999']);
  expect(player.activeNotes('missing')).toEqual([]);player.destroy();
});
// Run explicitly with TABPLAYER_AUDIO_BENCHMARK=1 in a serial, otherwise idle session.
it.skipIf(process.env.TABPLAYER_AUDIO_BENCHMARK!=='1')('benchmarks selected-track scans against the 5 ms/query view budget',async()=>{
  const {player}=await largeNoteFixture();
  const start=performance.now();let active=0;for(let query=0;query<200;query++)active+=player.activeNotes('base/0').length;
  const elapsed=performance.now()-start;expect(elapsed).toBeLessThan(1000);console.info(`Active selected-track scan: ${(elapsed/200).toFixed(3)} ms/query for 50,000 notes.`);player.destroy();
  expect(active).toBe(200);
});
it('native_state_ack_not_button_intent',async()=>{
  const {player,bridge,emit}=fixture();const p=blankProject();await player.loadDocument(p,buildDocument(p));
  bridge.command=vi.fn(async()=>{throw new Error('Device disconnected');});player.play();
  await vi.waitFor(()=>expect(player.getState().error).toBe('Device disconnected'));expect(player.getState().playing).toBe(false);
  emit();expect(player.getState().error).toBe('Device disconnected');
  bridge.command=vi.fn(async()=>{});emit();player.play();expect(player.getState().playing).toBe(false);emit({playing:true,seconds:1,tick:1920});expect(player.getState()).toMatchObject({playing:true,time:1000});player.destroy();
});
it('a valid Seek retires its previous operation error before a same-message rejection',async()=>{
  const {player,bridge,emit}=await selectionFixture(),range={startTick:120,endTick:1440};
  emit({range,tick:1440,seconds:.75,practice:practiceStatus(defaults(),{phase:'ended'})});bridge.command=vi.fn(async()=>{throw new Error('Queue full');});
  player.seekToMeasure(0);await vi.waitFor(()=>expect(player.getState().error).toBe('Queue full'));
  expect(()=>player.seekToMeasure(999)).toThrow();expect(player.getState().error).toBe('Queue full');
  const acknowledged=player.getState();player.seekToMeasure(1);expect(player.getState()).toMatchObject({...acknowledged,error:null});
  emit({range,tick:1440,seconds:.75,practice:practiceStatus(defaults(),{phase:'ended'})});expect(player.getState().error).toBeNull();
  await vi.waitFor(()=>expect(player.getState()).toMatchObject({...acknowledged,error:'Queue full'}));
  emit({error:'Native device fault',ready:true,range});player.seekToMeasure(1);expect(player.getState().error).toBe('Native device fault');player.destroy();
});
it('a failed prepare can recover when the document settings change',async()=>{
  const {player,bridge}=fixture();const p=blankProject();let built=buildDocument(p);
  bridge.prepare=vi.fn().mockRejectedValueOnce(new Error('Missing voice sample')).mockResolvedValue(undefined);
  await player.loadDocument(p,built);expect(player.getState().ready).toBe(false);expect(player.getState().error).toBe('Missing voice sample');
  built={...built,settings:{...built.settings,sounds:{}}};await player.loadDocument(p,built);
  expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(bridge.setMix).not.toHaveBeenCalled();player.destroy();
});
it('late_generation_cannot_replace_score',async()=>{
  const {player,bridge,emit}=fixture();const p=blankProject(),first=buildDocument(p);let release!:(p:ReturnType<typeof buildPlaybackPlan>)=>void;
  const plan=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockImplementation((project,generation)=>Promise.resolve(buildPlaybackPlan(buildDocument(project).score,generation)));
  player.destroy();const next=new NativePlaybackController({bridge,onEdit:()=>{},preparePlan:plan});
  const pending=next.loadDocument(p,first);const old=next.generation;
  const other={...p,base:{...p.base,kind:'blank' as const,title:'Next',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:4}};
  await next.loadDocument(other,buildDocument(other));release(buildPlaybackPlan(first.score,old));await pending;
  expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({generation:next.generation}),expect.anything(),null,'blank',DEFAULT_PRACTICE);
  emit({generation:old,playing:true});expect(next.getState().playing).toBe(false);next.destroy();
});
it('inclusive_loop_seek_pause_resume',async()=>{
  const {player,bridge,emit}=fixture();const p=blankProject();await player.loadDocument(p,buildDocument(p));emit();
  player.setLoop(1,2);expect(bridge.command).toHaveBeenLastCalledWith({type:'setLoop',startTick:3840,endTick:11520,generation:player.generation});
  player.seekToMeasure(3);expect(bridge.command).toHaveBeenLastCalledWith({type:'seekTick',tick:11520,generation:player.generation});
  player.setSpeed(10);expect(()=>player.setSpeed(9)).toThrow('10%');emit({playing:true,seconds:6,tick:11520,speed:.25});player.pause();expect(player.getState().playing).toBe(true);emit({seconds:6,tick:11520,speed:.25});expect(player.getState()).toMatchObject({playing:false,time:6000,speed:25,measure:3});player.destroy();
});
it('retains acknowledged speed and metronome across musical edit undo and redo in one document',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject(),built=buildDocument(project);
  bridge.prepare=vi.fn(async(_plan,_settings,_embedded,_sourceKey?:string,practice?:PracticeSettings)=>emit({practice:practiceStatus(practice),speed:practice?.tempo.kind==='relative'?practice.tempo.ratio:1,metronome:practice?.metronome.enabled??false}));
  await player.loadDocument(project,built,0,0);player.setSpeed(50);emit({speed:.5});player.setMetronome(.4);emit({speed:.5,metronome:true});
  const edited=previewEdit(project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});
  for(const document of [{project:edited.project,built:edited},{project,built:buildDocument(project)},{project:edited.project,built:buildDocument(edited.project)}]) {
    player.beforeScoreChange();await player.loadDocument(document.project,document.built,0,0);
    expect(player.getState()).toMatchObject({speed:50,metronome:true,playing:false});
    expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual({...DEFAULT_PRACTICE,tempo:{kind:'relative',ratio:.5},metronome:{enabled:true,volume:.4,visual:false,sound:'beep'}});
  }
  player.destroy();
});
it.each(['blank','file'])('resets practice after explicit New/Open of the same %s base',async kind=>{
  const {player,bridge,emit}=fixture();const blank=blankProject();const bytes=exportGp(buildDocument(blank).score);
  const project=kind==='blank'?blank:{...blank,base:{kind:'file' as const,filename:'authored.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
  const built=buildDocument(project);
  bridge.prepare=vi.fn(async(_plan,_settings,_embedded,_sourceKey?:string,practice?:PracticeSettings)=>emit({practice:practiceStatus(practice),speed:practice?.tempo.kind==='relative'?practice.tempo.ratio:1,metronome:practice?.metronome.enabled??false}));
  await player.loadDocument(project,built,0,0);
  for(const epoch of [1,2]) {
    emit({speed:.75,metronome:true});player.beforeScoreChange();await player.loadDocument(project,built,0,epoch);
    expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual(DEFAULT_PRACTICE);expect(player.getState()).toMatchObject({speed:100,metronome:false});
  }
  player.destroy();
});
it('seeks and inclusively loops the generated variable-meter measure boundaries',async()=>{
  const {player,bridge,emit}=fixture();const target={track:0,staff:0,bar:1,voice:0,beat:3};
  let project=previewEdit(blankProject(),{type:'deleteBeat',target}).project;
  for(let beat=0;beat<3;beat++)project=previewEdit(project,{type:'setBeatRhythm',target:{...target,beat},duration:8,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0}).project;
  project=previewEdit(project,{type:'setMeasureSettings',bar:1,numerator:3,denominator:8,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[]}).project;
  await player.loadDocument(project,buildDocument(project));emit();
  player.seekToMeasure(0);expect(bridge.command).toHaveBeenLastCalledWith({type:'seekTick',tick:0,generation:player.generation});
  player.seekToMeasure(3);expect(bridge.command).toHaveBeenLastCalledWith({type:'seekTick',tick:9120,generation:player.generation});
  player.setLoop(1,2);expect(bridge.command).toHaveBeenLastCalledWith({type:'setLoop',startTick:3840,endTick:9120,generation:player.generation});
  player.clearLoop();expect(bridge.command).toHaveBeenLastCalledWith({type:'clearLoop',generation:player.generation});
  expect(()=>player.setLoop(3,1)).toThrow('Loop end');expect(()=>player.seekToMeasure(99)).toThrow('Select a measure');
  emit({tick:5280,seconds:2.75});expect(player.getState().measure).toBe(2);player.destroy();
});
it('restores persisted mixer identity through structural undo redo and clears it on New',async()=>{
  const {player,bridge,onEdit}=fixture();const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  const bassId=trackIdentity(added.score.tracks[1]),mix={gain:.5,pan:-.2,mute:true,solo:true};
  const mixed=previewEdit(added.project,{type:'setTrackMix',trackId:bassId,mix});await player.loadDocument(mixed.project,mixed);
  const removed=previewEdit(mixed.project,{type:'removeTrack',track:0});await player.loadDocument(removed.project,removed);
  expect(player.mix(removed.score.tracks[0])).toEqual({volume:.5,pan:-.2,mute:true,solo:true});
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[0].tracks.map(t=>t.id)).toEqual([bassId]);
  player.setTrackVolume(0,.3);expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackMix',trackId:bassId,mix:{...mix,gain:.3}});
  const volume=previewEdit(removed.project,{type:'setTrackMix',trackId:bassId,mix:{...mix,gain:.3}},removed);await player.loadDocument(volume.project,volume);
  expect(player.mix(volume.score.tracks[0])?.volume).toBe(.3);
  await player.loadDocument(removed.project,removed);expect(player.mix(removed.score.tracks[0])?.volume).toBe(.5);
  const undo=buildDocument(mixed.project);await player.loadDocument(mixed.project,undo);
  expect(player.mix(undo.score.tracks[0])).toMatchObject({volume:1,mute:false,solo:false});expect(player.mix(undo.score.tracks[1])).toMatchObject({volume:.5,mute:true,solo:true});
  const redo=buildDocument(removed.project);await player.loadDocument(removed.project,redo);expect(player.mix(redo.score.tracks[0])).toMatchObject({volume:.5,mute:true,solo:true});
  const deletedSolo=previewEdit(mixed.project,{type:'removeTrack',track:1});await player.loadDocument(deletedSolo.project,deletedSolo);
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[0].tracks.map(t=>t.id)).toEqual(['base/0']);expect(player.mix(deletedSolo.score.tracks[0])).toMatchObject({mute:false,solo:false});
  const fresh=blankProject(),built=buildDocument(fresh);await player.loadDocument(fresh,built);
  expect(player.mix(built.score.tracks[0])).toMatchObject({volume:1,pan:0,mute:false,solo:false});expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[1].mixes).not.toHaveProperty(bassId);player.destroy();
});
it('mix_undo_delete_new_document uses persisted identity and no score preparation',async()=>{
  const {player,bridge,onEdit}=fixture();const p=blankProject();let built=buildDocument(p);await player.loadDocument(p,built);
  player.setMute(0,true);expect(onEdit).toHaveBeenCalledWith({type:'setTrackMix',trackId:trackIdentity(built.score.tracks[0]),mix:{gain:1,pan:0,mute:true,solo:false}});
  built={...built,settings:{...built.settings,mixes:{'base/0':{gain:.4,pan:0,mute:true,solo:false}}}};await player.loadDocument(p,built);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.setMix).toHaveBeenCalledWith(built.settings,player.generation);expect(player.mix(built.score.tracks[0])).toMatchObject({mute:true,volume:.4});
  built={...built,settings:buildDocument(p).settings};await player.loadDocument(p,built);expect(player.mix(built.score.tracks[0])?.mute).toBe(false);
  await player.loadDocument(blankProject(),buildDocument(blankProject()));expect(player.mix(built.score.tracks[0])?.solo).toBe(false);player.destroy();
});
it('external_cursor_has_one_audio_clock',async()=>{
  const {player,emit}=fixture();const p=blankProject();await player.loadDocument(p,buildDocument(p));
  const output={handler:undefined,updatePosition:vi.fn()};let ready=()=>{};
  const api={player:{output,updateSyncPoints:vi.fn()},playerReady:{on:(f:()=>void)=>{ready=f;},off:vi.fn()},play:vi.fn(),pause:vi.fn(),renderScore:vi.fn(),isReadyForPlayback:true} as unknown as Parameters<typeof player.attachView>[0];
  player.attachView(api);ready();emit({playing:true,seconds:1.5,tick:2880});expect(output.handler).toBeDefined();expect(output.updatePosition).toHaveBeenLastCalledWith(1500);expect(api.player?.updateSyncPoints).toHaveBeenCalledWith([]);expect(api.play).toHaveBeenCalledTimes(1);player.destroy();
});
it('embedded backing travels once per source and retains sync metadata through rebuilds',async()=>{
  const {bridge,player:unused}=fixture();unused.destroy();const original=buildDocument(blankProject());
  const player=new NativePlaybackController({bridge,onEdit:()=>{},preparePlan:async(_,generation)=>buildPlaybackPlan(original.score,generation)});
  const base=(sha256:string)=>({...blankProject(),base:{kind:'file' as const,filename:'Authored.gp',sha256,bytesBase64:'AA=='}});
  const audio=new Uint8Array([1,2,3]);let built={...original,embeddedBacking:audio,embeddedBackingSettings:{offsetMs:120,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:100}],mix:{gain:1,pan:0,mute:false,solo:false}}};
  const first=base('a'.repeat(64)),second=base('b'.repeat(64));
  await player.loadDocument(first,built);expect(bridge.prepare).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({backing:{assetId:'embedded',...built.embeddedBackingSettings}}),audio,first.base.sha256,DEFAULT_PRACTICE);
  built={...built,settings:{...built.settings,mixes:{'base/0':{gain:.4,pan:0,mute:false,solo:false}}}};await player.loadDocument(first,built);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.setMix).toHaveBeenCalledTimes(1);
  built={...built,score:buildDocument(blankProject()).score};await player.loadDocument(first,built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[2]).toBeNull();
  built={...built,score:buildDocument(blankProject()).score};await player.loadDocument(second,built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[2]).toBe(audio);
  built={...built,score:buildDocument(blankProject()).score};await player.loadDocument(first,built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[2]).toBe(audio);player.destroy();
});
it('cosmetic view renders do not forward external media stop or seek to native audio',async()=>{
  const {player,bridge}=fixture();const p=blankProject(),built=buildDocument(p);await player.loadDocument(p,built);
  const output:{handler?:{seekTo:(time:number)=>void;pause:()=>void};updatePosition:()=>void}={updatePosition:()=>{}};
  let ready=()=>{};const map=vi.fn();
  const api={player:{output,updateSyncPoints:map},playerReady:{on:(listener:()=>void)=>{ready=listener;},off:()=>{}},renderScore:()=>{ready();map(['upstream source sync']);output.handler?.pause();output.handler?.seekTo(0);}} as unknown as Parameters<typeof player.attachView>[0];
  player.attachView(api);vi.mocked(bridge.command).mockClear();player.replaceScore(built.score);expect(bridge.command).not.toHaveBeenCalled();
  expect(map).toHaveBeenLastCalledWith([]);
  await player.loadDocument(p,built,1);expect(bridge.setMix).not.toHaveBeenCalled();player.destroy();
});
it('webview reload generation starts after the native pending preparation',async()=>{
  const {player,bridge}=fixture();bridge.status=vi.fn(async()=>({generation:10000,desiredGeneration:10002,ready:false,playing:false,tick:0,seconds:0,durationSeconds:0,speed:1,metronome:false,error:null,deviceId:null,practice:practiceStatus(),range:null,loop:null}));
  const p=blankProject();await player.loadDocument(p,buildDocument(p));expect(player.generation).toBeGreaterThan(10002);expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({generation:player.generation}),expect.anything(),null,'blank',DEFAULT_PRACTICE);player.destroy();
});

it('waits for matching native practice acknowledgement, rejects concurrent Apply, and ignores unchanged settings',async()=>{
  const {player,bridge,emit,onEdit}=fixture();const project=blankProject();await player.loadDocument(project,buildDocument(project));emit();vi.mocked(bridge.command).mockClear();
  const settings:PracticeSettings={tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:1,betweenLoops:true}};
  player.setPractice(settings);settings.metronome.volume=.8;
  const accepted={...settings,metronome:{enabled:true,volume:0,visual:true}};
  expect(bridge.command).toHaveBeenCalledExactlyOnceWith({type:'setPractice',generation:player.generation,settings:accepted});
  expect(player.getState()).toMatchObject({practicePending:true,practice:{settings:DEFAULT_PRACTICE}});await Promise.resolve();
  expect(player.getState().practicePending).toBe(true);expect(()=>player.setPractice(defaults())).toThrow('pending');
  emit({practice:practiceStatus(defaults(),{currentBpm:130})});expect(player.getState().practicePending).toBe(true);
  emit({practice:practiceStatus(accepted,{phase:'playing',effectiveRatio:.7,currentBpm:84,completedPasses:2})});
  expect(player.getState()).toMatchObject({practicePending:false,speed:70,metronome:true,practice:{settings:accepted,currentBpm:84,completedPasses:2}});expect(player.exportPracticeRatio()).toBe(.7);
  player.setPractice(structuredClone(accepted));expect(bridge.command).toHaveBeenCalledTimes(1);expect(onEdit).not.toHaveBeenCalled();player.destroy();
});
it('practice rejection retains accepted settings and generation changes retire pending acknowledgements',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);emit();
  bridge.command=vi.fn(async()=>{throw new Error('Practice refused');});player.setPractice({...defaults(),tempo:{kind:'fixed',bpm:90}});
  await vi.waitFor(()=>expect(player.getState()).toMatchObject({practicePending:false,error:'Practice refused',practice:{settings:DEFAULT_PRACTICE}}));
  bridge.command=vi.fn(async()=>{});player.setPractice({...defaults(),tempo:{kind:'fixed',bpm:90}});const generation=player.generation;
  player.beforeScoreChange();expect(player.getState().practicePending).toBe(false);expect(player.getState().loop).toBeNull();
  emit({generation,practice:practiceStatus({...defaults(),tempo:{kind:'fixed',bpm:90}})});expect(player.getState().practice.settings).toEqual(DEFAULT_PRACTICE);player.destroy();
});
it('validates complete practice settings before IPC and convenience controls retain other settings',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject();await player.loadDocument(project,buildDocument(project));
  const accepted:PracticeSettings={tempo:{kind:'fixed',bpm:90},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};
  emit({practice:practiceStatus(accepted)});expect(player.exportPracticeRatio()).toBeNull();vi.mocked(bridge.command).mockClear();
  expect(()=>player.setPractice({...accepted,countIn:{bars:17,betweenLoops:false}})).toThrow();expect(bridge.command).not.toHaveBeenCalled();
  player.setSpeed(123);expect(bridge.command).toHaveBeenLastCalledWith({type:'setPractice',generation:player.generation,settings:{...accepted,tempo:{kind:'relative',ratio:1.23}}});
  emit({practice:practiceStatus({...accepted,tempo:{kind:'relative',ratio:1.23}})});player.setMetronome(.2);
  expect(bridge.command).toHaveBeenLastCalledWith({type:'setPractice',generation:player.generation,settings:{...accepted,tempo:{kind:'relative',ratio:1.23},metronome:{enabled:true,volume:.2,visual:true}}});player.destroy();
});
it('keeps alphaTab paused and notes empty during live or paused count while retaining paused score notes',async()=>{
  const {player,emit}=await soundingFixture();const output={handler:undefined,updatePosition:vi.fn()};
  const api={player:{output,updateSyncPoints:vi.fn()},playerReady:{on:vi.fn(),off:vi.fn()},play:vi.fn(),pause:vi.fn()} as unknown as Parameters<typeof player.attachView>[0];player.attachView(api);
  player.play();emit({playing:true,tick:100,seconds:.1,practice:practiceStatus(defaults(),{phase:'countIn',countInRemaining:3})});
  expect(player.getState().playing).toBe(true);expect(api.play).not.toHaveBeenCalled();expect(output.updatePosition).toHaveBeenLastCalledWith(100);expect(player.activeNotes('base/0')).toEqual([]);
  emit({tick:100,seconds:.1,practice:practiceStatus(defaults(),{phase:'paused',countInRemaining:3})});expect(player.activeNotes('base/0')).toEqual([]);
  emit({playing:true,tick:100,seconds:.1,practice:practiceStatus(defaults(),{phase:'playing'})});expect(api.play).toHaveBeenCalledTimes(1);expect(player.activeNotes('base/0')).toHaveLength(2);
  emit({tick:100,practice:practiceStatus(defaults(),{phase:'paused'})});expect(api.pause).toHaveBeenCalledTimes(1);expect(player.activeNotes('base/0')).toHaveLength(2);player.destroy();
});
it('fixed native cursor updates cannot feed a relative setting back through alphaTab playbackRate',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject();await player.loadDocument(project,buildDocument(project));
  const output:{handler?:{playbackRate:number};updatePosition:(milliseconds:number)=>void}={updatePosition:()=>{if(output.handler)output.handler.playbackRate=.75;}};
  const api={player:{output,updateSyncPoints:vi.fn()},playerReady:{on:vi.fn(),off:vi.fn()},play:vi.fn(),pause:vi.fn()} as unknown as Parameters<typeof player.attachView>[0];player.attachView(api);vi.mocked(bridge.command).mockClear();
  const settings={...defaults(),tempo:{kind:'fixed' as const,bpm:90}};
  emit({playing:true,seconds:2,tick:3840,practice:practiceStatus(settings,{phase:'playing',effectiveRatio:.75,currentBpm:90})});
  emit({playing:true,seconds:4,tick:4800,practice:practiceStatus(settings,{phase:'playing',effectiveRatio:1.5,currentBpm:90})});
  expect(player.getState()).toMatchObject({speed:150,practice:{currentBpm:90,settings}});expect(bridge.command).not.toHaveBeenCalled();expect(player.exportPracticeRatio()).toBeNull();player.destroy();
});
it.each(['imported','embedded'])('normalizes fixed before preparing %s backing, including muted backing',async kind=>{
  const {player,bridge,emit}=fixture();const project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);
  const settings:PracticeSettings={tempo:{kind:'fixed',bpm:90},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};emit({practice:practiceStatus(settings)});
  const backing={assetId:'recording',offsetMs:0,anchors:[],mix:{gain:1,pan:0,mute:true,solo:false}};
  const next=kind==='imported'?{...built,settings:{...built.settings,backing}}:{...built,embeddedBacking:new Uint8Array([1,2]),embeddedBackingSettings:{offsetMs:0,anchors:[],mix:backing.mix}};
  await player.loadDocument(project,next);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual({...settings,tempo:{kind:'relative',ratio:1}});
  expect(player.getState().practiceNotice).toBe('fixed_tempo_disabled_backing');
  expect(()=>player.setPractice(settings)).toThrow('backing track');expect(player.getState().practice.settings.tempo).not.toEqual({kind:'fixed',bpm:90});player.destroy();
});
it('publishes loop only after native acknowledgement and clears it on generation replacement',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject();await player.loadDocument(project,buildDocument(project));emit();
  player.setLoop(1,2);await Promise.resolve();expect(player.getState().loop).toBeNull();emit({loop:{startTick:3840,endTick:11520}});expect(player.getState().loop).toEqual({startTick:3840,endTick:11520});
  bridge.command=vi.fn(async()=>{throw new Error('Loop refused');});player.clearLoop();await vi.waitFor(()=>expect(player.getState().error).toBe('Loop refused'));expect(player.getState().loop).toEqual({startTick:3840,endTick:11520});
  player.beforeScoreChange();expect(player.getState().loop).toBeNull();player.destroy();
});

it.each(['relative','fixed','progressive'] as const)('retains full acknowledged %s practice through edit undo redo while clearing runtime',async kind=>{
  const {player,bridge,emit,onEdit}=fixture();const project=blankProject(),built=buildDocument(project),before=exportGp(built.score),snapshot=JSON.stringify(project);
  await player.loadDocument(project,built);
  const tempo:PracticeSettings['tempo']=kind==='relative'?{kind,ratio:1.23}:kind==='fixed'?{kind,bpm:90}:{kind,start:.5,end:1,step:.2,repetitions:2};
  const settings:PracticeSettings={tempo,metronome:{enabled:true,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};
  player.setPractice(settings);emit({practice:practiceStatus(settings,{completedPasses:3,effectiveRatio:.7}),loop:{startTick:0,endTick:3840}});
  expect(JSON.stringify(project)).toBe(snapshot);expect(exportGp(built.score)).toEqual(before);expect(onEdit).not.toHaveBeenCalled();
  const edited=previewEdit(project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});
  for(const doc of [{project:edited.project,built:edited},{project,built:buildDocument(project)},{project:edited.project,built:buildDocument(edited.project)}]){
    await player.loadDocument(doc.project,doc.built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual(settings);
    expect(player.getState()).toMatchObject({playing:false,range:null,loop:null,practicePending:false,practice:{settings,phase:'idle',countInRemaining:0,completedPasses:0,pulse:null}});
  }
  player.destroy();
});
it('retains only acknowledged settings when a musical edit replaces a pending Apply',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);
  emit({speed:1.23});const generation=player.generation;player.setPractice({...defaults(),tempo:{kind:'fixed',bpm:90}});
  const edited=previewEdit(project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});await player.loadDocument(edited.project,edited);
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual({...DEFAULT_PRACTICE,tempo:{kind:'relative',ratio:1.23}});
  emit({generation,practice:practiceStatus({...defaults(),tempo:{kind:'fixed',bpm:90}})});expect(player.getState()).toMatchObject({practicePending:false,practice:{settings:{tempo:{kind:'relative',ratio:1.23}}}});player.destroy();
});
it('removing backing permits a later fixed Apply without restoring the former fixed tempo',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject(),built=buildDocument(project);
  const backing={assetId:'recording',offsetMs:0,anchors:[],mix:{gain:1,pan:0,mute:true,solo:false}};
  await player.loadDocument(project,{...built,settings:{...built.settings,backing}});emit();
  expect(()=>player.setPractice({...defaults(),tempo:{kind:'fixed',bpm:90}})).toThrow('backing track');
  await player.loadDocument(project,built);expect(player.getState().practice.settings.tempo).toEqual({kind:'relative',ratio:1});
  player.setPractice({...defaults(),tempo:{kind:'fixed',bpm:90}});expect(bridge.command).toHaveBeenLastCalledWith({type:'setPractice',generation:player.generation,settings:{...DEFAULT_PRACTICE,tempo:{kind:'fixed',bpm:90}}});player.destroy();
});

it('an older Apply promise cannot fail a newer pending Apply after native acknowledgement',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject();await player.loadDocument(project,buildDocument(project));emit();
  let rejectFirst!:(reason:Error)=>void;bridge.command=vi.fn().mockImplementationOnce(()=>new Promise<void>((_resolve,reject)=>{rejectFirst=reject;})).mockResolvedValue(undefined);
  const first={...defaults(),tempo:{kind:'relative' as const,ratio:1.23}},second={...defaults(),tempo:{kind:'fixed' as const,bpm:90}};
  player.setPractice(first);emit({practice:practiceStatus(first)});player.setPractice(second);rejectFirst(new Error('Old request response lost'));
  await new Promise(resolve=>setTimeout(resolve,0));expect(player.getState()).toMatchObject({practicePending:true,error:null,practice:{settings:first}});
  emit({practice:practiceStatus(second)});expect(player.getState()).toMatchObject({practicePending:false,error:null,practice:{settings:second}});player.destroy();
});

function renderedView(){
  let ready=()=>{};const output:{handler?:{seekTo:(time:number)=>void;pause:()=>void};updatePosition:ReturnType<typeof vi.fn>}={updatePosition:vi.fn()};const sync=vi.fn();
  const api={player:{output,updateSyncPoints:sync},playerReady:{on:(callback:()=>void)=>{ready=callback;},off:vi.fn()},renderScore:vi.fn(()=>{ready();sync(['source backing sync']);output.handler?.pause();output.handler?.seekTo(0);}),play:vi.fn(),pause:vi.fn()} as unknown as Parameters<NativePlaybackController['attachView']>[0];
  return {api,output,sync,ready:()=>ready()};
}
it('renders an independently styled multi-track projection without changing canonical playback preparation',async()=>{
  const {player,bridge}=fixture();const target={track:0,staff:0,bar:0,voice:0,beat:0};
  const guitar=previewEdit(blankProject(),{type:'setNote',target,string:6,fret:5}),built=previewEdit(guitar.project,{type:'addPitchedTrack',name:'Keys',program:0});
  const ids=built.score.tracks.map(trackIdentity),engraving=defaultEngraving();engraving.profiles=[{trackId:ids[0],profile:'standard'},{trackId:ids[1],profile:'slash'}];
  const projection=projectEngraving(built.score,ids,engraving),view=renderedView();player.attachView(view.api);vi.mocked(bridge.command).mockClear();
  player.setRenderedScore(projection.score,[0,1]);expect(view.api.renderScore).toHaveBeenLastCalledWith(projection.score,[0,1]);expect(bridge.command).not.toHaveBeenCalled();expect(view.sync).toHaveBeenLastCalledWith([]);
  await player.loadDocument(built.project,built);expect(view.api.renderScore).toHaveBeenCalledTimes(1);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[0].notes[0].key).toBe(69);
  expect(built.score.tracks[0].staves[0].showTablature).toBe(true);expect(projection.score.tracks[0].staves[0].showTablature).toBe(false);
  player.replaceScore(projection.score,1);expect(view.api.renderScore).toHaveBeenLastCalledWith(projection.score,[1]);player.destroy();
});
it('retired view-ready callbacks cannot reinstall external-media handlers after replacement or destruction',async()=>{
  const {player}=fixture(),first=renderedView(),second=renderedView();player.attachView(first.api);expect(first.output.handler).toBeDefined();
  player.attachView(second.api);expect(first.api.playerReady.off).toHaveBeenCalled();expect(first.output.handler).toBeUndefined();expect(second.output.handler).toBeDefined();
  first.ready();expect(first.output.handler).toBeUndefined();player.destroy();second.ready();expect(second.output.handler).toBeUndefined();
});
it('presentation changes during delayed musical preparation keep the newest projection and prepare once',async()=>{
  let release!:(plan:ReturnType<typeof buildPlaybackPlan>)=>void;const prepare=vi.fn((_:unknown,_generation:number)=>new Promise<ReturnType<typeof buildPlaybackPlan>>(resolve=>{release=resolve;}));
  const {player,bridge}=fixture(prepare),project=blankProject(),built=buildDocument(project),view=renderedView();player.attachView(view.api);
  const pending=player.loadDocument(project,built);await vi.waitFor(()=>expect(prepare).toHaveBeenCalledTimes(1));const generation=player.generation;
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;const styled=previewEdit(project,{type:'setEngraving',engraving},built);
  const projection=projectEngraving(built.score,built.score.tracks.map(trackIdentity),engraving);player.setRenderedScore(projection.score,[0]);
  await player.loadDocument(styled.project,styled);expect(player.generation).toBe(generation);expect(prepare).toHaveBeenCalledTimes(1);
  const replacement=renderedView();player.attachView(replacement.api);player.setRenderedScore(projection.score,[0]);view.ready();
  release(buildPlaybackPlan(built.score,generation));await pending;expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(view.api.renderScore).toHaveBeenCalledExactlyOnceWith(projection.score,[0]);expect(replacement.api.renderScore).toHaveBeenCalledExactlyOnceWith(projection.score,[0]);player.destroy();
});
it.each([['ordinary','playing'],['pasted','playing'],['ordinary','countIn'],['pasted','countIn']] as const)('presentation apply undo redo preserves %s canonical music during %s',async(history,phase)=>{
  const target={track:0,staff:0,bar:0,voice:0,beat:0};let built=previewEdit(blankProject(),{type:'setNote',target,string:6,fret:5});
  if(history==='pasted'){const clip=makeMusicClip(built.score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');built=previewEdit(built.project,{type:'pasteMusic',clip,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}},built);}
  const {player,bridge,emit}=fixture(),canonical=built.score,backing=built.embeddedBacking;await player.loadDocument(built.project,built);player.play();
  const settings:PracticeSettings={tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:1,betweenLoops:true}};
  emit({playing:true,tick:100,seconds:.1,loop:{startTick:0,endTick:3840},practice:practiceStatus(settings,{phase,countInRemaining:phase==='countIn'?3:0,completedPasses:4,effectiveRatio:.9,currentBpm:108,pulse:{serial:23,beat:1,beatsPerBar:4,accent:true,counting:phase==='countIn'}})});
  const state=player.getState(),notes=player.activeNotes('base/0'),generation=player.generation,view=renderedView();player.attachView(view.api);vi.mocked(bridge.command).mockClear();
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;engraving.profiles=[{trackId:'base/0',profile:'standard'}];
  const styled=previewEdit(built.project,{type:'setEngraving',engraving},built),paged=previewEdit(styled.project,{type:'setPageLayout',layout:{widthMm:180,heightMm:240,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'}},styled);
  const undoPage={...replayDocumentSettings(styled.project,paged),project:styled.project},undoStyle={...replayDocumentSettings(built.project,undoPage),project:built.project},redo={...replayDocumentSettings(paged.project,undoStyle),project:paged.project};
  for(const next of [styled,paged,undoPage,undoStyle,redo]){expect(next.score).toBe(canonical);expect(next.embeddedBacking).toBe(backing);await player.loadDocument(next.project,next);const projection=projectEngraving(next.score,next.score.tracks.map(trackIdentity),next.settings.engraving);player.setRenderedScore(projection.score,[0]);expect(view.api.renderScore).toHaveBeenLastCalledWith(projection.score,[0]);expect(player.getState()).toEqual(state);expect(player.activeNotes('base/0')).toEqual(notes);expect(player.generation).toBe(generation);}
  expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.command).not.toHaveBeenCalled();expect(bridge.setMix).not.toHaveBeenCalled();
  const mixed=previewEdit(redo.project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}},redo);await player.loadDocument(mixed.project,mixed);expect(bridge.setMix).toHaveBeenCalledTimes(1);expect(player.generation).toBe(generation);player.destroy();
});
it('compares actual sound mixer and backing values while presentation copies retain the canonical score',async()=>{
  const {player,bridge}=fixture(),assetId='a'.repeat(64);let project={...blankProject(),assets:{[assetId]:{filename:'authored.wav',mediaType:'audio/wav',byteLength:96044}}},built=buildDocument(project);await player.loadDocument(project,built);const generation=player.generation;
  for(const edit of [
    {type:'setTrackSound' as const,trackId:'base/0',sound:{voiceId:null,presetId:'clean' as const,effects:defaultEffects()}},
    {type:'setBacking' as const,backing:{assetId,offsetMs:0,anchors:[],mix:{gain:.5,pan:0,mute:false,solo:false}}},
    {type:'setTrackMix' as const,trackId:'base/0',mix:{gain:.7,pan:.2,mute:false,solo:false}},
  ]){const next=previewEdit(project,edit,built);built=next;project={...next.project,assets:project.assets};await player.loadDocument(next.project,next);}
  expect(bridge.setMix).toHaveBeenCalledTimes(3);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(player.generation).toBe(generation);player.destroy();
});

it('a retired mixer acknowledgement cannot make a newer score presentation send an audio update',async()=>{
  const {player,bridge}=fixture(),project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);
  let release!:()=>void;bridge.setMix=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockResolvedValue(undefined);
  const mixed=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}},built),pending=player.loadDocument(mixed.project,mixed);
  await vi.waitFor(()=>expect(bridge.setMix).toHaveBeenCalledTimes(1));
  const changed=previewEdit(project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});await player.loadDocument(changed.project,changed);release();await pending;
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;const styled=previewEdit(changed.project,{type:'setEngraving',engraving},changed);
  await player.loadDocument(styled.project,styled);expect(bridge.setMix).toHaveBeenCalledTimes(1);expect(bridge.prepare).toHaveBeenCalledTimes(2);player.destroy();
});

it('orders Undo behind an outstanding mix instead of treating its last acknowledgement as the desired state',async()=>{
  const {player,bridge}=fixture(),project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);
  let release!:()=>void;bridge.setMix=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockResolvedValue(undefined);
  const mixed=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}},built);
  const pending=player.loadDocument(mixed.project,mixed);await vi.waitFor(()=>expect(bridge.setMix).toHaveBeenCalledTimes(1));
  const undo=player.loadDocument(project,built);release();await pending;await undo;
  expect(bridge.setMix).toHaveBeenCalledTimes(2);expect(vi.mocked(bridge.setMix).mock.calls[1][0].mixes).toEqual(built.settings.mixes);player.destroy();
});
it('presentation does not resend an identical desired mix before acknowledgement',async()=>{
  const {player,bridge}=fixture(),project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);
  let release!:()=>void;bridge.setMix=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockResolvedValue(undefined);
  const mixed=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}},built);
  const pending=player.loadDocument(mixed.project,mixed);await vi.waitFor(()=>expect(bridge.setMix).toHaveBeenCalledTimes(1));
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;const styled=previewEdit(mixed.project,{type:'setEngraving',engraving},mixed);
  const presentation=player.loadDocument(styled.project,styled);release();await pending;await presentation;
  expect(bridge.setMix).toHaveBeenCalledTimes(1);player.destroy();
});
it('dispatches distinct desired mixes serially and retries the latest failed configuration',async()=>{
  const {player,bridge}=fixture(),project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built);
  let release!:()=>void;bridge.setMix=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockRejectedValueOnce(new Error('Latest mix refused')).mockResolvedValue(undefined);
  const first=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}},built),second=previewEdit(first.project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.4,pan:0,mute:false,solo:false}},first);
  const pendingFirst=player.loadDocument(first.project,first);await vi.waitFor(()=>expect(bridge.setMix).toHaveBeenCalledTimes(1));
  const pendingSecond=player.loadDocument(second.project,second);await Promise.resolve();await Promise.resolve();expect(bridge.setMix).toHaveBeenCalledTimes(1);
  release();await pendingFirst;await pendingSecond;expect(player.getState().error).toBe('Latest mix refused');expect(bridge.setMix).toHaveBeenCalledTimes(2);
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;const styled=previewEdit(second.project,{type:'setEngraving',engraving},second);await player.loadDocument(styled.project,styled);
  expect(bridge.setMix).toHaveBeenCalledTimes(3);expect(vi.mocked(bridge.setMix).mock.calls.map(call=>call[0].mixes['base/0'].gain)).toEqual([.7,.4,.4]);expect(player.getState().error).toBeNull();player.destroy();
});
it('focuses a track for this session through the native mix without editing the document',async()=>{
  const {player,bridge,onEdit}=fixture();const project=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project;let built=buildDocument(project);
  await player.loadDocument(project,built,0,1);const [guitar,bass]=built.score.tracks.map(trackIdentity),saved=structuredClone(built.settings.mixes);
  await player.setFocus(bass,.5);
  expect(vi.mocked(bridge.setMix).mock.calls.at(-1)?.[0].mixes).toEqual({[guitar]:{gain:.5,pan:0,mute:false,solo:false},[bass]:{gain:1,pan:0,mute:false,solo:false}});
  expect(player.focus()).toEqual({track:bass,amount:.5});expect(onEdit).not.toHaveBeenCalled();expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(built.settings.mixes).toEqual(saved);
  expect(player.mix(built.score.tracks[0])?.volume??1).toBe(1);
  // A saved mix edit keeps the focus applied on top of it.
  built={...built,settings:{...built.settings,mixes:{[guitar]:{gain:.8,pan:0,mute:false,solo:false}}}};await player.loadDocument(project,built,0,1);
  expect(vi.mocked(bridge.setMix).mock.calls.at(-1)?.[0].mixes[guitar].gain).toBeCloseTo(.4);
  await player.setFocus(bass,0);expect(vi.mocked(bridge.setMix).mock.calls.at(-1)?.[0]).toEqual(built.settings);expect(player.focus()).toBeNull();
  await player.setFocus(guitar,-.25);expect(player.focus()).toEqual({track:guitar,amount:-.25});
  await expect(player.setFocus('base/9',.5)).rejects.toThrow('Select an existing track.');
  await expect(player.setFocus(guitar,1.5)).rejects.toThrow('Focus must be between -100% and 100%.');
  // Another document starts unfocused.
  const fresh=blankProject();await player.loadDocument(fresh,buildDocument(fresh),0,2);expect(player.focus()).toBeNull();player.destroy();
});
it('applies focus and selection changes made during preparation once it finishes, without preparing again',async()=>{
  const {player,bridge}=fixture();const project=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project,built=buildDocument(project);
  let release!:()=>void;bridge.prepare=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  const loading=player.loadDocument(project,built,0,1);await vi.waitFor(()=>expect(bridge.prepare).toHaveBeenCalledTimes(1));
  const [guitar,bass]=built.score.tracks.map(trackIdentity),generation=player.generation;
  await player.setFocus(guitar,.5);await player.setFocus(bass,.5);
  // The host reloads on selection while the preparation is still running.
  await player.loadDocument(project,built,1,1);expect(bridge.setMix).not.toHaveBeenCalled();
  release();await loading;
  await vi.waitFor(()=>expect(bridge.setMix).toHaveBeenCalledTimes(1));
  expect(vi.mocked(bridge.setMix).mock.calls[0][0].mixes[guitar].gain).toBe(.5);
  expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(player.generation).toBe(generation);player.destroy();
});
it('ends focus when its track is removed, so undo does not revive it',async()=>{
  const {player,bridge}=fixture();const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}),built=buildDocument(added.project);
  await player.loadDocument(added.project,built,0,1);const bass=trackIdentity(built.score.tracks[1]);await player.setFocus(bass,.5);
  const removed=previewEdit(added.project,{type:'removeTrack',track:1});await player.loadDocument(removed.project,removed,0,1);expect(player.focus()).toBeNull();
  await player.loadDocument(added.project,buildDocument(added.project),0,1);expect(player.focus()).toBeNull();
  expect(Object.values(vi.mocked(bridge.prepare).mock.calls.at(-1)![1].mixes).every(mix=>mix.gain===1)).toBe(true);player.destroy();
});
it('schedules notes for instrument previews with the position only while a performance is under way',async()=>{
  const {player,emit,plan}=await soundingFixture();
  emit({tick:0});let scheduled=player.scheduledNotes('base/0');
  expect(scheduled).toMatchObject({tick:null,counting:false,loop:null,range:null});expect(scheduled.notes.length).toBeGreaterThan(0);expect(scheduled.beats).toBe(plan.performedBeats);
  player.play();emit({playing:true,tick:100,loop:{startTick:0,endTick:960}});expect(player.scheduledNotes('base/0')).toMatchObject({tick:100,counting:false,loop:{startTick:0,endTick:960}});
  emit({playing:true,tick:0,practice:practiceStatus(defaults(),{phase:'countIn',countInRemaining:2})});expect(player.scheduledNotes('base/0')).toMatchObject({tick:0,counting:true});
  emit({tick:200,practice:practiceStatus(defaults(),{phase:'ended'})});expect(player.scheduledNotes('base/0').tick).toBeNull();
  player.stop();emit({tick:0});expect(player.scheduledNotes('base/0').tick).toBeNull();
  player.beforeScoreChange();scheduled=player.scheduledNotes('base/0');expect(scheduled).toEqual({notes:[],beats:[],tick:null,counting:false,loop:null,range:null});player.destroy();
});

it('sends the sounds again on request, so a cabinet response imported meanwhile is resolved anew',async()=>{
  const {player,bridge}=fixture(),project=blankProject(),built=buildDocument(project);
  await player.loadDocument(project,built);
  // The same document sends nothing, which is why an import that leaves it as it was needs this.
  await player.loadDocument(project,built);expect(bridge.setMix).not.toHaveBeenCalled();
  await player.refreshSounds();
  expect(bridge.setMix).toHaveBeenCalledTimes(1);expect(bridge.prepare).toHaveBeenCalledTimes(1);
  await player.refreshSounds();expect(bridge.setMix).toHaveBeenCalledTimes(2);
  player.destroy();
});

it('mixes drum kit elements for percussion tracks with volume, pan, mute, and solo', async () => {
  const { player, onEdit } = fixture();
  const added = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
  const drumTrack = added.score.tracks[1];
  const drumId = trackIdentity(drumTrack);
  await player.loadDocument(added.project, added);

  // Non-percussion track rejects drum kit mix edits
  expect(() => player.setDrumVolume(0, 'kick', 0.5)).toThrow(/Select a percussion track/);

  // Percussion track mixes kit elements
  player.setDrumVolume(1, 'kick', 0.7);
  expect(onEdit).toHaveBeenLastCalledWith({
    type: 'setTrackMix',
    trackId: drumId,
    mix: { gain: 1, pan: 0, mute: false, solo: false, drumKit: { kick: { gain: 0.7, pan: 0, mute: false, solo: false } } },
  });

  // Re-applying current value records nothing
  onEdit.mockClear();
  player.setDrumVolume(1, 'kick', 1);
  expect(onEdit).not.toHaveBeenCalled();

  // Mute, solo and pan
  player.setDrumPan(1, 'snare', -0.5);
  expect(onEdit).toHaveBeenLastCalledWith({
    type: 'setTrackMix',
    trackId: drumId,
    mix: { gain: 1, pan: 0, mute: false, solo: false, drumKit: { snare: { gain: 1, pan: -0.5, mute: false, solo: false } } },
  });

  player.setDrumMute(1, 'hats', true);
  expect(onEdit).toHaveBeenLastCalledWith({
    type: 'setTrackMix',
    trackId: drumId,
    mix: { gain: 1, pan: 0, mute: false, solo: false, drumKit: { hats: { gain: 1, pan: 0, mute: true, solo: false } } },
  });

  player.setDrumSolo(1, 'toms', true);
  expect(onEdit).toHaveBeenLastCalledWith({
    type: 'setTrackMix',
    trackId: drumId,
    mix: { gain: 1, pan: 0, mute: false, solo: false, drumKit: { toms: { gain: 1, pan: 0, mute: false, solo: true } } },
  });

  player.destroy();
});

it('a key shift is sent whole, acknowledged only by an echo that carries it, kept by later settings and reset by a new document',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject();await player.loadDocument(project,buildDocument(project));emit();vi.mocked(bridge.command).mockClear();
  const shifted={...defaults(),tonality:4};
  player.setPractice(shifted);
  expect(bridge.command).toHaveBeenCalledExactlyOnceWith({type:'setPractice',generation:player.generation,settings:shifted});
  emit({practice:practiceStatus(defaults())});expect(player.getState().practicePending).toBe(true);
  emit({practice:practiceStatus({...defaults(),tonality:0})});expect(player.getState().practicePending).toBe(true);
  emit({practice:practiceStatus(structuredClone(shifted))});
  expect(player.getState()).toMatchObject({practicePending:false,practice:{settings:{tonality:4}}});
  // The same shift again is not a change; an echo of 0 acknowledges a settings object that never named a shift.
  vi.mocked(bridge.command).mockClear();player.setPractice(structuredClone(shifted));expect(bridge.command).not.toHaveBeenCalled();
  player.setPractice({...defaults(),tonality:0});emit({practice:practiceStatus({...defaults(),tonality:0})});
  expect(player.getState().practicePending).toBe(false);
  player.setPractice(shifted);emit({practice:practiceStatus(structuredClone(shifted))});
  const other=blankProject();vi.mocked(bridge.prepare).mockClear();await player.loadDocument(other,buildDocument(other),0,1);
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual(DEFAULT_PRACTICE);player.destroy();
});
