// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TrackDisplayControls } from './TrackDisplayControls';
import type { TrackView } from './view';
import type { ScoreDisplayPreferences } from './screen-view';
afterEach(cleanup);

const ids=['base/0','added/3','base/1'],names=['Guitar','Bass','Drums'];
const props=()=>({ids,names,selected:1,view:{kind:'selected'} as TrackView,zoom:100,disabled:false,onView:vi.fn(),onZoom:vi.fn()});

it('switches selected all and custom using source IDs in source order',()=>{
  const p=props(),view=render(<TrackDisplayControls {...p}/>),mode=screen.getByLabelText('Displayed tracks');
  fireEvent.change(mode,{target:{value:'all'}});expect(p.onView).toHaveBeenLastCalledWith({kind:'all'});
  view.rerender(<TrackDisplayControls {...p} view={{kind:'all'}}/>);
  fireEvent.change(mode,{target:{value:'custom'}});expect(p.onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['base/0','added/3','base/1']});
  view.rerender(<TrackDisplayControls {...p} view={{kind:'custom',trackIds:['base/1','base/0']}}/>);
  fireEvent.change(mode,{target:{value:'selected'}});expect(p.onView).toHaveBeenLastCalledWith({kind:'selected'});
  view.rerender(<TrackDisplayControls {...p}/>);
  fireEvent.change(mode,{target:{value:'custom'}});expect(p.onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['added/3']});
  expect(p.onZoom).not.toHaveBeenCalled();
});

it('eye changes enter custom mode and never hide the final visible track',()=>{
  const onView=vi.fn();
  function Session(){const [view,setView]=useState<TrackView>({kind:'all'});return <TrackDisplayControls {...props()} onView={next=>{onView(next);setView(next);}} view={view}/>;}
  render(<Session/>);fireEvent.click(screen.getByText('Visible tracks'));
  fireEvent.click(screen.getByLabelText('Show track 2: Bass'));
  expect(onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['base/0','base/1']});
  fireEvent.click(screen.getByLabelText('Show track 1: Guitar'));
  expect(onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['base/1']});
  const last=screen.getByLabelText('Show track 3: Drums');expect(last).toBeDisabled();
  fireEvent.click(last);expect(onView).toHaveBeenCalledTimes(2);expect(last).toBeChecked();
  fireEvent.click(screen.getByLabelText('Show track 2: Bass'));
  expect(onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['added/3','base/1']});
});

it('shows hidden active state without changing membership and repairs labels after removal',()=>{
  const p=props(),custom:TrackView={kind:'custom',trackIds:['base/1','base/0']},view=render(<TrackDisplayControls {...p} view={custom}/>);
  expect(screen.getByRole('status')).toHaveTextContent('Bass is hidden in score.');
  expect(screen.getByLabelText('Show track 2: Bass')).not.toBeChecked();
  view.rerender(<TrackDisplayControls {...p} selected={2} view={custom}/>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(<TrackDisplayControls {...p} ids={['added/3','base/1']} names={['Bass','Drums']} selected={0} view={custom}/>);
  expect(screen.queryByLabelText('Show track 1: Guitar')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Show track 1: Bass')).not.toBeChecked();
  expect(screen.getByLabelText('Show track 2: Drums')).toBeChecked();
  fireEvent.click(screen.getByLabelText('Show track 1: Bass'));
  expect(p.onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['added/3','base/1']});
  expect(custom).toEqual({kind:'custom',trackIds:['base/1','base/0']});
});

it('keeps the active fallback visible when all custom IDs have been removed',()=>{
  const p=props();render(<TrackDisplayControls {...p} view={{kind:'custom',trackIds:['removed/2']}}/>);
  const active=screen.getByLabelText('Show track 2: Bass');expect(active).toBeChecked();expect(active).toBeDisabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Show track 1: Guitar'));
  expect(p.onView).toHaveBeenLastCalledWith({kind:'custom',trackIds:['base/0','added/3']});
});

it('accepts numeric zoom endpoints and fractions without changing track view',async()=>{
  const p=props(),user=userEvent.setup();
  function Session(){const [zoom,setZoom]=useState(100);return <TrackDisplayControls {...p} zoom={zoom} onZoom={next=>{p.onZoom(next);setZoom(next);}}/>;}
  render(<Session/>);const input=screen.getByLabelText('Zoom (%)');
  for(const value of ['25','100.5','300']){
    await user.clear(input);await user.type(input,value);
    expect(input).toHaveValue(Number(value));expect(p.onZoom).toHaveBeenLastCalledWith(Number(value));
  }
  expect(p.onView).not.toHaveBeenCalled();
  expect(input).toHaveAttribute('min','25');expect(input).toHaveAttribute('max','300');expect(input).toHaveAttribute('step','any');
});

it('does not dispatch blank nonfinite or out of range zoom and refreshes applied readback',()=>{
  const p=props(),view=render(<TrackDisplayControls {...p}/>),input=screen.getByLabelText('Zoom (%)');
  for(const value of ['','NaN','Infinity','24.9','300.1'])fireEvent.change(input,{target:{value}});
  expect(p.onZoom).not.toHaveBeenCalled();expect(input).toHaveValue(300.1);
  fireEvent.blur(input);expect(input).toHaveValue(100);expect(p.onZoom).not.toHaveBeenCalled();
  view.rerender(<TrackDisplayControls {...p} zoom={125.5}/>);expect(input).toHaveValue(125.5);
});

it('busy controls disable all display inputs and dispatch nothing',async()=>{
  const p=props(),user=userEvent.setup();render(<TrackDisplayControls {...p} disabled/>);
  expect(screen.getByLabelText('Displayed tracks')).toBeDisabled();expect(screen.getByLabelText('Zoom (%)')).toBeDisabled();
  for(const checkbox of screen.getAllByRole('checkbox',{hidden:true}))expect(checkbox).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Displayed tracks'),'all');
  await user.type(screen.getByLabelText('Zoom (%)'),'150');
  await user.click(screen.getByText('Visible tracks'));
  await user.click(screen.getByLabelText('Show track 1: Guitar'));
  expect(p.onView).not.toHaveBeenCalled();expect(p.onZoom).not.toHaveBeenCalled();
});

it('offers all six layouts and repairs page fit when switching to an endless layout',()=>{
  const p=props(),onDisplay=vi.fn(),display:ScoreDisplayPreferences={layout:'grid',zoomMode:'fitPage'};
  render(<TrackDisplayControls {...p} display={display} onDisplay={onDisplay}/>);
  const mode=screen.getByLabelText('Display mode');
  expect(within(mode).getAllByRole('option').map(option=>[option.getAttribute('value'),option.textContent])).toEqual([
    ['verticalPage','Vertical page'],['horizontalPage','Horizontal page'],['grid','Grid'],['parchment','Parchment'],['verticalScreen','Vertical screen'],['horizontalScreen','Horizontal screen'],
  ]);
  fireEvent.change(mode,{target:{value:'verticalPage'}});expect(onDisplay).toHaveBeenLastCalledWith({layout:'verticalPage',zoomMode:'fitPage'});
  for(const layout of ['parchment','verticalScreen','horizontalScreen']){
    fireEvent.change(mode,{target:{value:layout}});expect(onDisplay).toHaveBeenLastCalledWith({layout,zoomMode:'fitWidth'});
  }
  expect(p.onView).not.toHaveBeenCalled();expect(p.onZoom).not.toHaveBeenCalled();
});

it('exposes fit policy pressed state and explains unavailable page fit',()=>{
  const p=props(),onDisplay=vi.fn(),view=render(<TrackDisplayControls {...p} display={{layout:'verticalPage',zoomMode:'manual'}} onDisplay={onDisplay}/>);
  const width=screen.getByRole('button',{name:'Fit width'}),page=screen.getByRole('button',{name:'Fit page'});
  expect(width).toHaveAttribute('aria-pressed','false');expect(page).toBeEnabled();
  fireEvent.click(width);expect(onDisplay).toHaveBeenLastCalledWith({layout:'verticalPage',zoomMode:'fitWidth'});
  fireEvent.click(page);expect(onDisplay).toHaveBeenLastCalledWith({layout:'verticalPage',zoomMode:'fitPage'});
  view.rerender(<TrackDisplayControls {...p} display={{layout:'verticalPage',zoomMode:'fitPage'}} onDisplay={onDisplay}/>);
  expect(page).toHaveAttribute('aria-pressed','true');expect(width).toHaveAttribute('aria-pressed','false');
  view.rerender(<TrackDisplayControls {...p} display={{layout:'parchment',zoomMode:'fitWidth'}} onDisplay={onDisplay}/>);
  expect(width).toHaveAttribute('aria-pressed','true');expect(page).toBeDisabled();expect(page).toHaveAccessibleDescription('Fit page is available in page layouts.');
  expect(screen.getByText('Fit page is available in page layouts.')).toBeVisible();
  onDisplay.mockClear();fireEvent.click(page);expect(onDisplay).not.toHaveBeenCalled();
});

it('keeps manual fractional zoom separate from actual fit output and limit status',()=>{
  const p=props(),onDisplay=vi.fn(),view=render(<TrackDisplayControls {...p} zoom={137.5} display={{layout:'horizontalScreen',zoomMode:'fitWidth'}} onDisplay={onDisplay} actualZoom={25} fitLimited/>);
  const input=screen.getByLabelText('Zoom (%)');expect(input).toHaveValue(137.5);
  expect(screen.getByLabelText('Actual zoom')).toHaveTextContent('25%');
  expect(screen.getByText('Fit is limited to 25%. Scroll to view the full score.')).toHaveAttribute('role','status');
  fireEvent.change(input,{target:{value:'142.75'}});expect(p.onZoom).toHaveBeenLastCalledWith(142.75);expect(onDisplay).not.toHaveBeenCalled();
  fireEvent.blur(input);expect(input).toHaveValue(137.5);
  view.rerender(<TrackDisplayControls {...p} zoom={137.5} display={{layout:'grid',zoomMode:'fitPage'}} onDisplay={onDisplay} actualZoom={300} fitLimited/>);
  expect(screen.getByLabelText('Actual zoom')).toHaveTextContent('300%');expect(input).toHaveValue(137.5);
  expect(screen.getByText('Fit is limited to 300%. Scroll to view the full score.')).toHaveAttribute('role','status');
});

it('disables unavailable page fit on a page error and guards busy layout and fit dispatch',()=>{
  const p=props(),onDisplay=vi.fn(),view=render(<TrackDisplayControls {...p} display={{layout:'grid',zoomMode:'fitPage'}} onDisplay={onDisplay} pageError="A system exceeds this paper. Choose a larger page."/>);
  expect(screen.getByRole('button',{name:'Fit page'})).toBeDisabled();expect(screen.getByRole('alert')).toHaveTextContent('A system exceeds this paper. Choose a larger page.');
  view.rerender(<TrackDisplayControls {...p} disabled display={{layout:'grid',zoomMode:'fitPage'}} onDisplay={onDisplay}/>);
  expect(screen.getByLabelText('Display mode')).toBeDisabled();
  for(const name of ['Fit width','Fit page']){expect(screen.getByRole('button',{name})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name}));}
  fireEvent.change(screen.getByLabelText('Display mode'),{target:{value:'verticalPage'}});
  expect(onDisplay).not.toHaveBeenCalled();expect(p.onView).not.toHaveBeenCalled();expect(p.onZoom).not.toHaveBeenCalled();
});
