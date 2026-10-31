import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { createHash } from 'node:crypto';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { buildDocument,exportGp,previewEdit,replayDocumentSettings,trackIdentity } from '../engine';
import { blankProject,type EditCommand } from '../project';
import { makeMusicClip } from './clipboard-source';
import { getTrackLyrics } from './lyrics';
import { loadInterchangeScore } from '../interchange/gp';
import { music,noteAt } from './fixtures';
import type { PasteOptions } from './clipboard-types';
import { exportMidi } from '../export/midi';

const target={track:0,staff:0,bar:1,voice:0,beat:0},raw='[VERSE]\r\nHel-lo  world+today',assetId='a'.repeat(64);
const options:PasteOptions={target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:2,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}};
function clip(){const source=music();noteAt(source).dynamics=3;return makeMusicClip(source,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');}
it('replays self-contained repeated paste with exact raw lyric/backing maps, settings fallback and undo redo',()=>{
  const project={...blankProject(),assets:{[assetId]:{filename:'authored.wav',mediaType:'audio/wav',byteLength:96044}},edits:[
    {type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:1,text:raw}]},
    {type:'setBacking',backing:{assetId,offsetMs:10,anchors:[{bar:3,occurrence:0,ratio:0,audioMs:5000}],mix:{gain:.5,pan:0,mute:false,solo:false}}},
  ] as EditCommand[]},before=JSON.stringify(project);
  const pasted=previewEdit(project,{type:'pasteMusic',clip:clip(),options});
  expect(pasted.project.edits).toHaveLength(3);expect(pasted.score.masterBars).toHaveLength(6);expect(pasted.settings.backing?.anchors[0].bar).toBe(5);
  expect(getTrackLyrics(pasted.score,0)).toMatchObject({visible:false,lines:[{startBar:3,text:raw}]});expect(noteAt(pasted.score,1).dynamics).toBe(3);expect(noteAt(pasted.score,2).dynamics).toBe(3);
  expect(trackIdentity(pasted.score.tracks[0])).toBe('base/0');expect(pasted.sourceBarCount).toBe(4);
  const midi=(score:model.Score)=>exportMidi(score,{tracks:[0],range:null});
  const reopened=buildDocument(JSON.parse(JSON.stringify(pasted.project)));expect(midi(reopened.score)).toEqual(midi(pasted.score));
  expect(getTrackLyrics(reopened.score,0)).toMatchObject({visible:false,lines:[{startBar:3,text:raw}]});
  const changed={...pasted.project,edits:[...pasted.project.edits,{type:'setTrackMix' as const,trackId:'base/0',mix:{gain:.7,pan:0,mute:false,solo:false}}]};
  const full=buildDocument(changed),replayed=replayDocumentSettings(changed,pasted);expect(replayed.settings).toEqual(full.settings);expect(midi(replayed.score)).toEqual(midi(full.score));
  expect(replayed.score===pasted.score).toBe(true);expect(replayDocumentSettings(pasted.project,replayed).score===pasted.score).toBe(true);
  expect(buildDocument(project).score.masterBars).toHaveLength(4);expect(buildDocument(pasted.project).score.masterBars).toHaveLength(6);expect(JSON.stringify(project)).toBe(before);
});
it('preserves destination GP archives and embedded backing without retaining clipboard source provenance',()=>{
  const authored=music(),audio=new Uint8Array([82,73,70,70,1,2,3,4]);authored.backingTrack=new model.BackingTrack();authored.backingTrack.rawAudioFile=audio;
  const archive=unzipSync(exportGp(authored));archive['Content/Assets/destination.txt']=strToU8('destination sibling');
  const bytes=zipSync(archive),sha256=createHash('sha256').update(bytes).digest('hex'),project={...blankProject(),base:{kind:'file' as const,filename:'destination.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256}};
  const before=JSON.stringify(project),pasted=previewEdit(project,{type:'pasteMusic',clip:clip(),options});
  const output=exportGp(buildDocument(JSON.parse(JSON.stringify(pasted.project))).score);
  expect(unzipSync(output)['Content/Assets/destination.txt']).toEqual(strToU8('destination sibling'));
  expect(loadInterchangeScore(output,new Settings()).backingTrack?.rawAudioFile).toEqual(audio);expect(pasted.embeddedBacking).toEqual(audio);
  expect(JSON.stringify(project)).toBe(before);expect(createHash('sha256').update(Buffer.from(project.base.bytesBase64,'base64')).digest('hex')).toBe(sha256);
});
it('rejects invalid final mapping without changing the source project or existing built score',()=>{
  const project=blankProject(),built=buildDocument(project),before=exportGp(built.score);
  expect(()=>previewEdit(project,{type:'pasteMusic',clip:clip(),options:{...options,destinations:[{sourceTrack:0,track:99,staffMap:[0]}]}},built)).toThrow();
  expect(project.edits).toEqual([]);expect(exportGp(built.score)).toEqual(before);
});
