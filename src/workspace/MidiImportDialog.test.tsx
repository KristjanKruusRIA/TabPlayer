// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from '@coderline/alphatab';
import { MidiImportDialog, type MidiImportDialogProps } from './MidiImportDialog';
import { readMusicClip, scoreFromMusicClip } from '../editor/clipboard-source';
import { defaultMix } from '../document-settings';
import type { EditCommand } from '../edit-types';
import { buildDocument, previewEdit } from '../engine';
import { loadInterchangeScore } from '../interchange/gp';
import type { ImportTracksCommand } from '../interchange/import-tracks';
import { blankProject } from '../project';
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
const openInstrument = (name: string | RegExp) => {
  const button = screen.getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
  return within(screen.getByRole('dialog', { name }));
};
const assignInstrument = (part: string, kind: string) => {
  const picker = openInstrument(`Instrument for ${part}`);
  fireEvent.click(picker.getByRole('radio', { name: kind === 'Drums' ? 'Drums' : 'Stringed' }));
  if (kind === 'Bass') {
    fireEvent.change(picker.getByRole('listbox', { name: 'Sound family' }), { target: { value: '4' } });
    fireEvent.change(picker.getByRole('listbox', { name: 'MIDI instrument' }), { target: { value: '33' } });
  }
  fireEvent.click(picker.getByRole('button', { name: 'Apply' }));
};
const choose=(input:HTMLInputElement,bytes:Uint8Array,name='riff.mid')=>fireEvent.change(input,{target:{files:[new File([bytes as BlobPart],name)]}});

it('starts with nothing to import, focus on the file button and the default options',()=>{
  const {importButton}=setup();
  expect(screen.getByRole('button',{name:'Choose MIDI file…'})).toHaveFocus();expect(importButton).toHaveAttribute('aria-disabled','true');expect(status()).toHaveTextContent('Nothing to import yet.');
  expect(within(screen.getByRole('radiogroup',{name:'Quantization'})).getByRole('radio',{name:'16th note (1/16)'})).toBeChecked();expect(screen.getByLabelText('Tuplets')).toHaveValue('triplets');
  expect(within(screen.getByRole('radiogroup',{name:'Voices per track'})).getByRole('radio',{name:'2'})).toBeChecked();expect(screen.getByRole('radio', { name: 'From MIDI' })).toBeChecked();
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
  const picker = openInstrument('Choose instrument…');
  fireEvent.click(picker.getByRole('radio', { name: /^Standard$/ }));
  fireEvent.click(picker.getByRole('button', { name: 'Apply' }));
  await waitFor(()=>expect(screen.getByRole('list',{name:'Parts'})).toHaveTextContent('notation'));
  fireEvent.click(importButton);await waitFor(()=>expect(onImport).toHaveBeenCalled());
  expect(loadInterchangeScore(onImport.mock.calls[0][1],new Settings()).tracks[0].staves[0].showTablature).toBe(false);
});

it('previews a one-bar meter change and writes it to the imported score', async () => {
  const { onImport, input, importButton } = setup();
  const change = (numerator: number) => [0xff, 0x58, 4, numerator, 2, 24, 8];
  choose(input, makeMidi(1, 480, [
    makeTrack([[0, change(4)], [1920, change(2)], [960, change(4)]]),
    makeTrack(noteLine([[0, 60, 36], [1920, 60, 38], [2880, 60, 36]], 0)),
  ]));
  const shortBar = await screen.findByRole('button', { name: 'Measure 2 · 2/4' });
  fireEvent.click(shortBar);
  expect(shortBar).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('img', { name: 'Score preview' }).querySelector('svg')).toHaveAttribute('viewBox', expect.stringMatching(/^0 0 /));
  expect(screen.getByRole('button', { name: 'Measure 3 · 4/4' })).toBeInTheDocument();
  const meters = screen.getByRole('checkbox', { name: 'Import time signatures' });
  fireEvent.click(meters);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Measure 2 · 2/4' })).toBeNull());
  fireEvent.click(meters);
  await screen.findByRole('button', { name: 'Measure 2 · 2/4' });
  const picker = openInstrument(/Instrument for/);
  fireEvent.change(picker.getByRole('listbox', { name: 'Sound family' }), { target: { value: '1' } });
  fireEvent.change(picker.getByRole('listbox', { name: 'MIDI instrument' }), { target: { value: '12' } });
  fireEvent.click(picker.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(importButton).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(importButton);
  await waitFor(() => expect(onImport).toHaveBeenCalled());
  const score = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
  expect(score.masterBars.map(bar => bar.timeSignatureNumerator)).toEqual([4, 2, 4]);
  expect(score.tracks[0].playbackInfo.program).toBe(12);
});

it('can omit MIDI tempo and key signatures from a new score', async () => {
  const { onImport, input, importButton } = setup();
  choose(input, makeMidi(1, 480, [
    makeTrack([[0, [0xff, 0x51, 3, 0x09, 0x27, 0xc0]], [0, [0xff, 0x59, 2, 0xfe, 0]]]),
    makeTrack(noteLine([[0, 480, 60]], 0)),
  ]));
  await waitFor(() => expect(status()).toHaveTextContent('100 BPM'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Import key signatures' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Import tempo' }));
  await waitFor(() => expect(status()).toHaveTextContent('120 BPM'));
  fireEvent.click(importButton);
  await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
  const score = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
  expect(score.masterBars[0].keySignature).toBe(0);
  expect(score.masterBars[0].tempoAutomations[0].value).toBe(120);
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
  expect(screen.getByRole('button', { name: 'Choose instrument…' })).toBeDisabled();
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

const vlq = (value: number) => {
  const out = [value & 0x7f];
  while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
  return out;
};
const makeTrack = (events: [number, number[]][]) => {
  const body = events.flatMap(([delta, data]) => [...vlq(delta), ...data]);
  body.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
};
const makeMidi = (format: number, division: number, tracks: number[][]) =>
  new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, division >> 8, division & 255, ...tracks.flat()]);
const noteLine = (notes: [number, number, number][], channel = 0): [number, number[]][] => {
  const events = notes
    .flatMap(([start, len, key]) => [[start, [0x90 | channel, key, 100]], [start + len, [0x80 | channel, key, 0]]] as [number, number[]][])
    .sort((a, b) => a[0] - b[0] || (a[1][0] & 0xf0) - (b[1][0] & 0xf0));
  let last = 0;
  return events.map(([at, data]) => {
    const delta = at - last;
    last = at;
    return [delta, data] as [number, number[]];
  });
};

const setupWithScore = (extra: Partial<MidiImportDialogProps> = {}) => {
  const project = {
    ...blankProject(),
    edits: [{ type: 'addPercussionTrack', name: 'Drumkit', program: 0 }] as EditCommand[],
  };
  void defaultMix;
  const built = buildDocument(project);
  const onImport = vi.fn(async () => true);
  const onImportIntoScore = vi.fn(async (_cmd: ImportTracksCommand) => true);
  const onClose = vi.fn();
  render(
    <MidiImportDialog
      busy={false}
      currentScore={built.score}
      selectedTrack={0}
      onImport={onImport}
      onImportIntoScore={onImportIntoScore}
      onClose={onClose}
      {...extra}
    />,
  );
  return {
    built,
    onImport,
    onImportIntoScore,
    onClose,
    input: document.querySelector<HTMLInputElement>('input[type="file"]')!,
    importButton: document.querySelector<HTMLButtonElement>('button[type="submit"]')!,
  };
};

it('shows destination choices with a current score, disables add/replace when locked, and handles channel-10 on melodic replace', async () => {
  const lockedView = setupWithScore({ locked: true });
  const dest = screen.getByRole('radiogroup', { name: 'Destination' });
  expect(within(dest).getByRole('radio', { name: 'New score' })).toBeChecked();
  expect(within(dest).getByRole('radio', { name: 'Add to current score' })).toHaveAttribute('aria-disabled', 'true');
  expect(within(dest).getByRole('radio', { name: 'Replace track' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByText('Unlock editing on the current score to add or replace tracks.')).toBeInTheDocument();
  cleanup();

  // Unlocked score with channel-10 MIDI: replacing track 0 (melodic) shows mismatch and blocks Import; track 1 (drums) succeeds.
  const drumCh10 = makeMidi(0, 480, [makeTrack(noteLine([[0, 60, 36], [480, 60, 38]], 9))]);
  const { input, importButton, onImportIntoScore } = setupWithScore();
  choose(input, drumCh10, 'kit.mid');
  await waitFor(() => expect(status()).toHaveTextContent('Format 0, 1 part, 1 measure'));
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Destination' })).getByRole('radio', { name: 'Replace track' }));
  // Smart default selects Drumkit (track 1)!
  expect(screen.getByLabelText('Target track')).toHaveValue('1');
  expect(screen.getByRole('radio', { name: 'Drums' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Drums' })).toHaveAttribute('aria-disabled', 'true');

  // Switch Target track to Guitar (track 0): channel 10 drum MIDI is refused.
  fireEvent.change(screen.getByLabelText('Target track'), { target: { value: '0' } });
  await waitFor(() => expect(status()).toHaveTextContent('Choose a drum target track to import a channel 10 drum part'));
  expect(importButton).toHaveAttribute('aria-disabled', 'true');

  // Switch back to Drumkit (track 1) and submit importTracks command.
  fireEvent.change(screen.getByLabelText('Target track'), { target: { value: '1' } });
  await waitFor(() => expect(importButton).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(importButton);
  await waitFor(() => expect(onImportIntoScore).toHaveBeenCalledTimes(1));
  expect(onImportIntoScore.mock.calls[0][0]).toMatchObject({ type: 'importTracks', targetTrack: 1 });
});

it('supports Import as drums on channel-0 MIDI, per-part drum assignment, and appending tracks following current score meters', async () => {
  const multiCh0 = makeMidi(1, 480, [
    makeTrack([[0, [0xc0, 25]], ...noteLine([[0, 480, 60]], 0)]),
    makeTrack([[0, [0xff, 0x03, 5, ...[...'Drums'].map(c => c.charCodeAt(0))]], ...noteLine([[0, 60, 36], [480, 60, 38]], 0)]),
  ]);
  const { input, importButton, onImportIntoScore } = setupWithScore();
  choose(input, multiCh0, 'song.mid');
  await waitFor(() => expect(status()).toHaveTextContent('Format 1, 2 parts'));

  // Toggle only the second part as drums.
  assignInstrument('Drums', 'Drums');
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Drums: drums, 2 notes'));
  expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Acoustic Guitar (steel): guitar tab, 1 note');

  // Switch Destination to Add to current score and import.
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Destination' })).getByRole('radio', { name: 'Add to current score' }));
  expect(screen.getByText('Follows the current score\'s measures and time signatures.')).toBeInTheDocument();
  await waitFor(() => expect(importButton).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(importButton);
  await waitFor(() => expect(onImportIntoScore).toHaveBeenCalledTimes(1));
  const cmd = onImportIntoScore.mock.calls[0][0];
  expect(cmd.targetTrack).toBeUndefined();
  const clipScore = scoreFromMusicClip(readMusicClip(cmd.clip));
  expect(clipScore.tracks).toHaveLength(2);
  expect(clipScore.tracks[1].isPercussion).toBe(true);
});

it('offers source drum map presets, file loading with error handling, per-key remapping, skipping, reset, and Escape disclosure handling', async () => {
  // Channel-0 drum MIDI with key 22 (closed hat candidate), key 36 (kick), and key 66 (unmapped in EZdrummer 3 and Superior Drummer 3).
  const ch0Drums = makeMidi(0, 480, [makeTrack(noteLine([[0, 60, 36], [480, 60, 22], [960, 60, 66]], 0))]);
  let nextMap: { name: string; base: string | null; keys: [number, number | null][] } | Error | null = {
    name: 'Studio Map',
    base: 'gm',
    keys: [[52, 66], [36, 36]],
  };
  const onImportDrumMap = vi.fn(async () => {
    if (nextMap instanceof Error) throw nextMap;
    return nextMap;
  });
  const { input, importButton, onImportIntoScore, onClose } = setupWithScore({ onImportDrumMap });
  choose(input, ch0Drums, 'drums.mid');
  await waitFor(() => expect(status()).toHaveTextContent('Format 0, 1 part'));

  // Enable Import as drums.
  fireEvent.click(screen.getByRole('radio', { name: 'Drums' }));
  const mapSelect = screen.getByLabelText('Source drum map');
  expect(mapSelect).toHaveValue('gm');

  // Switch to verified EZdrummer 3 layout (no unverified disclaimer), then unverified Superior Drummer 3 layout.
  fireEvent.change(mapSelect, { target: { value: 'ezdrummer-3' } });
  expect(screen.queryByText(/Layout numbers come from third-party notes/)).not.toBeInTheDocument();
  expect(screen.getByText('2 of 3 MIDI keys mapped; 1 skipped.')).toBeInTheDocument();

  fireEvent.change(mapSelect, { target: { value: 'superior-drummer-3' } });
  expect(screen.getByText(/Layout numbers come from third-party notes/)).toBeInTheDocument();
  expect(screen.getByText('2 of 3 MIDI keys mapped; 1 skipped.')).toBeInTheDocument();

  // Open Map MIDI keys and verify Escape closes details before closing the dialog.
  const summary = screen.getByText('Map MIDI keys (3, 1 unmapped)');
  fireEvent.click(summary);
  const details = summary.closest('details')!;
  expect(details).toHaveAttribute('open');
  const key66Select = screen.getByLabelText('Drum sound for MIDI key 66 (F#4)');
  expect(key66Select).toHaveValue('');
  key66Select.focus();
  fireEvent.keyDown(key66Select, { key: 'Escape' });
  expect(details).not.toHaveAttribute('open');
  expect(summary).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();

  // Re-open, remap key 66 -> China (52), skip key 36, then reset key 36 and verify focus returns to key 36 select.
  fireEvent.click(summary);
  fireEvent.change(screen.getByLabelText('Drum sound for MIDI key 66 (F#4)'), { target: { value: '52' } });
  const key36Select = screen.getByLabelText('Drum sound for MIDI key 36 (C2)');
  fireEvent.change(key36Select, { target: { value: '' } });
  expect(screen.getByText('Map MIDI keys (3, 2 changed)')).toBeInTheDocument();

  const resetKey36 = screen.getByRole('button', { name: 'Reset MIDI key 36 to the source map' });
  fireEvent.click(resetKey36);
  expect(key36Select).toHaveValue('36');
  expect(key36Select).toHaveFocus();
  expect(screen.getByText('3 of 3 MIDI keys mapped.')).toBeInTheDocument();

  // Reset all overrides.
  fireEvent.click(screen.getByRole('button', { name: 'Reset key changes' }));
  expect(screen.getByText('2 of 3 MIDI keys mapped; 1 skipped.')).toBeInTheDocument();

  // Load a drum map file: first test error alert, then test valid import mapping key 66 -> 52.
  nextMap = new Error('bad_shape');
  fireEvent.click(screen.getByRole('button', { name: 'Load map file…' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not a TabPlayer drum map'));

  nextMap = { name: 'Studio Map', base: 'gm', keys: [[52, 66], [66, null]] };
  fireEvent.click(screen.getByRole('button', { name: 'Load map file…' }));
  await waitFor(() => expect(mapSelect).toHaveValue('__file__'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Drum sound for MIDI key 66 (F#4)')).toHaveValue('52');

  // Replace Drumkit (track 1) and verify resulting track plays China (52) & Kick (36).
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Destination' })).getByRole('radio', { name: 'Replace track' }));
  await waitFor(() => expect(importButton).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(importButton);
  await waitFor(() => expect(onImportIntoScore).toHaveBeenCalledTimes(1));
  const cmd = onImportIntoScore.mock.calls[0][0];
  expect(cmd.targetTrack).toBe(1);
  const project = { ...blankProject(), edits: [{ type: 'addPercussionTrack' as const, name: 'Drumkit', program: 0 }] };
  const applied = previewEdit(project, cmd);
  const notes = applied.score.tracks[1].staves[0].bars[0].voices[0].beats.flatMap(b => b.notes.map(n => n.percussionArticulation));
  expect(notes).toEqual([36, 52]);
});

it('translates new destination and drum mapping controls into Estonian and German', () => {
  try {
    setLanguagePreference('et');
    const et = setupWithScore();
    expect(screen.getByRole('radiogroup', { name: 'Sihtkoht' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Trummid' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Trummid' }));
    expect(screen.getByLabelText('Lähte-trummikaart')).toBeInTheDocument();
    cleanup();

    setLanguagePreference('de');
    setupWithScore();
    expect(screen.getByRole('radiogroup', { name: 'Ziel' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Schlagzeug' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Schlagzeug' }));
    expect(screen.getByLabelText('Quell-Drum-Map')).toBeInTheDocument();
    void et;
  } finally {
    setLanguagePreference('en');
  }
});

it('imports program-0 bass MIDI as bass tab with auto-fitted Drop D tuning and supports custom TuningDialog on Guitar', async () => {
  const bassDropDNoProg = makeMidi(0, 480, [makeTrack([[0, [0xff, 0x51, 3, 0x07, 0x08, 0x00]], ...noteLine([[0, 480, 26], [480, 480, 33]], 0)])]);
  const { onImport, onClose, input, importButton } = setup();
  choose(input, bassDropDNoProg, 'Sineater_bass.mid');
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Acoustic Grand Piano: notation, 2 notes'));

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Instrument' })).getByRole('radio', { name: 'Bass' }));
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Electric Bass (finger): bass tab, 2 notes'));
  expect(screen.getByText('MIDI note range: D1–A1')).toBeInTheDocument();
  expect((screen.getByLabelText('Bass tuning') as HTMLSelectElement).value).toBe('bass-4-drop-d');

  fireEvent.click(importButton);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  const importedScore = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
  expect(importedScore.tracks[0].playbackInfo.program).toBe(33);
  expect(importedScore.tracks[0].staves[0].showTablature).toBe(true);
  expect(importedScore.tracks[0].staves[0].tuning).toEqual([43, 38, 33, 26]);

  // Now verify custom Guitar tuning (Drop D1) via TuningDialog on a program-0 file containing D1 + E3.
  cleanup();
  const second = setup();
  const gtrDropD1 = makeMidi(0, 480, [makeTrack(noteLine([[0, 480, 26], [480, 480, 52]], 0))]);
  choose(second.input, gtrDropD1, 'baritone.mid');
  await waitFor(() => expect(second.importButton).not.toHaveAttribute('aria-disabled'));

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Instrument' })).getByRole('radio', { name: 'Guitar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
  fireEvent.change(screen.getByLabelText('Notes, high to low'), { target: { value: 'E3 B2 G2 D2 A1 D1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use tuning' }));

  await waitFor(() => expect((screen.getByLabelText('Guitar tuning') as HTMLSelectElement).value).toBe('__custom__'));
  await waitFor(() => expect(status()).not.toHaveTextContent('Updating…'));
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Acoustic Guitar (steel): guitar tab, 2 notes'));
  fireEvent.click(second.importButton);
  await waitFor(() => expect(second.onClose).toHaveBeenCalledTimes(1));
  const gtrScore = loadInterchangeScore(second.onImport.mock.calls[0][1], new Settings());
  expect(gtrScore.tracks[0].playbackInfo.program).toBe(25);
  expect(gtrScore.tracks[0].staves[0].tuning).toEqual([52, 47, 43, 38, 33, 26]);
});

it('opens the instrument catalog before file selection and applies per-track settings only on Apply', async () => {
  const { onImport, input, importButton } = setup();
  const defaults = openInstrument('Choose instrument…');
  expect(defaults.getByRole('radio', { name: 'Orchestra' })).toBeInTheDocument();
  expect(defaults.getByRole('radio', { name: 'MIDI' })).toBeChecked();
  fireEvent.click(defaults.getByRole('button', { name: 'Cancel' }));

  choose(input, midi);
  await waitFor(() => expect(status()).toHaveTextContent('1 part'));
  let picker = openInstrument(/Instrument for Acoustic Guitar/);
  fireEvent.change(picker.getByRole('textbox', { name: 'Track name' }), { target: { value: 'Discarded' } });
  fireEvent.click(picker.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: /Instrument for Acoustic Guitar/ })).toHaveFocus();
  expect(screen.getByRole('list', { name: 'Parts' })).not.toHaveTextContent('Discarded');

  picker = openInstrument(/Instrument for Acoustic Guitar/);
  fireEvent.click(picker.getByRole('radio', { name: 'Stringed' }));
  fireEvent.change(picker.getByRole('textbox', { name: 'Track name' }), { target: { value: 'Lead guitar' } });
  fireEvent.change(picker.getByRole('textbox', { name: 'Track short name' }), { target: { value: 'Lead' } });
  fireEvent.click(picker.getByRole('radio', { name: /^Tablature$/ }));
  fireEvent.change(picker.getByRole('combobox', { name: 'Tuning' }), { target: { value: 'guitar-6-drop-d' } });
  fireEvent.click(picker.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Lead guitar'));
  fireEvent.click(importButton);
  await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
  const track = loadInterchangeScore(onImport.mock.calls[0][1], new Settings()).tracks[0];
  expect(track.name).toBe('Lead guitar');
  expect(track.shortName).toBe('Lead');
  expect(track.staves[0].showTablature).toBe(true);
  expect(track.staves[0].showStandardNotation).toBe(false);
  expect(track.staves[0].tuning).toEqual([64, 59, 55, 50, 45, 38]);
});

it('assigns Guitar and Bass per part on multi-part program-0 MIDI and inherits stringed target track in Replace track mode', async () => {
  const twoParts = makeMidi(1, 480, [
    makeTrack([[0, [0xff, 0x03, 6, ...[...'Rhythm'].map(c => c.charCodeAt(0))]], ...noteLine([[0, 480, 40], [480, 480, 52]], 0)]),
    makeTrack([[0, [0xff, 0x03, 7, ...[...'LowBass'].map(c => c.charCodeAt(0))]], ...noteLine([[0, 480, 28], [480, 480, 33]], 0)]),
  ]);
  const { onImport, onClose, input, importButton } = setup();
  choose(input, twoParts, 'band.mid');
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Rhythm: notation, 2 notes'));

  assignInstrument('Rhythm', 'Guitar');
  assignInstrument('LowBass', 'Bass');
  await waitFor(() => {
    const list = screen.getByRole('list', { name: 'Parts' });
    expect(list).toHaveTextContent('Rhythm: guitar tab, 2 notes');
    expect(list).toHaveTextContent('LowBass: bass tab, 2 notes');
  });

  fireEvent.click(importButton);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  const bandScore = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
  expect(bandScore.tracks.map(t => t.staves[0].showTablature)).toEqual([true, true]);
  expect(bandScore.tracks.map(t => t.playbackInfo.program)).toEqual([25, 33]);

  // Replace track targeting Track 0 (6-string Guitar in blankProject) imports program-0 MIDI as guitar tab automatically.
  cleanup();
  const repl = setupWithScore();
  const riffNoProg = makeMidi(0, 480, [makeTrack(noteLine([[0, 480, 40], [480, 480, 52]], 0))]);
  choose(repl.input, riffNoProg, 'riff-no-prog.mid');
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Acoustic Grand Piano: notation, 2 notes'));

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Destination' })).getByRole('radio', { name: 'Replace track' }));
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('guitar tab, 2 notes'));
  expect(screen.getByLabelText('Guitar / bass tuning')).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(repl.importButton);
  await waitFor(() => expect(repl.onImportIntoScore).toHaveBeenCalledTimes(1));
  const cmd = repl.onImportIntoScore.mock.calls[0][0];
  expect(cmd.targetTrack).toBe(0);
  const clipScore = scoreFromMusicClip(readMusicClip(cmd.clip));
  expect(clipScore.tracks[0].staves[0].showTablature).toBe(true);
});

it('keeps Bass and 5-string count in TuningDialog for custom Drop F#0 bass and shifts Kontakt octave down cleanly', async () => {
  const kontaktDropFsharp = makeMidi(0, 480, [
    makeTrack(noteLine([[0, 480, 31], [480, 480, 32], [960, 480, 37], [1440, 480, 42]], 0)),
  ]);
  const { onImport, onClose, input, importButton } = setup();
  choose(input, kontaktDropFsharp, 'Sineater_bass.mid');
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Acoustic Grand Piano: notation, 4 notes'));

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Instrument' })).getByRole('radio', { name: 'Bass' }));
  fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
  fireEvent.change(screen.getByLabelText('Notes, high to low'), { target: { value: 'E2 B1 F#1 C#1 F#0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use tuning' }));

  await waitFor(() => expect((screen.getByLabelText('Bass tuning') as HTMLSelectElement).value).toBe('__custom__'));

  // Re-opening TuningDialog for this custom 5-string Drop F#0 tuning stays on Bass · 5 strings (never Guitar · 6 strings).
  fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
  const tuningDialog = screen.getByRole('dialog', { name: 'Tuning' });
  expect(within(tuningDialog).getByLabelText('Instrument')).toHaveValue('bass');
  expect(within(tuningDialog).getByLabelText('Number of strings')).toHaveValue('5');
  fireEvent.click(within(tuningDialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tuning' })).not.toBeInTheDocument());

  expect(screen.getByText(/All notes are an octave or more above F#0/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Shift −1 octave' }));

  await waitFor(() => {
    expect(screen.getByText('MIDI note range: G0–F#1')).toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup', { name: 'Octave shift' })).getByRole('radio', { name: '−1' })).toBeChecked();
  });
  await waitFor(() => expect(status()).not.toHaveTextContent('Updating…'));

  fireEvent.click(importButton);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  const bassScore = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
  const staff = bassScore.tracks[0].staves[0];
  expect(staff.tuning).toEqual([40, 35, 30, 25, 18]);
  const placements = staff.bars[0].voices[0].beats.map(b => [b.notes[0].string, b.notes[0].fret]);
  expect(placements).toEqual([[1, 1], [1, 2], [2, 0], [3, 0]]);
});

it('shows opt-in keyswitch articulation toggle, strips keyswitches cleanly, and imports forced strings', async () => {
  // Playable notes F#1(37 with -1oct -> 25), F#2(42 -> 30), paired with The Primer Force String keys 5 and 3.
  const midiWithKs = makeMidi(0, 480, [
    makeTrack(
      noteLine(
        [
          [0, 480, 5],
          [0, 480, 37],
          [480, 480, 3],
          [480, 480, 42],
        ],
        0,
      ),
    ),
  ]);
  const { onImport, onClose, input, importButton } = setup();
  choose(input, midiWithKs, 'Sineater_bass.mid');
  await waitFor(() => expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('Acoustic Grand Piano: notation, 4 notes'));

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Instrument' })).getByRole('radio', { name: 'Bass' }));
  fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
  fireEvent.change(screen.getByLabelText('Notes, high to low'), { target: { value: 'E2 B1 F#1 C#1 F#0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use tuning' }));

  const toggle = screen.getByRole('checkbox', { name: 'Read keyswitch articulations' });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(/2 low\/high keyswitch notes detected/)).toBeInTheDocument();

  fireEvent.click(toggle);
  const presetSelect = screen.getByLabelText('Keyswitch preset') as HTMLSelectElement;
  expect([...presetSelect.options].map(o => o.value)).toEqual(['submission-audio-default', 'the-primer']);
  expect(presetSelect.value).toBe('submission-audio-default');

  fireEvent.change(presetSelect, { target: { value: 'the-primer' } });
  await waitFor(() => {
    expect(screen.getByText('2 keyswitch notes matched this preset.')).toBeInTheDocument();
    expect(screen.getByText('MIDI note range: C#2–F#2')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole('button', { name: 'Shift −1 octave' }));
  await waitFor(() => {
    expect(screen.getByText('MIDI note range: C#1–F#1')).toBeInTheDocument();
    expect(status()).not.toHaveTextContent('Updating…');
  });

  fireEvent.click(importButton);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  const imported = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
  const staff = imported.tracks[0].staves[0];
  expect(staff.showTablature).toBe(true);
  expect(staff.bars[0].voices[0].beats.filter(b => b.notes.length > 0).map(b => [b.notes[0].string, b.notes[0].fret])).toEqual([
    [1, 7],
    [3, 0],
  ]);
});
