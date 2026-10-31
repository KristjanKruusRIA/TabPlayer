import { expect, it, vi } from 'vitest';
import commands from '../../tests/protocol.json';
import { buildDocument, previewEdit, replayDocumentSettings, validateProject } from '../engine';
import { blankProject } from '../project';
import { completeMaster, defaultDocumentSettings, defaultMaster, masterIsNeutral, masterProblem } from '../document-settings';
import { validateParityCommand } from '../parity-commands';
import type { EditCommand, MasterSettings } from '../edit-types';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge } from './bridge';

const loud=():MasterSettings=>({
  gainDb:-3,balance:.25,
  compressor:{enabled:true,thresholdDb:-20,ratio:3,attackMs:10,releaseMs:150,makeupDb:2},
  eq:{enabled:true,lowDb:2,midDb:-1,highDb:3,midHz:1500},
  reverb:{enabled:true,model:'plate',room:.4,damping:.6,mix:.2},
  limiter:{enabled:true,ceilingDb:-2,releaseMs:80},
});
const edit=(master:MasterSettings):EditCommand=>({type:'setMaster',master});
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const clone=<T,>(value:T):T=>structuredClone(value);

it('starts every document without a master, which plays as the defaults do',()=>{
  expect(defaultDocumentSettings()).not.toHaveProperty('master');
  expect(buildDocument(blankProject()).settings.master).toBeUndefined();
  expect(masterIsNeutral(undefined)).toBe(true);
  expect(masterIsNeutral(defaultMaster())).toBe(true);
  // Numbers behind a block that is off are not a setting.
  expect(masterIsNeutral({...defaultMaster(),compressor:{...defaultMaster().compressor,ratio:9}})).toBe(true);
  for(const change of [
    (m:MasterSettings)=>{m.gainDb=.5;},(m:MasterSettings)=>{m.balance=-.05;},(m:MasterSettings)=>{m.compressor.enabled=true;},
    (m:MasterSettings)=>{m.eq.enabled=true;},(m:MasterSettings)=>{m.reverb.enabled=true;},(m:MasterSettings)=>{m.limiter.enabled=true;},
  ]){const master=defaultMaster();change(master);expect(masterIsNeutral(master)).toBe(false);}
});

it('stores the master in the document, replays it, and takes it back with undo',()=>{
  const first=previewEdit(blankProject(),edit(loud()));
  expect(first.settings.master).toEqual(loud());
  const second=previewEdit(first.project,edit({...loud(),gainDb:6}),first);
  expect(second.settings.master?.gainDb).toBe(6);
  // The last edit wins on a full replay, and the settings-only replay agrees with the full build.
  expect(buildDocument(second.project).settings.master).toEqual(second.settings.master);
  expect(replayDocumentSettings(second.project,second).settings.master).toEqual(second.settings.master);
  // Dropping the edits (what undo does) gives back each earlier state, down to a document that never had one.
  const undone={...second.project,edits:second.project.edits.slice(0,-1)};
  expect(buildDocument(undone).settings.master).toEqual(loud());
  expect(buildDocument({...undone,edits:[]}).settings).not.toHaveProperty('master');
  expect(validateProject(second.project).edits.at(-1)).toEqual(edit({...loud(),gainDb:6}));
});

it('leaves old logs exactly as they replayed: no master, and the other settings untouched',()=>{
  let project=blankProject();
  for(const old of [
    {type:'setNote',target,string:6,fret:5},
    {type:'setTrackMix',trackId:'base/0',mix:{gain:.5,pan:.25,mute:false,solo:false}},
    {type:'setPrintLayout',layout:{paper:'Letter',orientation:'landscape',marginMm:12,scale:1,profile:'Score'}},
  ] as EditCommand[])project=previewEdit(project,old).project;
  const settings=buildDocument(project).settings;
  expect(settings).not.toHaveProperty('master');
  expect(JSON.stringify(settings)).not.toContain('master');
  expect(settings.mixes['base/0']).toEqual({gain:.5,pan:.25,mute:false,solo:false});
  expect(settings.print.paper).toBe('Letter');
});

it('agrees with the native rules on what a master may hold',()=>{
  expect(masterProblem(defaultMaster())).toBeNull();
  expect(masterProblem(loud())).toBeNull();
  const bad:[string,(m:MasterSettings)=>void][]=[
    ['level high',m=>{m.gainDb=12.5;}],['level low',m=>{m.gainDb=-24.5;}],['level not finite',m=>{m.gainDb=NaN;}],
    ['balance',m=>{m.balance=1.01;}],['ceiling above full scale',m=>{m.limiter.ceilingDb=.5;}],['ceiling low',m=>{m.limiter.ceilingDb=-12.5;}],
    ['release short',m=>{m.limiter.releaseMs=9;}],['release long',m=>{m.limiter.releaseMs=1001;}],
    ['ratio',m=>{m.compressor.ratio=21;}],['threshold',m=>{m.compressor.thresholdDb=1;}],['attack',m=>{m.compressor.attackMs=.05;}],
    ['makeup',m=>{m.compressor.makeupDb=-1;}],['eq',m=>{m.eq.lowDb=25;}],['eq frequency',m=>{m.eq.midHz=100;}],
    ['reverb mix',m=>{m.reverb.mix=1.5;}],['reverb model',m=>{(m.reverb as {model:string}).model='cave';}],
    ['flag',m=>{(m.eq as {enabled:unknown}).enabled=1;}],
    ['extra field',m=>{(m as unknown as {amp:object}).amp={};}],['extra block field',m=>{(m.eq as unknown as {q:number}).q=1;}],
    ['missing field',m=>{delete (m as Partial<MasterSettings>).limiter;}],['missing block field',m=>{delete (m.compressor as Partial<MasterSettings['compressor']>).ratio;}],
  ];
  for(const [what,change] of bad){const master=clone(loud());change(master);expect(masterProblem(master),what).not.toBeNull();expect(()=>validateParityCommand(edit(master)),what).toThrow();}
  for(const value of [null,undefined,3,'master',[]])expect(masterProblem(value)).not.toBeNull();
});

it('reads a room reverb saved without its model, as the native player writes it',()=>{
  const saved=clone(loud()) as unknown as {reverb:{model?:string}};delete saved.reverb.model;
  expect(masterProblem(saved)).toBeNull();
  expect(completeMaster(saved as unknown as MasterSettings).reverb.model).toBe('room');
  const built=previewEdit(blankProject(),edit(saved as unknown as MasterSettings));
  expect(built.settings.master?.reverb.model).toBe('room');
  // A model that is there is kept.
  expect(completeMaster(loud()).reverb.model).toBe('plate');
});

it('refuses a malformed setMaster when a project is opened, never part way through building it',()=>{
  const master=loud();
  const project=(entry:unknown)=>({...blankProject(),edits:[entry]});
  expect(()=>validateProject(project(edit(master)))).not.toThrow();
  expect(()=>validateProject(project({type:'setMaster'}))).toThrow();
  expect(()=>validateProject(project({type:'setMaster',master,extra:1}))).toThrow();
  expect(()=>validateProject(project(edit({...master,gainDb:99})))).toThrow();
  expect(()=>validateProject(project({type:'setMaster',master:null}))).toThrow();
  expect(()=>validateParityCommand({type:'setMaster',master:'loud'})).toThrow();
});

it('keeps the shared protocol example, and the defaults native code uses, valid',()=>{
  const example=commands.find(command=>command.type==='setMaster');
  expect(example).toBeDefined();
  expect(()=>validateParityCommand(example)).not.toThrow();
  expect(validateProject({...blankProject(),edits:[example]}).edits).toEqual([example]);
  // The defaults are what a switched-on block starts from, in the editor and in the native settings.
  expect(defaultMaster()).toEqual({
    gainDb:0,balance:0,
    compressor:{enabled:false,thresholdDb:-12,ratio:2,attackMs:30,releaseMs:200,makeupDb:0},
    eq:{enabled:false,lowDb:0,midDb:0,highDb:0,midHz:1000},
    reverb:{enabled:false,model:'hall',room:.6,damping:.5,mix:.1},
    limiter:{enabled:false,ceilingDb:-1,releaseMs:100},
  });
});

function fixture() {
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const onEdit=vi.fn();return {bridge,onEdit,player:new NativePlaybackController({bridge,onEdit})};
}

it('hands the player a master edit as one undoable command, and reads it back',async()=>{
  const {player,onEdit}=fixture();
  const project=blankProject(),built=buildDocument(project);
  expect(player.master()).toBeUndefined();
  await player.loadDocument(project,built);
  expect(player.master()).toBeUndefined();
  await player.setMaster(loud());
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenCalledWith(edit(loud()));
  const next=previewEdit(project,edit(loud()),built);
  await player.loadDocument(next.project,next);
  expect(player.master()).toEqual(loud());
  // The copy it hands out is its own: editing it does not change the document.
  player.master()!.gainDb=9;expect(player.master()!.gainDb).toBe(-3);
  player.destroy();
});

it('refuses to send a master the native player would refuse',async()=>{
  const {player,onEdit}=fixture();
  await expect(player.setMaster({...loud(),gainDb:50})).rejects.toThrow('Invalid master settings.');
  expect(onEdit).not.toHaveBeenCalled();
  expect(player.getState().error).toBe('Invalid master settings.');
  player.destroy();
});

it('settles a master edit only when the edit has been decided',async()=>{
  const {player,onEdit}=fixture();let refuse!:(error:Error)=>void;
  onEdit.mockImplementationOnce(()=>new Promise<void>((_,reject)=>{refuse=reject;}));
  const outcome=player.setMaster(loud()).then(()=>'accepted',error=>(error as Error).message);
  await Promise.resolve();
  refuse(new Error('This document is finalized. Unfinalize it to make changes.'));
  expect(await outcome).toBe('This document is finalized. Unfinalize it to make changes.');
  player.destroy();
});

it('sends the master to the player when it changes during playback, and not when it does not',async()=>{
  const {bridge,player}=fixture();
  const project=blankProject(),built=buildDocument(project);
  await player.loadDocument(project,built);
  expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.setMix).not.toHaveBeenCalled();
  const first=previewEdit(project,edit(loud()),built);
  await player.loadDocument(first.project,first);
  expect(bridge.setMix).toHaveBeenCalledTimes(1);
  expect(vi.mocked(bridge.setMix).mock.calls[0][0].master).toEqual(loud());
  expect(bridge.prepare).toHaveBeenCalledTimes(1);
  // The same master again is no change; another is.
  await player.loadDocument(first.project,first);
  expect(bridge.setMix).toHaveBeenCalledTimes(1);
  const second=previewEdit(first.project,edit({...loud(),limiter:{...loud().limiter,ceilingDb:-6}}),first);
  await player.loadDocument(second.project,second);
  expect(bridge.setMix).toHaveBeenCalledTimes(2);
  expect(vi.mocked(bridge.setMix).mock.calls[1][0].master?.limiter.ceilingDb).toBe(-6);
  player.destroy();
});
