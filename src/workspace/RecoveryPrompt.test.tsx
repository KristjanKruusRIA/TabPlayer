// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { blankProject } from '../project';
import type { DocumentSnapshot } from './types';
import type { RecoveryPreview } from './recovery-types';
import { RecoveryPrompt } from './RecoveryPrompt';

afterEach(cleanup);
function documentRecord(id:string,title:string):DocumentSnapshot {
  const project=blankProject();
  if(project.base.kind==='blank')project.base.title=title;
  return {documentId:id,revision:2,snapshot:{project,canUndo:true,canRedo:false,dirty:true,path:null}};
}
function preview(change:Partial<RecoveryPreview>={}):RecoveryPreview {
  return {token:'recovery-one',reason:'crash',documents:[documentRecord('one','夜の音楽'),documentRecord('two','夜の音楽')],views:{},activeDocumentId:'one',issues:[],capturedAtUnixMs:1792053600000,...change};
}
function callbacks(){return {onRestore:vi.fn(),onDiscard:vi.fn(),onStartNew:vi.fn()};}

it('crash_choice_lists_valid_titles_time_and_exclusions',()=>{
  const actions=callbacks();
  const {container}=render(<RecoveryPrompt preview={preview({issues:[{documentId:null,message:'The newest backup could not be read. Using an older checkpoint.'},{documentId:'bad',message:'Score 3 could not be recovered.'}]})} busy={false} {...actions}/>);
  const dialog=screen.getByRole('dialog',{name:'Recover unsaved work?'});
  expect(dialog).toHaveAccessibleDescription(/last completed backup/);
  expect(within(dialog).getByText('2 recoverable documents')).toBeInTheDocument();
  expect(within(dialog).getAllByText('夜の音楽')).toHaveLength(2);
  expect(within(dialog).getAllByRole('listitem').slice(0,2).map(item=>item.getAttribute('aria-label'))).toEqual(['Score 1 of 2: 夜の音楽','Score 2 of 2: 夜の音楽']);
  expect(container.querySelector('time')).toHaveAttribute('datetime','2026-10-15T08:40:00.000Z');
  expect(within(dialog).getByText(/Using an older checkpoint/)).toBeInTheDocument();
  expect(within(dialog).getByText('Score 3 could not be recovered.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Restore'})).toBeEnabled();
  expect(screen.getByRole('button',{name:'Discard recovery'})).toBeEnabled();
  expect(screen.queryByRole('button',{name:'Start new session'})).not.toBeInTheDocument();
  expect(Object.values(actions).every(action=>action.mock.calls.length===0)).toBe(true);
});

it('prompt_has_keyboard_focus_and_no_editor_actions',async()=>{
  const user=userEvent.setup(),actions=callbacks();
  render(<RecoveryPrompt preview={preview({documents:[documentRecord('one','長い曲名 '.repeat(80))]})} busy={false} {...actions}/>);
  const dialog=screen.getByRole('dialog');
  expect(dialog).toHaveFocus();
  const scores=screen.getByRole('region',{name:'Recoverable documents'});
  expect(scores).toHaveAttribute('tabindex','0');
  expect(within(scores).getByRole('listitem')).toHaveTextContent('長い曲名 '.repeat(80).trim());
  await user.tab();expect(scores).toHaveFocus();
  await user.tab();expect(screen.getByRole('button',{name:'Restore'})).toHaveFocus();
  await user.keyboard('{Enter}');expect(actions.onRestore).toHaveBeenCalledExactlyOnceWith();
  await user.tab();expect(screen.getByRole('button',{name:'Discard recovery'})).toHaveFocus();
  await user.tab();expect(scores).toHaveFocus();
  await user.tab({shift:true});expect(screen.getByRole('button',{name:'Discard recovery'})).toHaveFocus();
  await user.keyboard(' ');expect(actions.onDiscard).toHaveBeenCalledExactlyOnceWith();
  expect(actions.onStartNew).not.toHaveBeenCalled();
});

it('Escape_backdrop_and_window_close_never_discard',async()=>{
  const user=userEvent.setup(),actions=callbacks();
  const {container}=render(<RecoveryPrompt preview={preview()} busy={false} {...actions}/>);
  await user.keyboard('{Escape}');
  fireEvent.click(container.firstElementChild!);
  fireEvent(window,new Event('beforeunload'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(Object.values(actions).every(action=>action.mock.calls.length===0)).toBe(true);
});

it('busy_disables_duplicate_submissions_and_keeps_focus_inside',()=>{
  const actions=callbacks(),value=preview();
  const view=render(<RecoveryPrompt preview={value} busy={false} {...actions}/>);
  const restore=screen.getByRole('button',{name:'Restore'});restore.focus();
  fireEvent.click(restore);expect(actions.onRestore).toHaveBeenCalledTimes(1);
  view.rerender(<RecoveryPrompt preview={value} busy {...actions}/>);
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy','true');
  expect(screen.getByRole('dialog')).toHaveFocus();
  for(const button of screen.getAllByRole('button')){expect(button).toBeDisabled();fireEvent.click(button);}
  expect(actions.onRestore).toHaveBeenCalledTimes(1);expect(actions.onDiscard).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('Opening session…');
  view.rerender(<RecoveryPrompt preview={value} busy={false} {...actions}/>);
  expect(screen.getByRole('button',{name:'Restore'})).toBeEnabled();
});

it.each(['unavailable','crash'] as const)('empty_%s_requires_explicit_start_new',async reason=>{
  const user=userEvent.setup(),actions=callbacks();
  const view=render(<RecoveryPrompt preview={preview({reason,documents:[],capturedAtUnixMs:null,issues:[{documentId:null,message:'The recovery manifest could not be read.'}]})} busy={false} {...actions}/>);
  expect(screen.getByRole('dialog',{name:'Recovery unavailable'})).toHaveAccessibleDescription(/could not recover/);
  expect(screen.getByText('The recovery manifest could not be read.')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Restore'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Discard recovery'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Start new session'}));
  expect(actions.onStartNew).toHaveBeenCalledExactlyOnceWith();
  expect(actions.onDiscard).not.toHaveBeenCalled();expect(actions.onRestore).not.toHaveBeenCalled();
  view.rerender(<RecoveryPrompt preview={preview({reason,documents:[]})} busy {...actions}/>);
  expect(screen.getByRole('button',{name:'Start new session'})).toBeDisabled();
});

it('clean_automatic_restoration_shows_progress_and_issues_without_choices',()=>{
  const actions=callbacks();
  render(<RecoveryPrompt preview={preview({reason:'clean',issues:[{documentId:'one',message:'Editor location was reset.'}]})} busy {...actions}/>);
  expect(screen.getByRole('dialog',{name:'Restoring previous session'})).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('Restoring session…');
  expect(screen.getByText('Editor location was reset.')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(Object.values(actions).every(action=>action.mock.calls.length===0)).toBe(true);
});

it('titles_use_latest_applied_metadata_and_never_expose_source_directories',()=>{
  const edited=documentRecord('one','Old title');
  edited.snapshot.project.edits=[{type:'setScoreInfo',title:'Earlier edit',artist:'',tempo:120},{type:'setScoreInfo',title:'New title',artist:'',tempo:120}];
  const imported=documentRecord('two','');
  imported.snapshot.project.base={kind:'file',filename:'C:\\private\\scores\\夕暮れ.gp',bytesBase64:'',sha256:'unused'};
  const untitled=documentRecord('three','  ');
  render(<RecoveryPrompt preview={preview({documents:[edited,imported,untitled],capturedAtUnixMs:null})} busy={false} {...callbacks()}/>);
  expect(screen.getByText('New title')).toBeInTheDocument();
  expect(screen.queryByText('Old title')).not.toBeInTheDocument();
  expect(screen.queryByText('Earlier edit')).not.toBeInTheDocument();
  expect(screen.getByText('夕暮れ.gp')).toBeInTheDocument();
  expect(screen.getByText('Untitled')).toBeInTheDocument();
  expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  expect(screen.getByText('Checkpoint time unavailable.')).toBeInTheDocument();
});

it('titles_use_baseline_metadata_until_a_user_edit_overrides_it',()=>{
  const baseline=documentRecord('baseline','Base title'),override=documentRecord('override','Base title'),empty=documentRecord('empty','Base title');
  baseline.snapshot.project.baselineEdits=[{type:'setScoreInfo',title:'Template ensemble',artist:'',tempo:120}];
  override.snapshot.project.baselineEdits=structuredClone(baseline.snapshot.project.baselineEdits);
  override.snapshot.project.edits=[{type:'setScoreInfo',title:'User ensemble',artist:'',tempo:120}];
  empty.snapshot.project.baselineEdits=[{type:'setScoreInfo',title:'  ',artist:'',tempo:120}];
  render(<RecoveryPrompt preview={preview({documents:[baseline,override,empty]})} busy={false} {...callbacks()}/>);
  expect(screen.getByText('Template ensemble')).toBeInTheDocument();expect(screen.getByText('User ensemble')).toBeInTheDocument();expect(screen.getByText('Untitled')).toBeInTheDocument();
  expect(screen.queryByText('Base title')).not.toBeInTheDocument();
});
