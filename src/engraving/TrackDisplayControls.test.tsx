// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

it('shows a fitted zoom rounded in the output and in the limit message',()=>{
  render(<TrackDisplayControls {...props()} display={{layout:'parchment',zoomMode:'fitWidth'}} onDisplay={vi.fn()} actualZoom={87.81646825396825} fitLimited/>);
  expect(screen.getByLabelText('Actual zoom')).toHaveTextContent('Actual zoom: 87.8%');
  expect(screen.getByText('Fit is limited to 87.8%. Scroll to view the full score.')).toBeInTheDocument();
});

describe('folded into one menu at small heights (THE-196)',()=>{
  const menu=()=>screen.getByRole('button',{name:'Score display'});
  const controls=()=>document.getElementById(menu().getAttribute('aria-controls')!)!;
  it('shows the whole row and no menu button when the window is tall enough',()=>{
    render(<TrackDisplayControls {...props()}/>);
    expect(screen.queryByRole('button',{name:'Score display'})).not.toBeInTheDocument();expect(screen.getByLabelText('Display mode')).toBeVisible();expect(screen.getByRole('button',{name:'Fit width'})).toBeVisible();
  });
  it('folds the same controls behind a button that opens and closes them, with Escape returning focus to the button',()=>{
    render(<TrackDisplayControls {...props()} compact/>);
    expect(menu()).toHaveAttribute('aria-expanded','false');expect(controls()).not.toBeVisible();expect(screen.getByLabelText('Display mode',{selector:'select'})).not.toBeVisible();
    fireEvent.click(menu());
    expect(menu()).toHaveAttribute('aria-expanded','true');expect(screen.getByRole('group',{name:'Score display'})).toBe(controls());expect(controls()).toBeVisible();
    const order=[...controls().querySelectorAll('select,input,button')].map(node=>node.getAttribute('title')??node.textContent);
    expect(order.slice(0,5)).toEqual(['Display mode','Displayed tracks','Zoom (%)','Fit width','Fit page']);
    screen.getByLabelText('Zoom (%)').focus();fireEvent.keyDown(screen.getByLabelText('Zoom (%)'),{key:'Escape'});
    expect(controls()).not.toBeVisible();expect(menu()).toHaveFocus();expect(menu()).toHaveAttribute('aria-expanded','false');
  });
  it('acts exactly as the unfolded row does',()=>{
    const p=props(),onDisplay=vi.fn();render(<TrackDisplayControls {...p} compact display={{layout:'grid',zoomMode:'manual'}} onDisplay={onDisplay}/>);
    fireEvent.click(menu());fireEvent.click(screen.getByRole('button',{name:'Fit width'}));expect(onDisplay).toHaveBeenLastCalledWith({layout:'grid',zoomMode:'fitWidth'});
    fireEvent.change(screen.getByLabelText('Zoom (%)'),{target:{value:'150'}});expect(p.onZoom).toHaveBeenLastCalledWith(150);
    fireEvent.change(screen.getByLabelText('Displayed tracks'),{target:{value:'all'}});expect(p.onView).toHaveBeenLastCalledWith({kind:'all'});
  });
  it('closes on a press outside, and not on a press inside',()=>{
    render(<TrackDisplayControls {...props()} compact/>);fireEvent.click(menu());
    fireEvent.pointerDown(screen.getByLabelText('Zoom (%)'));expect(controls()).toBeVisible();
    fireEvent.pointerDown(document.body);expect(controls()).not.toBeVisible();
  });
  it('keeps the same elements, so unfolding on growth restores the row without remounting it',()=>{
    const view=render(<TrackDisplayControls {...props()} compact/>),select=screen.getByLabelText('Display mode',{selector:'select'});
    view.rerender(<TrackDisplayControls {...props()}/>);
    expect(screen.getByLabelText('Display mode',{selector:'select'})).toBe(select);expect(select).toBeVisible();expect(screen.queryByRole('button',{name:'Score display'})).not.toBeInTheDocument();
  });
  it('keeps focus when the row folds or unfolds: into the button when a folded control had it, into the first control when the button had it',()=>{
    const p=props(),view=render(<TrackDisplayControls {...p}/>);
    screen.getByLabelText('Zoom (%)').focus();view.rerender(<TrackDisplayControls {...p} compact/>);expect(menu()).toHaveFocus();
    view.rerender(<TrackDisplayControls {...p}/>);expect(screen.getByLabelText('Display mode',{selector:'select'})).toHaveFocus();
  });
  it('leaves other focus alone when the row folds',()=>{
    const p=props(),view=render(<><button>Elsewhere</button><TrackDisplayControls {...p}/></>);
    screen.getByRole('button',{name:'Elsewhere'}).focus();view.rerender(<><button>Elsewhere</button><TrackDisplayControls {...p} compact/></>);expect(screen.getByRole('button',{name:'Elsewhere'})).toHaveFocus();
  });
  it('never disables the button for a busy document, even while it has focus',()=>{
    const p=props(),view=render(<TrackDisplayControls {...p} compact/>);menu().focus();
    view.rerender(<TrackDisplayControls {...p} compact disabled/>);expect(menu()).not.toBeDisabled();expect(menu()).toHaveFocus();
    fireEvent.click(menu());expect(controls()).toBeVisible();expect(screen.getByLabelText('Display mode')).toBeDisabled();
  });
  describe('messages stay visible and announced while the row is folded',()=>{
    it('shows a page error',()=>{
      render(<TrackDisplayControls {...props()} compact display={{layout:'grid',zoomMode:'fitPage'}} pageError="A system exceeds this paper. Choose a larger page."/>);
      expect(controls()).not.toBeVisible();expect(screen.getByRole('alert')).toBeVisible();expect(screen.getByRole('alert')).toHaveTextContent('A system exceeds this paper.');
    });
    it('shows the fit limit',()=>{
      render(<TrackDisplayControls {...props()} compact display={{layout:'parchment',zoomMode:'fitWidth'}} actualZoom={63} fitLimited/>);
      expect(controls()).not.toBeVisible();expect(screen.getByRole('status')).toBeVisible();expect(screen.getByRole('status')).toHaveTextContent('Fit is limited to 63%.');
    });
    it('shows that the selected track is hidden',()=>{
      render(<TrackDisplayControls {...props()} compact view={{kind:'custom',trackIds:['base/0']}}/>);
      expect(controls()).not.toBeVisible();expect(screen.getByRole('status')).toBeVisible();expect(screen.getByRole('status')).toHaveTextContent('Bass is hidden in score.');
    });
  });
});

describe('getting back to an unfitted 100% (THE-196)',()=>{
  it('pressing Fit width while it is pressed turns the fit off and chooses 100%',()=>{
    const p=props(),onDisplay=vi.fn();render(<TrackDisplayControls {...p} display={{layout:'parchment',zoomMode:'fitWidth'}} onDisplay={onDisplay}/>);
    fireEvent.click(screen.getByRole('button',{name:'Fit width'}));expect(p.onZoom).toHaveBeenCalledExactlyOnceWith(100);expect(onDisplay).not.toHaveBeenCalled();
  });
  it('pressing Fit width while it is not pressed still fits',()=>{
    const p=props(),onDisplay=vi.fn();render(<TrackDisplayControls {...p} display={{layout:'parchment',zoomMode:'manual'}} onDisplay={onDisplay}/>);
    fireEvent.click(screen.getByRole('button',{name:'Fit width'}));expect(onDisplay).toHaveBeenCalledWith({layout:'parchment',zoomMode:'fitWidth'});expect(p.onZoom).not.toHaveBeenCalled();
  });
  it('Enter in the zoom field commits the shown value while a fit is shown, even when it equals the zoom',()=>{
    const p=props(),view=render(<TrackDisplayControls {...p} display={{layout:'parchment',zoomMode:'fitWidth'}} onDisplay={vi.fn()}/>),field=screen.getByLabelText('Zoom (%)');
    fireEvent.keyDown(field,{key:'Enter'});expect(p.onZoom).toHaveBeenCalledExactlyOnceWith(100);
    p.onZoom.mockClear();view.rerender(<TrackDisplayControls {...p} display={{layout:'parchment',zoomMode:'manual'}} onDisplay={vi.fn()}/>);
    fireEvent.keyDown(field,{key:'Enter'});expect(p.onZoom).not.toHaveBeenCalled();
  });
  it('Enter does not commit an invalid draft or act while busy',()=>{
    const p=props(),view=render(<TrackDisplayControls {...p} display={{layout:'parchment',zoomMode:'fitWidth'}} onDisplay={vi.fn()}/>),field=screen.getByLabelText('Zoom (%)');
    fireEvent.change(field,{target:{value:'4'}});fireEvent.keyDown(field,{key:'Enter'});expect(p.onZoom).not.toHaveBeenCalled();
    view.rerender(<TrackDisplayControls {...p} disabled display={{layout:'parchment',zoomMode:'fitWidth'}} onDisplay={vi.fn()}/>);fireEvent.keyDown(field,{key:'Enter'});expect(p.onZoom).not.toHaveBeenCalled();
  });
});
