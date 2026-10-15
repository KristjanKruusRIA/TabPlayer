// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { DirectionsPanel } from './DirectionsPanel';
import { applyDirectionEdit } from './directions';
import { music, target } from './fixtures';

afterEach(cleanup);
it('offers all nineteen directions and applies the chosen signs to the selected measure',()=>{
  const score=music();score.masterBars[0].directions=new Set([model.Direction.TargetSegno]);
  render(<DirectionsPanel score={score} target={target} busy={false} onEdit={edit=>{applyDirectionEdit(score,edit);}}/>);
  expect(screen.getAllByRole('checkbox')).toHaveLength(19);
  fireEvent.click(screen.getByLabelText('Fine'));fireEvent.click(screen.getByLabelText('D.C. al Fine'));
  fireEvent.click(screen.getByRole('button',{name:'Apply directions'}));expect([...score.masterBars[0].directions!].sort((a,b)=>a-b)).toEqual([0,1,8]);
  expect(score.masterBars[1].directions).toBeNull();
});

it('refreshes the selection and permits removing all directions',()=>{
  const score=music();score.masterBars[1].directions=new Set([model.Direction.TargetCoda]);
  const props={score,target,busy:false,onEdit:(edit:Parameters<typeof applyDirectionEdit>[1])=>{applyDirectionEdit(score,edit);}},view=render(<DirectionsPanel {...props}/>);
  fireEvent.click(screen.getByLabelText('Fine'));view.rerender(<DirectionsPanel {...props} target={{...target,bar:1}}/>);
  expect(screen.getByLabelText('Fine')).not.toBeChecked();expect(screen.getByLabelText('Coda')).toBeChecked();
  fireEvent.click(screen.getByLabelText('Coda'));fireEvent.click(screen.getByRole('button',{name:'Apply directions'}));expect(score.masterBars[1].directions).toBeNull();
  view.rerender(<DirectionsPanel {...props} busy/>);expect(screen.getByLabelText('Fine')).toBeDisabled();
});
