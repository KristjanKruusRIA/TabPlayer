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

it('glyph editing toolbar dispatches one undoable edit per duration, dot, rest, tie and technique click with roving keyboard navigation',()=>{
  const input=props();
  render(<EditorPanel {...input}/>);
  const toolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));
  expect(toolbar.getByRole('button',{name:'Quarter note (1/4)'})).toHaveAttribute('aria-pressed','true');

  fireEvent.click(toolbar.getByRole('button',{name:'Eighth note (1/8)'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setDuration',target,duration:8,dots:0});
  expect(screen.getByLabelText('Duration')).toHaveValue('8');

  fireEvent.click(toolbar.getByRole('button',{name:'Dotted'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setDuration',target,duration:4,dots:1});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle rest'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setRest',target});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle tie'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:{target:{...target,beat:1},string:6},kind:'tie'});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle hammer/pull'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:{target:{...target,beat:1},string:6},kind:'hammerPull'});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle slide'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{slideOut:1}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle bend'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{bend:{type:1,style:0,points:[{offset:0,value:0},{offset:60,value:4}]}}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle vibrato'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{vibrato:1}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle palm mute'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{palmMute:true}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle harmonic'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{harmonic:{type:1,value:12}}});

  const first=toolbar.getByRole('button',{name:'Whole note (1/1)'});
  first.focus();
  fireEvent.keyDown(first,{key:'ArrowRight'});
  expect(toolbar.getByRole('button',{name:'Half note (1/2)'})).toHaveFocus();
  fireEvent.keyDown(toolbar.getByRole('button',{name:'Half note (1/2)'}),{key:'End'});
  expect(toolbar.getByRole('button',{name:'Toggle accent'})).toHaveFocus();
  fireEvent.keyDown(toolbar.getByRole('button',{name:'Toggle accent'}),{key:'Home'});
  expect(first).toHaveFocus();
});

it('duration button at current duration and rest toggle on indexed-staff rest record nothing',()=>{
  const input=props();
  render(<EditorPanel {...input}/>);
  const toolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));

  // Beat 1 starts with Quarter note (4). Clicking Quarter note again records nothing (Finding 2)
  fireEvent.click(toolbar.getByRole('button',{name:'Quarter note (1/4)'}));
  expect(input.onEdit).not.toHaveBeenCalled();

  // Test indexed staff rest toggle
  input.score.tracks[0].staves[0].isPercussion=true;
  input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].isEmpty=false;
  input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes=[];
  // beat 0 is now a rest on percussion/indexed staff
  cleanup();
  render(<EditorPanel {...input}/>);
  const indexedToolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));
  expect(indexedToolbar.getByRole('button',{name:'Toggle rest'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(indexedToolbar.getByRole('button',{name:'Toggle rest'}));
  // Must NOT dispatch setRest on an existing rest on an indexed staff (Finding 2)
  expect(input.onEdit).not.toHaveBeenCalled();
});

it('toggle slide and tie mirror engine preconditions from techniques.ts',()=>{
  const input=props();
  // String 6 has notes on beat 0 and beat 1 in music() fixture.
  // Beat 0: realValue 40 (fret 0 or whatever). Beat 1: change pitch so notes differ!
  const note0=input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.find(n=>n.string===6)!;
  const note1=input.score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes.find(n=>n.string===6)!;
  note0.fret=3;
  note1.fret=5; // different pitch!

  const view=render(<EditorPanel {...input} target={{...target,beat:0}} string={6}/>);
  const toolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));

  // Toggle tie requires EQUAL pitch according to techniques.ts:38 (Finding 9)
  expect(toolbar.getByRole('button',{name:'Toggle tie'})).toBeDisabled();

  // Make pitch equal: tie should become enabled
  note1.fret=3;
  view.rerender(<EditorPanel {...input} target={{...target,beat:0}} string={6}/>);
  expect(toolbar.getByRole('button',{name:'Toggle tie'})).toBeEnabled();

  // Toggle slide: clear subsequent notes on string 6 so beat 1 has NO next note on string 6!
  // It must be disabled according to techniques.ts:55 (Finding 9)
  for (let b = 2; b < 4; b++) {
    const beat = input.score.tracks[0].staves[0].bars[0].voices[0].beats[b];
    beat.notes = beat.notes.filter(n => n.string !== 6);
  }
  for (let bar = 1; bar < 4; bar++) {
    for (const beat of input.score.tracks[0].staves[0].bars[bar].voices[0].beats) {
      beat.notes = beat.notes.filter(n => n.string !== 6);
    }
  }
  view.rerender(<EditorPanel {...input} target={{...target,beat:1}} string={6}/>);
  expect(toolbar.getByRole('button',{name:'Toggle slide'})).toBeDisabled();
});

it('toolbar keyboard keeps one tab stop always and keeps focus through an edit',()=>{
  const input=props();
  const view=render(<EditorPanel {...input}/>);
  const toolbar=screen.getByRole('toolbar',{name:'Editing toolbar'});

  // Focus a button
  const eighth=within(toolbar).getByRole('button',{name:'Eighth note (1/8)'});
  eighth.focus();
  expect(eighth).toHaveFocus();

  // When busy becomes true during an edit, the button keeps focus (Finding 7)
  view.rerender(<EditorPanel {...input} busy/>);
  expect(eighth).toHaveFocus();
  expect(eighth).toHaveAttribute('aria-disabled','true');

  // Verify there is always at least one tab stop
  const tabStops=toolbar.querySelectorAll<HTMLButtonElement>('button.tp-glyph-btn[tabindex="0"]');
  expect(tabStops.length).toBeGreaterThanOrEqual(1);
});

it('contextual inspector shows active selection badges and filters panels by context while preserving drafts',()=>{
  const input=props();
  const note=input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  note.isPalmMute=true;
  note.bendType=1;
  const view=render(<EditorPanel {...input}><Draft label="Clipboard draft"/></EditorPanel>);

  const contextCard=within(screen.getByRole('region',{name:'Selection context'}));
  expect(contextCard.getByText(/Selected note · String 6/)).toBeVisible();
  expect(contextCard.getByLabelText('Active note techniques')).toHaveTextContent('Bend');
  expect(contextCard.getByLabelText('Active note techniques')).toHaveTextContent('PM');

  disclose('Beat text');
  fireEvent.change(screen.getByLabelText('Beat text'),{target:{value:'Verse riff'}});

  fireEvent.click(contextCard.getByRole('button',{name:'Note'}));
  expect(screen.getByLabelText('Fret')).toBeVisible();
  expect(screen.getByLabelText('Palm mute')).toBeVisible();
  expect(screen.getByText('Measure & notation',{selector:'summary'})).not.toBeVisible();
  expect(screen.getByText('Music selection',{selector:'summary'})).not.toBeVisible();

  fireEvent.click(contextCard.getByRole('button',{name:'Measure'}));
  expect(screen.getByLabelText('Time numerator')).toBeVisible();
  expect(screen.getByLabelText('Fret')).not.toBeVisible();

  fireEvent.click(contextCard.getByRole('button',{name:'Selection'}));
  expect(screen.getByLabelText('Clipboard draft')).toBeVisible();
  expect(screen.getByLabelText('Time numerator')).not.toBeVisible();

  fireEvent.click(contextCard.getByRole('button',{name:'Beat'}));
  expect(screen.getByLabelText('Beat text')).toHaveValue('Verse riff');

  view.rerender(<EditorPanel {...input} musicSelection={{kind:'bars',tracks:[0],firstBar:0,lastBar:1}}><Draft label="Clipboard draft"/></EditorPanel>);
  expect(contextCard.getByText('Range selection · Measures 1–2')).toBeVisible();
});
