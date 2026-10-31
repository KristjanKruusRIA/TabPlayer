// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ScoreErrorsPanel } from './ScoreErrorsPanel';
import type { ScoreError } from './score-errors';

afterEach(cleanup);
const errors:ScoreError[]=[
  {track:0,staff:0,bar:1,voice:0,beat:0,kind:'incomplete',ticks:960,place:'Guitar'},
  {track:1,staff:1,bar:3,voice:1,beat:2,kind:'overfull',ticks:480,place:'Piano · Staff 2'},
];

it('lists each error and selects the first beat of its voice',()=>{
  const onSelect=vi.fn();
  render(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={onSelect}/>);
  expect(screen.getByText('Score errors (2)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Measure 4 · Piano · Staff 2 · Voice 2: 1/2 quarter note too long'}));
  expect(onSelect).toHaveBeenCalledWith({track:1,staff:1,bar:3,voice:1,beat:2});
  expect(screen.getByRole('button',{name:'Measure 2 · Guitar · Voice 1: 1 quarter note missing'})).toBeInTheDocument();
});

it('reports a complete score and toggles marking',()=>{
  const onMark=vi.fn();
  render(<ScoreErrorsPanel errors={[]} mark onMark={onMark} onSelect={()=>{}}/>);
  expect(screen.getByText('Every measure is complete.')).toBeInTheDocument();
  expect(screen.queryByRole('list',{name:'Score errors'})).toBeNull();
  const box=screen.getByRole('checkbox',{name:'Mark errors in the score'});
  expect(box).toBeChecked();
  fireEvent.click(box);
  expect(onMark).toHaveBeenCalledWith(false);
});

it('names errors on tracks the score does not show',()=>{
  render(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={()=>{}} shownTracks={[0]}/>);
  expect(screen.getByRole('button',{name:'Measure 4 · Piano · Staff 2 · Voice 2: 1/2 quarter note too long (track not shown)'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Measure 2 · Guitar · Voice 1: 1 quarter note missing'})).toBeInTheDocument();
});

it('opens for a score that starts with errors and then leaves opening to the user',()=>{
  const view=render(<ScoreErrorsPanel errors={[]} mark onMark={()=>{}} onSelect={()=>{}}/>),details=view.container.querySelector('details')!;
  expect(details.open).toBe(false);
  view.rerender(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={()=>{}}/>);
  expect(details.open).toBe(false);
  cleanup();
  const first=render(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={()=>{}}/>);
  expect(first.container.querySelector('details')!.open).toBe(true);
});

it('offers one repair per error: rests for a short voice, trimming for a long one',()=>{
  const onFit=vi.fn();
  render(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={()=>{}} onFit={onFit}/>);
  fireEvent.click(screen.getByRole('button',{name:'Fill with rests: measure 2, Guitar, voice 1'}));
  expect(onFit).toHaveBeenLastCalledWith(errors[0]);
  fireEvent.click(screen.getByRole('button',{name:'Trim to fit: measure 4, Piano · Staff 2, voice 2'}));
  expect(onFit).toHaveBeenLastCalledWith(errors[1]);
  expect(onFit).toHaveBeenCalledTimes(2);
});

it('offers no repair when editing is not available',()=>{
  render(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={()=>{}}/>);
  expect(screen.queryByRole('button',{name:/Fill with rests|Trim to fit/})).toBeNull();
});

it('refuses a repair while busy without disabling the focused button',()=>{
  const onFit=vi.fn();
  render(<ScoreErrorsPanel errors={errors} mark onMark={()=>{}} onSelect={()=>{}} onFit={onFit} busy/>);
  const button=screen.getByRole('button',{name:'Fill with rests: measure 2, Guitar, voice 1'});
  expect(button).not.toBeDisabled();expect(button).toHaveAttribute('aria-disabled','true');
  button.focus();fireEvent.click(button);
  expect(onFit).not.toHaveBeenCalled();expect(button).toHaveFocus();
});

it('says what Trim to fit removes before it is pressed',()=>{
  const trimmed:ScoreError={...errors[1],trim:{beats:2,notes:3}},onFit=vi.fn();
  render(<ScoreErrorsPanel errors={[trimmed]} mark onMark={()=>{}} onSelect={()=>{}} onFit={onFit}/>);
  const button=screen.getByRole('button',{name:'Trim to fit: measure 4, Piano · Staff 2, voice 2, removes 2 beats and 3 notes'});
  expect(button).toHaveTextContent('removes 2 beats and 3 notes');
  fireEvent.click(button);expect(onFit).toHaveBeenCalledWith(trimmed);
});

it('moves focus to the repair now in the repaired row\'s place, or to the heading when none is left',()=>{
  const third:ScoreError={...errors[0],bar:5},rows=[errors[0],errors[1],third];
  const view=render(<ScoreErrorsPanel errors={rows} mark onMark={()=>{}} onSelect={()=>{}} onFit={()=>{}}/>);
  const repairs=()=>screen.getAllByRole('button',{name:/^(Fill with rests|Trim to fit):/});
  repairs()[1].focus();fireEvent.click(repairs()[1]);
  view.rerender(<ScoreErrorsPanel errors={[rows[0],third]} mark onMark={()=>{}} onSelect={()=>{}} onFit={()=>{}}/>);
  expect(repairs()[1]).toHaveFocus();
  fireEvent.click(repairs()[1]);
  view.rerender(<ScoreErrorsPanel errors={[rows[0]]} mark onMark={()=>{}} onSelect={()=>{}} onFit={()=>{}}/>);
  expect(repairs()[0]).toHaveFocus();
  fireEvent.click(repairs()[0]);
  view.rerender(<ScoreErrorsPanel errors={[]} mark onMark={()=>{}} onSelect={()=>{}} onFit={()=>{}}/>);
  expect(screen.getByText('Score errors (0)')).toHaveFocus();
});
