// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model,Settings } from '@coderline/alphatab';
import { LyricsPanel } from './LyricsPanel';
import { applyLyricsEdit,getTrackLyrics } from './lyrics';
import type { LyricsCommand } from './lyrics-types';
import { music } from './fixtures';
import { scoreFromJson } from '../model-clone';

afterEach(cleanup);
it('panel_dispatches_one_complete_five_line_command',()=>{
  const score=music(),commands:LyricsCommand[]=[];
  render(<LyricsPanel score={score} track={0} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByText('Guitar')).toBeInTheDocument();
  for(let line=1;line<=5;line++) {
    fireEvent.click(screen.getByRole('button',{name:'Add line'}));
    fireEvent.change(screen.getByLabelText(`Line ${line} text`),{target:{value:`verse ${line}\nraw+words`}});
    fireEvent.change(screen.getByLabelText(`Line ${line} start measure`),{target:{value:String((line-1)%4+1)}});
  }
  expect(screen.getByRole('button',{name:'Add line'})).toBeDisabled();expect(screen.queryByLabelText('Line 6 text')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Visible'));expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply lyrics'}));
  expect(commands).toEqual([{type:'setTrackLyrics',track:0,visible:false,lines:[
    {startBar:0,text:'verse 1\nraw+words'},{startBar:1,text:'verse 2\nraw+words'},{startBar:2,text:'verse 3\nraw+words'},{startBar:3,text:'verse 4\nraw+words'},{startBar:0,text:'verse 5\nraw+words'}
  ]}]);
  expect(getTrackLyrics(score,0).lines).toEqual([]);
});
it('panel_removes_lines_resets_drafts_and_disables_while_busy',()=>{
  const score=music(),commands:LyricsCommand[]=[];score.addTrack(scoreFromJson(model.JsonConverter.scoreToJson(music()),new Settings()).tracks[0]);score.tracks[1].name='Other guitar';
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:1,text:'First'},{startBar:2,text:'Second'}]});
  const props={score,track:0,busy:false,onEdit:(edit:LyricsCommand)=>commands.push(edit)},view=render(<LyricsPanel {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Remove line 1'}));expect(screen.getByLabelText('Line 1 text')).toHaveValue('Second');expect(screen.getByLabelText('Line 1 start measure')).toHaveValue(3);
  view.rerender(<LyricsPanel {...props} busy/>);expect(screen.getByLabelText('Visible')).toBeDisabled();expect(screen.getByLabelText('Line 1 text')).toBeDisabled();expect(screen.getByRole('button',{name:'Apply lyrics'})).toBeDisabled();
  view.rerender(<LyricsPanel {...props} track={1}/>);expect(screen.queryByLabelText('Line 1 text')).not.toBeInTheDocument();expect(screen.getByText('Other guitar')).toBeInTheDocument();
  const restored=music();applyLyricsEdit(restored,{type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:3,text:'Restored'}]});
  view.rerender(<LyricsPanel {...props} score={restored}/>);expect(screen.getByLabelText('Line 1 text')).toHaveValue('Restored');expect(screen.getByLabelText('Line 1 start measure')).toHaveValue(4);expect(screen.getByLabelText('Visible')).not.toBeChecked();expect(commands).toEqual([]);
});
it('panel_labels_reconstructed_source_and_does_not_apply_on_open',()=>{
  const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics=['shown words'];
  const json=model.JsonConverter.scoreToJson(score),commands:LyricsCommand[]=[];
  render(<LyricsPanel score={score} track={0} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByText('Reconstructed from displayed syllables')).toBeInTheDocument();expect(screen.getByLabelText('Line 1 text')).toHaveValue('shown+words');
  expect(commands).toEqual([]);expect(model.JsonConverter.scoreToJson(score)).toBe(json);
});
