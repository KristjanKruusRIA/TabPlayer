// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from '@coderline/alphatab';
import { MidiImportDialog } from './MidiImportDialog';
import { loadInterchangeScore } from '../interchange/gp';
import { setLanguagePreference } from '../i18n';

afterEach(() => { cleanup(); setLanguagePreference('en'); });
// One format 0 track: 100 BPM, an E3 quarter note on a guitar program.
const midi=new Uint8Array([0x4d,0x54,0x68,0x64,0,0,0,6,0,0,0,1,0x01,0xe0,0x4d,0x54,0x72,0x6b,0,0,0,23,0,0xc0,25,0,0xff,0x51,3,0x09,0x27,0xc0,0,0x90,0x34,0x5a,0x83,0x60,0x80,0x34,0,0,0xff,0x2f,0]);
const setup=(busy=false,result:()=>Promise<boolean>=async()=>true)=>{
  const onImport=vi.fn((_name:string,_bytes:Uint8Array)=>result()),onClose=vi.fn();
  render(<MidiImportDialog busy={busy} onImport={onImport} onClose={onClose}/>);
  return {onImport,onClose,input:document.querySelector<HTMLInputElement>('input[type="file"]')!,importButton:document.querySelector<HTMLButtonElement>('button[type="submit"]')!};
};
const status=()=>screen.getByRole('status');
const choose=(input:HTMLInputElement,bytes:Uint8Array,name='riff.mid')=>fireEvent.change(input,{target:{files:[new File([bytes as BlobPart],name)]}});

it('starts with nothing to import, focus on the file button and the default options',()=>{
  const {importButton}=setup();
  expect(screen.getByRole('button',{name:'Choose MIDI file…'})).toHaveFocus();expect(importButton).toHaveAttribute('aria-disabled','true');expect(status()).toHaveTextContent('Nothing to import yet.');
  expect(within(screen.getByRole('radiogroup',{name:'Quantization'})).getByRole('radio',{name:'16th note (1/16)'})).toBeChecked();expect(screen.getByLabelText('Tuplets')).toHaveValue('triplets');
  expect(within(screen.getByRole('radiogroup',{name:'Voices per track'})).getByRole('radio',{name:'2'})).toBeChecked();expect(screen.getByLabelText('Guitar and bass as tablature')).toBeChecked();
});

it('summarises a chosen file, imports it as a GP score named after it and closes once it opens',async()=>{
  const {onImport,onClose,input,importButton}=setup();
  choose(input,midi);
  await waitFor(()=>expect(status()).toHaveTextContent('Format 0, 1 part, 1 measure at 100 BPM.'));
  expect(screen.getByRole('list',{name:'Parts'})).toHaveTextContent('Acoustic Guitar (steel): guitar tab, 1 note');
  fireEvent.click(importButton);
  await waitFor(()=>expect(onClose).toHaveBeenCalled());
  const [name,bytes]=onImport.mock.calls[0],score=loadInterchangeScore(bytes,new Settings());
  expect(name).toBe('riff.gp');expect(score.masterBars[0].tempoAutomations[0].value).toBe(100);
  expect(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(2);
});

it('applies the chosen options to the score it imports',async()=>{
  const {onImport,input,importButton}=setup();
  choose(input,midi);await waitFor(()=>expect(importButton).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(screen.getByLabelText('Guitar and bass as tablature'));
  await waitFor(()=>expect(screen.getByRole('list',{name:'Parts'})).toHaveTextContent('notation'));
  fireEvent.click(importButton);await waitFor(()=>expect(onImport).toHaveBeenCalled());
  expect(loadInterchangeScore(onImport.mock.calls[0][1],new Settings()).tracks[0].staves[0].showTablature).toBe(false);
});

it('disables the tuplet kinds the chosen quantization cannot hold',()=>{
  setup();
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'Quantization'})).getByRole('radio',{name:'Quarter note (1/4)'}));
  expect(screen.getByRole('option',{name:'Triplets'})).toBeDisabled();
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'Quantization'})).getByRole('radio',{name:'Eighth note (1/8)'}));
  expect(screen.getByRole('option',{name:'Triplets'})).toBeEnabled();expect(screen.getByRole('option',{name:'Triplets and quintuplets'})).toBeDisabled();
});

it('refuses a malformed file with its reason, keeps Import disabled and opens nothing',async()=>{
  const {onImport,onClose,input,importButton}=setup();
  choose(input,midi.slice(0,30),'cut.mid');
  await waitFor(()=>expect(status()).toHaveTextContent('This is not a valid MIDI file: track 1 is cut off.'));
  expect(importButton).toHaveAttribute('aria-disabled','true');fireEvent.submit(importButton.closest('form')!);
  expect(onImport).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();
  // A later good file replaces the refusal.
  choose(input,midi);await waitFor(()=>expect(importButton).not.toHaveAttribute('aria-disabled'));
});

it('refuses a file that is too large without reading it',()=>{
  const {input,importButton}=setup();
  fireEvent.change(input,{target:{files:[Object.defineProperty(new File(['x'],'huge.mid'),'size',{value:9*1024*1024})]}});
  expect(status()).toHaveTextContent('huge.mid is larger than 8 MB, so it was not loaded.');expect(importButton).toHaveAttribute('aria-disabled','true');
});

it('keeps the dialog and file when the score cannot be opened',async()=>{
  const {onClose,input,importButton}=setup(false,async()=>{throw new Error('The workspace is completing a session transition.');});
  choose(input,midi);await waitFor(()=>expect(importButton).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(importButton);
  await waitFor(()=>expect(status()).toHaveTextContent('The score could not be opened: The workspace is completing a session transition.'));
  expect(onClose).not.toHaveBeenCalled();expect(importButton).not.toHaveAttribute('aria-disabled');
});

it('keeps Tab inside the dialog, closes with Escape and blocks Import while busy',async()=>{
  const {onClose,input,importButton}=setup(true);
  choose(input,midi);await waitFor(()=>expect(status()).toHaveTextContent('1 part'));expect(importButton).toHaveAttribute('aria-disabled','true');
  const close=screen.getByRole('button',{name:'Close'}),cancel=screen.getByRole('button',{name:'Cancel'});cancel.focus();
  fireEvent.keyDown(cancel,{key:'Tab'});expect(close).toHaveFocus();
  fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(cancel).toHaveFocus();
  fireEvent.keyDown(close,{key:'Escape'});expect(onClose).toHaveBeenCalled();
});

it('closes from the backdrop, refuses presses while opening without losing focus, and leaves focus on Import after a failed open',async()=>{
  let finish!:(opened:boolean)=>void;
  const {onImport,onClose,input,importButton}=setup(false,()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  choose(input,midi);
  await waitFor(()=>expect(status()).toHaveTextContent('Format 0, 1 part'));
  importButton.focus();fireEvent.click(importButton);
  await waitFor(()=>expect(onImport).toHaveBeenCalledTimes(1));
  expect(importButton).toHaveAttribute('aria-disabled','true');expect(importButton).not.toBeDisabled();expect(importButton).toHaveFocus();
  const eighth=within(screen.getByRole('radiogroup',{name:'Quantization'})).getByRole('radio',{name:'Eighth note (1/8)'});
  fireEvent.click(eighth);expect(eighth).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('Tuplets'),{target:{value:'none'}});expect(screen.getByLabelText('Tuplets')).toHaveValue('triplets');
  fireEvent.click(screen.getByLabelText('Guitar and bass as tablature'));expect(screen.getByLabelText('Guitar and bass as tablature')).toBeChecked();
  fireEvent.click(importButton);fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(onImport).toHaveBeenCalledTimes(1);expect(onClose).not.toHaveBeenCalled();
  finish(false);
  await waitFor(()=>expect(status()).toHaveTextContent('The score was not opened.'));
  expect(importButton).toHaveFocus();
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);expect(onClose).toHaveBeenCalledTimes(1);
});

it('translates MIDI import dialog when language preference changes', () => {
  try {
    setLanguagePreference('et');
    render(<MidiImportDialog busy={false} onImport={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Kvantimine' })).toBeInTheDocument();
    expect(screen.getByText('Faili pole valitud')).toBeInTheDocument();
  } finally {
    setLanguagePreference('en');
  }
});


it('translates MIDI import summary notes across supported languages', async () => {
  const midiUnplayable = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 23,
    0, 0xc0, 25,
    0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0,
    0, 0x90, 0x10, 0x5a,
    0x83, 0x60, 0x80, 0x10, 0,
    0, 0xff, 0x2f, 0,
  ]);
  const { input } = setup();
  choose(input, midiUnplayable);
  await waitFor(() => expect(screen.getByText('1 guitar or bass part has notes that cannot be fingered on strings, so it was imported as notation only.')).toBeInTheDocument());

  cleanup();
  setLanguagePreference('et');
  const et = setup();
  choose(et.input, midiUnplayable);
  await waitFor(() => expect(screen.getByText('1 kitarri- või bassipartiil on noodid, mida ei saa keeltel sõrmitseda, seega imporditi see ainult noodikirjana.')).toBeInTheDocument());

  cleanup();
  setLanguagePreference('de');
  const de = setup();
  choose(de.input, midiUnplayable);
  await waitFor(() => expect(screen.getByText('1 Gitarren- oder Bass-Part enthält Noten, die auf Saiten nicht gegriffen werden können, und wurde daher nur als Notation importiert.')).toBeInTheDocument());
});
