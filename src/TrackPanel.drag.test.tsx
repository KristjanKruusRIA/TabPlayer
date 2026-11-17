// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { previewEdit } from './engine';
import { blankProject, type EditCommand, type Project } from './project';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import type { PlaybackState } from './audio/types';
import { movedTrackIndex } from './selection';
import { TrackPanel } from './TrackPanel';

beforeEach(()=>{
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(200);
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const names=(score:model.Score)=>score.tracks.map(track=>track.name);

/** The track list as the app keeps it: one recorded edit per move, and the selected track following the moved one. */
function setup({busy=false,onMoveTrack,refuse=false}:{busy?:boolean;onMoveTrack?:(from:number,to:number)=>void;refuse?:boolean}={}){
  let project:Project=blankProject();
  for(const name of ['Bass','Keys'])project=previewEdit(project,{type:'addTrack',name,tuning:[43,38,33,28],program:33}).project;
  const log:EditCommand[]=[];let selected=0,score=previewEdit(project,{type:'setRest',target}).score,state={busy};
  const history:Project[]=[project];
  const playerState={ready:true,playing:false,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null,error:null} as PlaybackState;
  const player={subscribe:()=>()=>{},getState:()=>playerState,mix:()=>undefined,setMute:vi.fn(),setSolo:vi.fn(),setTrackVolume:vi.fn(),setPan:vi.fn(),focus:()=>null,setFocus:vi.fn(async()=>{})};
  const move=(from:number,to:number)=>{
    onMoveTrack?.(from,to);
    if(refuse)return false;
    const edit:EditCommand={type:'moveTrack',track:from,to};log.push(edit);
    project=previewEdit(project,edit).project;history.push(project);score=previewEdit(project,{type:'setRest',target}).score;selected=movedTrackIndex(selected,edit);draw();
    return true;
  };
  const undo=()=>{log.pop();history.pop();project=history.at(-1)!;score=previewEdit(project,{type:'setRest',target}).score;draw();};
  const panel=()=><TrackPanel score={score} selected={selected} busy={state.busy} view="overview" target={{...target,track:selected}} onExitOverview={vi.fn()} onSelect={index=>{selected=index;draw();}} onSelectPosition={vi.fn()} player={player as never} onMoveTrack={move}/>;
  const view=render(panel());const draw=()=>view.rerender(panel());
  const first=score.tracks[0].name;
  // A change from elsewhere (such as an undo in another view) that reorders the tracks without going through the grip.
  const reorderElsewhere=()=>{project=previewEdit(project,{type:'moveTrack',track:0,to:1}).project;history.push(project);score=previewEdit(project,{type:'setRest',target}).score;draw();};
  const moveElsewhere=(from:number,to:number)=>{project=previewEdit(project,{type:'moveTrack',track:from,to}).project;history.push(project);score=previewEdit(project,{type:'setRest',target}).score;draw();};
  return {first,log,undo,reorderElsewhere,moveElsewhere,get selected(){return selected;},get score(){return score;},setBusy:(next:boolean)=>{state={busy:next};draw();}};
}
const handle=(name:string)=>screen.getByRole('button',{name:`Move ${name}`});
const drag=(grip:HTMLElement,from:number,steps:number[])=>{
  fireEvent.pointerDown(grip,{pointerId:3,button:0,clientY:from});
  for(const y of steps)fireEvent.pointerMove(grip,{pointerId:3,clientY:y});
};

it('moves a track across several positions as one edit and one undo step, and the selection follows it',()=>{
  const view=setup();expect(names(view.score)).toEqual([view.first,'Bass','Keys']);
  const grip=handle(view.first);drag(grip,100,[110,130,157]);
  // Two rows down: a visible drop line, and nothing recorded yet.
  expect(screen.getByTestId('track-drop-indicator')).toBeInTheDocument();expect(view.log).toEqual([]);
  fireEvent.pointerUp(grip,{pointerId:3,clientY:157});
  expect(view.log).toEqual([{type:'moveTrack',track:0,to:2}]);
  expect(names(view.score)).toEqual(['Bass','Keys',view.first]);
  expect(view.selected).toBe(2);
  expect(screen.getByRole('button',{name:`Select track ${view.first}`,pressed:true})).toBeInTheDocument();
  expect(screen.queryByTestId('track-drop-indicator')).toBeNull();
  view.undo();expect(names(view.score)).toEqual([view.first,'Bass','Keys']);expect(view.log).toEqual([]);
});

it('moves a track up past several rows, clamped to the list, as one edit',()=>{
  const view=setup();const grip=handle('Keys');
  drag(grip,200,[170,100,-500]);fireEvent.pointerUp(grip,{pointerId:3,clientY:-500});
  expect(view.log).toEqual([{type:'moveTrack',track:2,to:0}]);expect(names(view.score)).toEqual(['Keys',view.first,'Bass']);
});

it('records nothing for a drop on the row the drag started in, even after wandering away',()=>{
  const onMove=vi.fn();const view=setup({onMoveTrack:onMove});const grip=handle('Bass');
  drag(grip,100,[140,170,100]);expect(screen.queryByTestId('track-drop-indicator')).toBeNull();
  fireEvent.pointerUp(grip,{pointerId:3,clientY:100});
  expect(onMove).not.toHaveBeenCalled();expect(view.log).toEqual([]);expect(names(view.score)).toEqual([view.first,'Bass','Keys']);
  // A bare press and release without moving records nothing either.
  fireEvent.pointerDown(grip,{pointerId:4,button:0,clientY:100});fireEvent.pointerUp(grip,{pointerId:4,clientY:100});
  expect(onMove).not.toHaveBeenCalled();
});

it('cancels with Escape or a cancelled pointer, recording nothing and ignoring later pointer events',()=>{
  const onMove=vi.fn();const view=setup({onMoveTrack:onMove});const grip=handle(view.first);
  drag(grip,100,[150]);expect(screen.getByTestId('track-drop-indicator')).toBeInTheDocument();
  const seen:string[]=[];const spy=(event:KeyboardEvent)=>seen.push(event.key);document.addEventListener('keydown',spy);
  fireEvent.keyDown(grip,{key:'Escape'});document.removeEventListener('keydown',spy);
  expect(seen).toEqual([]);expect(screen.queryByTestId('track-drop-indicator')).toBeNull();
  fireEvent.pointerMove(grip,{pointerId:3,clientY:200});fireEvent.pointerUp(grip,{pointerId:3,clientY:200});
  expect(onMove).not.toHaveBeenCalled();
  drag(grip,100,[150,180]);fireEvent.pointerCancel(grip,{pointerId:3});
  expect(screen.queryByTestId('track-drop-indicator')).toBeNull();
  fireEvent.pointerUp(grip,{pointerId:3,clientY:180});
  expect(onMove).not.toHaveBeenCalled();expect(view.log).toEqual([]);expect(view.selected).toBe(0);
});

it('drops a drag whose track list changes underneath it, recording nothing',()=>{
  const onMove=vi.fn();const view=setup({onMoveTrack:onMove});const grip=handle(view.first);
  drag(grip,100,[157]);expect(screen.getByTestId('track-drop-indicator')).toBeInTheDocument();
  act(()=>view.reorderElsewhere());
  expect(screen.queryByTestId('track-drop-indicator')).toBeNull();
  fireEvent.pointerUp(grip,{pointerId:3,clientY:157});
  expect(onMove).not.toHaveBeenCalled();expect(view.log).toEqual([]);
});

it('never disables the grip: a busy app refuses a new drag but the grip keeps focus, and the keyboard moves one row per edit',()=>{
  const view=setup({busy:true});const grip=handle('Bass');
  grip.focus();expect(grip).toHaveFocus();expect(grip).not.toBeDisabled();expect(grip).toHaveAttribute('aria-disabled','true');
  drag(grip,100,[170]);expect(screen.queryByTestId('track-drop-indicator')).toBeNull();fireEvent.pointerUp(grip,{pointerId:3,clientY:170});
  fireEvent.keyDown(grip,{key:'ArrowDown',altKey:true});expect(view.log).toEqual([]);
  view.setBusy(false);expect(grip).toHaveFocus();expect(grip).not.toHaveAttribute('aria-disabled');
  // The same drag turning busy mid-way keeps its grip enabled and focused.
  drag(grip,100,[170]);view.setBusy(true);expect(grip).not.toBeDisabled();expect(grip).toHaveFocus();
  fireEvent.pointerCancel(grip,{pointerId:3});view.setBusy(false);
  fireEvent.keyDown(grip,{key:'ArrowDown',altKey:true});
  expect(view.log).toEqual([{type:'moveTrack',track:1,to:2}]);expect(names(view.score)).toEqual([view.first,'Keys','Bass']);
  fireEvent.keyDown(screen.getByRole('button',{name:`Move ${view.first}`}),{key:'ArrowUp',altKey:true});expect(view.log).toHaveLength(1);
});

it('keeps focus on the moved track so the next Alt+Arrow moves the same track again',()=>{
  const view=setup();const grip=handle('Keys');grip.focus();
  fireEvent.keyDown(grip,{key:'ArrowUp',altKey:true});
  expect(names(view.score)).toEqual([view.first,'Keys','Bass']);
  expect(document.activeElement).toBe(handle('Keys'));
  fireEvent.keyDown(document.activeElement!,{key:'ArrowUp',altKey:true});
  expect(view.log).toEqual([{type:'moveTrack',track:2,to:1},{type:'moveTrack',track:1,to:0}]);
  expect(names(view.score)).toEqual(['Keys',view.first,'Bass']);expect(document.activeElement).toBe(handle('Keys'));
});

it('puts focus on the grip of a track moved by a pointer drag',()=>{
  const view=setup();const grip=handle(view.first);drag(grip,100,[157]);fireEvent.pointerUp(grip,{pointerId:3,clientY:157});
  expect(names(view.score)).toEqual(['Bass','Keys',view.first]);expect(document.activeElement).toBe(handle(view.first));
});

it('has no grip without a move handler or with a single track',()=>{
  const project=previewEdit(blankProject(),{type:'setRest',target});
  const props={selected:0,busy:false,view:'overview' as const,target,onExitOverview:vi.fn(),onSelect:vi.fn(),onSelectPosition:vi.fn(),player:null};
  const view=render(<TrackPanel score={project.score} {...props} onMoveTrack={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:/^Move /})).toBeNull();view.unmount();
  const two=previewEdit(project.project,{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  render(<TrackPanel score={two.score} {...props}/>);expect(screen.queryByRole('button',{name:/^Move /})).toBeNull();
});

it('Escape cancels a drag while the pointer is on the starting row, so a later release records nothing',()=>{
  const onMove=vi.fn();const view=setup({onMoveTrack:onMove});const grip=handle('Bass');
  // Right after the press, before the pointer has left the row.
  fireEvent.pointerDown(grip,{pointerId:3,button:0,clientY:100});
  fireEvent.keyDown(grip,{key:'Escape'});
  fireEvent.pointerMove(grip,{pointerId:3,clientY:128});fireEvent.pointerUp(grip,{pointerId:3,clientY:128});
  expect(onMove).not.toHaveBeenCalled();expect(view.log).toEqual([]);
  // After drifting away and coming back to the starting row.
  drag(grip,100,[128,100]);expect(screen.queryByTestId('track-drop-indicator')).toBeNull();
  fireEvent.keyDown(grip,{key:'Escape'});
  fireEvent.pointerMove(grip,{pointerId:3,clientY:128});fireEvent.pointerUp(grip,{pointerId:3,clientY:128});
  expect(onMove).not.toHaveBeenCalled();expect(view.log).toEqual([]);
});

it('does not pull focus to a grip after a refused move when the same track later lands at that index from elsewhere',()=>{
  const view=setup({refuse:true});const grip=handle('Bass');grip.focus();
  fireEvent.keyDown(grip,{key:'ArrowDown',altKey:true});expect(view.log).toEqual([]);
  const elsewhere=document.createElement('button');document.body.append(elsewhere);elsewhere.focus();
  act(()=>view.moveElsewhere(1,2));
  expect(names(view.score)).toEqual([view.first,'Keys','Bass']);
  expect(document.activeElement).toBe(elsewhere);elsewhere.remove();
});
