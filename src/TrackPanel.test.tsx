// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
