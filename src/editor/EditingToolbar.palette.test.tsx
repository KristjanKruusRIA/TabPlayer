// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import { EditingToolbar } from './EditingToolbar';
import { DockResizeHandle,InspectorResizeHandle } from '../workstation/DockResizeHandle';

afterEach(cleanup);
const target={track:0,staff:0,bar:0,voice:0,beat:0};

function toolbar(busy=false){
  const score=previewEdit(blankProject(),{type:'setNote',target,string:1,fret:3}).score;
  const onEdit=vi.fn(),onSelect=vi.fn(),onOpenMeasure=vi.fn();
  render(<EditingToolbar score={score} target={target} string={1} fret={3} noteIndex={null} duration={4} dots={0} busy={busy} locked={false}
    onDurationChange={vi.fn()} onDotsChange={vi.fn()} onEdit={onEdit} onSelect={onSelect} onOpenMeasure={onOpenMeasure} orientation="vertical"/>);
  return {score,onEdit,onSelect,onOpenMeasure};
}

it('offers the bar voices, with only voices the bar has taking the cursor',()=>{
  const {score,onSelect}=toolbar();const voices=score.tracks[0].staves[0].bars[0].voices.length;
  expect(screen.getByRole('button',{name:'Voice 1'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(screen.getByRole('button',{name:'Voice 1'}));expect(onSelect).not.toHaveBeenCalled();
  for(let voice=1;voice<4;voice++){
    const button=screen.getByRole('button',{name:`Voice ${voice+1}`});
    if(voice<voices){fireEvent.click(button);expect(onSelect).toHaveBeenLastCalledWith({...target,voice,beat:0});}
    else expect(button).toBeDisabled();
  }
});

it('sets the cursor note dynamic, and choosing the current one records nothing',()=>{
  const {score,onEdit}=toolbar();const current=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].dynamics;
  const marks=['ppp','pp','p','mp','mf','f','ff','fff'];
  expect(screen.getByRole('button',{name:`Dynamic ${marks[current]}`})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(screen.getByRole('button',{name:`Dynamic ${marks[current]}`}));expect(onEdit).not.toHaveBeenCalled();
  const other=current===6?5:6;
  fireEvent.click(screen.getByRole('button',{name:`Dynamic ${marks[other]}`}));
  expect(onEdit).toHaveBeenCalledWith({type:'setNoteTechniques',target,string:1,patch:{dynamics:other}});
});

it('opens the measure settings from time signature and tempo, and ignores clicks while busy',()=>{
  const {onOpenMeasure}=toolbar();
  fireEvent.click(screen.getByRole('button',{name:'Time signature'}));fireEvent.click(screen.getByRole('button',{name:'Tempo'}));
  expect(onOpenMeasure).toHaveBeenCalledTimes(2);expect(onOpenMeasure).toHaveBeenLastCalledWith(0);
  cleanup();
  const busy=toolbar(true);
  const tempo=screen.getByRole('button',{name:'Tempo'});expect(tempo).toHaveAttribute('aria-disabled','true');expect(tempo).not.toBeDisabled();
  fireEvent.click(tempo);expect(busy.onOpenMeasure).not.toHaveBeenCalled();
});

it('resizes the dock with the keyboard within its limits and resets with Escape',()=>{
  const onHeight=vi.fn(),onReset=vi.fn();
  render(<DockResizeHandle height={176} min={96} max={300} onHeight={onHeight} onReset={onReset}/>);
  const handle=screen.getByRole('separator',{name:'Resize bottom dock'});
  expect(handle).toHaveAttribute('aria-valuenow','176');
  fireEvent.keyDown(handle,{key:'ArrowUp'});expect(onHeight).toHaveBeenLastCalledWith(192);
  fireEvent.keyDown(handle,{key:'ArrowDown'});expect(onHeight).toHaveBeenLastCalledWith(160);
  fireEvent.keyDown(handle,{key:'End'});expect(onHeight).toHaveBeenLastCalledWith(300);
  fireEvent.keyDown(handle,{key:'Home'});expect(onHeight).toHaveBeenLastCalledWith(96);
  fireEvent.keyDown(handle,{key:'Escape'});expect(onReset).toHaveBeenCalledTimes(1);
  fireEvent.doubleClick(handle);expect(onReset).toHaveBeenCalledTimes(2);
});

it('widens the inspector with the left arrow and drags its edge within its limits',()=>{
  const onWidth=vi.fn(),onReset=vi.fn();
  render(<InspectorResizeHandle width={304} min={240} max={480} onWidth={onWidth} onReset={onReset}/>);
  const handle=screen.getByRole('separator',{name:'Resize inspector'});
  expect(handle).toHaveAttribute('aria-orientation','vertical');expect(handle).toHaveAttribute('aria-valuetext','304 px');
  fireEvent.keyDown(handle,{key:'ArrowLeft'});expect(onWidth).toHaveBeenLastCalledWith(320);
  fireEvent.keyDown(handle,{key:'ArrowRight'});expect(onWidth).toHaveBeenLastCalledWith(288);
  fireEvent.keyDown(handle,{key:'ArrowUp'});expect(onWidth).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(handle,{key:'End'});expect(onWidth).toHaveBeenLastCalledWith(480);
  fireEvent.pointerDown(handle,{button:0,clientX:900,pointerId:1});fireEvent.pointerMove(handle,{clientX:850,pointerId:1});expect(onWidth).toHaveBeenLastCalledWith(354);
  fireEvent.pointerMove(handle,{clientX:100,pointerId:1});expect(onWidth).toHaveBeenLastCalledWith(480);
  fireEvent.pointerMove(handle,{clientX:1200,pointerId:1});expect(onWidth).toHaveBeenLastCalledWith(240);
  fireEvent.pointerUp(handle,{pointerId:1});const calls=onWidth.mock.calls.length;fireEvent.pointerMove(handle,{clientX:800,pointerId:1});expect(onWidth).toHaveBeenCalledTimes(calls);
  fireEvent.keyDown(handle,{key:'Escape'});expect(onReset).toHaveBeenCalledOnce();
});
