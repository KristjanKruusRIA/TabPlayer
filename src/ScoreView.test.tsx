// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { model, rendering, Settings, type PlaybackHighlightChangeEventArgs } from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import { music, target } from './editor/fixtures';
import type { MusicSelection } from './editor/range-types';

const view=vi.hoisted(()=>({options:null as unknown,beat:null as ((beat:model.Beat)=>void)|null,note:null as ((note:model.Note)=>void)|null,destroy:vi.fn(),settings:vi.fn(),api:null as unknown}));
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
  settings={display:{scale:1,staveProfile:0}};constructor(_container:unknown,options:unknown){view.options=options;view.api=this;}
  beatMouseDown=event<model.Beat>(handler=>{view.beat=handler;});noteMouseDown=event<model.Note>(handler=>{view.note=handler;});
  beatMouseMove=event<model.Beat>();beatMouseUp=event<model.Beat|null>();postRenderFinished=event<void>();playbackRangeHighlightChanged=event<PlaybackHighlightChangeEventArgs>();
  canvasElement={};uiFacade={getOffset:()=>({x:30,y:40,w:600,h:300})};
  boundsLookup={findBeat:beatBounds,findBeats:(beat:model.Beat)=>[beatBounds(beat)],getBeatAtPos:(_x:number,_y:number)=>null as model.Beat|null};
  highlighted:[model.Beat,model.Beat]|null=null;rangeEndpoints:[model.Beat,model.Beat]|null=null;playbackRange={startTick:1920,endTick:3840};
  highlightPlaybackRange(start:model.Beat,end:model.Beat){this.rangeEndpoints=[start,end];this.highlighted=[start,end];this.playbackRangeHighlightChanged.emit(start===end?{}:{startBeat:start,endBeat:end,startBeatBounds:beatBounds(start),endBeatBounds:beatBounds(end)});}
  clearPlaybackRangeHighlight(){this.highlighted=null;this.playbackRangeHighlightChanged.emit({});}
  applyPlaybackRangeFromHighlight(){throw new Error('Editor selection must never apply a playback range.');}
  destroy=view.destroy;updateSettings=view.settings;
}}));
function event<T>(installed?:(handler:(value:T)=>void)=>void){const handlers=new Set<(value:T)=>void>();return {handlers,on:(handler:(value:T)=>void)=>{handlers.add(handler);installed?.(handler);return()=>handlers.delete(handler);},off:(handler:(value:T)=>void)=>handlers.delete(handler),emit:(value:T)=>{for(const handler of handlers)handler(value);}};}
function beatBounds(beat:model.Beat){const bounds=new rendering.BeatBounds();bounds.beat=beat;bounds.realBounds=new rendering.Bounds(beat.index*50,beat.voice.index*100,50,60);for(const [index,note] of beat.notes.entries()){const noteBounds=new rendering.NoteBounds();noteBounds.note=note;noteBounds.noteHeadBounds=new rendering.Bounds(beat.index*50+8,10+index*15,12,9);bounds.addNote(noteBounds);}return bounds;}
type FakeView={beatMouseMove:ReturnType<typeof event<model.Beat>>;beatMouseUp:ReturnType<typeof event<model.Beat|null>>;postRenderFinished:ReturnType<typeof event<void>>;playbackRangeHighlightChanged:ReturnType<typeof event<PlaybackHighlightChangeEventArgs>>;highlighted:[model.Beat,model.Beat]|null;rangeEndpoints:[model.Beat,model.Beat]|null;boundsLookup:{getBeatAtPos:(x:number,y:number)=>model.Beat|null;findBeat:(beat:model.Beat)=>rendering.BeatBounds|null;findBeats:(beat:model.Beat)=>rendering.BeatBounds[]};playbackRange:{startTick:number;endTick:number}};
function setup(initial:MusicSelection|null=null,score=music()){
  const changes:(MusicSelection|null)[]=[],onSelect=vi.fn();
  function Harness(){const [selected,setSelected]=useState(initial);return <ScoreView score={score} track={0} zoom={100} profile="ScoreTab" playback={null} onSelect={onSelect} editorSelection={selected} onEditorSelection={next=>{changes.push(next);setSelected(next);}}/>;}
  const result=render(<Harness/>),api=view.api as FakeView,notation=screen.getByLabelText('Music notation');
  const beat=(index:number)=>score.tracks[0].staves[0].bars[0].voices[0].beats[index];
  const down=(index:number,options:Record<string,unknown>={},noteIndex?:number)=>{fireEvent.mouseDown(notation,{button:0,...options});act(()=>{view.beat?.(beat(index));if(noteIndex!==undefined)view.note?.(beat(index).notes[noteIndex]);});};
  return {...result,score,changes,onSelect,api,notation,beat,down};
}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('uses public external media output and keeps viewport changes out of native plan loading',()=>{
  const score=music(),playback={attachView:vi.fn(),replaceScore:vi.fn()},onSelect=vi.fn();const props={score,track:0,zoom:100,profile:'ScoreTab',onSelect,playback:playback as never};const rendered=render(<ScoreView {...props}/>);
  expect(view.options).toMatchObject({player:{playerMode:'EnabledExternalMedia',enableCursor:true}});expect((view.options as {player:object}).player).not.toHaveProperty('soundFont');expect(playback.attachView).toHaveBeenCalledTimes(1);
  view.note?.(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]);expect(onSelect).toHaveBeenLastCalledWith(target,6,0);
  rendered.rerender(<ScoreView {...props} zoom={130}/>);expect(playback.replaceScore).toHaveBeenLastCalledWith(score,0);expect(playback.attachView).toHaveBeenCalledTimes(1);
  rendered.unmount();expect(view.destroy).toHaveBeenCalledTimes(1);
});
it('collapses a click and extends Shift selection from its original same-voice anchor',()=>{
  const {down,changes,onSelect}=setup();down(1);down(3,{shiftKey:true});
  expect(changes).toEqual([{kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:1920},lanes:[{track:0,staff:0,voice:0}]}},{kind:'range',range:{start:{bar:0,tick:960},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}}]);
  expect(onSelect).toHaveBeenLastCalledWith({...target,beat:3},undefined,undefined);
  expect(view.options).toMatchObject({player:{enableUserInteraction:false}});
});
it('prevents the browser text drag from interrupting an editor range drag',()=>{
  const {notation}=setup(),event=new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true});
  fireEvent(notation,event);expect(event.defaultPrevented).toBe(true);
});
it('focuses notation after an inspector input so music keyboard shortcuts receive the next key',()=>{
  const {notation,down}=setup(),input=document.createElement('input');document.body.append(input);
  try{input.focus();down(0);expect(document.activeElement===notation.parentElement).toBe(true);}finally{input.remove();}
});
it('toggles exactly one chord member with Ctrl/Cmd without widening through the beat event',()=>{
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],second=new model.Note();second.string=5;second.fret=2;beat.addNote(second);
  const {down,changes}=setup(null,score);down(0,{ctrlKey:true},0);down(0,{metaKey:true},1);down(0,{ctrlKey:true},0);down(0,{metaKey:true},1);
  expect(changes).toEqual([{kind:'notes',notes:[{target,noteIndex:0}]},{kind:'notes',notes:[{target,noteIndex:0},{target,noteIndex:1}]},{kind:'notes',notes:[{target,noteIndex:1}]},null]);
});
it('normalizes reverse drag and ignores movement into another voice without seeking or changing a loop',()=>{
  const {down,changes,api,beat}=setup();down(3);act(()=>api.beatMouseMove.emit(beat(1)));
  expect(changes.at(-1)).toEqual({kind:'range',range:{start:{bar:0,tick:960},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}});
  const other=new model.Voice(),otherBeat=new model.Beat();otherBeat.isEmpty=false;otherBeat.duration=4;other.addBeat(otherBeat);beat(0).voice.bar.addVoice(other);
  const count=changes.length;act(()=>api.beatMouseMove.emit(otherBeat));expect(changes).toHaveLength(count);
  act(()=>api.beatMouseUp.emit(beat(1)));act(()=>api.beatMouseMove.emit(beat(0)));expect(changes).toHaveLength(count);
  expect(api.playbackRange).toEqual({startTick:1920,endTick:3840});
});
it('triple-click selects the track and note events cannot collapse it',()=>{
  const {down,changes}=setup();down(1,{detail:3},0);
  expect(changes).toEqual([{kind:'bars',tracks:[0],firstBar:0,lastBar:3}]);
});
it('draws indexed note overlays from public bounds and refreshes them after rendering',()=>{
  const selected:MusicSelection={kind:'notes',notes:[{target,noteIndex:0}]};const {api}=setup(selected);
  const marker=screen.getByLabelText('Selected note 1');expect(marker.style.left).toBe('38px');expect(marker.style.top).toBe('50px');
  expect(api.highlighted).toBeNull();api.boundsLookup.findBeats=beat=>{const bounds=beatBounds(beat);bounds.notes![0].noteHeadBounds.x=108;return [bounds];};act(()=>api.postRenderFinished.emit());expect(screen.getByLabelText('Selected note 1').style.left).toBe('138px');
});
it('uses highlight bounds for endpoint handles and resizes through public hit-testing',()=>{
  const initial:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}};
  const {api,beat,changes}=setup(initial);expect(api.highlighted).toEqual([beat(0),beat(2)]);
  const end=screen.getByRole('button',{name:'Resize selection end'});expect(end.style.left).toBe('174px');
  api.boundsLookup.getBeatAtPos=(x,y)=>x===175&&y===30?beat(3):null;
  fireEvent.mouseDown(end,{button:0});fireEvent.mouseMove(document,{clientX:205,clientY:70});fireEvent.mouseUp(document);
  expect(changes.at(-1)).toEqual({kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}});
  expect(api.playbackRange).toEqual({startTick:1920,endTick:3840});
});
it('disposes public render/highlight/drag subscriptions on unmount',()=>{
  const {api,unmount}=setup();expect(api.postRenderFinished.handlers.size).toBe(1);unmount();expect(api.postRenderFinished.handlers.size).toBe(0);expect(api.playbackRangeHighlightChanged.handlers.size).toBe(0);expect(api.beatMouseMove.handlers.size).toBe(0);
});
it('keeps both resize handles on one voice when the selection spans several lanes',()=>{
  const score=music(),staff=score.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice();for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;voice.addBeat(beat);}bar.addVoice(voice);}score.finish(new Settings());
  const selected:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]}};
  const {api,beat,changes}=setup(selected,score);expect(api.highlighted?.map(item=>item.voice.index)).toEqual([0,0]);
  api.boundsLookup.getBeatAtPos=()=>beat(1);fireEvent.mouseDown(screen.getByRole('button',{name:'Resize selection start'}),{button:0});fireEvent.mouseMove(document,{clientX:80,clientY:70});fireEvent.mouseUp(document);
  expect(changes.at(-1)).toEqual({kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]}});
});
it('extends an existing programmatic range when Shift is the first view interaction',()=>{
  const initial:MusicSelection={kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}};
  const {down,changes}=setup(initial);down(3,{shiftKey:true});expect(changes.at(-1)).toEqual({kind:'range',range:{start:{bar:0,tick:960},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}});
});
it('uses fresh model/callback props and ignores delayed hits from a replaced score',()=>{
  const old=music(),next=music(),first=vi.fn(),second=vi.fn(),onSelect=vi.fn(),props={score:old,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect};const rendered=render(<ScoreView {...props} onEditorSelection={first}/>);
  rendered.rerender(<ScoreView {...props} score={next} onEditorSelection={second}/>);const notation=screen.getByLabelText('Music notation');fireEvent.mouseDown(notation,{button:0});
  act(()=>view.beat?.(old.tracks[0].staves[0].bars[0].voices[0].beats[0]));expect(second).not.toHaveBeenCalled();expect(onSelect).not.toHaveBeenCalled();
  act(()=>view.beat?.(next.tracks[0].staves[0].bars[0].voices[0].beats[1]));expect(first).not.toHaveBeenCalled();expect(second).toHaveBeenCalledWith({kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:1920},lanes:[{track:0,staff:0,voice:0}]}});
});
it('resets persistent public highlight endpoints and waits for current render bounds after source replacement',()=>{
  const old=music(),next=music(),selected:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}},props={track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editorSelection:selected};
  const rendered=render(<ScoreView {...props} score={old}/>),api=view.api as FakeView;
  expect(api.rangeEndpoints?.[0]).not.toBe(api.rangeEndpoints?.[1]);
  api.boundsLookup.findBeat=()=>null;
  rendered.rerender(<ScoreView {...props} score={next}/>);
  expect(api.rangeEndpoints?.[0]).toBe(api.rangeEndpoints?.[1]);expect(api.highlighted).toBeNull();
  api.boundsLookup.findBeat=beatBounds;act(()=>api.postRenderFinished.emit());
  expect(api.rangeEndpoints).toEqual([next.tracks[0].staves[0].bars[0].voices[0].beats[0],next.tracks[0].staves[0].bars[0].voices[0].beats[2]]);
  rendered.rerender(<ScoreView {...props} score={next} editorSelection={null}/>);
  expect(api.rangeEndpoints?.[0]).toBe(api.rangeEndpoints?.[1]);expect(api.playbackRange).toEqual({startTick:1920,endTick:3840});
});
