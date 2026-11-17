// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { model, rendering, Settings, type PlaybackHighlightChangeEventArgs } from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import type { MusicSelection } from './editor/range-types';
import { kitScore } from './engraving/drum-tab-fixtures';
import { defaultEngraving,projectEngraving } from './engraving/projection';
import type { TrackProfile } from './engraving/types';

/**
 * Score-error shading on a drum track drawn as standard notation and tab covers both staves of the pair, whichever was clicked last. alphaTab's bounds are faked: the tab staff's boxes are 200 px below the percussion staff's.
 */
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>{throw new Error('Edit target feedback must not invoke native IPC.');})}));
const view=vi.hoisted(()=>({options:null as unknown,beat:null as ((beat:model.Beat)=>void)|null,note:null as ((note:model.Note)=>void)|null,destroy:vi.fn(),settings:vi.fn(),api:null as unknown}));
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
  settings=new Settings();constructor(_container:unknown,options:unknown){view.options=options;view.api=this;}
  beatMouseDown=event<model.Beat>(handler=>{view.beat=handler;});noteMouseDown=event<model.Note>(handler=>{view.note=handler;});
  beatMouseMove=event<model.Beat>();beatMouseUp=event<model.Beat|null>();renderStarted=event<boolean>();postRenderFinished=event<void>();playbackRangeHighlightChanged=event<PlaybackHighlightChangeEventArgs>();
  canvasElement={};uiFacade={getOffset:()=>({x:30,y:40,w:600,h:300}),highlightElements(){},removeHighlights(){}};
  renderer={width:0,partialRenderFinished:event<never>(),partialLayoutFinished:event<never>(),renderResult(_id:string){}};renderScore(){}render(){}
  boundsLookup={findBeat:beatBounds,findBeats:(beat:model.Beat)=>[beatBounds(beat)],findMasterBarByIndex:(_index:number)=>null as rendering.MasterBarBounds|null,getBeatAtPos:(_x:number,_y:number)=>null as model.Beat|null};
  highlighted:[model.Beat,model.Beat]|null=null;rangeEndpoints:[model.Beat,model.Beat]|null=null;playbackRange={startTick:1920,endTick:3840};
  highlightPlaybackRange(start:model.Beat,end:model.Beat){this.rangeEndpoints=[start,end];this.highlighted=[start,end];this.playbackRangeHighlightChanged.emit(start===end?{}:{startBeat:start,endBeat:end,startBeatBounds:beatBounds(start),endBeatBounds:beatBounds(end)});}
  clearPlaybackRangeHighlight(){this.highlighted=null;this.playbackRangeHighlightChanged.emit({});}
  applyPlaybackRangeFromHighlight(){throw new Error('Editor selection must never apply a playback range.');}
  destroy=view.destroy;updateSettings=view.settings;
}}));
function event<T>(installed?:(handler:(value:T)=>void)=>void){const handlers=new Set<(value:T)=>void>();return {handlers,on:(handler:(value:T)=>void)=>{handlers.add(handler);installed?.(handler);return()=>handlers.delete(handler);},off:(handler:(value:T)=>void)=>handlers.delete(handler),emit:(value:T)=>{for(const handler of handlers)handler(value);}};}
/** The tab staff of a drum track is the one that is not percussion; its boxes are drawn 200 px lower than the other staves'. */
const DROP=200;
const system=new rendering.StaffSystemBounds(),master=new rendering.MasterBarBounds();master.staffSystemBounds=system;
function beatBounds(beat:model.Beat){
  const lower=beat.voice.bar.staff.track.index===1&&!beat.voice.bar.staff.isPercussion?DROP:0;
  const bounds=new rendering.BeatBounds();bounds.beat=beat;bounds.realBounds=new rendering.Bounds(beat.index*50,lower+beat.voice.index*100,50,60);
  const bar=new rendering.BarBounds();bar.realBounds=new rendering.Bounds(0,lower,200,60);bar.masterBarBounds=master;bounds.barBounds=bar;
  for(const [index,note] of beat.notes.entries()){const noteBounds=new rendering.NoteBounds();noteBounds.note=note;noteBounds.noteHeadBounds=new rendering.Bounds(beat.index*50+8,lower+10+index*15,12,9);bounds.addNote(noteBounds);}
  return bounds;
}
afterEach(()=>{cleanup();vi.clearAllMocks();});

const error={track:1,staff:0,bar:0,voice:0,beat:0,kind:'incomplete' as const,ticks:960,place:'Drums'};
function shaded(profile:TrackProfile) {
  const {score,ids}=kitScore(),engraving={...defaultEngraving(),profiles:[{trackId:ids[1],profile}]},projection=projectEngraving(score,ids,engraving);
  const props={score,track:1,zoom:100,profile:'Default',projection,engraving,visibleTracks:[0,1],playback:null,onSelect:vi.fn(),errors:[error]};
  const result=render(<ScoreView {...props as React.ComponentProps<typeof ScoreView>}/>);
  return {projection,...result};
}
const block=()=>{const element=screen.getByRole('img',{name:/Score error/});return {top:Number(element.style.top.replace('px','')),height:Number(element.style.height.replace('px',''))};};

it('standard + tab: the error is shaded across both staves of the drum pair, before and after the tab staff was clicked',()=>{
  const {projection}=shaded('standardTab');
  // The pair is 60 px high each, the tab staff 200 px lower: one block from the top of the first to the bottom of the second.
  expect(block().height).toBe(DROP+60);
  const tab=projection.score.tracks[1].staves[1].bars[0].voices[0].beats[0];
  act(()=>view.beat?.(tab));
  expect(block().height).toBe(DROP+60);
});
it('tab only: the error is shaded over the one staff drawn',()=>{
  shaded('tablature');
  expect(block().height).toBe(60);
});
