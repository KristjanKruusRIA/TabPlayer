// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { SystemGapsPanel } from './SystemGapsPanel';
import { withSystemGaps } from './system-gaps';
import { defaultEngraving } from './projection';

afterEach(cleanup);
const systems=[{first:0,last:1},{first:2,last:3},{first:4,last:5}];
const open=()=>{for(const details of document.querySelectorAll('details'))details.open=true;};
const setup=(props:Partial<Parameters<typeof SystemGapsPanel>[0]>={})=>{
  const onEdit=vi.fn(),value=props.value??defaultEngraving();
  const result=render(<SystemGapsPanel value={value} systems={systems} pageLayout bar={2} busy={false} onEdit={onEdit} {...props}/>);open();
  return {onEdit,value,...result};
};
const field=()=>screen.getByLabelText('System gap (%)') as HTMLInputElement;
const commitText=(text:string)=>{fireEvent.change(field(),{target:{value:text}});fireEvent.blur(field());};
const gaps=(...entries:Array<[number,number]>)=>withSystemGaps(defaultEngraving(),entries.map(([bar,scale])=>({bar,scale})));

it('records one setEngraving command for a committed percentage',()=>{
  const {onEdit}=setup();
  expect(screen.getByText('Selected system: bars 3 to 4.')).toBeTruthy();
  commitText('200');
  expect(onEdit).toHaveBeenCalledTimes(1);
  const sent=onEdit.mock.calls[0][0];expect(sent.type).toBe('setEngraving');expect(sent.engraving.systemGaps).toEqual([{bar:2,scale:2}]);
});

it('records nothing when the value equals the resolved gap, even if stored entries differ in layout',()=>{
  const {onEdit}=setup();commitText('100');expect(onEdit).not.toHaveBeenCalled();
  // An entry on a later bar of the system resolves to 150%.
  const value=gaps([3,1.5]);onEdit.mockClear();
  cleanup();const again=setup({value});expect(field().value).toBe('150');commitText('150');expect(again.onEdit).not.toHaveBeenCalled();
});

it('refuses out-of-range and non-numeric input, shows the message and restores the value on blur',()=>{
  const {onEdit}=setup();
  for(const text of ['24','401','','abc']){
    fireEvent.change(field(),{target:{value:text}});fireEvent.keyDown(field(),{key:'Enter'});
    if(text!=='')expect(screen.getByRole('alert').textContent).toBe('Enter a number from 25 to 400.');
    fireEvent.blur(field());expect(field().value).toBe('100');expect(screen.queryByRole('alert')).toBeNull();
  }
  expect(onEdit).not.toHaveBeenCalled();
});

it('resets only the selected system entries',()=>{
  const value=gaps([0,.5],[2,2],[4,3]);
  const {onEdit}=setup({value});
  fireEvent.click(screen.getByRole('button',{name:'Reset selected system'}));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.systemGaps).toEqual([{bar:0,scale:.5},{bar:4,scale:3}]);
});

it('resets every gap in one command and is unavailable when there are none',()=>{
  const {onEdit}=setup({value:gaps([2,2],[4,3])});
  fireEvent.click(screen.getByRole('button',{name:'Reset all system gaps'}));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(Object.hasOwn(onEdit.mock.calls[0][0].engraving,'systemGaps')).toBe(false);
  cleanup();const none=setup();
  for(const name of ['Reset selected system','Reset all system gaps']){const button=screen.getByRole('button',{name});expect(button.getAttribute('aria-disabled')).toBe('true');fireEvent.click(button);}
  expect(none.onEdit).not.toHaveBeenCalled();
});

it('reset selected is unavailable when its system holds no entry',()=>{
  const {onEdit}=setup({value:gaps([4,3])});
  const button=screen.getByRole('button',{name:'Reset selected system'});expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);expect(onEdit).not.toHaveBeenCalled();
});

it('says why the controls are unavailable',()=>{
  const cases:Array<[Partial<Parameters<typeof SystemGapsPanel>[0]>,RegExp]>=[
    [{pageLayout:false},/apply in the page layouts/],
    [{systems:null},/still rendering/],
    [{systems:null,pageError:true},/pages cannot be arranged/],
    [{busy:true,locked:true},/Editing is locked/],
    [{bar:null},/Select a bar/],
    [{bar:40},/not in a rendered system/],
    [{bar:1},/first system of the score has no gap/],
  ];
  for(const [props,text] of cases){
    cleanup();const {onEdit}=setup(props);
    expect(screen.getByRole('status',{name:''}).textContent).toMatch(text);
    expect(field().hasAttribute('disabled')).toBe(false);expect(field().readOnly).toBe(true);expect(field().getAttribute('aria-disabled')).toBe('true');fireEvent.change(field(),{target:{value:'200'}});fireEvent.blur(field());expect(onEdit).not.toHaveBeenCalled();
  }
});

it('refuses to commit while busy without disabling the controls, so they keep focus',()=>{
  const {onEdit}=setup({busy:true,value:gaps([2,2])});
  const button=screen.getByRole('button',{name:'Reset selected system'});button.focus();
  expect(button.hasAttribute('disabled')).toBe(false);expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);fireEvent.keyDown(button,{key:'Enter'});
  expect(field().hasAttribute('disabled')).toBe(false);
  field().focus();fireEvent.change(field(),{target:{value:'300'}});fireEvent.blur(field());
  expect(onEdit).not.toHaveBeenCalled();expect(field().value).toBe('200');
});

it('records nothing when the field is focused and blurred untouched, even for a stored scale the display rounds',()=>{
  const {onEdit}=setup({value:gaps([2,1/3])});
  expect(field().value).toBe('33.33');field().focus();fireEvent.blur(field());expect(onEdit).not.toHaveBeenCalled();
  // Typing back the shown text is also no change.
  commitText('33.33');expect(onEdit).not.toHaveBeenCalled();
});

it('commits Enter exactly once, including when Enter is followed by blur',()=>{
  const {onEdit}=setup();
  fireEvent.change(field(),{target:{value:'250'}});fireEvent.keyDown(field(),{key:'Enter'});fireEvent.blur(field());
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.systemGaps).toEqual([{bar:2,scale:2.5}]);
});

it('follows a new engraving value (undo or redo) while the field is being edited',()=>{
  const {onEdit,rerender}=setup({value:gaps([2,2])});
  fireEvent.change(field(),{target:{value:'310'}});expect(field().value).toBe('310');
  rerender(<SystemGapsPanel value={gaps([2,1.5])} systems={systems} pageLayout bar={2} busy={false} onEdit={onEdit}/>);
  expect(field().value).toBe('150');fireEvent.blur(field());expect(onEdit).not.toHaveBeenCalled();
});

it('follows the selected system and never commits old typed text to the new one',()=>{
  const {onEdit,rerender}=setup({value:gaps([4,3])});
  fireEvent.change(field(),{target:{value:'210'}});
  rerender(<SystemGapsPanel value={gaps([4,3])} systems={systems} pageLayout bar={4} busy={false} onEdit={onEdit}/>);
  expect(field().value).toBe('300');expect(screen.getByText('Selected system: bars 5 to 6.')).toBeTruthy();
  fireEvent.blur(field());expect(onEdit).not.toHaveBeenCalled();expect(field().value).toBe('300');
});

it('keeps an unavailable field readable, focusable and uneditable, with the status described',()=>{
  const {onEdit}=setup({busy:true,bar:1});
  field().focus();expect(document.activeElement).toBe(field());
  expect(field().readOnly).toBe(true);expect(field().hasAttribute('disabled')).toBe(false);expect(field().getAttribute('aria-disabled')).toBe('true');
  expect(document.getElementById(field().getAttribute('aria-describedby')!)?.textContent).toMatch(/first system/);
  fireEvent.change(field(),{target:{value:'200'}});fireEvent.blur(field());expect(onEdit).not.toHaveBeenCalled();
});

it('announces an invalid value once, through the alert the field points at',()=>{
  setup();fireEvent.change(field(),{target:{value:'900'}});fireEvent.keyDown(field(),{key:'Enter'});
  const alert=screen.getByRole('alert');expect(field().getAttribute('aria-describedby')).toContain(alert.id);
  expect(field().validity.customError).toBe(false);expect(screen.getAllByRole('alert')).toHaveLength(1);
});

it('drops typed text when the panel becomes unavailable or busy, so a later blur commits nothing stale',()=>{
  for(const change of [{busy:true},{pageError:true,systems:null}] as Array<Partial<Parameters<typeof SystemGapsPanel>[0]>>){
    cleanup();const {onEdit,rerender}=setup();
    fireEvent.change(field(),{target:{value:'250'}});expect(field().value).toBe('250');
    rerender(<SystemGapsPanel value={defaultEngraving()} systems={systems} pageLayout bar={2} busy={false} onEdit={onEdit} {...change}/>);
    rerender(<SystemGapsPanel value={defaultEngraving()} systems={systems} pageLayout bar={2} busy={false} onEdit={onEdit}/>);
    expect(field().value).toBe('100');fireEvent.blur(field());expect(onEdit).not.toHaveBeenCalled();
  }
});
