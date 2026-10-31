import {expect,it,vi} from 'vitest';
import {midi} from '@coderline/alphatab';
import protocol from '../../tests/reference-sync-protocol.json';
import {validateParityCommand} from '../parity-commands';
import {backingLocationsForScore,validateBackingAnchors,validatePlaybackPlan} from './plan';
import type {PlaybackPlan} from './types';
import {MAX_EXPORT_BACKING_BYTES,validateBackingAssetReadRequest} from '../export/backing-asset-types';
import {applySettingsEdit,defaultDocumentSettings} from '../document-settings';
import {buildScore} from '../engine';
import {blankProject} from '../project';
import type {BackingSettings} from '../edit-types';

function validate(kind:string,payload:unknown):void {
  if(kind==='backing')validateParityCommand({type:'setBacking',backing:payload});
  else if(kind==='command')validateParityCommand(payload);
  else if(kind==='plan')validatePlaybackPlan(payload as PlaybackPlan);
  else if(kind==='assetRead')validateBackingAssetReadRequest(payload);
  else throw new Error('Unknown protocol fixture kind.');
}

it.each(protocol.valid)('accepts literal $kind: $name',({kind,payload})=>{
  expect(()=>validate(kind,payload)).not.toThrow();
});
it.each(protocol.invalid)('rejects literal $kind: $name',({kind,payload})=>{
  expect(()=>validate(kind,payload)).toThrow();
});
it('rejects explicitly present undefined and nonfinite active ends',()=>{
  const plan=protocol.valid.find(row=>row.kind==='plan')!.payload;
  for(const playbackEndTick of [undefined,NaN,Infinity,-Infinity])expect(()=>validate('plan',{...plan,playbackEndTick})).toThrow();
});
it('rejects nonfinite ratio tempos and invalid boolean flags',()=>{
  const point={bar:0,ratio:0,bpm:120,linear:false};
  for(const [key,value] of [['ratio',NaN],['ratio',Infinity],['bpm',NaN],['bpm',Infinity],['bpm',-1],['bar',NaN],['linear',0],['linear',null]] as const)expect(()=>validate('command',{type:'replaceTempoAutomations',points:[{...point,[key]:value}]})).toThrow();
});
it('rejects nonfinite reference coordinates and physical arithmetic overflow',()=>{
  const backing=protocol.valid.find(row=>row.name==='reference negative stored source40')!.payload;
  for(const referenceSync of [{entryAudioMs:NaN,exitAudioMs:1880},{entryAudioMs:-120,exitAudioMs:Infinity},{entryAudioMs:0,exitAudioMs:Number.MAX_VALUE}]){
    expect(()=>validate('backing',{...backing,offsetMs:-Number.MAX_VALUE,referenceSync})).toThrow();
  }
});
it('uses the query-specific raw container limit',()=>{
  expect(MAX_EXPORT_BACKING_BYTES).toBe(536870912);
});
it('keeps omitted and null legacy bounds valid without rewriting stored settings',()=>{
  const score=buildScore(blankProject());
  for(const name of ['legacy bounds omitted','legacy bounds null']) {
    const backing=structuredClone(protocol.valid.find(row=>row.name===name)!.payload) as BackingSettings;
    const before=structuredClone(backing),settings=defaultDocumentSettings();
    applySettingsEdit(settings,{type:'setBacking',backing},score,[]);
    validateBackingAnchors(score,settings.backing);
    expect(settings.backing).toEqual(before);expect(backing).toEqual(before);
  }
});
it('accepts signed stored reference anchors through settings and route validation',()=>{
  const backing=structuredClone(protocol.valid.find(row=>row.name==='reference negative stored source40')!.payload) as BackingSettings;
  const settings=defaultDocumentSettings(),score=buildScore(blankProject());
  expect(()=>applySettingsEdit(settings,{type:'setBacking',backing},score,[])).not.toThrow();
  expect(()=>validateBackingAnchors(score,settings.backing)).not.toThrow();
  expect(settings.backing).toEqual(backing);expect(settings.backing).not.toBe(backing);
});
it('rejects extra mixer fields and missing or nonfinite nested backing values',()=>{
  const backing=structuredClone(protocol.valid[0].payload) as BackingSettings;
  const invalid=[{...backing,mix:{...backing.mix,extra:1}},{...backing,mix:{...backing.mix,solo:undefined}},{...backing,offsetMs:NaN},{...backing,anchors:[{...backing.anchors[0],occurrence:0x100000000}]},{...backing,referenceSync:undefined}];
  for(const value of invalid)expect(()=>validate('backing',value)).toThrow();
});
it('resolves actual route freshly without isolated note lanes or stale score caching',()=>{
  const score=buildScore(blankProject()),spy=vi.spyOn(midi.MidiFileGenerator.prototype,'generate');
  try {
    const first=backingLocationsForScore(score);
    expect(first.map(row=>row.bar)).toEqual([0,1,2,3]);expect(spy).toHaveBeenCalledOnce();
    score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.rebuildRepeatGroups();
    const second=backingLocationsForScore(score);
    expect(second.map(row=>[row.bar,row.occurrence,row.startTick,row.endTick])).toEqual([
      [0,0,0,3840],[1,0,3840,7680],[0,1,7680,11520],[1,1,11520,15360],[2,0,15360,19200],[3,0,19200,23040],
    ]);
    expect(spy).toHaveBeenCalledTimes(2);expect(first.map(row=>row.bar)).toEqual([0,1,2,3]);
  }finally{spy.mockRestore();}
});
it('rejects reference endpoint aliases, missing occurrences and crossed interior points',()=>{
  const score=buildScore(blankProject());
  const backing=structuredClone(protocol.valid.find(row=>row.name==='reference negative stored source40')!.payload) as BackingSettings;
  for(const anchors of [
    [{bar:0,occurrence:0,ratio:0,audioMs:0}],
    [{bar:3,occurrence:0,ratio:1,audioMs:0}],
    [{bar:0,occurrence:1,ratio:.5,audioMs:0}],
    [{bar:0,occurrence:0,ratio:.5,audioMs:1000},{bar:1,occurrence:0,ratio:.5,audioMs:500}],
    [{bar:0,occurrence:0,ratio:1,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:1500}],
  ])expect(()=>validateBackingAnchors(score,{...backing,anchors})).toThrow();
});
it('rejects reference coordinates collapsed by physical offset arithmetic in the route validator',()=>{
  const score=buildScore(blankProject());
  expect(()=>validateBackingAnchors(score,{offsetMs:-1e308,anchors:[],referenceSync:{entryAudioMs:0,exitAudioMs:1}})).toThrow();
  expect(()=>validateBackingAnchors(score,{offsetMs:-1e16,anchors:[{bar:0,occurrence:0,ratio:.5,audioMs:1}],referenceSync:{entryAudioMs:0,exitAudioMs:10}})).toThrow();
  const collapsed={assetId:'a'.repeat(64),offsetMs:-1e16,mix:{gain:1,pan:0,mute:false,solo:false},anchors:[{bar:0,occurrence:0,ratio:.25,audioMs:3},{bar:0,occurrence:0,ratio:.5,audioMs:4}],referenceSync:{entryAudioMs:0,exitAudioMs:100}};
  expect(()=>validate('backing',collapsed)).not.toThrow();
  expect(()=>validateBackingAnchors(score,collapsed)).toThrow();
});
