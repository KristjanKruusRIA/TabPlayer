// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SelectionPlaybackControls,type SelectionPlaybackControlsProps } from './SelectionPlaybackControls';

afterEach(cleanup);
const cursorChoices=[{generation:7,occurrenceIndex:0,startTick:0},{generation:7,occurrenceIndex:2,startTick:7680}];
const passageChoices=[{generation:7,startOccurrence:0,endOccurrence:3,startTick:0,endTick:15360},{generation:7,startOccurrence:2,endOccurrence:3,startTick:7680,endTick:15360}];
function props():SelectionPlaybackControlsProps {
  return {cursorChoices,passageChoices,cursorChoice:null,passageChoice:null,disabled:false,occurrences:[{bar:0,occurrence:0,startTick:0,endTick:3840,startMs:0,endMs:2000,meterNumerator:4,meterDenominator:4},{bar:1,occurrence:0,startTick:3840,endTick:7680,startMs:2000,endMs:4000,meterNumerator:4,meterDenominator:4},{bar:0,occurrence:1,startTick:7680,endTick:11520,startMs:4000,endMs:6000,meterNumerator:4,meterDenominator:4},{bar:2,occurrence:0,startTick:11520,endTick:15360,startMs:6000,endMs:8000,meterNumerator:4,meterDenominator:4}],onCursorChoice:vi.fn(),onPassageChoice:vi.fn(),onPlayCursor:vi.fn(),onPlaySelection:vi.fn(),onLoopSelection:vi.fn()};
}
const reveal=()=>fireEvent.click(screen.getByText('Selected playback'));
it('controls_require_visible_occurrence_choice_and_emit_only_intentions',()=>{
  const p=props(),view=render(<SelectionPlaybackControls {...p}/>);reveal();
  expect(screen.getByLabelText('Cursor occurrence')).toHaveValue('');expect(screen.getByLabelText('Selection occurrence')).toHaveValue('');
  expect(screen.getAllByRole('option',{name:'Choose performed occurrence'})).toHaveLength(2);
  for(const name of ['Play from cursor','Play selection','Loop selection'])expect(screen.getByRole('button',{name})).toBeDisabled();
  expect(screen.getByText('Plays the bounding time passage with the current full mix.')).toBeVisible();
  expect(screen.getByText(/actual performed route/i)).toBeVisible();
  expect(screen.getByRole('option',{name:'Measure 1, occurrence 2 → measure 3, occurrence 1'})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Cursor occurrence'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('Selection occurrence'),{target:{value:'1'}});
  expect(p.onCursorChoice).toHaveBeenLastCalledWith(cursorChoices[1]);expect(p.onPassageChoice).toHaveBeenLastCalledWith(passageChoices[1]);
  expect(p.onPlayCursor).not.toHaveBeenCalled();expect(p.onPlaySelection).not.toHaveBeenCalled();expect(p.onLoopSelection).not.toHaveBeenCalled();
  // Parent acceptance is required before the controlled view enables actions.
  expect(screen.getByRole('button',{name:'Play from cursor'})).toBeDisabled();
  view.rerender(<SelectionPlaybackControls {...p} cursorChoice={{...cursorChoices[1]}} passageChoice={{...passageChoices[1]}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Play from cursor'}));fireEvent.click(screen.getByRole('button',{name:'Play selection'}));fireEvent.click(screen.getByRole('button',{name:'Loop selection'}));
  expect(p.onPlayCursor).toHaveBeenCalledOnce();expect(p.onPlaySelection).toHaveBeenCalledOnce();expect(p.onLoopSelection).toHaveBeenCalledOnce();
});
it('one_candidate_auto_selects_through_parent_state_without_playing',()=>{
  const p=props(),view=render(<SelectionPlaybackControls {...p} cursorChoices={[cursorChoices[0]]} passageChoices={[passageChoices[0]]}/>);reveal();
  expect(p.onCursorChoice).toHaveBeenCalledExactlyOnceWith(cursorChoices[0]);expect(p.onPassageChoice).toHaveBeenCalledExactlyOnceWith(passageChoices[0]);
  expect(screen.getByRole('button',{name:'Play selection'})).toBeDisabled();
  view.rerender(<SelectionPlaybackControls {...p} cursorChoices={[cursorChoices[0]]} passageChoices={[passageChoices[0]]} cursorChoice={cursorChoices[0]} passageChoice={passageChoices[0]}/>);
  expect(screen.getByRole('button',{name:'Play selection'})).toBeEnabled();
  expect(p.onPlayCursor).not.toHaveBeenCalled();expect(p.onPlaySelection).not.toHaveBeenCalled();expect(p.onLoopSelection).not.toHaveBeenCalled();
});
it('disabled_or_missing_or_stale_controlled_choices_cannot_start_or_loop',()=>{
  const p=props(),view=render(<SelectionPlaybackControls {...p} cursorChoice={cursorChoices[0]} passageChoice={passageChoices[0]} disabled/>);reveal();
  for(const name of ['Play from cursor','Play selection','Loop selection']){expect(screen.getByRole('button',{name})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name}));}
  expect(p.onPlayCursor).not.toHaveBeenCalled();expect(p.onPlaySelection).not.toHaveBeenCalled();expect(p.onLoopSelection).not.toHaveBeenCalled();
  view.rerender(<SelectionPlaybackControls {...p} cursorChoice={{...cursorChoices[0],generation:6}} passageChoice={{...passageChoices[0],endTick:999}}/>);
  for(const name of ['Play from cursor','Play selection','Loop selection'])expect(screen.getByRole('button',{name})).toBeDisabled();
  view.rerender(<SelectionPlaybackControls {...p} cursorChoices={[]} passageChoices={[]} cursorChoice={cursorChoices[0]} passageChoice={passageChoices[0]}/>);
  for(const name of ['Play from cursor','Play selection','Loop selection'])expect(screen.getByRole('button',{name})).toBeDisabled();
  view.rerender(<SelectionPlaybackControls {...p} occurrences={[]} cursorChoice={cursorChoices[0]} passageChoice={passageChoices[0]}/>);
  for(const name of ['Play from cursor','Play selection','Loop selection'])expect(screen.getByRole('button',{name})).toBeDisabled();
});
