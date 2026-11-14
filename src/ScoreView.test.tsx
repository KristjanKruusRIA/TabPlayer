// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { model, rendering, Settings, type PlaybackHighlightChangeEventArgs } from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import { music, target } from './editor/fixtures';
import type { MusicSelection } from './editor/range-types';
import {defaultEngraving,projectEngraving} from './engraving/projection';
import { setLanguagePreference } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { newMark,setScaleDiagram } from './harmony/scale-diagram';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>{throw new Error('Edit target feedback must not invoke native IPC.');})}));

const view=vi.hoisted(()=>({options:null as unknown,beat:null as ((beat:model.Beat)=>void)|null,note:null as ((note:model.Note)=>void)|null,destroy:vi.fn(),settings:vi.fn(),api:null as unknown}));
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
  settings=new Settings();constructor(_container:unknown,options:unknown){view.options=options;view.api=this;}
  beatMouseDown=event<model.Beat>(handler=>{view.beat=handler;});noteMouseDown=event<model.Note>(handler=>{view.note=handler;});
  beatMouseMove=event<model.Beat>();beatMouseUp=event<model.Beat|null>();renderStarted=event<boolean>();postRenderFinished=event<void>();playbackRangeHighlightChanged=event<PlaybackHighlightChangeEventArgs>();
  canvasElement={};uiFacade={getOffset:()=>({x:30,y:40,w:600,h:300}),highlightElements(){},removeHighlights(){}};
  renderer={width:0,partialRenderFinished:event<never>()};renderScore(){}render(){}
  boundsLookup={findBeat:beatBounds,findBeats:(beat:model.Beat)=>[beatBounds(beat)],findMasterBarByIndex:(_index:number)=>null as rendering.MasterBarBounds|null,getBeatAtPos:(_x:number,_y:number)=>null as model.Beat|null};
  highlighted:[model.Beat,model.Beat]|null=null;rangeEndpoints:[model.Beat,model.Beat]|null=null;playbackRange={startTick:1920,endTick:3840};
  highlightPlaybackRange(start:model.Beat,end:model.Beat){this.rangeEndpoints=[start,end];this.highlighted=[start,end];this.playbackRangeHighlightChanged.emit(start===end?{}:{startBeat:start,endBeat:end,startBeatBounds:beatBounds(start),endBeatBounds:beatBounds(end)});}
  clearPlaybackRangeHighlight(){this.highlighted=null;this.playbackRangeHighlightChanged.emit({});}
  applyPlaybackRangeFromHighlight(){throw new Error('Editor selection must never apply a playback range.');}
  destroy=view.destroy;updateSettings=view.settings;
}}));
function event<T>(installed?:(handler:(value:T)=>void)=>void){const handlers=new Set<(value:T)=>void>();return {handlers,on:(handler:(value:T)=>void)=>{handlers.add(handler);installed?.(handler);return()=>handlers.delete(handler);},off:(handler:(value:T)=>void)=>handlers.delete(handler),emit:(value:T)=>{for(const handler of handlers)handler(value);}};}
function beatBounds(beat:model.Beat){const bounds=new rendering.BeatBounds();bounds.beat=beat;bounds.realBounds=new rendering.Bounds(beat.index*50,beat.voice.index*100,50,60);for(const [index,note] of beat.notes.entries()){const noteBounds=new rendering.NoteBounds();noteBounds.note=note;noteBounds.noteHeadBounds=new rendering.Bounds(beat.index*50+8,10+index*15,12,9);bounds.addNote(noteBounds);}return bounds;}
type FakeView={beatMouseMove:ReturnType<typeof event<model.Beat>>;beatMouseUp:ReturnType<typeof event<model.Beat|null>>;renderStarted:ReturnType<typeof event<boolean>>;postRenderFinished:ReturnType<typeof event<void>>;playbackRangeHighlightChanged:ReturnType<typeof event<PlaybackHighlightChangeEventArgs>>;highlighted:[model.Beat,model.Beat]|null;rangeEndpoints:[model.Beat,model.Beat]|null;boundsLookup:{getBeatAtPos:(x:number,y:number)=>model.Beat|null;findBeat:(beat:model.Beat)=>rendering.BeatBounds|null;findBeats:(beat:model.Beat)=>rendering.BeatBounds[]};playbackRange:{startTick:number;endTick:number}};
function setup(initial:MusicSelection|null=null,score=music()){
  const changes:(MusicSelection|null)[]=[],onSelect=vi.fn();
  function Harness(){const [selected,setSelected]=useState(initial);return <ScoreView score={score} track={0} zoom={100} profile="ScoreTab" playback={null} onSelect={onSelect} editorSelection={selected} onEditorSelection={next=>{changes.push(next);setSelected(next);}}/>;}
  const result=render(<Harness/>),api=view.api as FakeView,notation=screen.getByLabelText('Music notation');
  const beat=(index:number)=>score.tracks[0].staves[0].bars[0].voices[0].beats[index];
  const down=(index:number,options:Record<string,unknown>={},noteIndex?:number)=>{fireEvent.mouseDown(notation,{button:0,...options});act(()=>{view.beat?.(beat(index));if(noteIndex!==undefined)view.note?.(beat(index).notes[noteIndex]);});};
  return {...result,score,changes,onSelect,api,notation,beat,down};
}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('moves the edit target across beats independently of selection and playback',()=>{
  const score=music(),playback={attachView:vi.fn(),setRenderedScore:vi.fn(),replaceScore:vi.fn(),seek:vi.fn()},onSelect=vi.fn(),onEditorSelection=vi.fn();
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:playback as never,onSelect,onEditorSelection,editTarget:target,editString:6};
  const rendered=render(<ScoreView {...props}/>),api=view.api as FakeView;
  expect(screen.getByLabelText('Edit target').style.left).toBe('35px');
  expect(screen.getByRole('status').textContent).toMatch(/Guitar.*measure 1.*beat 1.*string 6/i);
  rendered.rerender(<ScoreView {...props} editTarget={{...target,beat:2}}/>);
  expect(screen.getByLabelText('Edit target').style.left).toBe('135px');
  expect(screen.getByRole('status').textContent).toMatch(/beat 3/i);
  expect(api.playbackRange).toEqual({startTick:1920,endTick:3840});expect(api.highlighted).toBeNull();
  expect(playback.replaceScore).not.toHaveBeenCalled();expect(playback.seek).not.toHaveBeenCalled();expect(onSelect).not.toHaveBeenCalled();expect(onEditorSelection).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
it('follows changed strings and indexed notes within the same beat',()=>{
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],second=new model.Note();second.string=5;second.fret=2;beat.addNote(second);
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target,editString:6};
  const rendered=render(<ScoreView {...props}/>);expect(screen.getByLabelText('Edit target').style.top).toBe('47px');
  rendered.rerender(<ScoreView {...props} editString={5}/>);expect(screen.getByLabelText('Edit target').style.top).toBe('62px');
  expect(screen.getByRole('status').textContent).toMatch(/string 5/i);
  rendered.rerender(<ScoreView {...props} editNoteIndex={1}/>);expect(screen.getByLabelText('Edit target').style.top).toBe('62px');
  expect(screen.getByRole('status').textContent).toMatch(/note 2/i);
  rendered.rerender(<ScoreView {...props} editNoteIndex={null} editString={4}/>);
  expect(screen.getByLabelText('Edit target').style.left).toBe('27px');expect(screen.getByText('String 4')).toBeTruthy();
});
it('keeps rests and empty entry targets visible without requiring a note bound',()=>{
  const score=music(),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;beats[0].notes=[];beats[1].notes=[];beats[1].isEmpty=true;
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target,editString:3};
  const rendered=render(<ScoreView {...props}/>);expect(screen.getByLabelText('Edit target').style.width).toBe('56px');
  expect(screen.getByRole('status').textContent).toMatch(/rest.*string 3/i);
  rendered.rerender(<ScoreView {...props} editTarget={{...target,beat:1}}/>);expect(screen.getByLabelText('Edit target').style.left).toBe('77px');
  expect(screen.getByRole('status').textContent).toMatch(/empty.*string 3/i);
});
it('uses only current projected bounds and refreshes edit geometry after zoom rendering',()=>{
  const {score,projection,engraving}=twoTrackProjection(),props={score,track:0,zoom:100,profile:'Default',projection,engraving,visibleTracks:[0,1],playback:null,onSelect:vi.fn(),editTarget:{...target,track:1},editNoteIndex:0};
  const rendered=render(<ScoreView {...props}/>),api=view.api as FakeView;
  api.boundsLookup.findBeats=beat=>{if(beat.voice.bar.staff.track.score!==projection.score)return [];const bounds=beatBounds(beat);bounds.notes![0].noteHeadBounds.x=108;return [bounds];};
  rendered.rerender(<ScoreView {...props} zoom={150}/>);act(()=>api.postRenderFinished.emit());expect(screen.getByLabelText('Edit target').style.left).toBe('135px');
  const next=projectEngraving(score,['base/0','base/1'],engraving);rendered.rerender(<ScoreView {...props} projection={next}/>);
  expect(screen.queryByLabelText('Edit target')).toBeNull();
  api.boundsLookup.findBeats=beat=>beat.voice.bar.staff.track.score===next.score?[beatBounds(beat)]:[];act(()=>api.postRenderFinished.emit());expect(screen.getByLabelText('Edit target').style.left).toBe('35px');
  rendered.rerender(<ScoreView {...props} projection={next} visibleTracks={[0]}/>);expect(screen.queryByLabelText('Edit target')).toBeNull();
});
it('hides the edit target when bounds are stale or missing and preserves callers without a target',()=>{
  const score=music(),props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn()};
  const rendered=render(<ScoreView {...props}/>),api=view.api as FakeView;expect(screen.queryByLabelText('Edit target')).toBeNull();
  rendered.rerender(<ScoreView {...props} editTarget={target}/>);expect(screen.getByLabelText('Edit target')).toBeTruthy();
  api.boundsLookup.findBeats=()=>[beatBounds(music().tracks[0].staves[0].bars[0].voices[0].beats[0])];act(()=>api.postRenderFinished.emit());expect(screen.queryByLabelText('Edit target')).toBeNull();
  api.boundsLookup.findBeats=()=>[];act(()=>api.postRenderFinished.emit());expect(screen.queryByLabelText('Edit target')).toBeNull();
  rendered.rerender(<ScoreView {...props}/>);expect(screen.getByRole('status').textContent).toBe('');
});
it('reveals moved edit targets only in the score host and waits for current bounds',()=>{
  const windowScroll=vi.spyOn(window,'scrollTo'),scroll=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return {x:0,y:0,left:0,top:0,right:100,bottom:this.classList.contains('score-edit-target')?150:100,width:100,height:100,toJSON(){}};});
  const score=music(),props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target,editString:6};
  const tree=(beat=0)=><div className="paper-scroll"><ScoreView {...props} editTarget={{...target,beat}}/></div>;
  const rendered=render(tree()),api=view.api as FakeView,host=rendered.container.firstElementChild!;
  expect(host.scrollTop).toBe(50);act(()=>api.postRenderFinished.emit());expect(host.scrollTop).toBe(50);
  api.boundsLookup.findBeats=()=>[];rendered.rerender(tree(1));expect(host.scrollTop).toBe(50);
  api.boundsLookup.findBeats=beat=>[beatBounds(beat)];act(()=>api.postRenderFinished.emit());expect(host.scrollTop).toBe(100);
  act(()=>api.postRenderFinished.emit());expect(host.scrollTop).toBe(100);expect(windowScroll).not.toHaveBeenCalled();scroll.mockRestore();windowScroll.mockRestore();
});
it('waits for a layout in progress before reusing edit bounds for a moved target',()=>{
  const score=music(),props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target,editString:6};
  const rendered=render(<ScoreView {...props}/>),api=view.api as FakeView;expect(screen.getByLabelText('Edit target')).toBeTruthy();
  act(()=>api.renderStarted.emit(true));expect(screen.queryByLabelText('Edit target')).toBeNull();
  rendered.rerender(<ScoreView {...props} editTarget={{...target,beat:1}}/>);expect(screen.queryByLabelText('Edit target')).toBeNull();
  act(()=>api.postRenderFinished.emit());expect(screen.getByLabelText('Edit target').style.left).toBe('85px');
});
it('moves the edit target with the page when the score area is resized and nothing renders again (THE-208)',()=>{
  const score=music(),props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target,editString:6};
  const rendered=render(<ScoreView {...props}/>),api=view.api as unknown as {uiFacade:{getOffset:()=>{x:number;y:number;w:number;h:number}}};
  const host=rendered.container.querySelector('.score-presentation')!.parentElement!;
  expect(screen.getByLabelText('Edit target').style.left).toBe('35px');
  // The page is centred in the score area: a wider area moves the page right. Only the page moves, so alphaTab has no reason to render again.
  api.uiFacade.getOffset=()=>({x:230,y:40,w:600,h:300});
  Object.defineProperty(host,'clientWidth',{configurable:true,value:1500});
  act(()=>{window.dispatchEvent(new Event('resize'));});
  expect(screen.getByLabelText('Edit target').style.left).toBe('235px');
  api.uiFacade.getOffset=()=>({x:10,y:40,w:600,h:300});
  Object.defineProperty(host,'clientWidth',{configurable:true,value:700});
  act(()=>{window.dispatchEvent(new Event('resize'));});
  expect(screen.getByLabelText('Edit target').style.left).toBe('15px');
});
it('moves every mark placed from the canvas offset when the page moves and nothing renders again (THE-208)',()=>{
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[1];
  setScaleDiagram(beat,{name:'Shape',strings:6,frets:5,firstFret:1,orientation:'horizontal',showFretMarkers:true,marks:[newMark(1,3)]});
  const selected:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}};
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),onEditorSelection:vi.fn(),editorSelection:selected,editTarget:target};
  const rendered=render(<ScoreView {...props}/>),api=view.api as unknown as FakeView&{uiFacade:{getOffset:()=>{x:number;y:number;w:number;h:number}}};
  act(()=>api.postRenderFinished.emit());
  const host=rendered.container.querySelector('.score-presentation')!.parentElement!;
  const left=(node:Element)=>parseFloat((node as HTMLElement).style.left);
  const read=()=>({handle:left(screen.getByRole('button',{name:'Resize selection end'})),diagram:left(document.querySelector('.score-scale-diagram')!),edit:left(screen.getByLabelText('Edit target'))});
  const before=read();
  api.uiFacade.getOffset=()=>({x:230,y:40,w:600,h:300});
  Object.defineProperty(host,'clientWidth',{configurable:true,value:1500});
  act(()=>{window.dispatchEvent(new Event('resize'));});
  const after=read();
  for(const key of Object.keys(before) as (keyof typeof before)[])expect(after[key],key).toBe(before[key]+200);
});
it('uses public external media output and keeps viewport changes out of native plan loading',()=>{
  const score=music(),playback={attachView:vi.fn(),replaceScore:vi.fn(),setRenderedScore:vi.fn()},onSelect=vi.fn();const props={score,track:0,zoom:100,profile:'ScoreTab',onSelect,playback:playback as never};const rendered=render(<ScoreView {...props}/>);
  expect(view.options).toMatchObject({player:{playerMode:'EnabledExternalMedia',enableCursor:false}});expect((view.options as {player:object}).player).not.toHaveProperty('soundFont');expect(playback.attachView).toHaveBeenCalledTimes(1);
  view.note?.(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]);expect(onSelect).toHaveBeenLastCalledWith(target,6,0);
  rendered.rerender(<ScoreView {...props} zoom={130}/>);expect(playback.setRenderedScore).toHaveBeenLastCalledWith(score,[0]);expect(playback.attachView).toHaveBeenCalledTimes(1);
  rendered.unmount();expect(view.destroy).toHaveBeenCalledTimes(1);
});

function twoTrackProjection(){
  const score=music();score.addTrack(music().tracks[0]);score.finish(new Settings());
  const engraving=defaultEngraving(),projection=projectEngraving(score,['base/0','base/1'],engraving);
  return {score,engraving,projection};
}
it('renders visible projected tracks and resolves cloned note hits to canonical addresses',()=>{
  const {score,engraving,projection}=twoTrackProjection(),onSelect=vi.fn(),playback={attachView:vi.fn(),replaceScore:vi.fn(),setRenderedScore:vi.fn()};
  render(<ScoreView score={score} track={0} zoom={100} profile="Default" projection={projection} engraving={engraving} visibleTracks={[0,1]} playback={playback as never} onSelect={onSelect}/>);
  expect(playback.setRenderedScore).toHaveBeenLastCalledWith(projection.score,[0,1]);
  const note=projection.score.tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0];act(()=>view.note?.(note));
  expect(onSelect).toHaveBeenLastCalledWith({...target,track:1,beat:1},6,0);
});
it('uses rendered bounds for all visible selected notes and ignores stale or hidden hits',()=>{
  const {score,engraving,projection}=twoTrackProjection(),onSelect=vi.fn(),editorSelection:MusicSelection={kind:'notes',notes:[{target,noteIndex:0},{target:{...target,track:1},noteIndex:0}]};
  const props={score,engraving,track:0,zoom:100,profile:'Default',playback:null,onSelect,editorSelection};
  const rendered=render(<ScoreView {...props} projection={projection} visibleTracks={[0,1]}/>);expect(screen.getAllByRole('img')).toHaveLength(2);
  const api=view.api as FakeView;api.boundsLookup.findBeats=beat=>beat.voice.bar.staff.track.score===projection.score?[beatBounds(beat)]:[];act(()=>api.postRenderFinished.emit());expect(screen.getAllByRole('img')).toHaveLength(2);
  const next=projectEngraving(score,['base/0','base/1'],engraving);rendered.rerender(<ScoreView {...props} projection={next} visibleTracks={[1]}/>);
  act(()=>view.note?.(projection.score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0]));
  act(()=>view.note?.(next.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]));expect(onSelect).not.toHaveBeenCalled();
});
it('resizes a canonical selection using public projected bounds and hit testing',()=>{
  const {score,engraving,projection}=twoTrackProjection(),onEditorSelection=vi.fn(),selected:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:2880},lanes:[{track:1,staff:0,voice:0}]}};
  render(<ScoreView score={score} track={1} zoom={100} profile="Default" projection={projection} engraving={engraving} visibleTracks={[0,1]} playback={null} onSelect={vi.fn()} editorSelection={selected} onEditorSelection={onEditorSelection}/>);
  const api=view.api as FakeView,beats=projection.score.tracks[1].staves[0].bars[0].voices[0].beats;expect(api.highlighted?.[0]===beats[0]).toBe(true);
  api.boundsLookup.getBeatAtPos=()=>beats[3];fireEvent.mouseDown(screen.getByRole('button',{name:'Resize selection end'}),{button:0});fireEvent.mouseMove(document,{clientX:200,clientY:70});fireEvent.mouseUp(document);
  expect(onEditorSelection).toHaveBeenLastCalledWith({kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:0},lanes:[{track:1,staff:0,voice:0}]}});
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
  try{input.focus();down(0);expect(document.activeElement===notation.closest('.score-presentation')).toBe(true);}finally{input.remove();}
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
it('extends Shift selection from a selection set from outside, not from an older click of its own',()=>{
  // Click beat 2 in the score, then something else (the instrument view) selects beat 3, then Shift+click beat 4: the range is 3 to 4.
  const score=music(),changes:(MusicSelection|null)[]=[],onSelect=vi.fn();
  const tree=(selected:MusicSelection|null)=><ScoreView score={score} track={0} zoom={100} profile="ScoreTab" playback={null} onSelect={onSelect} editorSelection={selected} onEditorSelection={next=>changes.push(next)}/>;
  const rendered=render(tree(null)),notation=screen.getByLabelText('Music notation'),beat=(index:number)=>score.tracks[0].staves[0].bars[0].voices[0].beats[index];
  const down=(index:number,options:Record<string,unknown>={})=>{fireEvent.mouseDown(notation,{button:0,...options});act(()=>{view.beat?.(beat(index));});};
  down(1);rendered.rerender(tree(changes.at(-1)!));
  const outside:MusicSelection={kind:'range',range:{start:{bar:0,tick:1920},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}};
  rendered.rerender(tree(outside));
  down(3,{shiftKey:true});
  expect(changes.at(-1)).toEqual({kind:'range',range:{start:{bar:0,tick:1920},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}});
  // A selection the view published itself keeps its anchor, as before.
  const own=changes.at(-1)!;rendered.rerender(tree(own));down(1,{shiftKey:true});
  expect(changes.at(-1)).toEqual({kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:2880},lanes:[{track:0,staff:0,voice:0}]}});
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
it('draws a chip for each scale diagram above its beat, opens the diagram on hover or focus, and removes it when the beat is not rendered',()=>{
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[1];
  setScaleDiagram(beat,{name:'Shape',strings:6,frets:5,firstFret:1,orientation:'horizontal',showFretMarkers:true,marks:[newMark(1,3),newMark(6,0,'square')]});
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target};
  const rendered=render(<ScoreView {...props}/>),api=view.api as FakeView;act(()=>api.postRenderFinished.emit());
  const chip=screen.getByRole('button',{name:'Show scale diagram Shape'}),box=chip.closest('.score-scale-diagram') as HTMLElement;
  expect(box.style.left).toBe('80px');expect(Number.parseFloat(box.style.top)).toBeGreaterThanOrEqual(0);
  expect(screen.queryByRole('group',{name:'Scale diagram Shape'})).toBeNull();
  fireEvent.mouseEnter(box);expect(screen.getByRole('group',{name:'Scale diagram Shape'})).toBeTruthy();expect(screen.getByLabelText('String 6, open: square mark')).toBeTruthy();
  fireEvent.mouseLeave(box);expect(screen.queryByRole('group',{name:'Scale diagram Shape'})).toBeNull();
  fireEvent.focus(chip);expect(screen.getByRole('group',{name:'Scale diagram Shape'})).toBeTruthy();fireEvent.blur(chip);expect(screen.queryByRole('group',{name:'Scale diagram Shape'})).toBeNull();
  api.boundsLookup.findBeats=()=>[];act(()=>api.postRenderFinished.emit());expect(screen.queryByRole('button',{name:'Show scale diagram Shape'})).toBeNull();
  rendered.unmount();
});
it('packs chips of adjacent beats so none covers another and keeps them above the first staff',()=>{
  const score=music(),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
  beats.slice(0,3).forEach((beat,index)=>setScaleDiagram(beat,{name:`Long diagram ${index}`,strings:6,frets:12,firstFret:1,orientation:'horizontal',showFretMarkers:true,marks:[newMark(1,3)]}));
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target};
  const rendered=render(<ScoreView {...props}/>),api=view.api as FakeView;act(()=>api.postRenderFinished.emit());
  const boxes=screen.getAllByRole('button',{name:/Show scale diagram Long diagram/}).map(chip=>({box:chip.closest('.score-scale-diagram') as HTMLElement,width:Number.parseFloat(chip.style.width)}));
  expect(boxes).toHaveLength(3);
  for(let i=1;i<boxes.length;i++){
    expect(boxes[i].box.style.top).toBe(boxes[i-1].box.style.top);
    expect(Number.parseFloat(boxes[i].box.style.left)).toBeGreaterThanOrEqual(Number.parseFloat(boxes[i-1].box.style.left)+boxes[i-1].width);
  }
  // The first staff starts 40px down; every chip sits entirely above it and never above the top edge.
  for(const {box} of boxes){const top=Number.parseFloat(box.style.top);expect(top).toBeGreaterThanOrEqual(0);expect(top+16).toBeLessThanOrEqual(40);}
  act(()=>api.renderStarted.emit(false));expect(screen.queryAllByRole('button',{name:/Show scale diagram/})).toHaveLength(0);
  rendered.unmount();
});

it('renders pending fret digits on the score edit target caret overlay when provided',()=>{
  const score=music(),onSelect=vi.fn();
  const props={score,track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect,editTarget:target,editString:6};
  const rendered=render(<ScoreView {...props}/>);
  expect(document.querySelector('.score-edit-entry')).toBeNull();

  rendered.rerender(<ScoreView {...props} editPendingFret="7"/>);
  expect(document.querySelector('.score-edit-entry')?.textContent).toBe('Fret 7');

  rendered.rerender(<ScoreView {...props} editPendingFret={null}/>);
  expect(document.querySelector('.score-edit-entry')).toBeNull();
});

it.each([['et','Krihv 7'],['de','Bund 7']] as const)('translates the on-score pending fret label in %s',(language,fret)=>{
  setLanguagePreference(language);
  try{
    const props={score:music(),track:0,zoom:100,profile:'ScoreTab',playback:null,onSelect:vi.fn(),editTarget:target,editString:6};
    render(<ScoreView {...props} editPendingFret="7"/>);
    expect(document.querySelector('.score-edit-entry')?.textContent).toBe(fret);
  }finally{setLanguagePreference('en');}
});
