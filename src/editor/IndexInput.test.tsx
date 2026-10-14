// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { IndexInput } from './IndexInput';

afterEach(cleanup);

it('rejects_fractional_and_empty_selection_drafts',()=>{
  const onValue=vi.fn();
  render(<IndexInput label="Measure" value={1} min={1} max={4} onValue={onValue}/>);
  const input=screen.getByLabelText('Measure');
  for (const value of ['', '1.5','NaN','Infinity','1e309','0','-1','5']) {
    fireEvent.change(input,{target:{value}});
    expect(onValue).not.toHaveBeenCalled();
  }
  fireEvent.change(input,{target:{value:'2'}});
  expect(onValue).toHaveBeenLastCalledWith(2);
});

it('retains an empty draft until the selected value changes',()=>{
  const onValue=vi.fn();
  const view=render(<IndexInput label="Beat" value={2} min={1} max={4} onValue={onValue}/>);
  fireEvent.change(screen.getByLabelText('Beat'),{target:{value:''}});
  view.rerender(<IndexInput label="Beat" value={2} min={1} max={4} onValue={onValue}/>);
  expect(screen.getByLabelText('Beat')).toHaveValue(null);
  view.rerender(<IndexInput label="Beat" value={3} min={1} max={4} onValue={onValue}/>);
  expect(screen.getByLabelText('Beat')).toHaveValue(3);
});

it('exposes whole-number bounds and disables editing while busy',()=>{
  render(<IndexInput label="Voice" value={1} min={1} max={4} disabled onValue={()=>{}}/>);
  const input=screen.getByLabelText('Voice');
  expect(input).toBeDisabled();
  expect(input).toHaveAttribute('min','1');
  expect(input).toHaveAttribute('max','4');
  expect(input).toHaveAttribute('step','1');
});
