// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
import type { PlaybackState } from './audio/types';
import { DEFAULT_PRACTICE } from './audio/practice-types';

const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
const choices=[{generation:7,occurrenceIndex:0,startTick:0},{generation:7,occurrenceIndex:1,startTick:3840}];
const passage={generation:7,startOccurrence:0,endOccurrence:1,startTick:0,endTick:7680};
function playback(patch:Partial<PlaybackState>={}):PlaybackState{return {ready:true,playing:false,time:1000,endTime:6000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null,...patch};}
function fixture(initial=playback()){
  let state=initial;const listeners=new Set<()=>void>();
  const player={generation:7,getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setPractice:vi.fn(),cursorPlaybackChoices:()=>choices,selectionPlaybackChoices:()=>[passage],playbackOccurrences:()=>[0,1].map(occurrence=>({bar:0,occurrence,startTick:occurrence*3840,endTick:(occurrence+1)*3840,startMs:occurrence*2000,endMs:(occurrence+1)*2000,meterNumerator:4,meterDenominator:4,clickTicks:[]})),playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn()};
  return {player,update:(next:PlaybackState)=>act(()=>{state=next;for(const listener of listeners)listener();})};
}
const more=()=>screen.getByText(/^More playback/,{selector:'summary'});
afterEach(()=>cleanup());
it('workstation More playback reveals the real seek loop and repeated-occurrence controls',()=>{
  const {player}=fixture();render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={{kind:'bars',tracks:[0],firstBar:0,lastBar:0}}/>);
  expect(screen.getByRole('button',{name:'Play'})).toBeVisible();expect(screen.getByRole('button',{name:'Stop'})).toBeVisible();expect(screen.getByLabelText('Speed')).toBeVisible();expect(screen.getByLabelText('Metronome')).toBeVisible();expect(screen.getByLabelText('Practice playback')).toHaveTextContent('120 BPM');const summary=more();expect(summary.closest('details')).not.toHaveAttribute('open');expect(screen.getByLabelText('Seek measure')).not.toBeVisible();
  fireEvent.click(summary);expect(screen.getByLabelText('Seek measure')).toBeVisible();fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenCalledWith(2);
  fireEvent.change(screen.getByLabelText('Loop start'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Loop end'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(1,3);fireEvent.click(screen.getByText('Selected playback',{selector:'summary'}));fireEvent.change(screen.getByLabelText('Cursor occurrence'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Play from cursor'}));expect(player.playFromCursor).toHaveBeenCalledWith(cursor,choices[1]);fireEvent.click(screen.getByRole('button',{name:'Loop selection'}));expect(player.loopSelection).toHaveBeenCalledWith({kind:'bars',tracks:[0],firstBar:0,lastBar:0},passage);expect(player.play).not.toHaveBeenCalled();
});
it('workstation More playback retains acknowledged passage count-in and practice notices behind the disclosure',()=>{
  const state=playback({playing:true,range:{startTick:0,endTick:7680},practiceNotice:'Progressive speed is capped.'});state.practice={...state.practice,phase:'countIn',countInRemaining:3};const {player}=fixture(state);render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);const summary=more();expect(screen.getByLabelText('Selected playback range')).not.toBeVisible();expect(screen.getByLabelText('Count-in')).not.toBeVisible();fireEvent.click(summary);expect(screen.getByLabelText('Selected playback range')).toBeVisible();expect(screen.getByLabelText('Selected playback range')).toHaveAttribute('data-end-tick','7680');expect(screen.getByLabelText('Count-in')).toHaveTextContent('3 pulses remaining');expect(screen.getByText('Progressive speed is capped.')).toBeVisible();expect(player.getState()).toBe(state);
});
it('workstation More playback Escape restores summary focus and Space does not invoke playback',()=>{
  const {player}=fixture(),ancestor=vi.fn();render(<div onKeyDown={ancestor}><Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/></div>);const summary=more();fireEvent.click(summary);const seek=screen.getByLabelText('Seek measure');seek.focus();fireEvent.keyDown(seek,{key:'Escape'});expect(summary.closest('details')).not.toHaveAttribute('open');expect(summary).toHaveFocus();expect(ancestor).not.toHaveBeenCalled();fireEvent.keyDown(summary,{key:' '});expect(player.play).not.toHaveBeenCalled();expect(player.pause).not.toHaveBeenCalled();expect(player.stop).not.toHaveBeenCalled();
});
it('workstation primary Pause and Stop remain available during document and practice transitions',()=>{
  const {player}=fixture(playback({playing:true,practicePending:true}));render(<Transport player={player} measures={4} busy cursor={cursor} selection={null}/>);expect(more()).toBeVisible();expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();expect(screen.getByLabelText('Speed')).toBeDisabled();expect(screen.getByLabelText('Metronome')).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Pause'}));fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(player.pause).toHaveBeenCalledOnce();expect(player.stop).toHaveBeenCalledOnce();
});
it('workstation hidden playback errors mark More playback while the native failure remains visible',()=>{
  const {player}=fixture(playback({error:'Audio device disconnected'}));render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);const summary=more();expect(summary).toHaveTextContent('More playback · Error');expect(summary.closest('details')).not.toHaveAttribute('open');expect(screen.getByRole('alert')).toBeVisible();expect(screen.getByRole('alert')).toHaveTextContent('Audio device disconnected');
});
