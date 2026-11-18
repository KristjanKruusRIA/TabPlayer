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

/** The dock's track rows with the app's edit history behind them: a move or an undo hands the panel a score with the tracks in another order. */
function setup(){
  let project:Project=blankProject();
  for(const name of ['Bass','Keys'])project=previewEdit(project,{type:'addTrack',name,tuning:[43,38,33,28],program:33}).project;
  let selected=0,score=previewEdit(project,{type:'setRest',target}).score;
  const history:Project[]=[project];
  const playerState={ready:true,playing:false,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null,error:null} as PlaybackState;
  const player={subscribe:()=>()=>{},getState:()=>playerState,mix:()=>undefined,setMute:vi.fn(),setSolo:vi.fn(),setTrackVolume:vi.fn(),setPan:vi.fn(),focus:()=>null,setFocus:vi.fn(async()=>{})};
  const move=(from:number,to:number)=>{
    const edit:EditCommand={type:'moveTrack',track:from,to};
    project=previewEdit(project,edit).project;history.push(project);score=previewEdit(project,{type:'setRest',target}).score;selected=movedTrackIndex(selected,edit);draw();
    return true;
  };
  const undo=()=>{history.pop();project=history.at(-1)!;score=previewEdit(project,{type:'setRest',target}).score;draw();};
  const panel=()=><TrackPanel score={score} selected={selected} busy={false} view="overview" target={{...target,track:selected}} onExitOverview={vi.fn()} onSelect={index=>{selected=index;draw();}} onSelectPosition={vi.fn()} player={player as never} onMoveTrack={move}/>;
  const view=render(panel());const draw=()=>view.rerender(panel());
  return {first:score.tracks[0].name,undo,move:(from:number,to:number)=>act(()=>{move(from,to);}),get score(){return score;}};
}

/** Every dock row holds exactly one of each mix control, and nothing else in its mix group. */
function expectOneOfEach(rows:number){
  const dock=document.querySelectorAll<HTMLElement>('.score-overview-row');
  expect(dock).toHaveLength(rows);
  for(const row of dock){
    expect(row.querySelectorAll('.score-overview-mix')).toHaveLength(1);
    expect(row.querySelectorAll('input.dock-fader')).toHaveLength(1);
    expect(row.querySelectorAll('.dock-pan')).toHaveLength(1);
    expect(row.querySelectorAll('.dock-pan [role="slider"]')).toHaveLength(1);
    expect(row.querySelectorAll('button[data-kind="mute"]')).toHaveLength(1);
    expect(row.querySelectorAll('button[data-kind="solo"]')).toHaveLength(1);
    expect(row.querySelector('.score-overview-mix')!.children).toHaveLength(5);
  }
  // The volume faders carry the owning track's name, one each.
  expect(document.querySelectorAll('input.dock-fader')).toHaveLength(rows);
}

it('keeps one volume fader, pan, mute and solo in every dock row, before and after a move, an undo and two moves in a row',()=>{
  const view=setup();expectOneOfEach(3);
  view.move(0,1);expect(names(view.score)).toEqual(['Bass',view.first,'Keys']);expectOneOfEach(3);
  view.undo();expect(names(view.score)).toEqual([view.first,'Bass','Keys']);expectOneOfEach(3);
  view.move(0,2);expectOneOfEach(3);view.move(1,0);expectOneOfEach(3);
  expect(names(view.score)).toEqual(['Keys','Bass',view.first]);
  // Each fader still belongs to the track in its row.
  for(const [index,name] of names(view.score).entries()){
    expect(document.querySelectorAll('.score-overview-row')[index].querySelector('input.dock-fader')!.getAttribute('aria-label')).toContain(name);
  }
});

it('keeps one of each control after moves made with the grip from the keyboard', ()=>{
  const view=setup();
  const grip=screen.getByRole('button',{name:`Move ${view.first}`});grip.focus();
  fireEvent.keyDown(grip,{key:'ArrowDown',altKey:true});expectOneOfEach(3);
  fireEvent.keyDown(document.activeElement!,{key:'ArrowDown',altKey:true});expectOneOfEach(3);
  view.undo();expectOneOfEach(3);
});
