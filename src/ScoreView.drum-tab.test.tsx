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
 * THE-220: a drum track drawn as tablature. The source note is what a click selects and what the marker and the caret follow; in 'both' mode it is drawn twice,
 * and they sit on the staff the user last clicked. alphaTab's bounds are faked: the tab staff's boxes are 200 px below the percussion staff's.
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
function beatBounds(beat:model.Beat){
  const lower=beat.voice.bar.staff.track.index===1&&!beat.voice.bar.staff.isPercussion?DROP:0;
  const bounds=new rendering.BeatBounds();bounds.beat=beat;bounds.realBounds=new rendering.Bounds(beat.index*50,lower+beat.voice.index*100,50,60);
  for(const [index,note] of beat.notes.entries()){const noteBounds=new rendering.NoteBounds();noteBounds.note=note;noteBounds.noteHeadBounds=new rendering.Bounds(beat.index*50+8,lower+10+index*15,12,9);bounds.addNote(noteBounds);}
  return bounds;
}
afterEach(()=>{cleanup();vi.clearAllMocks();});

const drumTarget=(beat:number,bar=0)=>({track:1,staff:0,bar,voice:0,beat});
function setup(profile:TrackProfile,extra:Partial<React.ComponentProps<typeof ScoreView>>={}) {
  const {score,ids}=kitScore(),engraving={...defaultEngraving(),profiles:[{trackId:ids[1],profile}]},projection=projectEngraving(score,ids,engraving);
  const onSelect=vi.fn(),props={score,track:1,zoom:100,profile:'Default',projection,engraving,visibleTracks:[0,1],playback:null,onSelect,...extra};
  const result=render(<ScoreView {...props as React.ComponentProps<typeof ScoreView>}/>);
  const beats=(index:number)=>projection.score.tracks[1].staves[index].bars[0].voices[0].beats;
  return {score,projection,onSelect,props,beats,...result};
}
const top=()=>Number(screen.getByLabelText('Edit target').style.top.replace('px',''));

it('tab only: clicking a tab note or beat selects the source drum note, by its place in the source beat',()=>{
  const {score,onSelect,beats,projection}=setup('tablature');
  // The third beat holds a kick, a hi-hat and a crash: tab notes are drawn in line order, the source keeps its own order.
  const drawn=beats(0)[2].notes.find(note=>note.fret===49)!;
  act(()=>{view.beat?.(beats(0)[2]);view.note?.(drawn);});
  const crash=score.tracks[1].staves[0].bars[0].voices[0].beats[2].notes.find(note=>note.percussionArticulation===49)!;
  expect(onSelect).toHaveBeenLastCalledWith(drumTarget(2),crash.string,crash.index);
  expect(crash.index).toBe(2);expect(projection.renderedNotes!.get(drawn)).toBe(crash);
  act(()=>view.beat?.(beats(0)[3]));
  expect(onSelect).toHaveBeenLastCalledWith(drumTarget(3),undefined,undefined);
});

it('both staves: clicking either drawing of a note selects the same source note',()=>{
  const {score,onSelect,projection}=setup('standardTab'),beat=score.tracks[1].staves[0].bars[0].voices[0].beats[1],snare=beat.notes.find(note=>note.percussionArticulation===38)!;
  const pair=projection.notes.get(snare.id)!;
  act(()=>view.note?.(pair.rendered));const percussionCall=onSelect.mock.lastCall;
  act(()=>view.note?.(pair.tab!));
  expect(onSelect.mock.lastCall).toEqual(percussionCall);expect(percussionCall).toEqual([drumTarget(1),snare.string,snare.index]);
  // A beat press on the tab staff is the beat of the source too.
  act(()=>view.beat?.(projection.beats.get(beat.id)!.tab!));expect(onSelect.mock.lastCall![0]).toEqual(drumTarget(1));
});

it('both staves: the edit target sits on the percussion staff until the tab is clicked, stays there for keyboard moves, and goes back on a click of the percussion staff',async()=>{
  const {score,props,projection,rerender}=setup('standardTab',{editTarget:drumTarget(1),editNoteIndex:0});
  const snare=score.tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0],pair=projection.notes.get(snare.id)!;
  const onPercussion=top();
  // The tab lists its notes by line (hi-hat above snare), so the snare is the tab beat's second box: 15 px further down.
  const second=15;
  await act(async()=>{view.note?.(pair.tab!);});
  expect(top()).toBe(onPercussion+DROP+second);
  // The caret keeps to the tab across a move to the next beat and back to the first note.
  rerender(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} editTarget={drumTarget(2)} editNoteIndex={1}/>);
  expect(top()).toBeGreaterThanOrEqual(onPercussion+DROP);
  rerender(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} editTarget={drumTarget(1)} editNoteIndex={0}/>);
  expect(top()).toBe(onPercussion+DROP+second);
  await act(async()=>{view.note?.(pair.rendered);});
  expect(top()).toBe(onPercussion);
});

it('tab only: the edit target and the selected notes are drawn on the tab, and a note the tab left off falls back to its beat',()=>{
  const crowded=kitScore({crowded:true}),engraving={...defaultEngraving(),profiles:[{trackId:crowded.ids[1],profile:'tablature' as TrackProfile}]},projection=projectEngraving(crowded.score,crowded.ids,engraving);
  const crowd=crowded.score.tracks[1].staves[0].bars[1].voices[0].beats[2],left=crowd.notes.find(note=>!projection.notes.has(note.id))!,kept=crowd.notes.find(note=>projection.notes.has(note.id))!;
  const props={score:crowded.score,track:1,zoom:100,profile:'Default',projection,engraving,visibleTracks:[0,1],playback:null,onSelect:vi.fn()};
  const target={track:1,staff:0,bar:1,voice:0,beat:2};
  const rendered=render(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} editTarget={target} editNoteIndex={kept.index}/>);
  // A kept note is boxed on its own head (a 12x9 box plus the caret's margin) and the caret says it is on a note.
  expect(screen.getByLabelText('Edit target').style.width).toBe('18px');
  rendered.rerender(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} editTarget={target} editNoteIndex={left.index}/>);
  // The left-off note has no head on the tab, so the whole beat is boxed instead (50 px wide).
  expect(screen.getByLabelText('Edit target').style.width).toBe('56px');
  const selection:MusicSelection={kind:'notes',notes:[{target,noteIndex:kept.index}]};
  rendered.rerender(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} editTarget={target} editNoteIndex={kept.index} editorSelection={selection}/>);
  expect(screen.getAllByRole('img').length).toBeGreaterThan(0);
});

it('tab only: a range of beats is highlighted on the tab staff',()=>{
  const {score,projection}=setup('tablature',{editorSelection:{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:1,staff:0,voice:0}]}}});
  const api=view.api as {highlighted:[model.Beat,model.Beat]|null},beats=projection.score.tracks[1].staves[0].bars[0].voices[0].beats;
  expect(api.highlighted?.[0]).toBe(beats[0]);expect(api.highlighted?.[1]).toBe(beats[2]);
  expect(projection.renderedBeats!.get(beats[0])).toBe(score.tracks[1].staves[0].bars[0].voices[0].beats[0]);
});

it('both staves: the staff the user clicked is forgotten when another document opens, and follows the track, not its place in the list',async()=>{
  const {score,props,projection,rerender}=setup('standardTab',{editTarget:drumTarget(1),editNoteIndex:0,trackIds:['base/0','base/1'],documentEpoch:1});
  const snare=score.tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0],pair=projection.notes.get(snare.id)!;
  const onPercussion=top();
  await act(async()=>{view.note?.(pair.tab!);});
  expect(top()).toBeGreaterThan(onPercussion+DROP-1);
  // The same score again, as another document's track of the same index: nothing was clicked there.
  await act(async()=>{rerender(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} documentEpoch={2}/>);});
  expect(top()).toBe(onPercussion);
  // Within one document the track that was clicked keeps its tab when its place changes; another track at that place does not inherit it.
  await act(async()=>{view.note?.(pair.tab!);});
  expect(top()).toBeGreaterThan(onPercussion+DROP-1);
  await act(async()=>{rerender(<ScoreView {...props as React.ComponentProps<typeof ScoreView>} documentEpoch={2} trackIds={['base/0','removed-and-replaced']}/>);});
  expect(top()).toBe(onPercussion);
});
