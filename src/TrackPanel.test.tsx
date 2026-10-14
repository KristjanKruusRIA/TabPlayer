// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { previewEdit } from './engine';
import { blankProject } from './project';
import { TrackPanel } from './TrackPanel';
afterEach(cleanup);

it('shows the current instrument mix after deletion and undo change its index',()=>{
  const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  let score=added.score;const state={};
  const player={subscribe:()=>()=>{},getState:()=>state,mix:(value:number|model.Track)=>{
    const track=typeof value==='number'?score.tracks[value]:value;
    return {mute:track.name==='Bass',solo:false,volume:track.name==='Bass'?.5:1};
  }};
  const props=()=>({score,selected:0,busy:false,player:player as never,onSelect:()=>{},onEdit:()=>{}});
  const view=render(<TrackPanel {...props()}/>);
  expect(screen.getAllByLabelText('Mute')[1]).toBeChecked();
  score=previewEdit(added.project,{type:'removeTrack',track:0}).score;view.rerender(<TrackPanel {...props()}/>);
  expect(screen.getByLabelText('Mute')).toBeChecked();expect(screen.getByLabelText('Volume Bass')).toHaveValue('0.5');
  score=added.score;view.rerender(<TrackPanel {...props()}/>);
  expect(screen.getAllByLabelText('Mute')[0]).not.toBeChecked();expect(screen.getAllByLabelText('Mute')[1]).toBeChecked();
});
it('all 128 programs are selectable and existing track settings dispatch exact payload',()=>{
  const score=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3}).score,onEdit=vi.fn();
  render(<TrackPanel score={score} selected={0} busy={false} player={null} onSelect={()=>{}} onEdit={onEdit}/>);
  const select=screen.getByLabelText('Track MIDI instrument');expect(select.querySelectorAll('option')).toHaveLength(128);
  fireEvent.change(screen.getByLabelText('Track name'),{target:{value:'Lead'}});fireEvent.change(screen.getByLabelText('Track short name'),{target:{value:'Ld'}});fireEvent.change(select,{target:{value:'127'}});fireEvent.click(screen.getByRole('button',{name:'Apply instrument settings'}));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackInfo',track:0,name:'Lead',shortName:'Ld',program:127});
});
