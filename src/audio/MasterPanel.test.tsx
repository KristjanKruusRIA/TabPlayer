// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import { defaultMaster } from '../document-settings';
import type { MasterSettings } from '../edit-types';
import { TrackPanel } from '../TrackPanel';
import { MasterPanel } from './MasterPanel';

afterEach(cleanup);
const open=(name:string)=>{const summary=screen.getByText(name,{selector:'summary'});fireEvent.click(summary);};
const slider=(name:string)=>screen.getByRole('slider',{name}) as HTMLInputElement;

it('shows an untouched master at its defaults and sends nothing until a gesture ends',()=>{
  const onChange=vi.fn();
  render(<MasterPanel master={undefined} disabled={false} onChange={onChange}/>);
  expect(screen.getByRole('region',{name:'Master'})).toHaveTextContent('Untouched');
  expect(slider('Master level')).toHaveValue('0');expect(slider('Master level')).toHaveAttribute('aria-valuetext','0.0 dB');
  expect(slider('Master balance')).toHaveAttribute('aria-valuetext','Centre');
  fireEvent.change(slider('Master level'),{target:{value:'-6'}});
  // Dragging shows the value without committing it.
  expect(screen.getByRole('slider',{name:'Master level'})).toHaveAttribute('aria-valuetext','-6.0 dB');
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(slider('Master level'),{target:{value:'-7.5'}});
  fireEvent.pointerUp(slider('Master level'));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith({...defaultMaster(),gainDb:-7.5});
});

it('commits a keyboard change when the key is released, and a blur that changes nothing sends nothing',()=>{
  const onChange=vi.fn();
  render(<MasterPanel master={undefined} disabled={false} onChange={onChange}/>);
  fireEvent.change(slider('Master balance'),{target:{value:'0.25'}});
  fireEvent.keyUp(slider('Master balance'),{key:'ArrowRight'});
  expect(onChange).toHaveBeenCalledWith({...defaultMaster(),balance:.25});
  onChange.mockClear();
  fireEvent.blur(slider('Master level'));fireEvent.pointerUp(slider('Master level'));
  expect(onChange).not.toHaveBeenCalled();
});

it('edits each effect from its own section, keeping the rest of the master',()=>{
  const onChange=vi.fn();const master:MasterSettings={...defaultMaster(),gainDb:-2,limiter:{enabled:true,ceilingDb:-3,releaseMs:50}};
  render(<MasterPanel master={master} disabled={false} onChange={onChange}/>);
  expect(screen.getByRole('region',{name:'Master'})).toHaveTextContent('Changed');
  expect(screen.getByText('Limiter (on)',{selector:'summary'})).toBeInTheDocument();
  open('Compressor');
  fireEvent.click(screen.getByLabelText('Compressor on'));
  expect(onChange).toHaveBeenLastCalledWith({...master,compressor:{...master.compressor,enabled:true}});
  fireEvent.change(slider('Master compressor ratio'),{target:{value:'8'}});fireEvent.pointerUp(slider('Master compressor ratio'));
  expect(onChange).toHaveBeenLastCalledWith({...master,compressor:{...master.compressor,ratio:8}});
  open('EQ');
  fireEvent.change(slider('Master EQ mid frequency'),{target:{value:'2000'}});fireEvent.pointerUp(slider('Master EQ mid frequency'));
  expect(onChange).toHaveBeenLastCalledWith({...master,eq:{...master.eq,midHz:2000}});
  open('Reverb');
  fireEvent.change(screen.getByRole('combobox',{name:'Master reverb model'}),{target:{value:'plate'}});
  expect(onChange).toHaveBeenLastCalledWith({...master,reverb:{...master.reverb,model:'plate'}});
  fireEvent.change(slider('Master reverb send'),{target:{value:'0.3'}});fireEvent.pointerUp(slider('Master reverb send'));
  expect(onChange).toHaveBeenLastCalledWith({...master,reverb:{...master.reverb,mix:.3}});
  open('Limiter (on)');
  fireEvent.change(slider('Master limiter ceiling'),{target:{value:'-6'}});fireEvent.pointerUp(slider('Master limiter ceiling'));
  expect(onChange).toHaveBeenLastCalledWith({...master,limiter:{...master.limiter,ceilingDb:-6}});
  fireEvent.click(screen.getByLabelText('Limiter on'));
  expect(onChange).toHaveBeenLastCalledWith({...master,limiter:{...master.limiter,enabled:false}});
});

it('resets to the defaults, and has nothing to reset on an untouched master',()=>{
  const onChange=vi.fn();
  const view=render(<MasterPanel master={undefined} disabled={false} onChange={onChange}/>);
  expect(screen.getByRole('button',{name:'Reset master'})).toBeDisabled();
  view.rerender(<MasterPanel master={{...defaultMaster(),gainDb:3}} disabled={false} onChange={onChange}/>);
  fireEvent.click(screen.getByRole('button',{name:'Reset master'}));
  expect(onChange).toHaveBeenCalledWith(defaultMaster());
  view.rerender(<MasterPanel master={defaultMaster()} disabled={false} onChange={onChange}/>);
  expect(screen.getByRole('button',{name:'Reset master'})).toBeDisabled();
});

it('disables every control while busy or without a player',()=>{
  render(<MasterPanel master={{...defaultMaster(),gainDb:3}} disabled={true} onChange={vi.fn()}/>);
  open('Compressor');open('EQ');open('Reverb');open('Limiter');
  for(const control of [...screen.getAllByRole('slider'),...screen.getAllByRole('checkbox'),screen.getByRole('combobox'),screen.getByRole('button',{name:'Reset master'})])expect(control).toBeDisabled();
});

it('drops the draft when the edit is refused, so the slider goes back to the saved value',async()=>{
  const onChange=vi.fn(()=>Promise.reject(new Error('This document is finalized. Unfinalize it to make changes.')));
  render(<MasterPanel master={undefined} disabled={false} onChange={onChange}/>);
  fireEvent.change(slider('Master level'),{target:{value:'6'}});fireEvent.pointerUp(slider('Master level'));
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(slider('Master level')).toHaveValue('0');
});

function mixer(master:MasterSettings|undefined,extra:object={}) {
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score as model.Score;
  const state={},player={subscribe:()=>()=>{},getState:()=>state,focus:()=>null,mix:()=>({mute:false,solo:false,volume:1,pan:0}),master:()=>master,setMaster:vi.fn(async()=>{}),...extra};
  const props={score,selected:0,busy:false,view:'mixer' as const,target:{track:0,staff:0,bar:0,voice:0,beat:0},onExitOverview:vi.fn(),onSelect:vi.fn(),onSelectPosition:vi.fn(),player:player as never};
  return {props,player};
}

it('puts the master strip in the mixer and saves its edits through the player',()=>{
  const {props,player}=mixer({...defaultMaster(),gainDb:-4});
  render(<TrackPanel {...props}/>);
  const strip=screen.getByRole('region',{name:'Master'});
  expect(strip).toBeInTheDocument();
  expect(slider('Master level')).toHaveValue('-4');
  fireEvent.change(slider('Master level'),{target:{value:'-5'}});fireEvent.pointerUp(slider('Master level'));
  expect(player.setMaster).toHaveBeenCalledWith({...defaultMaster(),gainDb:-5});
});

it('keeps the master strip, disabled, in a mixer with no player or a busy one',()=>{
  const none=mixer(undefined);
  const view=render(<TrackPanel {...none.props} player={null}/>);
  expect(slider('Master level')).toBeDisabled();
  view.unmount();
  const busy=mixer(undefined);
  render(<TrackPanel {...busy.props} busy={true}/>);
  expect(slider('Master level')).toBeDisabled();
});
