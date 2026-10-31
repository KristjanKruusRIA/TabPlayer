// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
import type { PlaybackState } from './audio/types';
import type { BeatTarget } from './project';
import type { MusicSelection } from './editor/range-types';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import { NativePlaybackController } from './audio/NativePlaybackController';
import type { NativeAudioBridge,NativeAudioStatus } from './audio/bridge';
import { buildDocument } from './engine';
import { blankProject } from './project';
const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
const selection:MusicSelection={kind:'bars',tracks:[0],firstBar:0,lastBar:0};
afterEach(cleanup);
function fixture(){
  let state:PlaybackState={ready:true,playing:false,time:0,endTime:10000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null};
  const listeners=new Set<()=>void>();
  const player={generation:7,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getState:()=>state,play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setPractice:vi.fn(),cursorPlaybackChoices:vi.fn((_target:BeatTarget)=>[{generation:player.generation,occurrenceIndex:0,startTick:0}]),selectionPlaybackChoices:vi.fn((_selection:MusicSelection)=>[{generation:player.generation,startOccurrence:0,endOccurrence:0,startTick:0,endTick:3840}]),playbackOccurrences:()=>[{bar:0,occurrence:0,startTick:0,endTick:3840,startMs:0,endMs:2000,meterNumerator:4,meterDenominator:4}],playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn()};
  return {player,update:(patch:Partial<PlaybackState>)=>act(()=>{state={...state,...patch};for(const listener of listeners)listener();})};
}
it('clock-only updates retain real occurrence controls without querying cursor or passage choices again',()=>{
  const {player,update}=fixture();render(<Transport player={player} measures={64} busy={false} cursor={cursor} selection={selection}/>);
  fireEvent.click(screen.getByText('More playback',{selector:'summary'}));fireEvent.click(screen.getByText('Selected playback',{selector:'summary'}));
  expect(screen.getByRole('button',{name:'Play from cursor'})).toBeEnabled();expect(screen.getByRole('button',{name:'Play selection'})).toBeEnabled();
  player.cursorPlaybackChoices.mockClear();player.selectionPlaybackChoices.mockClear();
  for(let time=1000;time<=3000;time+=1000)update({time,measure:time/1000});
  expect(document.querySelector('.transport-time')).toHaveTextContent('0:03 / 0:10');expect(screen.getByText('Bar 4')).toBeVisible();expect(player.cursorPlaybackChoices).not.toHaveBeenCalled();expect(player.selectionPlaybackChoices).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Play from cursor'}));expect(player.playFromCursor).toHaveBeenCalledWith(cursor,{generation:7,occurrenceIndex:0,startTick:0});
  fireEvent.click(screen.getByRole('button',{name:'Play selection'}));expect(player.playSelection).toHaveBeenCalledWith(selection,{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:3840});
});
it('choice queries follow player identity generation readiness cursor scalars and selection identity',()=>{
  const {player,update}=fixture();let target=cursor,selected:MusicSelection|null=selection;
  const element=()=> <Transport player={player} measures={64} busy={false} cursor={target} selection={selected}/>;
  const view=render(element());player.cursorPlaybackChoices.mockClear();player.selectionPlaybackChoices.mockClear();
  target={...cursor};view.rerender(element());expect(player.cursorPlaybackChoices).not.toHaveBeenCalled();expect(player.selectionPlaybackChoices).not.toHaveBeenCalled();
  for(const key of ['track','staff','bar','voice','beat'] as const){target={...target,[key]:target[key]+1};view.rerender(element());expect(player.cursorPlaybackChoices).toHaveBeenLastCalledWith(target);}
  expect(player.cursorPlaybackChoices).toHaveBeenCalledTimes(5);expect(player.selectionPlaybackChoices).not.toHaveBeenCalled();
  selected={kind:'bars',tracks:[0],firstBar:0,lastBar:1};view.rerender(element());expect(player.selectionPlaybackChoices).toHaveBeenCalledExactlyOnceWith(selected);expect(player.cursorPlaybackChoices).toHaveBeenCalledTimes(5);
  player.generation=8;update({time:50});expect(player.cursorPlaybackChoices).toHaveBeenCalledTimes(6);expect(player.selectionPlaybackChoices).toHaveBeenCalledTimes(2);
  update({ready:false});expect(player.cursorPlaybackChoices).toHaveBeenCalledTimes(6);expect(player.selectionPlaybackChoices).toHaveBeenCalledTimes(2);expect(screen.getByText('Loading local audio…')).toBeVisible();
  update({ready:true});expect(player.cursorPlaybackChoices).toHaveBeenCalledTimes(7);expect(player.selectionPlaybackChoices).toHaveBeenCalledTimes(3);
  selected=null;view.rerender(element());expect(player.selectionPlaybackChoices).toHaveBeenCalledTimes(3);expect(player.cursorPlaybackChoices).toHaveBeenCalledTimes(7);
  const replacement=fixture().player;view.rerender(<Transport player={replacement} measures={64} busy={false} cursor={target} selection={selection}/>);expect(replacement.cursorPlaybackChoices).toHaveBeenCalledWith(target);expect(replacement.selectionPlaybackChoices).toHaveBeenCalledWith(selection);
});
it('cached render errors are refreshed when generation changes and actions still report fresh controller failures',()=>{
  const {player,update}=fixture();player.cursorPlaybackChoices.mockImplementation(()=>{throw new Error('Cursor unavailable.');});
  render(<Transport player={player} measures={64} busy={false} cursor={cursor} selection={selection}/>);fireEvent.click(screen.getByText(/^More playback/,{selector:'summary'}));expect(screen.getByText('Cursor unavailable.')).toBeVisible();
  player.cursorPlaybackChoices.mockImplementation(()=>[{generation:player.generation,occurrenceIndex:0,startTick:0}]);player.generation=8;update({time:100});
  expect(screen.queryByText('Cursor unavailable.')).not.toBeInTheDocument();fireEvent.click(screen.getByText('Selected playback',{selector:'summary'}));
  player.playFromCursor.mockImplementation(()=>{throw new Error('Choose a current performed occurrence.');});fireEvent.click(screen.getByRole('button',{name:'Play from cursor'}));expect(screen.getByRole('alert')).toHaveTextContent('Choose a current performed occurrence.');expect(player.playFromCursor).toHaveBeenCalledWith(cursor,{generation:8,occurrenceIndex:0,startTick:0});
});
it('real early ready acknowledgement recovers choices after prepare settles without changing cursor selection or generation',async()=>{
  let receive!:(status:NativeAudioStatus)=>void,finishPrepare!:()=>void;
  const pendingPrepare=new Promise<void>(resolve=>{finishPrepare=resolve;});
  const bridge:NativeAudioBridge={prepare:vi.fn(()=>pendingPrepare),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const player=new NativePlaybackController({bridge,onEdit:()=>{}}),cursorQueries=vi.spyOn(player,'cursorPlaybackChoices'),passageQueries=vi.spyOn(player,'selectionPlaybackChoices');
  const view=render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={selection}/>);
  try{
    const project=blankProject();let loading!:Promise<void>;
    await act(async()=>{loading=player.loadDocument(project,buildDocument(project));await Promise.resolve();});
    await waitFor(()=>expect(bridge.prepare).toHaveBeenCalledTimes(1));
    const generation=player.generation,early:NativeAudioStatus={generation,ready:true,playing:false,tick:0,seconds:0,durationSeconds:8,speed:1,metronome:false,practice:player.getState().practice,loop:null,range:null,error:null,deviceId:null};
    act(()=>receive(early));expect(player.getState().ready).toBe(true);expect(player.playbackOccurrences()).toEqual([]);
    fireEvent.click(screen.getByText('More playback',{selector:'summary'}));fireEvent.click(screen.getByText('Selected playback',{selector:'summary'}));
    expect(screen.getByRole('button',{name:'Play from cursor'})).toBeDisabled();expect(screen.getByRole('button',{name:'Play selection'})).toBeDisabled();
    await act(async()=>{finishPrepare();await loading;});
    expect(player.generation).toBe(generation);expect(player.getState().ready).toBe(true);expect(player.playbackOccurrences()).toHaveLength(4);
    act(()=>receive({...early,tick:240,seconds:.125}));
    expect(screen.getByLabelText('Cursor occurrence')).toHaveValue('0');expect(screen.getByLabelText('Selection occurrence')).toHaveValue('0');
    expect(screen.getByRole('button',{name:'Play from cursor'})).toBeEnabled();expect(screen.getByRole('button',{name:'Play selection'})).toBeEnabled();
    cursorQueries.mockClear();passageQueries.mockClear();act(()=>receive({...early,tick:480,seconds:.25}));
    expect(cursorQueries).not.toHaveBeenCalled();expect(passageQueries).not.toHaveBeenCalled();
  }finally{view.unmount();player.destroy();}
});
