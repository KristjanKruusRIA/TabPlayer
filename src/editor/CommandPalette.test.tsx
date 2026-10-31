// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CommandPalette } from './CommandPalette';
import { music,target } from './fixtures';

afterEach(cleanup);
const context={score:music(),target,string:6,canUndo:true,canRedo:false};
const setup=(busy=false)=>{const onRun=vi.fn(),onClose=vi.fn();render(<CommandPalette context={context} busy={busy} onRun={onRun} onClose={onClose}/>);return {onRun,onClose,input:screen.getByRole('combobox',{name:'Command'})};};

it('focuses the command field, runs the first match with Enter and closes',()=>{
  const {onRun,onClose,input}=setup();
  expect(input).toHaveFocus();
  fireEvent.change(input,{target:{value:'measure 3'}});
  expect(screen.getAllByRole('option').map(option=>option.textContent)).toEqual(['Go to measure — measure 12']);
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).toHaveBeenCalledWith({kind:'select',target:{...target,bar:2}});expect(onClose).toHaveBeenCalled();
  // Closing comes first, so a dialog the command opens keeps its focus.
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onRun.mock.invocationCallOrder[0]);
});

it('moves through matches with the arrow keys and announces the active option',()=>{
  const {onRun,input}=setup();
  fireEvent.change(input,{target:{value:'measure'}});
  const options=()=>screen.getAllByRole('option');
  expect(options().map(option=>option.textContent?.split(' — ')[0])).toEqual(['Go to measure','Append measure','Remove measure']);
  fireEvent.keyDown(input,{key:'ArrowDown'});
  expect(options()[1]).toHaveAttribute('aria-selected','true');expect(input).toHaveAttribute('aria-activedescendant',options()[1].id);
  fireEvent.keyDown(input,{key:'ArrowUp'});fireEvent.keyDown(input,{key:'ArrowUp'});
  expect(options()[2]).toHaveAttribute('aria-selected','true');
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).toHaveBeenCalledWith({kind:'edit',command:{type:'removeMeasure',bar:0}});
});

it('shows why a command cannot run and does nothing on Enter, click or while busy',()=>{
  const {onRun,onClose,input}=setup();
  fireEvent.change(input,{target:{value:'measure 9'}});
  expect(screen.getByRole('option')).toHaveTextContent('Go to measure — Type a measure number from 1 to 4.');
  expect(screen.getByRole('option')).toHaveAttribute('aria-disabled','true');
  fireEvent.keyDown(input,{key:'Enter'});fireEvent.click(screen.getByRole('option'));
  expect(onRun).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'qqq'}});
  expect(screen.getByRole('status')).toHaveTextContent('No command or expression matches. Try measure 12, fret 5, ff, 3/4, Eb major, [Chorus] or Am7.');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(input,{key:'Tab'});expect(input).toHaveFocus();
  fireEvent.keyDown(input,{key:'Escape'});expect(onClose).toHaveBeenCalled();
  cleanup();
  const busy=setup(true);fireEvent.change(busy.input,{target:{value:'append'}});fireEvent.keyDown(busy.input,{key:'Enter'});
  expect(busy.onRun).not.toHaveBeenCalled();expect(screen.getByRole('status')).toHaveTextContent('Wait for the current operation to finish.');
});

it('lists shortcuts beside commands and runs a typed expression first',()=>{
  const {onRun,input}=setup();
  fireEvent.change(input,{target:{value:'undo'}});
  expect(screen.getByRole('option')).toHaveTextContent('Undo Ctrl+Z');
  fireEvent.change(input,{target:{value:'ff'}});
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('Dynamic ff on the note');
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).toHaveBeenCalledWith({kind:'edit',command:{type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{dynamics:6}}});
});

it('refuses edit commands, undo and redo while the document is finalized but still navigates',()=>{
  const onRun=vi.fn(),onClose=vi.fn();
  render(<CommandPalette context={{...context,canRedo:true,locked:true}} busy={false} onRun={onRun} onClose={onClose}/>);
  const input=screen.getByRole('combobox',{name:'Command'});
  fireEvent.change(input,{target:{value:'fret 5'}});
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('This document is finalized. Unfinalize it to make changes.');
  fireEvent.keyDown(input,{key:'Enter'});
  fireEvent.change(input,{target:{value:'undo'}});fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'measure 3'}});fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).toHaveBeenCalledWith({kind:'select',target:{...target,bar:2}});
});

it('keeps input focus when clicking the dialog title or padding, and anchors near top',()=>{
  const {input}=setup();
  expect(input).toHaveFocus();
  const title=screen.getByRole('heading',{name:'Commands'});
  fireEvent.mouseDown(title);
  expect(input).toHaveFocus();
  const dialog=screen.getByRole('dialog');
  expect(dialog.parentElement).toHaveClass('command-palette-backdrop');
});

it('refuses score-editing palette commands while the score is hidden but allows non-score commands',()=>{
  const onRun=vi.fn(),onClose=vi.fn();
  render(<CommandPalette context={{...context,scoreHidden:true}} busy={false} onRun={onRun} onClose={onClose}/>);
  const input=screen.getByRole('combobox',{name:'Command'});
  fireEvent.change(input,{target:{value:'append measure'}});
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('Score editing is unavailable while the score is hidden.');
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-disabled','true');
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'play'}});
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onRun).toHaveBeenCalledWith({kind:'app',name:'play'});
});

it('closes when the backdrop is pressed but not when the panel is',()=>{
  const {onClose}=setup();
  fireEvent.mouseDown(screen.getByRole('dialog'));expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);expect(onClose).toHaveBeenCalledTimes(1);
});
