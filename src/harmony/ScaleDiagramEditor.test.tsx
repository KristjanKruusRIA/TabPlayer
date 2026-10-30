// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { music,noteAt,target } from '../editor/fixtures';
import { ScaleToolPanel } from './ScaleToolPanel';
import { ScaleDiagramView } from './ScaleDiagramView';
import { newMark,setScaleDiagram,type ScaleDiagramCommand } from './scale-diagram';
afterEach(cleanup);

const open=(score:model.Score,commands:ScaleDiagramCommand[],extra:Partial<Parameters<typeof ScaleToolPanel>[0]>={})=>{
  const staff=score.tracks[0].staves[0],beat=staff.bars[0].voices[0].beats[0];
  return render(<ScaleToolPanel score={score} staff={staff} beat={beat} target={target} selection={null} busy={false} onClose={()=>{}} onEdit={command=>commands.push(command as ScaleDiagramCommand)} {...extra}/>);
};

it('authors_a_marked_and_fingered_diagram_from_scratch_and_sends_one_command',()=>{
  const score=music(),commands:ScaleDiagramCommand[]=[],before=model.JsonConverter.scoreToJson(score);open(score,commands);
  expect(screen.getByText('This beat has no scale diagram.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Apply diagram to beat'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Blank diagram'}));
  fireEvent.change(screen.getByLabelText('Diagram name'),{target:{value:'Position 1'}});fireEvent.change(screen.getByLabelText('Starting fret'),{target:{value:'5'}});
  fireEvent.change(screen.getByLabelText('Default shape'),{target:{value:'diamond'}});
  fireEvent.click(screen.getByLabelText('String 6, fret 5'));
  fireEvent.change(screen.getByLabelText('Mark text'),{target:{value:'A12'}});expect((screen.getByLabelText('Mark text') as HTMLInputElement).value).toBe('A12');
  fireEvent.change(screen.getByLabelText('Mark text'),{target:{value:'abcdef'}});expect((screen.getByLabelText('Mark text') as HTMLInputElement).value).toBe('abc');
  fireEvent.change(screen.getByLabelText('Mark text'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('Mark shape'),{target:{value:'square'}});
  fireEvent.click(screen.getByLabelText('String 6, fret 8'));fireEvent.click(screen.getByLabelText('String 1, open'));
  fireEvent.click(screen.getByRole('button',{name:'Apply diagram to beat'}));
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({type:'setScaleDiagram',target,diagram:{
    name:'Position 1',strings:6,frets:12,firstFret:5,orientation:'horizontal',showFretMarkers:true,
    marks:[{string:6,fret:5,shape:'square',color:'#2f6fed',text:'1',textColor:'#ffffff'},{string:6,fret:8,shape:'diamond',color:'#2f6fed',text:'',textColor:'#ffffff'},{string:1,fret:0,shape:'diamond',color:'#2f6fed',text:'',textColor:'#ffffff'}],
  }});
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('removes_a_mark_with_the_button_double_click_or_delete_and_resizing_drops_marks_outside_the_window',()=>{
  const score=music(),commands:ScaleDiagramCommand[]=[];open(score,commands);fireEvent.click(screen.getByRole('button',{name:'Blank diagram'}));
  for(const name of ['String 3, fret 4','String 3, fret 6','String 3, fret 8'])fireEvent.click(screen.getByLabelText(name));
  fireEvent.doubleClick(screen.getByLabelText(/String 3, fret 8: circle mark/));expect(screen.queryByLabelText(/String 3, fret 8: circle mark/)).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText(/String 3, fret 6: circle mark/),{key:'Delete'});expect(screen.queryByLabelText(/String 3, fret 6: circle mark/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/String 3, fret 4: circle mark/));fireEvent.click(screen.getByRole('button',{name:'Remove mark'}));expect(screen.queryByLabelText(/circle mark/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('String 3, fret 9'));fireEvent.change(screen.getByLabelText('Diagram frets'),{target:{value:'8'}});expect(screen.queryByLabelText(/String 3, fret 9: circle mark/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('String 3, fret 2'));fireEvent.click(screen.getByRole('button',{name:'Reset marks'}));expect(screen.queryByLabelText(/circle mark/)).not.toBeInTheDocument();
  expect(commands).toEqual([]);
});

it('builds_from_the_selected_notes_and_from_the_scale_above_and_reports_an_unusable_selection',()=>{
  const score=music(),commands:ScaleDiagramCommand[]=[];noteAt(score,0,1).fret=5;
  const selection={kind:'bars' as const,tracks:[0],firstBar:0,lastBar:0};
  const view=open(score,commands,{selection});
  fireEvent.click(screen.getByRole('button',{name:'From selected notes'}));expect(screen.getByLabelText('String 6, fret 3: circle mark "G"')).toBeInTheDocument();expect(screen.getByLabelText('String 6, fret 5: circle mark "A"')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Scale root'),{target:{value:'9'}});fireEvent.change(screen.getByLabelText('Scale pattern'),{target:{value:'minor-pentatonic'}});
  fireEvent.click(screen.getByRole('button',{name:'From scale above'}));
  expect(screen.getByLabelText('Diagram name')).toHaveValue('A Minor pentatonic');expect(screen.getByLabelText('String 6, fret 5: circle mark "A"')).toBeInTheDocument();expect(screen.getByLabelText('String 6, fret 8: circle mark "C"')).toBeInTheDocument();
  view.rerender(<ScaleToolPanel score={score} staff={score.tracks[0].staves[0]} beat={score.tracks[0].staves[0].bars[0].voices[0].beats[0]} target={target} selection={{kind:'bars',tracks:[0],firstBar:9,lastBar:9}} busy={false} onClose={()=>{}} onEdit={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'From selected notes'}));expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});

it('shows_the_stored_diagram_and_deletes_it_with_one_command',()=>{
  const score=music(),commands:ScaleDiagramCommand[]=[],beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0];
  setScaleDiagram(beat,{name:'Stored',strings:6,frets:5,firstFret:1,orientation:'vertical',showFretMarkers:false,marks:[newMark(2,3,'triangle','#ff0000','x','#ffffff')]});
  open(score,commands);expect(screen.getByText(/This beat has a diagram named “Stored” with 1 marks\./)).toBeInTheDocument();
  expect(screen.getByLabelText('String 2, fret 3: triangle mark "x"')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Apply diagram to beat'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Delete diagram from beat'}));expect(commands).toEqual([{type:'setScaleDiagram',target,diagram:null}]);
});

it('is_disabled_when_busy_or_the_beat_cannot_hold_a_diagram',()=>{
  const score=music(),commands:ScaleDiagramCommand[]=[];open(score,commands,{busy:true});expect(screen.getByRole('button',{name:'Blank diagram'})).toBeDisabled();cleanup();
  score.tracks[0].staves[0].isPercussion=true;open(score,commands);expect(screen.getByRole('button',{name:'Blank diagram'})).toBeDisabled();
  expect(screen.getByText(/Select a written beat on a stringed or keyboard staff/)).toBeInTheDocument();
});

it('the_panel_without_an_edit_handler_is_the_unchanged_browser',()=>{
  render(<ScaleToolPanel score={music()} selection={null} busy={false} onClose={()=>{}}/>);expect(screen.queryByText('Scale diagram')).not.toBeInTheDocument();
});

it('renders_each_shape_orientation_and_open_string_with_its_label',()=>{
  const marks=(['circle','square','diamond','triangle','cross'] as const).map((shape,index)=>newMark(index+1,index+1,shape,'#112233','ab','#ffffff'));
  for(const orientation of ['horizontal','vertical'] as const){
    const view=render(<ScaleDiagramView diagram={{name:'D',strings:6,frets:5,firstFret:1,orientation,showFretMarkers:true,marks:[...marks,newMark(6,0)]}}/>);
    expect(screen.getByRole('group',{name:'Scale diagram D'})).toBeInTheDocument();expect(screen.getAllByRole('img').map(item=>item.getAttribute('aria-label'))).toContain('String 6, open: circle mark');
    expect(view.container.querySelectorAll('polygon,rect[width="22"],path[stroke="#112233"],circle[fill="#112233"]').length).toBeGreaterThanOrEqual(5);
    cleanup();
  }
});
