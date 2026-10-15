import { expect,it } from 'vitest';
import { blankProject,type EditCommand } from '../project';
import { buildScore,previewEdit } from '../engine';
import { getTrackLyrics } from './lyrics';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
it('replays exact piano chord-member transposition with one history entry and undo redo',()=>{
  const edits:EditCommand[]=[{type:'addPitchedTrack',name:'Piano',program:0},
    {type:'addPitchedNote',target:{...target,track:1},pitch:60},{type:'addPitchedNote',target:{...target,track:1},pitch:64},
    {type:'setNoteTechniquesByIndex',target:{...target,track:1},noteIndex:0,patch:{dynamics:3}}];
  const source={...blankProject(),edits},before=JSON.stringify(source);
  const next=previewEdit(source,{type:'transposeSelection',selection:{kind:'notes',notes:[{target:{...target,track:1},noteIndex:0}]},semitones:1});
  const notes=(score:ReturnType<typeof buildScore>)=>score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes;
  expect(next.project.edits).toHaveLength(edits.length+1);expect(notes(next.score).map(n=>[n.realValue,n.dynamics])).toEqual([[61,3],[64,5]]);
  expect(notes(buildScore({...next.project,edits:next.project.edits.slice(0,-1)})).map(n=>n.realValue)).toEqual([60,64]);
  expect(notes(buildScore(JSON.parse(JSON.stringify(next.project)))).map(n=>n.realValue)).toEqual([61,64]);expect(JSON.stringify(source)).toBe(before);
});
it('erases only named notes while retaining exact managed raw lyrics after rebuild and later edits',()=>{
  const raw='[VERSE]\r\nHel-lo  world+today';
  const edits:EditCommand[]=[...Array.from({length:4},(_,beat)=>({type:'setNote' as const,target:{...target,beat},string:1,fret:beat})),
    {type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:raw}]},
    {type:'eraseSelection',selection:{kind:'notes',notes:[{target,noteIndex:0}]}},{type:'appendMeasure'}];
  const score=buildScore({...blankProject(),edits}),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
  expect(beats[0].isRest).toBe(true);expect(beats[0].lyrics).toBeNull();expect(beats[1].lyrics).toEqual(['Hel-']);
  expect(getTrackLyrics(score,0)).toEqual({visible:true,lines:[{startBar:0,text:raw}],source:'raw'});
});
