import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { buildDocument,previewEdit,replayDocumentSettings,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { scoreFromJson } from '../model-clone';
import { makeMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { music } from './fixtures';
import { rhythmTicks } from './common';
import type { ClipboardCommand,MusicClip,PasteDestination,PasteFilters } from './clipboard-types';

const filters:PasteFilters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:true,sections:true};
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
function twoTracks() {
  const score=music(),bass=scoreFromJson(json(music()),new Settings()).tracks[0];bass.name='Bass';bass.playbackInfo.program=33;
  const staff=bass.staves[0];staff.stringTuning.tunings=[43,38,33,28];staff.capo=2;
  for(const bar of staff.bars)for(const beat of bar.voices[0].beats)for(const note of beat.notes){note.string=2;note.fret=5;}
  score.addTrack(bass);score.finish(new Settings());return score;
}
function command(clip:MusicClip,destinations:PasteDestination[]):ClipboardCommand {
  return {type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar:1,voice:0,beat:0},destinations,count:1,placement:'beforeBar',filters:{...filters,masterAutomations:clip.mode==='multiTrack',sections:clip.mode==='multiTrack'}}};
}
const multiClip=()=>makeMusicClip(twoTracks(),{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0},'multiTrack');

it('multitrack bar paste appends a missing destination track with the copied instrument context',()=>{
  const destination=music(),before=json(destination),result=preparePasteMusic(destination,command(multiClip(),[{sourceTrack:0,track:0,staffMap:[0]},{sourceTrack:1,track:1,staffMap:[0]}]));
  expect(result.addedTracks).toBe(1);expect(json(destination)).toBe(before);
  const score=result.score,created=score.tracks[1],staff=created.staves[0];
  expect(score.tracks).toHaveLength(2);expect(created.name).toBe('Bass');expect(created.playbackInfo.program).toBe(33);
  expect(staff.stringTuning.tunings).toEqual([43,38,33,28]);expect(staff.capo).toBe(2);
  expect(staff.bars).toHaveLength(score.masterBars.length);expect(score.tracks[0].staves[0].bars).toHaveLength(score.masterBars.length);
  const existing=[score.tracks[0].playbackInfo.primaryChannel,score.tracks[0].playbackInfo.secondaryChannel],added=[created.playbackInfo.primaryChannel,created.playbackInfo.secondaryChannel];
  expect(added.some(channel=>existing.includes(channel)||channel===9)).toBe(false);expect(new Set(added).size).toBe(2);
  expect(staff.bars[1].voices[0].beats.flatMap(beat=>beat.notes).map(note=>[note.string,note.fret])).toEqual(Array(4).fill([2,5]));
  for(const index of [0,2,3,4]){const capacity=score.masterBars[index].calculateDuration(false),beats=staff.bars[index].voices[0].beats;
    expect(beats.every(beat=>beat.isRest)).toBe(true);expect(beats.reduce((sum,beat)=>sum+rhythmTicks(beat,capacity),0)).toBe(capacity);}
  const ids=score.tracks.flatMap(track=>track.staves.flatMap(item=>item.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.map(beat=>beat.id)))));
  expect(new Set(ids).size).toBe(ids.length);
});

it('rejects created tracks that skip an index, reorder staves or come from single-track or phrase clips without mutation',()=>{
  const destination=music(),before=json(destination),clip=multiClip();
  expect(()=>preparePasteMusic(destination,command(clip,[{sourceTrack:0,track:0,staffMap:[0]},{sourceTrack:1,track:2,staffMap:[0]}]))).toThrow(/directly follow/);
  const piano=music(),extra=scoreFromJson(json(music()),new Settings()).tracks[0];extra.addStaff(scoreFromJson(json(music()),new Settings()).tracks[0].staves[0]);piano.addTrack(extra);piano.finish(new Settings());
  const twoStaves=makeMusicClip(piano,{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0},'multiTrack');
  expect(()=>preparePasteMusic(destination,command(twoStaves,[{sourceTrack:0,track:0,staffMap:[0]},{sourceTrack:1,track:1,staffMap:[1,0]}]))).toThrow(/staff order/);
  const single=makeMusicClip(music(),{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
  expect(()=>preparePasteMusic(destination,command(single,[{sourceTrack:0,track:1,staffMap:[0]}]))).toThrow(/multitrack bar paste/);
  expect(json(destination)).toBe(before);
});

it('created tracks get their own identities and replay identically after reopening',()=>{
  const pasted=previewEdit(blankProject(),command(multiClip(),[{sourceTrack:0,track:0,staffMap:[0]},{sourceTrack:1,track:1,staffMap:[0]}]));
  expect(pasted.score.tracks).toHaveLength(2);expect(trackIdentity(pasted.score.tracks[0])).toBe('base/0');expect(trackIdentity(pasted.score.tracks[1])).toBe('added/0/paste/0');
  const stable=(score:model.Score)=>json(score).replace(/"id":\d+/g,'"id":0');
  const reopened=buildDocument(JSON.parse(JSON.stringify(pasted.project)));expect(stable(reopened.score)).toBe(stable(pasted.score));expect(trackIdentity(reopened.score.tracks[1])).toBe('added/0/paste/0');
  const changed={...pasted.project,edits:[...pasted.project.edits,{type:'setTrackMix' as const,trackId:'added/0/paste/0',mix:{gain:.4,pan:0,mute:false,solo:false}}]};
  const full=buildDocument(changed);expect(full.settings.mixes['added/0/paste/0'].gain).toBe(.4);expect(full.settings.mixes['base/0'].gain).not.toBe(.4);
  expect(replayDocumentSettings(changed,pasted).settings).toEqual(full.settings);
});
