// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MeasureTransformPanel } from './MeasureTransformPanel';
import type { MeasureCommand } from './measures-types';
import { music } from './fixtures';
afterEach(cleanup);
it('uses_one_based_labels_and_dispatches_exact_before_after_inclusive_envelopes',()=>{
  const commands:MeasureCommand[]=[];render(<MeasureTransformPanel score={music()} bar={1} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByText('Measure 2 of 4')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('Measures to insert'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Insert before'}));fireEvent.click(screen.getByRole('button',{name:'Insert after'}));fireEvent.change(screen.getByLabelText('First measure to remove'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Last measure to remove'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Remove measure range'}));
  expect(commands).toEqual([{type:'insertMeasures',beforeBar:1,count:2},{type:'insertMeasures',beforeBar:2,count:2},{type:'removeMeasures',firstBar:1,lastBar:2}]);
});
it('invalid_counts_ranges_and_removing_all_show_errors_without_dispatch',()=>{
  const commands:MeasureCommand[]=[];render(<MeasureTransformPanel score={music()} bar={0} busy={false} onEdit={edit=>commands.push(edit)}/>);
  for(const count of ['','0','1001','1.5']){fireEvent.change(screen.getByLabelText('Measures to insert'),{target:{value:count}});fireEvent.click(screen.getByRole('button',{name:'Insert before'}));expect(screen.getByRole('alert')).toHaveTextContent(/1.*1000/i);}
  fireEvent.change(screen.getByLabelText('First measure to remove'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('Last measure to remove'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Remove measure range'}));expect(screen.getByRole('alert')).toHaveTextContent(/keep at least one/i);
  fireEvent.change(screen.getByLabelText('First measure to remove'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('Last measure to remove'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Remove measure range'}));expect(screen.getByRole('alert')).toHaveTextContent(/inclusive/i);expect(commands).toEqual([]);
});
it('busy_blocks_every_control_and_selection_change_resets_the_draft',()=>{
  const score=music(),props={score,bar:1,busy:false,onEdit:()=>{}},view=render(<MeasureTransformPanel {...props}/>);fireEvent.change(screen.getByLabelText('Measures to insert'),{target:{value:'3'}});view.rerender(<MeasureTransformPanel {...props} bar={2}/>);expect(screen.getByLabelText('Measures to insert')).toHaveValue(1);expect(screen.getByLabelText('First measure to remove')).toHaveValue(3);expect(screen.getByLabelText('Last measure to remove')).toHaveValue(3);view.rerender(<MeasureTransformPanel {...props} busy/>);for(const element of [...screen.getAllByRole('spinbutton'),...screen.getAllByRole('button')])expect(element).toBeDisabled();
});
