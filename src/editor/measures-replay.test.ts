import { expect,it } from 'vitest';
import { blankProject,type EditCommand } from '../project';
import { buildDocument,previewEdit,replayDocumentSettings } from '../engine';
import { getTrackLyrics } from './lyrics';
import { createHash } from 'node:crypto';
import { model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { exportGp } from '../engine';
import { loadInterchangeScore } from '../interchange/gp';
import { music,noteAt } from './fixtures';

const assetId='a'.repeat(64),raw='[VERSE]\r\nHel-lo  world+today';
const source=()=>({...blankProject(),assets:{[assetId]:{filename:'authored.wav',mediaType:'audio/wav',byteLength:96044}},edits:[
  {type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:1,text:raw}]},
  {type:'setBacking',backing:{assetId,offsetMs:10,anchors:[{bar:3,occurrence:0,ratio:0,audioMs:5000}],mix:{gain:.5,pan:0,mute:false,solo:false}}},
] as EditCommand[]});
it('maps raw lyrics and backing on insertion/removal with deterministic settings replay and undo redo',()=>{
  const original=source(),before=JSON.stringify(original),inserted=previewEdit(original,{type:'insertMeasures',beforeBar:1,count:2});
  expect(inserted.score.masterBars).toHaveLength(6);expect(inserted.settings.backing?.anchors[0].bar).toBe(5);expect(getTrackLyrics(inserted.score,0).lines[0]).toEqual({startBar:3,text:raw});
  const setting:EditCommand={type:'setTrackMix',trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}};
  const settingsProject={...inserted.project,edits:[...inserted.project.edits,setting]};
  expect(replayDocumentSettings(settingsProject,inserted).settings).toEqual(buildDocument(settingsProject).settings);
  const removed=previewEdit(settingsProject,{type:'removeMeasures',firstBar:1,lastBar:2});
  expect(removed.score.masterBars).toHaveLength(4);expect(removed.settings.backing?.anchors[0].bar).toBe(3);
  expect(getTrackLyrics(removed.score,0)).toEqual({visible:false,lines:[{startBar:1,text:raw}],source:'raw'});
  const reopened=buildDocument(JSON.parse(JSON.stringify(removed.project)));expect(reopened.settings).toEqual(removed.settings);
  expect(buildDocument({...removed.project,edits:removed.project.edits.slice(0,-1)}).score.masterBars).toHaveLength(6);
  expect(JSON.stringify(original)).toBe(before);
});
it('preserves imported archive siblings, embedded bytes and raw hidden lyrics through range and measure history',()=>{
  const authored=music(),audio=new Uint8Array([82,73,70,70,1,2,3,4]);
  authored.backingTrack=new model.BackingTrack();authored.backingTrack.rawAudioFile=audio;
  const entries=unzipSync(exportGp(authored));entries['Content/Assets/authored.txt']=strToU8('original sibling');
  const bytes=zipSync(entries),sha256=createHash('sha256').update(bytes).digest('hex'),expectedPitch=noteAt(loadInterchangeScore(bytes,new Settings()),1).realValue+1;
  const project={...blankProject(),base:{kind:'file' as const,filename:'authored.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256},edits:[
    {type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:1,text:raw}]},
    {type:'transposeSelection',selection:{kind:'notes',notes:[{target:{track:0,staff:0,bar:1,voice:0,beat:0},noteIndex:0}]},semitones:1},
    {type:'insertMeasures',beforeBar:1,count:2},{type:'removeMeasures',firstBar:1,lastBar:2},
  ] as EditCommand[]};
  const before=JSON.stringify(project),built=buildDocument(project),reopened=buildDocument(JSON.parse(before));
  for(const document of [built,reopened]){
    expect(document.embeddedBacking).toEqual(audio);expect(noteAt(document.score,1).realValue).toBe(expectedPitch);
    const output=exportGp(document.score),archive=unzipSync(output);
    expect(archive['Content/Assets/authored.txt']).toEqual(strToU8('original sibling'));
    const copy=loadInterchangeScore(output,new Settings());
    expect(copy.backingTrack?.rawAudioFile).toEqual(audio);expect(noteAt(copy,1).realValue).toBe(expectedPitch);
    expect(getTrackLyrics(copy,0)).toMatchObject({visible:false,lines:[{startBar:1,text:raw}]});
  }
  expect(JSON.stringify(project)).toBe(before);
  expect(createHash('sha256').update(Buffer.from(project.base.bytesBase64,'base64')).digest('hex')).toBe(sha256);
});
