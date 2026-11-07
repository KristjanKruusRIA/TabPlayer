// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { StaffGroupsPanel,type StaffGroupsPanelProps } from './StaffGroupsPanel';
import { LONG_FIRST_SHORT_AFTER,withLongFirstShortAfter,withStaffGaps,withStaffGroups } from './staff-groups';
import { defaultEngraving } from './projection';
import { threeTrackScore } from './staff-fixtures';

afterEach(cleanup);
const {score,ids}=threeTrackScore();
const onEdit=vi.fn();
let user=userEvent.setup();
beforeEach(()=>{onEdit.mockClear();user=userEvent.setup();});
const open=()=>{for(const details of document.querySelectorAll('details'))details.open=true;};
const setup=(value=defaultEngraving(),props:Partial<StaffGroupsPanelProps>={})=>{
  cleanup();
  const result=render(<StaffGroupsPanel value={value} score={score} trackIds={ids} rendered={[0,1,2]} pageLayout busy={false} onEdit={onEdit} {...props}/>);open();
  return result;
};

it('creating a group from two adjacent checked tracks is one command',async()=>{
  setup();await user.click(screen.getByLabelText('Include Guitar6'));await user.click(screen.getByLabelText('Include Grand Piano'));
  await user.selectOptions(screen.getByLabelText('Group mark'),'brace');await user.click(screen.getByRole('button',{name:'Group chosen tracks'}));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGroups).toEqual([{trackIds:['base/0','base/1'],kind:'brace'}]);
});
it('create is unavailable with a reason for one track or a gap in the run',async()=>{
  setup();const create=screen.getByRole('button',{name:'Group chosen tracks'});
  expect(create).toHaveAttribute('aria-disabled','true');expect(screen.getByText('Choose at least two tracks.')).toBeInTheDocument();
  await user.click(screen.getByLabelText('Include Guitar6'));await user.click(screen.getByLabelText('Include Drums'));
  expect(screen.getByText('Choose tracks that are next to each other.')).toBeInTheDocument();await user.click(create);expect(onEdit).not.toHaveBeenCalled();
});
it('a grouped track blocks a new group with a reason',async()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));
  await user.click(screen.getByLabelText('Include Grand Piano'));await user.click(screen.getByLabelText('Include Drums'));
  expect(screen.getByText('A chosen track is already in a group.')).toBeInTheDocument();
});
it('changing a group kind is one command and choosing the current kind records nothing',async()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));const kind=screen.getByLabelText('Group mark: Group: Guitar6, Grand Piano');
  await user.selectOptions(kind,'bracket');expect(onEdit).not.toHaveBeenCalled();
  await user.selectOptions(kind,'brace');expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGroups[0].kind).toBe('brace');
});
it('shows each stored group state, including a removed track',()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['gone','base/2'],kind:'brace'},{trackIds:['base/0','base/2'],kind:'bracket'}]));
  expect(screen.getByText('Group: removed track, Drums')).toBeInTheDocument();
  expect(screen.getByText('Not drawn: fewer than two of its tracks remain.')).toBeInTheDocument();
  expect(screen.getByText('Not drawn: its tracks are no longer next to each other.')).toBeInTheDocument();
});
it('shows a drawn group and one hidden by the view',()=>{
  const value=withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]);
  setup(value);expect(screen.getByText('Drawn.')).toBeInTheDocument();
  setup(value,{rendered:[0]});expect(screen.getByText('Not drawn in this view: fewer than two of its tracks are shown.')).toBeInTheDocument();
});
it('remove and remove all are single commands and unavailable when there is nothing to remove',async()=>{
  setup();expect(screen.getByRole('button',{name:'Remove all groups'})).toHaveAttribute('aria-disabled','true');
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));
  await user.click(screen.getByRole('button',{name:'Remove group'}));expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGroups).toBeUndefined();
  await user.click(screen.getByRole('button',{name:'Remove all groups'}));expect(onEdit).toHaveBeenCalledTimes(2);
});
it('a staff gap commits on Enter and blur, rejects 24 and 401, and the current value records nothing',async()=>{
  setup();const field=screen.getByLabelText('Staff gap (%)');
  await user.clear(field);await user.type(field,'24{Enter}');expect(screen.getByRole('alert')).toHaveTextContent('Enter a staff gap from 25 to 400%.');
  await user.clear(field);await user.type(field,'401{Enter}');expect(onEdit).not.toHaveBeenCalled();
  await user.clear(field);await user.type(field,'100{Enter}');expect(onEdit).not.toHaveBeenCalled();
  await user.clear(field);await user.type(field,'200{Enter}');expect(onEdit.mock.calls[0][0].engraving.staffGaps).toEqual([{trackId:'base/0',scale:2}]);
  await user.clear(field);await user.type(field,'150');field.blur();expect(onEdit).toHaveBeenCalledTimes(2);
});
it('the last shown track gets the last-track status and its stored gap can still be reset',async()=>{
  setup(withStaffGaps(defaultEngraving(),[{trackId:'base/2',scale:2}]));await user.selectOptions(screen.getByLabelText('Space below'),'base/2');
  expect(screen.getByText('This is the last shown track, so there is no space below it to change in this view.')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Reset'}));expect(onEdit.mock.calls[0][0].engraving.staffGaps).toBeUndefined();
});
it('resets all staff gaps in one command',async()=>{
  setup();expect(screen.getByRole('button',{name:'Reset all staff gaps'})).toHaveAttribute('aria-disabled','true');
  setup(withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2},{trackId:'base/1',scale:3}]));
  await user.click(screen.getByRole('button',{name:'Reset all staff gaps'}));expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.staffGaps).toBeUndefined();
});
it('outside page layouts the panel says staff gaps show only in page layouts and export',()=>{
  setup(defaultEngraving(),{pageLayout:false});expect(screen.getByText('Staff gaps show only in the page layouts and in export.')).toBeInTheDocument();
});
it('long names first, short after is one command and unavailable once set',async()=>{
  setup();await user.click(screen.getByRole('button',{name:'Long names first, short after'}));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].engraving.stylesheet).toMatchObject(LONG_FIRST_SHORT_AFTER);
  setup(withLongFirstShortAfter(defaultEngraving()));expect(screen.getAllByRole('button',{name:'Long names first, short after'}).at(-1)).toHaveAttribute('aria-disabled','true');
  expect(screen.getByText('Names already show long first and short after.')).toBeInTheDocument();
});
it('busy keeps focus: controls are aria-disabled, never disabled, and record nothing',async()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),{busy:true});
  for(const control of screen.getAllByRole('button'))expect(control).not.toBeDisabled();
  for(const control of [...screen.getAllByRole('checkbox'),...screen.getAllByRole('combobox')])expect(control).not.toBeDisabled();
  await user.click(screen.getByRole('button',{name:'Remove group'}));await user.click(screen.getByLabelText('Include Drums'));expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Include Drums')).not.toBeChecked();
});
it('locked documents say so',()=>{
  setup(defaultEngraving(),{busy:true,locked:true});expect(screen.getByText('This document is locked.')).toBeInTheDocument();
});
it('the gap field points at the visible last-track and layout notes',()=>{
  const described=(field:HTMLElement)=>(field.getAttribute('aria-describedby')??'').split(' ').filter(Boolean).map(id=>document.getElementById(id)?.textContent);
  setup(defaultEngraving(),{pageLayout:false});
  expect(described(screen.getByLabelText('Staff gap (%)'))).toContain('Staff gaps show only in the page layouts and in export.');
  setup(defaultEngraving(),{rendered:[0]});
  expect(described(screen.getByLabelText('Staff gap (%)'))).toContain('This is the last shown track, so there is no space below it to change in this view.');
});
it('each remove button is described by its group and the tracks sit in a labelled fieldset',()=>{
  setup(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'},{trackIds:['base/2','gone'],kind:'brace'}]));
  const buttons=screen.getAllByRole('button',{name:'Remove group'});
  expect(buttons.map(button=>button.getAttribute('aria-describedby')&&document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)).toEqual(['Group: Guitar6, Grand Piano','Group: Drums, removed track']);
  expect(screen.getByRole('group',{name:'Tracks to group'})).toBeInTheDocument();
});
it('ticked tracks are cleared only when the edit was accepted',async()=>{
  const choose=async()=>{await user.click(screen.getByLabelText('Include Guitar6'));await user.click(screen.getByLabelText('Include Grand Piano'));await user.click(screen.getByRole('button',{name:'Group chosen tracks'}));};
  onEdit.mockResolvedValueOnce(false);setup();await choose();
  expect(onEdit).toHaveBeenCalledTimes(1);await new Promise(resolve=>setTimeout(resolve,0));
  expect(screen.getByLabelText('Include Guitar6')).toBeChecked();
  onEdit.mockResolvedValueOnce(true);await user.click(screen.getByRole('button',{name:'Group chosen tracks'}));
  await waitFor(()=>expect(screen.getByLabelText('Include Guitar6')).not.toBeChecked());
});
