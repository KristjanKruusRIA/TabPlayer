// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
import type { PlaybackState } from './audio/types';
import { DEFAULT_PRACTICE } from './audio/practice-types';

const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
const choices=[{generation:7,occurrenceIndex:0,startTick:0},{generation:7,occurrenceIndex:1,startTick:3840}];
const passage={generation:7,startOccurrence:0,endOccurrence:1,startTick:0,endTick:7680};
function playback(patch:Partial<PlaybackState>={}):PlaybackState{return {ready:true,playing:false,time:1000,endTime:6000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null,error:null,...patch};}
function fixture(initial=playback()){
  let state=initial;const listeners=new Set<()=>void>();
  const player={generation:7,getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setPractice:vi.fn(),stepKeyShift:vi.fn(),setKeyShift:vi.fn(),cursorPlaybackChoices:()=>choices,selectionPlaybackChoices:()=>[passage],playbackOccurrences:()=>[0,1].map(occurrence=>({bar:0,occurrence,startTick:occurrence*3840,endTick:(occurrence+1)*3840,startMs:occurrence*2000,endMs:(occurrence+1)*2000,meterNumerator:4,meterDenominator:4,clickTicks:[]})),playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn()};
  return {player,update:(next:PlaybackState)=>act(()=>{state=next;for(const listener of listeners)listener();})};
}
const more=()=>screen.getByText(/^More playback/,{selector:'summary'});
afterEach(()=>cleanup());
it('workstation More playback reveals the real seek loop and repeated-occurrence controls',()=>{
  const {player}=fixture();render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={{kind:'bars',tracks:[0],firstBar:0,lastBar:0}}/>);
  expect(screen.getByRole('button',{name:'Play'})).toBeVisible();expect(screen.getByRole('button',{name:'Stop'})).toBeVisible();expect(screen.getByLabelText('Speed')).toBeVisible();expect(screen.getByLabelText('Metronome')).toBeVisible();expect(screen.getByLabelText('Practice playback')).toHaveTextContent('120 BPM');const summary=more();expect(summary.closest('details')).not.toHaveAttribute('open');expect(screen.getByLabelText('Seek measure')).not.toBeVisible();
  fireEvent.click(summary);expect(screen.getByLabelText('Seek measure')).toBeVisible();fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenCalledWith(2);
  fireEvent.change(screen.getByLabelText('Loop start'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Loop end'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(1,3);fireEvent.click(screen.getByText('Selected playback',{selector:'summary'}));fireEvent.change(screen.getByLabelText('Cursor occurrence'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Play from cursor'}));expect(player.playFromCursor).toHaveBeenCalledWith(cursor,choices[1]);fireEvent.click(within(document.querySelector<HTMLElement>('.transport-more')!).getByRole('button',{name:'Loop selection'}));expect(player.loopSelection).toHaveBeenCalledWith({kind:'bars',tracks:[0],firstBar:0,lastBar:0},passage);expect(player.play).not.toHaveBeenCalled();
});
it('workstation More playback retains acknowledged passage count-in and practice notices behind the disclosure',()=>{
  const state=playback({playing:true,range:{startTick:0,endTick:7680},practiceNotice:'fixed_tempo_backing_range'});state.practice={...state.practice,phase:'countIn',countInRemaining:3};const {player}=fixture(state);render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);const summary=more();expect(screen.getByLabelText('Selected playback range')).not.toBeVisible();expect(screen.getByLabelText('Count-in')).not.toBeVisible();fireEvent.click(summary);expect(screen.getByLabelText('Selected playback range')).toBeVisible();expect(screen.getByLabelText('Selected playback range')).toHaveAttribute('data-end-tick','7680');expect(screen.getByLabelText('Count-in')).toHaveTextContent('3 pulses remaining');expect(screen.getByText('Fixed tempo reset to 100% speed because it would stretch the backing audio outside 10% to 300%.')).toBeVisible();expect(player.getState()).toBe(state);
});
it('workstation More playback Escape restores summary focus and Space does not invoke playback',()=>{
  const {player}=fixture(),ancestor=vi.fn();render(<div onKeyDown={ancestor}><Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/></div>);const summary=more();fireEvent.click(summary);const seek=screen.getByLabelText('Seek measure');seek.focus();fireEvent.keyDown(seek,{key:'Escape'});expect(summary.closest('details')).not.toHaveAttribute('open');expect(summary).toHaveFocus();expect(ancestor).not.toHaveBeenCalled();fireEvent.keyDown(summary,{key:' '});expect(player.play).not.toHaveBeenCalled();expect(player.pause).not.toHaveBeenCalled();expect(player.stop).not.toHaveBeenCalled();
});
it('workstation primary Pause and Stop remain available during document and practice transitions',()=>{
  const {player}=fixture(playback({playing:true,practicePending:true}));render(<Transport player={player} measures={4} busy cursor={cursor} selection={null}/>);expect(more()).toBeVisible();expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();expect(screen.getByRole('button',{name:'Slower'})).toHaveAttribute('aria-disabled','true');expect(screen.getByLabelText('Metronome')).toHaveAttribute('aria-disabled','true');fireEvent.click(screen.getByRole('button',{name:'Pause'}));fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(player.pause).toHaveBeenCalledOnce();expect(player.stop).toHaveBeenCalledOnce();
});
it('workstation hidden playback errors mark More playback while the native failure remains visible',()=>{
  const {player}=fixture(playback({error:'Audio device disconnected'}));render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);const summary=more();expect(summary).toHaveTextContent('More playback · Error');expect(summary.closest('details')).not.toHaveAttribute('open');expect(screen.getByRole('alert')).toBeVisible();expect(screen.getByRole('alert')).toHaveTextContent('Audio device disconnected');
});
it('loop, speed, click and position are on the bar itself; only seek and passage choices wait behind More playback',()=>{
  const {player}=fixture();render(<Transport player={player} measures={24} busy={false} cursor={cursor} selection={null}/>);
  const bar=screen.getByRole('group',{name:'Transport'}),more=()=>screen.getByText(/^More playback/,{selector:'summary'}).closest('details')!;
  for(const name of ['Loop start','Loop end','Metronome'])expect(screen.getByLabelText(name)).toBeVisible();
  expect(screen.getByRole('group',{name:'Loop'})).toContainElement(screen.getByRole('button',{name:'Loop'}));
  expect(screen.getByRole('group',{name:'Speed'})).toHaveTextContent('100%');expect(bar).toHaveTextContent('Bar 1of 24');
  expect(more()).not.toHaveAttribute('open');expect(more().contains(screen.getByLabelText('Seek measure'))).toBe(true);expect(more().contains(screen.getByLabelText('Loop start'))).toBe(false);
  fireEvent.change(screen.getByLabelText('Loop start'),{target:{value:'9'}});fireEvent.change(screen.getByLabelText('Loop end'),{target:{value:'12'}});fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(8,11);
});
it('speed steps through the preset list and stops at its ends',()=>{
  const low=fixture(playback({speed:10}));render(<Transport player={low.player} measures={4} busy={false} cursor={cursor} selection={null}/>);
  expect(screen.getByRole('button',{name:'Slower'})).toHaveAttribute('aria-disabled','true');fireEvent.click(screen.getByRole('button',{name:'Slower'}));expect(low.player.setSpeed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Faster'}));expect(low.player.setSpeed).toHaveBeenLastCalledWith(25);cleanup();
  const high=fixture(playback({speed:300}));render(<Transport player={high.player} measures={4} busy={false} cursor={cursor} selection={null}/>);
  expect(screen.getByRole('button',{name:'Faster'})).toHaveAttribute('aria-disabled','true');fireEvent.click(screen.getByRole('button',{name:'Faster'}));expect(high.player.setSpeed).not.toHaveBeenCalled();
});
it('a focused Loop, Slower, Speed or Metronome keeps focus when the document goes busy and refuses until it is idle',()=>{
  const {player}=fixture(),view=render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);
  for(const control of [screen.getByRole('button',{name:'Loop'}),screen.getByRole('button',{name:'Slower'}),screen.getByLabelText('Metronome'),screen.getByLabelText('Speed percentage')]){
    control.focus();view.rerender(<Transport player={player} measures={4} busy cursor={cursor} selection={null}/>);
    expect(control).not.toBeDisabled();expect(control).toHaveFocus();fireEvent.click(control);
    view.rerender(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);
  }
  expect(player.setLoop).not.toHaveBeenCalled();expect(player.setSpeed).not.toHaveBeenCalled();expect(player.setPractice).not.toHaveBeenCalled();
});
it('the scrubber seeks to a bar: a key step at once, a drag once on release, and nothing while the document is busy',()=>{
  const {player}=fixture(),view=render(<Transport player={player} measures={24} busy={false} cursor={cursor} selection={null}/>),scrub=()=>screen.getByRole('slider',{name:'Playback position'});
  expect(scrub()).toHaveValue('1');expect(scrub()).toHaveAttribute('aria-valuetext','Bar 1 of 24');
  fireEvent.change(scrub(),{target:{value:'5'}});expect(player.seekToMeasure).toHaveBeenCalledTimes(1);expect(player.seekToMeasure).toHaveBeenLastCalledWith(4);
  fireEvent.pointerDown(scrub());fireEvent.change(scrub(),{target:{value:'9'}});fireEvent.change(scrub(),{target:{value:'12'}});expect(player.seekToMeasure).toHaveBeenCalledTimes(1);expect(scrub()).toHaveAttribute('aria-valuetext','Bar 12 of 24');
  fireEvent.pointerUp(scrub());expect(player.seekToMeasure).toHaveBeenCalledTimes(2);expect(player.seekToMeasure).toHaveBeenLastCalledWith(11);
  view.rerender(<Transport player={player} measures={24} busy cursor={cursor} selection={null}/>);expect(scrub()).toHaveAttribute('aria-disabled','true');expect(scrub()).not.toBeDisabled();
  fireEvent.change(scrub(),{target:{value:'20'}});expect(player.seekToMeasure).toHaveBeenCalledTimes(2);
});
it('stylesheet rules that jsdom cannot apply: the bar stays one row, the popover opens upward, labels give way to glyphs under 1181px, the scrubber is a thin overlay',async()=>{
  const {readFileSync}=await import('node:fs'),css=readFileSync('src/shell/transport.css','utf8'),shell=readFileSync('src/workstation/workstation-shell.css','utf8');
  expect(css).toMatch(/\.transport>\.transport-primary\s*\{[^}]*flex-wrap:nowrap/);
  expect(css).toMatch(/\.transport-more-content\s*\{[^}]*bottom:calc\(100% \+ 1px\)/);
  expect(css).toMatch(/@media \(max-width:1180px\)[\s\S]*\.transport-label\s*\{[^}]*clip-path:inset\(50%\)/);
  expect(css).toMatch(/input\.transport-scrub\s*\{[^}]*height:10px[^}]*min-height:0/);
  expect(css).not.toMatch(/\.transport[^{}]*output\s*\{[^}]*min-width:135px/);
  expect(shell).toMatch(/\.toolbar\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/);
});
it('the toolbar feedback line reserves its height so the More playback panel opens below it (THE-187)',()=>{
  const {player,update}=fixture(),height=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return {height:this.classList.contains('transport-messages')?16.2:0} as DOMRect;});
  const real=window.getComputedStyle.bind(window),style=vi.spyOn(window,'getComputedStyle').mockImplementation((node,pseudo)=>(node as HTMLElement).classList?.contains('transport-messages')?({position:'absolute'}) as CSSStyleDeclaration:real(node,pseudo));
  try{render(<Transport player={player} measures={4} busy={false} cursor={cursor} selection={null}/>);const root=screen.getByRole('group',{name:'Transport'});expect(root.style.getPropertyValue('--transport-messages-h')).toBe('0px');
    update(playback({error:'Loop end must follow its start.'}));expect(root.style.getPropertyValue('--transport-messages-h')).toBe('17px');
    update(playback());expect(root.style.getPropertyValue('--transport-messages-h')).toBe('0px');}
  finally{height.mockRestore();style.mockRestore();}
});
