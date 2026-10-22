// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ViewDefaultsPanel } from './ViewDefaultsPanel';
import { standardViewDefaults } from './view-defaults';

afterEach(cleanup);
const current={zoom:150,trackView:{kind:'all'} as const,scoreDisplay:{layout:'verticalPage',zoomMode:'fitWidth'} as const};

it('edits and saves the default view without changing the open score view',()=>{
  const onSave=vi.fn(()=>true);
  render(<ViewDefaultsPanel current={current} load={()=>standardViewDefaults} onSave={onSave}/>);
  fireEvent.change(screen.getByLabelText('Default layout'),{target:{value:'grid'}});
  fireEvent.change(screen.getByLabelText('Default zoom (%)'),{target:{value:'80'}});
  fireEvent.change(screen.getByLabelText('Default zoom mode'),{target:{value:'fitPage'}});
  fireEvent.change(screen.getByLabelText('Default tracks'),{target:{value:'all'}});
  fireEvent.click(screen.getByRole('button',{name:'Save default view'}));
  expect(onSave).toHaveBeenCalledWith({layout:'grid',zoomMode:'fitPage',zoom:80,tracks:'all'});
  expect(screen.getByRole('status')).toHaveTextContent('Saved. Scores opened or created from now on start in this view.');
});

it('copies the current view, offers fit page only for page layouts, and refuses an out-of-range zoom',()=>{
  const onSave=vi.fn(()=>true);
  render(<ViewDefaultsPanel current={current} load={()=>standardViewDefaults} onSave={onSave}/>);
  expect(screen.getByRole('option',{name:'Fit page'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Use current view'}));
  expect(screen.getByLabelText('Default layout')).toHaveValue('verticalPage');
  expect(screen.getByRole('option',{name:'Fit page'})).toBeEnabled();
  expect(screen.getByLabelText('Default zoom (%)')).toHaveValue(150);
  fireEvent.change(screen.getByLabelText('Default zoom (%)'),{target:{value:'400'}});
  expect(screen.getByRole('button',{name:'Save default view'})).toBeDisabled();
  expect(screen.getByText('Zoom must be 25–300%.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Default layout'),{target:{value:'parchment'}});
  fireEvent.change(screen.getByLabelText('Default zoom (%)'),{target:{value:'120'}});
  fireEvent.click(screen.getByRole('button',{name:'Reset to standard view'}));
  fireEvent.click(screen.getByRole('button',{name:'Save default view'}));
  expect(onSave).toHaveBeenLastCalledWith(standardViewDefaults);
});

it('turns fit page into fit width when a screen layout is chosen, and reports a failed save',()=>{
  render(<ViewDefaultsPanel current={current} load={()=>({layout:'verticalPage',zoomMode:'fitPage',zoom:100,tracks:'selected'})} onSave={()=>false}/>);
  fireEvent.change(screen.getByLabelText('Default layout'),{target:{value:'horizontalScreen'}});
  expect(screen.getByLabelText('Default zoom mode')).toHaveValue('fitWidth');
  fireEvent.click(screen.getByRole('button',{name:'Save default view'}));
  expect(screen.getByRole('status')).toHaveTextContent('This default view could not be stored, so it lasts only until TabPlayer closes.');
});

it('makes a typed zoom manual, as the score display controls do, and explains an unavailable fit page',()=>{
  render(<ViewDefaultsPanel current={current} load={()=>({layout:'verticalPage',zoomMode:'fitWidth',zoom:100,tracks:'selected'})} onSave={()=>true}/>);
  fireEvent.change(screen.getByLabelText('Default zoom (%)'),{target:{value:'137.5'}});
  expect(screen.getByLabelText('Default zoom mode')).toHaveValue('manual');
  expect(screen.getByLabelText('Default zoom (%)')).toHaveAttribute('step','any');
  fireEvent.change(screen.getByLabelText('Default zoom (%)'),{target:{value:'10'}});
  expect(screen.getByLabelText('Default zoom (%)')).toHaveAccessibleDescription('Zoom must be 25–300%.');
  fireEvent.change(screen.getByLabelText('Default layout'),{target:{value:'parchment'}});
  expect(screen.getByLabelText('Default zoom mode')).toHaveAccessibleDescription('Fit page is available in page layouts.');
});
