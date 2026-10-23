// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from '@coderline/alphatab';
import { AsciiTabImportDialog } from './AsciiTabImportDialog';
import { loadInterchangeScore } from '../interchange/gp';

afterEach(cleanup);
const riff=['e|----------------|','B|----------------|','G|----------------|','D|----------------|','A|----3-------3---|','E|0-------0-------|'].join('\n');
const setup=(busy=false,result:()=>Promise<boolean>=async()=>true)=>{
  const onImport=vi.fn((_name:string,_bytes:Uint8Array)=>result()),onClose=vi.fn();
  render(<AsciiTabImportDialog busy={busy} onImport={onImport} onClose={onClose}/>);
  return {onImport,onClose,area:screen.getByRole('textbox',{name:'ASCII tab'}),importButton:screen.getByRole('button',{name:'Import'})};
};
const status=()=>screen.getByRole('status');

it('summarises pasted tab, imports it as a GP score and closes once it opens',async()=>{
  const {onImport,onClose,area,importButton}=setup();
  expect(area).toHaveFocus();expect(importButton).toBeDisabled();expect(status()).toHaveTextContent('Nothing to import yet.');
  fireEvent.change(area,{target:{value:riff}});
  await waitFor(()=>expect(status()).toHaveTextContent('1 measure, 6 strings tuned E A D G B E.'));
  fireEvent.click(importButton);
  await waitFor(()=>expect(onClose).toHaveBeenCalled());
  const [name,bytes]=onImport.mock.calls[0];
  expect(name).toBe('Imported tab.gp');
  const score=loadInterchangeScore(bytes,new Settings());
  expect(score.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0]?.fret)).toEqual([0,3,0,3]);
});

it('keeps the dialog and the text when the score cannot be opened',async()=>{
  const {onClose,area,importButton}=setup(false,async()=>{throw new Error('The workspace is completing a session transition.');});
  fireEvent.change(area,{target:{value:riff}});await waitFor(()=>expect(importButton).toBeEnabled());
  fireEvent.click(importButton);
  await waitFor(()=>expect(status()).toHaveTextContent('The score could not be opened: The workspace is completing a session transition.'));
  expect(onClose).not.toHaveBeenCalled();expect(area).toHaveValue(riff);expect(importButton).toBeEnabled();
});

it('explains text it cannot import and keeps Import disabled',async()=>{
  const {onImport,area,importButton}=setup();
  fireEvent.change(area,{target:{value:'just words'}});
  await waitFor(()=>expect(status()).toHaveTextContent('No tab lines were found.'));expect(area).toHaveAttribute('aria-invalid','true');
  expect(importButton).toBeDisabled();fireEvent.submit(importButton.closest('form')!);expect(onImport).not.toHaveBeenCalled();
});

it('loads a chosen file, names the score after it, and forgets the name when the text is cleared',async()=>{
  const {onImport,area,importButton}=setup();
  const input=document.querySelector<HTMLInputElement>('input[type="file"]')!,text=riff.replace('0-------0-------','0---s---0-------');
  fireEvent.change(input,{target:{files:[new File([text],'riff.txt',{type:'text/plain'})]}});
  await waitFor(()=>expect(area).toHaveValue(text));
  await waitFor(()=>expect(status()).toHaveTextContent('1 unsupported mark was skipped.'));
  // A file that is too large is refused without blocking the text already loaded.
  fireEvent.change(input,{target:{files:[new File(['-'.repeat(300_000)],'big.txt')]}});
  expect(status()).toHaveTextContent('big.txt is larger than 256 KB, so it was not loaded.');expect(importButton).toBeEnabled();
  fireEvent.click(importButton);await waitFor(()=>expect(onImport).toHaveBeenCalledTimes(1));expect(onImport.mock.calls[0][0]).toBe('riff.gp');
});

it('drops a file read that finishes after typing, and a cleared box forgets the file name',async()=>{
  const {onImport,area,importButton}=setup();
  const input=document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input,{target:{files:[new File([riff],'old.txt')]}});
  fireEvent.change(area,{target:{value:riff.replace('3-------3','5-------5')}});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(area).toHaveValue(riff.replace('3-------3','5-------5'));
  // A refused file also supersedes one still loading, so its message stays and the text is kept.
  fireEvent.change(input,{target:{files:[new File([riff],'slow.txt')]}});
  fireEvent.change(input,{target:{files:[new File(['-'.repeat(300_000)],'big.txt')]}});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(area).toHaveValue(riff.replace('3-------3','5-------5'));expect(status()).toHaveTextContent('big.txt is larger than 256 KB');
  fireEvent.change(input,{target:{files:[new File([riff],'named.txt')]}});await waitFor(()=>expect(area).toHaveValue(riff));
  fireEvent.change(area,{target:{value:''}});fireEvent.change(area,{target:{value:riff}});
  await waitFor(()=>expect(importButton).toBeEnabled());fireEvent.click(importButton);
  await waitFor(()=>expect(onImport).toHaveBeenCalled());expect(onImport.mock.calls[0][0]).toBe('Imported tab.gp');
});

it('keeps Tab inside the dialog, closes with Escape and blocks Import while busy',async()=>{
  const {onClose,area,importButton}=setup(true);
  fireEvent.change(area,{target:{value:riff}});await waitFor(()=>expect(status()).toHaveTextContent('1 measure'));expect(importButton).toBeDisabled();
  const cancel=screen.getByRole('button',{name:'Cancel'});cancel.focus();
  fireEvent.keyDown(cancel,{key:'Tab'});expect(area).toHaveFocus();
  fireEvent.keyDown(area,{key:'Tab',shiftKey:true});expect(cancel).toHaveFocus();
  fireEvent.keyDown(area,{key:'Escape'});expect(onClose).toHaveBeenCalled();
});
