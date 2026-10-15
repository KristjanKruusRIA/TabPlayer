import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { blankProject } from '../project';
import { buildScore } from '../engine';
import { getLyricsSource,setLyricsSource } from './lyrics-source';
import { mapLyricsMeasures } from './lyrics-measures';

const raw='[VERSE]\r\nHel-lo  world+today';
const score=()=>buildScore({...blankProject(),edits:[{type:'addPitchedTrack',name:'Voice',program:0}]});
it.each([true,false])('maps exact raw verse slots on insert for visible=%s',visible=>{
  const value=score();setLyricsSource(value.tracks[0],{visible,lines:[{startBar:0,text:''},{startBar:2,text:raw},{startBar:6,text:'future'}]},true);
  const before=model.JsonConverter.scoreToJson(value);
  mapLyricsMeasures(value,{oldToNew:[0,3,4,5],inserted:[1,2]});
  expect(getLyricsSource(value.tracks[0])).toEqual({managed:true,value:{visible,lines:[{startBar:0,text:''},{startBar:4,text:raw},{startBar:8,text:'future'}]}});
  expect(model.JsonConverter.scoreToJson(value)).toBe(before);expect(getLyricsSource(value.tracks[1])).toBeUndefined();
});
it('moves removed starts to a retained successor and tail starts to the new final bar',()=>{
  const value=score();setLyricsSource(value.tracks[0],{visible:true,lines:[0,1,2,3].map(startBar=>({startBar,text:raw}))},true);
  mapLyricsMeasures(value,{oldToNew:[0,null,null,1],inserted:[]});
  expect(getLyricsSource(value.tracks[0])?.value.lines.map(line=>line.startBar)).toEqual([0,1,1,1]);
  const tail=score();setLyricsSource(tail.tracks[0],{visible:false,lines:[{startBar:3,text:raw}]},false);
  mapLyricsMeasures(tail,{oldToNew:[0,1,null,null],inserted:[]});
  expect(getLyricsSource(tail.tracks[0])).toEqual({managed:false,value:{visible:false,lines:[{startBar:1,text:raw}]}});
});
it('leaves unmanaged distributed syllables unchanged while moving their raw source start',()=>{
  const value=score(),beat=value.tracks[0].staves[0].bars[2].voices[0].beats[0];beat.lyrics=['original'];
  setLyricsSource(value.tracks[0],{visible:true,lines:[{startBar:2,text:raw}]},false);
  mapLyricsMeasures(value,{oldToNew:[0,null,1,2],inserted:[]});
  expect(beat.lyrics).toEqual(['original']);expect(getLyricsSource(value.tracks[0])).toEqual({managed:false,value:{visible:true,lines:[{startBar:1,text:raw}]}});
});
it('rejects an overflowing imported start on the last track before changing earlier raw sources',()=>{
  const value=score();setLyricsSource(value.tracks[0],{visible:true,lines:[{startBar:1,text:raw}]},true);
  setLyricsSource(value.tracks[1],{visible:false,lines:[{startBar:0xffffffff,text:'future'}]},false);
  const before=value.tracks.map(getLyricsSource);
  expect(()=>mapLyricsMeasures(value,{oldToNew:[0,3,4,5],inserted:[1,2]})).toThrow(/overflow|range|start/i);
  expect(value.tracks.map(getLyricsSource)).toEqual(before);
});
