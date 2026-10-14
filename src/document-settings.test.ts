import { afterEach, expect, it, vi } from 'vitest';
import { importer, model } from '@coderline/alphatab';
import { buildDocument, buildScore, effectiveAudioSettings, previewEdit, replayDocumentSettings } from './engine';
import { blankProject, type EditCommand } from './project';

afterEach(()=>vi.restoreAllMocks());

function embeddedProject(edits:EditCommand[]=[]) {
  const source=buildScore(blankProject());const bytes=new Uint8Array([82,73,70,70]);
  source.backingTrack={rawAudioFile:bytes};source.tracks[0].playbackInfo.isMute=true;
  for (const [bar,occurrence,ratio,audioMs] of [[0,0,0,120],[2,1,.5,4200],[3,0,.75,6900]]) {
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
    offsetMs:0,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:120},{bar:2,occurrence:1,ratio:.5,audioMs:4200},{bar:3,occurrence:0,ratio:.75,audioMs:6900}],
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
    anchors:[{bar:0,occurrence:0,ratio:0,audioMs:120},{bar:2,occurrence:1,ratio:.5,audioMs:4200},{bar:3,occurrence:0,ratio:.75,audioMs:6900}],
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
  project.edits=[{type:'setBacking',backing:{assetId,offsetMs:0,anchors:[{bar:3,occurrence:1,ratio:.5,audioMs:4000}],mix:{gain:1,pan:0,mute:false,solo:false}}},{type:'removeMeasure',bar:1}];
  const built=buildDocument(project);const cleared=previewEdit(project,{type:'setBacking',backing:null},built);
  const restored=replayDocumentSettings(project,cleared);
  expect(restored.settings.backing?.anchors).toEqual([{bar:2,occurrence:1,ratio:.5,audioMs:4000}]);
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
