// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OpenPasswordDialog,ProtectionDialog,UnlockEditingDialog } from './PasswordDialogs';
import { PASSWORDS_DIFFER,PASSWORD_RULE,type ProtectionRequest } from './protection';
import type { Protection } from '../project';

afterEach(cleanup);
const WRONG='The password is incorrect, or this file is damaged.';
const type=(label:string|RegExp,value:string,scope:HTMLElement|undefined=undefined)=>fireEvent.change((scope?within(scope):screen).getByLabelText(label),{target:{value}});
const pending=()=>{let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};

it('asks for the password with focus in the field, says nothing about the file, and opens on the right one',async()=>{
  const onTry=vi.fn(async(_password:string)=>{}),onCancel=vi.fn();
  render(<OpenPasswordDialog fileName="Moonlight.tabplayer" onTry={onTry} onCancel={onCancel}/>);
  const field=screen.getByLabelText('Password');
  expect(screen.getByRole('dialog',{name:'Password required'})).toHaveTextContent('“Moonlight.tabplayer” is password-protected.');
  expect(field).toHaveFocus();expect(field).toHaveAttribute('type','password');
  expect(screen.getByRole('button',{name:'Open'})).toHaveAttribute('aria-disabled','true');
  fireEvent.submit(field.closest('form')!);expect(onTry).not.toHaveBeenCalled();
  type('Password','open sesame');
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(onTry).toHaveBeenCalledWith('open sesame'));
  // The password is never shown as text, and showing it is the person's choice.
  expect(document.body.textContent).not.toContain('open sesame');
  fireEvent.click(screen.getByLabelText('Show passwords'));expect(field).toHaveAttribute('type','text');
});

it('a wrong password keeps the dialog, shows the one reason, clears the field and returns focus to it',async()=>{
  const onTry=vi.fn(async(_password:string)=>{throw new Error(WRONG);}),onCancel=vi.fn();
  render(<OpenPasswordDialog fileName="a.tabplayer" onTry={onTry} onCancel={onCancel}/>);
  const field=screen.getByLabelText('Password');
  type('Password','nope nope');fireEvent.click(screen.getByRole('button',{name:'Open'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(WRONG);
  await waitFor(()=>expect(field).toHaveFocus());
  expect(field).toHaveValue('');expect(field).toHaveAttribute('aria-invalid','true');
  expect(onCancel).not.toHaveBeenCalled();expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('nope nope');
  // Another attempt is possible, and cancelling still gives up.
  type('Password','again again');fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(onTry).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(document,{key:'Escape'});expect(onCancel).toHaveBeenCalledTimes(1);
});

it('while the password is checked nothing becomes disabled, so focus stays, and a second press does nothing',async()=>{
  const wait=pending(),onTry=vi.fn((_password:string)=>wait.promise),onCancel=vi.fn();
  render(<OpenPasswordDialog fileName="a.tabplayer" onTry={onTry} onCancel={onCancel}/>);
  const field=screen.getByLabelText('Password');field.focus();
  type('Password','slow slow slow');
  const open=screen.getByRole('button',{name:'Open'});
  fireEvent.click(open);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Checking…'})).toHaveAttribute('aria-disabled','true'));
  for(const control of screen.getAllByRole('button'))expect(control).not.toBeDisabled();
  expect(field).not.toBeDisabled();expect(field).toHaveAttribute('readonly');expect(field).toHaveFocus();
  fireEvent.click(screen.getByRole('button',{name:'Checking…'}));
  fireEvent.submit(field.closest('form')!);expect(onTry).toHaveBeenCalledTimes(1);
  // Cancel and close are refused while the check runs, but stay focusable.
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));fireEvent.keyDown(document,{key:'Escape'});expect(onCancel).not.toHaveBeenCalled();
  wait.resolve();await waitFor(()=>expect(screen.queryByRole('button',{name:'Checking…'})).toBeNull());
});

it('unlocking editing says the score can still be read and played, and shows a wrong password beside the field',async()=>{
  const onTry=vi.fn(async(_password:string)=>{throw new Error('That password is not correct.');});
  render(<UnlockEditingDialog onTry={onTry} onClose={vi.fn()}/>);
  expect(screen.getByRole('dialog',{name:'Unlock editing'})).toHaveTextContent('You can still play and read it.');
  type('Password to edit','teacher teacher');fireEvent.click(screen.getByRole('button',{name:'Unlock editing'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.');
  expect(screen.getByLabelText('Password to edit')).toHaveFocus();
});

const none:Protection={edit:'none',open:false};
const manage=(protection:Protection,onRequest:(request:ProtectionRequest)=>Promise<void>=async()=>{},dirty=false)=>{
  const onClose=vi.fn();render(<ProtectionDialog protection={protection} dirty={dirty} onRequest={onRequest} onClose={onClose}/>);
  return {onClose,edit:screen.getByRole('region',{name:'Password to edit'}),open:screen.getByRole('region',{name:'Password to open'})};
};

it('is honest about each password: the edit password is a deterrent, the open password cannot be recovered',()=>{
  const {edit,open}=manage(none);
  expect(edit).toHaveTextContent('This is a deterrent, not encryption.');
  expect(edit).toHaveTextContent('can get around it');
  expect(open).toHaveTextContent('There is no way to recover a forgotten password');
  expect(open).toHaveTextContent('Encrypts the saved file');
  expect(edit).toHaveTextContent('No password to edit is set.');expect(open).toHaveTextContent('No password to open is set.');
});

it('refuses a short password or two that differ before asking the native side, and keeps what was typed',async()=>{
  const onRequest=vi.fn(async(_request:ProtectionRequest)=>{});
  const {edit}=manage(none,onRequest);
  type('Password','short',edit);type('Confirm password','short',edit);fireEvent.click(within(edit).getByRole('button',{name:'Set password'}));
  expect(within(edit).getByRole('alert')).toHaveTextContent(PASSWORD_RULE);
  type('Password','long enough pass',edit);type('Confirm password','long enough pasS',edit);fireEvent.click(within(edit).getByRole('button',{name:'Set password'}));
  expect(within(edit).getByRole('alert')).toHaveTextContent(PASSWORDS_DIFFER);
  expect(onRequest).not.toHaveBeenCalled();expect(within(edit).getByLabelText('Password')).toHaveValue('long enough pass');
});

it('sets a password with one request, says to save, and forgets what was typed',async()=>{
  const onRequest=vi.fn(async(_request:ProtectionRequest)=>{});
  const {open}=manage(none,onRequest);
  type('Password','a good long phrase',open);type('Confirm password','a good long phrase',open);fireEvent.click(within(open).getByRole('button',{name:'Set password'}));
  await waitFor(()=>expect(onRequest).toHaveBeenCalledExactlyOnceWith({kind:'setOpenPassword',current:null,password:'a good long phrase'}));
  await waitFor(()=>expect(open).toHaveTextContent('Password to open set. Save the score to encrypt the file.'));
  expect(within(open).getByLabelText('Password')).toHaveValue('');expect(within(open).getByLabelText('Confirm password')).toHaveValue('');
  expect(document.body.textContent).not.toContain('a good long phrase');
});

it('changing or removing a password needs the current one and shows a wrong one beside the field',async()=>{
  const onRequest=vi.fn(async(request:ProtectionRequest)=>{if(request.kind==='removeEditPassword'&&request.current!=='right right')throw new Error('That password is not correct.');});
  const {edit}=manage({edit:'unlocked',open:false},onRequest);
  expect(edit).toHaveTextContent('Editing is unlocked for now.');
  fireEvent.click(within(edit).getByRole('button',{name:'Remove password'}));
  expect(within(edit).getByRole('alert')).toHaveTextContent('Enter the current password to remove it.');expect(onRequest).not.toHaveBeenCalled();
  type('Current password','wrong wrong',edit);fireEvent.click(within(edit).getByRole('button',{name:'Remove password'}));
  await waitFor(()=>expect(within(edit).getByRole('alert')).toHaveTextContent('That password is not correct.'));
  expect(within(edit).getByLabelText('Current password')).toHaveFocus();expect(within(edit).getByLabelText('Current password')).toHaveValue('');
  type('Current password','right right',edit);fireEvent.click(within(edit).getByRole('button',{name:'Remove password'}));
  await waitFor(()=>expect(edit).toHaveTextContent('Password to edit removed. Save the score to keep this.'));
  // A change names the current password and the new one.
  type('Current password','right right',edit);type('New password','brand new phrase',edit);type('Confirm password','brand new phrase',edit);
  fireEvent.click(within(edit).getByRole('button',{name:'Change password'}));
  await waitFor(()=>expect(onRequest).toHaveBeenLastCalledWith({kind:'setEditPassword',current:'right right',password:'brand new phrase'}));
});

it('offers to lock editing again only while it is unlocked, and keeps every control focusable while busy',async()=>{
  const wait=pending(),onRequest=vi.fn((_request:ProtectionRequest)=>wait.promise);
  const {edit}=manage({edit:'unlocked',open:true},onRequest);
  const lock=within(edit).getByRole('button',{name:'Lock editing now'});
  lock.focus();fireEvent.click(lock);
  await waitFor(()=>expect(onRequest).toHaveBeenCalledExactlyOnceWith({kind:'lockEditing'}));
  expect(lock).not.toBeDisabled();expect(lock).toHaveAttribute('aria-disabled','true');expect(lock).toHaveFocus();
  fireEvent.click(lock);expect(onRequest).toHaveBeenCalledTimes(1);
  wait.resolve();
  cleanup();
  const locked=manage({edit:'locked',open:false});
  expect(within(locked.edit).queryByRole('button',{name:'Lock editing now'})).toBeNull();
  expect(locked.edit).toHaveTextContent('Editing is locked.');
});

it('tells the person when the new passwords still need saving',()=>{
  manage({edit:'unlocked',open:false},async()=>{},true);
  expect(screen.getByRole('dialog')).toHaveTextContent('Passwords take effect in the saved file when you save the score.');
});
