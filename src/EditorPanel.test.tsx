// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EditorPanel } from './EditorPanel';
import { music, target } from './editor/fixtures';

afterEach(cleanup);
function props() {
  return {score:music(),target,string:6,fret:3,noteIndex:null,busy:false,musicSelection:null,
    onSelectNote:vi.fn(),onSelect:vi.fn(),onString:vi.fn(),onFret:vi.fn(),onEdit:vi.fn(),onMusicSelection:vi.fn(),onChord:vi.fn(),onScales:vi.fn()};
}
function Draft({label}:{label:string}) {
  const [value,setValue]=useState('');
  return <label>{label}<input value={value} onChange={event=>setValue(event.target.value)}/></label>;
}
function disclose(name:string) {fireEvent.click(screen.getByText(name,{selector:'summary'}));}

it('keeps common entry and musical tools visible while all original panels remain reachable by task',()=>{
  const input=props();
  render(<EditorPanel {...input} practiceTools={<Draft label="Practice draft"/>} presentationTools={<Draft label="Presentation draft"/>}><Draft label="Clipboard draft"/></EditorPanel>);
  expect(screen.getByLabelText('Editing location')).toHaveTextContent('Guitar · Measure 1 · Beat 1');
  expect(screen.getByLabelText('Duration')).toBeVisible();
  expect(screen.getByRole('button',{name:'Set note'})).toBeVisible();
  expect(screen.getByLabelText('Tuplet numerator')).not.toBeVisible();
  disclose('Advanced rhythm');expect(screen.getByLabelText('Tuplet numerator')).toBeVisible();expect(screen.getByLabelText('Grace type')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Edit chord diagram'}));fireEvent.click(screen.getByRole('button',{name:'Browse scales'}));
  expect(input.onChord).toHaveBeenCalledOnce();expect(input.onScales).toHaveBeenCalledOnce();
  const edit=within(screen.getByRole('region',{name:'Edit tools'}));
  for(const title of ['Notes & techniques','Beat notation','Music selection','Beat text','Measure & notation','Directions','Staff, voices & layout','Bar gestures','Lyrics','Insert & remove measures'])expect(edit.getByText(title,{selector:'summary'})).toBeVisible();
  expect(edit.getByLabelText('Clipboard draft')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Practice'}));expect(screen.getByLabelText('Practice draft')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Presentation'}));expect(screen.getByLabelText('Presentation draft')).toBeVisible();
  const presentation=within(screen.getByRole('region',{name:'Presentation tools'}));
  expect(presentation.getByText('Score information',{selector:'summary'})).toBeVisible();expect(presentation.getByText('Song metadata',{selector:'summary'})).toBeVisible();
});

it('preserves parent, child and slot drafts when tasks are closed and reopened',()=>{
  render(<EditorPanel {...props()} practiceTools={<Draft label="Practice draft"/>} presentationTools={<Draft label="Presentation draft"/>}><Draft label="Clipboard draft"/></EditorPanel>);
  disclose('Beat text');fireEvent.change(screen.getByLabelText('Beat text'),{target:{value:'Palm mute here'}});
  fireEvent.change(screen.getByLabelText('Clipboard draft'),{target:{value:'Keep clipboard'}});
  disclose('Edit');fireEvent.click(screen.getByRole('button',{name:'Practice'}));
  fireEvent.change(screen.getByLabelText('Practice draft'),{target:{value:'Four passes'}});disclose('Practice');
  fireEvent.click(screen.getByRole('button',{name:'Presentation'}));disclose('Score information');disclose('Song metadata');
  fireEvent.change(screen.getByLabelText('Title'),{target:{value:'New title draft'}});fireEvent.change(screen.getByLabelText('Subtitle'),{target:{value:'Verse study'}});
  fireEvent.change(screen.getByLabelText('Presentation draft'),{target:{value:'Print draft'}});disclose('Presentation');
  for(const task of ['Edit','Practice','Presentation'])fireEvent.click(screen.getByRole('button',{name:task}));
  for(const [label,value] of [['Beat text','Palm mute here'],['Clipboard draft','Keep clipboard'],['Practice draft','Four passes'],['Title','New title draft'],['Subtitle','Verse study'],['Presentation draft','Print draft']])expect(screen.getByLabelText(label)).toHaveValue(value);
});

it('keeps task navigation usable while busy and disables editing and supplied tools',()=>{
  render(<EditorPanel {...props()} busy practiceTools={<Draft label="Practice draft"/>} presentationTools={<button>Export draft</button>}/>);
  for(const task of ['Edit','Practice','Presentation']) {
    const button=screen.getByRole('button',{name:task});expect(button).toBeEnabled();fireEvent.click(button);
  }
  expect(screen.getByLabelText('Fret')).toBeDisabled();expect(screen.getByRole('button',{name:'Set note'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Edit chord diagram'})).toBeDisabled();expect(screen.getByRole('button',{name:'Browse scales'})).toBeDisabled();
  expect(screen.getByLabelText('Practice draft')).toBeDisabled();expect(screen.getByRole('button',{name:'Export draft'})).toBeDisabled();
});

it('opens a task from keyboard navigation and keeps rhythm and selection callbacks intact',async()=>{
  const user=userEvent.setup(),input=props();render(<EditorPanel {...input} practiceTools={<Draft label="Practice draft"/>}/>);
  const navigation=within(screen.getByRole('navigation',{name:'Inspector tasks'}));
  navigation.getByRole('button',{name:'Edit'}).focus();await user.tab();expect(navigation.getByRole('button',{name:'Practice'})).toHaveFocus();
  await user.keyboard('{Enter}');expect(screen.getByLabelText('Practice draft')).toBeVisible();expect(screen.getByText('Practice',{selector:'summary'})).toHaveFocus();
  fireEvent.click(navigation.getByRole('button',{name:'Edit'}));
  fireEvent.change(screen.getByLabelText('Measure'),{target:{value:'2'}});expect(input.onSelect).toHaveBeenCalledWith({...target,bar:1,beat:0});
  fireEvent.change(screen.getByLabelText('Duration'),{target:{value:'8'}});disclose('Advanced rhythm');
  fireEvent.change(screen.getByLabelText('Tuplet numerator'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('Tuplet denominator'),{target:{value:'2'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply rhythm'}));expect(input.onEdit).toHaveBeenCalledWith({type:'setBeatRhythm',target,duration:8,dots:0,tupletNumerator:3,tupletDenominator:2,graceType:0});
});

it('retains unapplied rhythm and text drafts when the parent hides and reveals the mounted inspector',()=>{
  const input=props(),view=render(<div><EditorPanel {...input}/></div>);
  fireEvent.change(screen.getByLabelText('Duration'),{target:{value:'16'}});
  disclose('Beat text');fireEvent.change(screen.getByLabelText('Beat text'),{target:{value:'Let this ring'}});
  expect(input.onEdit).not.toHaveBeenCalled();
  view.rerender(<div hidden><EditorPanel {...input}/></div>);
  expect(screen.getByLabelText('Editing location')).not.toBeVisible();
  view.rerender(<div><EditorPanel {...input}/></div>);
  expect(screen.getByLabelText('Editing location')).toBeVisible();
  expect(screen.getByLabelText('Duration')).toHaveValue('16');expect(screen.getByLabelText('Beat text')).toHaveValue('Let this ring');
  fireEvent.click(screen.getByRole('button',{name:'Apply rhythm'}));
  expect(input.onEdit).toHaveBeenNthCalledWith(1,{type:'setBeatRhythm',target,duration:16,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0});
  fireEvent.click(screen.getByRole('button',{name:'Apply beat text'}));
  expect(input.onEdit).toHaveBeenNthCalledWith(2,{type:'setBeatText',target,text:'Let this ring'});
});

it('identifies the indexed note in the persistent location and keeps unsupported techniques reachable',()=>{
  const input=props();input.score.tracks[0].staves[0].isPercussion=true;
  const view=render(<EditorPanel {...input} noteIndex={0}/>);
  expect(screen.getByLabelText('Editing location')).toHaveTextContent('Staff 1 · Voice 1 · Note 1');
  disclose('Notes & techniques');expect(screen.getByLabelText('Palm mute')).toBeVisible();expect(screen.getByLabelText('Palm mute')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Ghost note'));
  expect(input.onEdit).toHaveBeenCalledWith({type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{ghost:true}});
  view.rerender(<EditorPanel {...input} noteIndex={null}/>);
  expect(screen.getByLabelText('Editing location')).toHaveTextContent('No note selected');
});
