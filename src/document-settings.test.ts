import { afterEach, expect, it, vi } from 'vitest';
import { importer, model } from '@coderline/alphatab';
import { buildDocument, buildScore, effectiveAudioSettings, previewEdit, replayDocumentSettings, validateProject } from './engine';
import { blankProject, type EditCommand } from './project';
import type { SyncAnchor } from './edit-types';
import { buildPlaybackPlan } from './audio/plan';
import { completeSound, defaultEffects, laterFields, soundProblem } from './document-settings';
import { soundPreset } from './audio/sound-model';
import type { TrackSound } from './edit-types';
import pluginProtocol from '../tests/plugin-slot-protocol.json';

afterEach(()=>vi.restoreAllMocks());

function embeddedProject(edits:EditCommand[]=[]) {
  const source=buildScore(blankProject());const bytes=new Uint8Array([82,73,70,70]);
  source.backingTrack={rawAudioFile:bytes};source.tracks[0].playbackInfo.isMute=true;
  for (const [bar,occurrence,ratio,audioMs] of [[0,0,0,120],[2,0,.5,4200],[3,0,.75,6900]]) {
    const sync=new model.Automation();sync.ratioPosition=ratio;sync.syncPointValue=new model.SyncPointData();
    sync.syncPointValue.barOccurence=occurrence;sync.syncPointValue.millisecondOffset=audioMs;
    source.masterBars[bar].syncPoints=[sync];
  }
  vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockReturnValue(source);
  const project={...blankProject(),base:{kind:'file' as const,filename:'original.gp',bytesBase64:'AA==',sha256:'a'.repeat(64)},edits};
  return {source,bytes,project};
}

it('captures original embedded audio anchors before rebuilding the score',()=>{
  const {project,bytes}=embeddedProject();const built=buildDocument(project);
  expect(built.embeddedBacking).toEqual(bytes);
  expect(built.embeddedBacking===bytes).toBe(false);
  expect(built).toHaveProperty('embeddedBackingSettings',{
    offsetMs:0,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:120},{bar:2,occurrence:0,ratio:.5,audioMs:4200},{bar:3,occurrence:0,ratio:.75,audioMs:6900}],
    mix:{gain:1,pan:0,mute:false,solo:false},
  });
});

it('shifts and deletes embedded synchronization anchors with removed measures',()=>{
  const {project}=embeddedProject([{type:'removeMeasure',bar:2}]);
  expect(buildDocument(project)).toHaveProperty('embeddedBackingSettings.anchors',[
    {bar:0,occurrence:0,ratio:0,audioMs:120},{bar:2,occurrence:0,ratio:.75,audioMs:6900},
  ]);
});

it('uses original embedded backing until an explicit score-only edit and restores it on undo',()=>{
  const {project}=embeddedProject();const built=buildDocument(project);
  expect(effectiveAudioSettings(project,built).backing).toEqual({assetId:'embedded',offsetMs:0,
    anchors:[{bar:0,occurrence:0,ratio:0,audioMs:120},{bar:2,occurrence:0,ratio:.5,audioMs:4200},{bar:3,occurrence:0,ratio:.75,audioMs:6900}],
    mix:{gain:1,pan:0,mute:false,solo:false},
  });
  expect(built.settings.backing).toBeNull();expect(project.assets).toEqual({});
  const scoreOnly=previewEdit(project,{type:'setBacking',backing:null},built);
  expect(effectiveAudioSettings(scoreOnly.project,scoreOnly).backing).toBeNull();
  const restored=replayDocumentSettings(project,scoreOnly);
  expect(effectiveAudioSettings(project,restored).backing?.assetId).toBe('embedded');
  expect(restored.score===built.score).toBe(true);expect(restored.embeddedBacking===built.embeddedBacking).toBe(true);
});

it('preserves explicitly selected backing instead of the original embedded audio',()=>{
  const {project}=embeddedProject();const assetId='b'.repeat(64);
  project.assets[assetId]={filename:'chosen.wav',mediaType:'audio/wav',byteLength:100};
  const backing={assetId,offsetMs:250,anchors:[{bar:1,occurrence:0,ratio:.25,audioMs:1000}],mix:{gain:.4,pan:.5,mute:false,solo:false}};
  const selected=previewEdit(project,{type:'setBacking',backing});
  expect(effectiveAudioSettings(selected.project,selected).backing).toEqual(backing);
});

it('replays earlier backing anchors against their historical measure layout',()=>{
  const assetId='b'.repeat(64);const project=blankProject();
  project.assets[assetId]={filename:'backing.wav',mediaType:'audio/wav',byteLength:100};
  project.edits=[{type:'setBacking',backing:{assetId,offsetMs:0,anchors:[{bar:3,occurrence:0,ratio:.5,audioMs:4000}],mix:{gain:1,pan:0,mute:false,solo:false}}},{type:'removeMeasure',bar:1}];
  const built=buildDocument(project);const cleared=previewEdit(project,{type:'setBacking',backing:null},built);
  const restored=replayDocumentSettings(project,cleared);
  expect(restored.settings.backing?.anchors).toEqual([{bar:2,occurrence:0,ratio:.5,audioMs:4000}]);
  expect(restored.score===built.score).toBe(true);
});

it('replays mixer and print settings without changing music', () => {
  const project = blankProject();
  const score = buildScore(project);
  const mix = { gain: 0.4, pan: -0.5, mute: true, solo: false };
  const candidate = previewEdit(project, { type: 'setTrackMix', trackId: 'base/0', mix } as unknown as EditCommand);
  expect(candidate).toHaveProperty('settings.mixes.base/0', mix);
  expect(candidate.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes)
    .toEqual(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes);
  const layout = { paper: 'Letter', orientation: 'landscape', marginMm: 12, scale: 1, profile: 'Tab' };
  const printed = previewEdit(candidate.project, { type: 'setPrintLayout', layout } as unknown as EditCommand);
  expect(printed).toHaveProperty('settings.print', layout);
  expect(printed.project.edits).toHaveLength(2);
});

it('distinguishes original embedded backing from explicit score-only playback', () => {
  const project = blankProject();
  const candidate = previewEdit(project, { type: 'setBacking', backing: null } as unknown as EditCommand);
  expect(candidate.project.edits).toEqual([{ type: 'setBacking', backing: null }]);
  expect(candidate).toHaveProperty('settings.backing', null);
});

const invalidBackingAnchors:{reason:string;anchors:SyncAnchor[]}[]=[
  {reason:'missing repeat occurrence',anchors:[{bar:0,occurrence:999,ratio:0,audioMs:0}]},
  {reason:'backwards mapped audio time',anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:0}]},
  {reason:'aliased bar-boundary positions',anchors:[{bar:0,occurrence:0,ratio:1,audioMs:0},{bar:1,occurrence:0,ratio:0,audioMs:1000}]},
];
const backingAssetId='c'.repeat(64);
const backingEdit=(anchors:SyncAnchor[]):EditCommand=>({type:'setBacking',backing:{assetId:backingAssetId,offsetMs:0,anchors,mix:{gain:1,pan:0,mute:false,solo:false}}});
const projectForBacking=(edits:EditCommand[]=[])=>({...blankProject(),assets:{[backingAssetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:100}},edits});
const repeatStart:Extract<EditCommand,{type:'setMeasureSettings'}>={type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:true,repeatCount:0,endings:[],section:'',tempos:[]};
const repeatEnd={...repeatStart,bar:1,repeatStart:false,repeatCount:2};

it.each(invalidBackingAnchors)('rejects a preview with $reason before installing candidate settings',({anchors})=>{
  const project=projectForBacking();const original=structuredClone(project);const current=buildDocument(project);const originalSettings=structuredClone(current.settings);
  expect(()=>previewEdit(project,backingEdit(anchors),current)).toThrow(/anchor|backing|occurrence/i);
  expect(project).toEqual(original);expect(current.settings).toEqual(originalSettings);
});

it('rejects repeat removal when an existing backing anchor loses its played occurrence',()=>{
  const project=projectForBacking([repeatStart,repeatEnd,backingEdit([{bar:1,occurrence:1,ratio:.5,audioMs:6500}])]);
  const current=buildDocument(project);const original=structuredClone(project);const originalSettings=structuredClone(current.settings);
  expect(buildPlaybackPlan(current.score,1).occurrences.map(o=>[o.bar,o.occurrence])).toEqual([[0,0],[1,0],[0,1],[1,1],[2,0],[3,0]]);
  expect(()=>previewEdit(project,{...repeatEnd,repeatCount:0},current)).toThrow(/anchor|backing|occurrence/i);
  expect(project).toEqual(original);expect(current.settings).toEqual(originalSettings);
});

it('accepts backing anchors in performed repeat order instead of lexical bar order',()=>{
  const project=projectForBacking([repeatStart,repeatEnd]);const current=buildDocument(project);
  const candidate=previewEdit(project,backingEdit([{bar:1,occurrence:0,ratio:0,audioMs:2000},{bar:0,occurrence:1,ratio:0,audioMs:3000}]),current);
  expect(candidate.settings.backing?.anchors).toEqual([{bar:1,occurrence:0,ratio:0,audioMs:2000},{bar:0,occurrence:1,ratio:0,audioMs:3000}]);
  expect(candidate.score===current.score).toBe(true);
});

const ampSound=(capture?:unknown)=>{const sound=soundPreset('lead');if(capture!==undefined)(sound.effects.amp as unknown as Record<string,unknown>).capture=capture;return sound;};
it('reads a stored null capture or impulse response as none, so a sound with one equals the same sound without',()=>{
  const bare=ampSound(),stored=ampSound(null);
  (stored.effects.cabinet as unknown as Record<string,unknown>).ir=null;
  const second=ampSound(null);stored.effects.second=second.effects;
  const done=completeSound(stored);
  expect('capture' in done.effects.amp).toBe(false);expect('ir' in done.effects.cabinet).toBe(false);
  expect('capture' in done.effects.second!.amp).toBe(false);
  expect(done.effects.amp).toEqual(completeSound(bare).effects.amp);expect(done.effects.cabinet).toEqual(completeSound(bare).effects.cabinet);
  // The sound that was passed in is not touched.
  expect((stored.effects.amp as unknown as Record<string,unknown>).capture).toBeNull();
});
it('leaves the amp exactly as it was while no capture is chosen',()=>{
  expect(defaultEffects().amp).toEqual({enabled:false,model:'clean',drive:.1,gainDb:0});
  expect(laterFields('amp')).toEqual(['bassDb','midDb','trebleDb','presenceDb','capture']);
  const older=ampSound();expect('capture' in older.effects.amp).toBe(false);
  expect(soundProblem(older)).toBeNull();expect(completeSound(older).effects.amp).toEqual(older.effects.amp);
});
it('accepts the amp captures the native player accepts and refuses the rest',()=>{
  const good={id:'ab'.repeat(16),name:'Plexi',levelDb:0};
  for(const value of [good,{...good,levelDb:-12},{...good,levelDb:12},{...good,name:'x'.repeat(64)},null])expect(soundProblem(ampSound(value)),JSON.stringify(value)).toBeNull();
  for(const value of [{...good,id:'zz'},{...good,id:'A'.repeat(32)},{...good,name:'x'.repeat(65)},{...good,name:''},{...good,levelDb:12.5},{...good,levelDb:-12.5},{...good,levelDb:Number.NaN},{...good,extra:1},{id:good.id,name:good.name},'text',[]])expect(soundProblem(ampSound(value)),JSON.stringify(value)).toBe('Invalid effect parameter.');
});

// A sound carrying this plug-in value, whatever it is.
const withPlugin=(plugin:unknown)=>({...soundPreset('lead'),plugin}) as unknown as TrackSound;
const pluginCases=pluginProtocol.cases as {name:string;valid:boolean;set?:Record<string,unknown>;remove?:string[]}[];
it('accepts a valid plug-in slot and keeps it through completion',()=>{
  const sound=withPlugin(pluginProtocol.base);
  expect(soundProblem(sound)).toBeNull();
  expect(completeSound(sound).plugin).toEqual(pluginProtocol.base);
  // A track without one is as it was: no key, no problem, and an undefined key is not written back.
  expect(soundProblem(soundPreset('lead'))).toBeNull();
  expect('plugin' in soundPreset('lead')).toBe(false);
  expect('plugin' in completeSound({...soundPreset('lead'),plugin:undefined})).toBe(false);
});
it('holds plug-in slots to the rules the native player holds them to, case for case',()=>{
  expect(pluginCases.length).toBeGreaterThan(60);
  for(const {name,valid,set,remove} of pluginCases){
    const slot:Record<string,unknown>={...pluginProtocol.base,...set};
    for(const key of remove??[])delete slot[key];
    const problem=soundProblem(withPlugin(slot));
    expect(problem===null,`${name}: ${problem}`).toBe(valid);
  }
});
it('refuses a malformed plug-in slot and an unknown key beside it',()=>{
  for(const bad of [null,'vst3',[],{},{...pluginProtocol.base,extra:true},{...pluginProtocol.base,inputDb:Number.NaN},{...pluginProtocol.base,outputDb:Infinity},{...pluginProtocol.base,outputDb:-Infinity}])
    expect(soundProblem(withPlugin(bad)),JSON.stringify(bad)).toMatch(/^Invalid plug-in/);
  expect(soundProblem({...withPlugin(pluginProtocol.base),pluginX:{}} as unknown as TrackSound)).toBe('Invalid sound.');
});
it('refuses a project whose plug-in slot names state it does not hold, as it does for backing audio',()=>{
  const project=blankProject();
  project.edits=[{type:'setTrackSound',trackId:'base/0',sound:withPlugin(pluginProtocol.base)}] as unknown as EditCommand[];
  expect(()=>validateProject(project)).toThrow('Plug-in state asset is missing.');
  project.assets[pluginProtocol.base.state]={filename:'plugin-state.tpstate',mediaType:'application/x-tabplayer-plugin-state',byteLength:30};
  expect(validateProject(project).edits).toHaveLength(1);
});
