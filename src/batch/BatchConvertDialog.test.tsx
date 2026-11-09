// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { strToU8 } from 'fflate';
import { BatchConvertDialog } from './BatchConvertDialog';
import type { BatchBridge,BatchScan } from './convert';
import type { Probe } from './probe';
import { setLanguagePreference } from '../i18n';

afterEach(()=>{cleanup();setLanguagePreference('en');});
const xml=strToU8('<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>');
const scan:BatchScan={files:[{index:0,relative:'old/a.gp3',bytes:3},{index:1,relative:'b.gp5',bytes:3}],skipped:[],truncated:false,totalBytes:6};
const probe:Probe=async bytes=>bytes.length>10?{ok:true,tracks:1,bars:1}:{ok:false,error:'The file could not be read.'};
function setup(overrides:Partial<BatchBridge>={},busy=false) {
  const bridge:BatchBridge={
    pickFolder:vi.fn(async role=>role==='source'?'C:\\old scores':'C:\\converted'),
    scan:vi.fn(async()=>scan),
    read:vi.fn(async index=>index===0?xml:strToU8('garbage')),
    write:vi.fn(async(index)=>({relative:index===0?'old/a.gp':'b.gp',renamed:false})),
    reset:vi.fn(async()=>{}),
    ...overrides,
  };
  const onClose=vi.fn();render(<BatchConvertDialog busy={busy} bridge={bridge} probe={probe} onClose={onClose}/>);
  return {bridge,onClose,convert:()=>screen.getByRole('button',{name:'Convert'})};
}
const choose=async()=>{
  fireEvent.click(screen.getByRole('button',{name:'Choose source folder…'}));await screen.findByText('C:\\old scores');
  fireEvent.click(screen.getByRole('button',{name:'Choose destination folder…'}));await screen.findByText('C:\\converted');
};

it('needs both folders and a type, then converts, continues past a bad file and reports each one',async()=>{
  const {bridge,convert}=setup();
  expect(convert()).toBeDisabled();expect(screen.getByRole('status')).toHaveTextContent('Choose a source and a destination folder.');
  await choose();expect(convert()).toBeEnabled();
  const types=screen.getByRole('group',{name:'File types'});
  expect(within(types).getByRole('checkbox',{name:/Guitar Pro 3, 4 and 5/})).toBeChecked();
  expect(within(types).getByRole('checkbox',{name:/Guitar Pro 6/})).toBeChecked();
  expect(within(types).getByRole('checkbox',{name:/Guitar Pro 7 and 8/})).not.toBeChecked();
  fireEvent.click(within(types).getByRole('checkbox',{name:/MusicXML/}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Keep the subfolders in the destination'}));
  fireEvent.click(convert());
  const report=await screen.findByRole('table',{name:'Conversion report'});
  expect(bridge.scan).toHaveBeenCalledWith(['gp345','gpx','musicxml']);
  const rows=within(report).getAllByRole('row').slice(1).map(row=>within(row).getAllByRole('cell').map(cell=>cell.textContent).concat(within(row).getByRole('rowheader').textContent!));
  expect(rows).toEqual([['Failed',expect.stringMatching(/./),'b.gp5'],['Converted','1 track, 1 bar. Saved as old/a.gp.','old/a.gp3']]);
  expect(bridge.write).toHaveBeenCalledTimes(1);expect(bridge.write).toHaveBeenCalledWith(0,expect.any(Uint8Array),false);
  expect(screen.getByRole('status')).toHaveTextContent('1 converted, 1 failed.');
});

it('shows a scan refusal without reading or writing anything',async()=>{
  const {bridge,convert}=setup({scan:vi.fn(async()=>{throw new Error('Choose a destination folder first.');})});
  await choose();
  fireEvent.click(convert());
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose a destination folder first.');
  expect(bridge.read).not.toHaveBeenCalled();expect(convert()).toBeEnabled();
});

it('cancels between files, keeps the dialog open meanwhile and reports the files not reached',async()=>{
  let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const {bridge,onClose,convert}=setup({read:vi.fn(async()=>{await gate;return xml;})});
  await choose();fireEvent.click(convert());
  await screen.findByRole('button',{name:'Cancel conversion'});
  expect(screen.getByRole('button',{name:'Close'})).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
  expect(onClose).not.toHaveBeenCalled();
  release();
  const report=await screen.findByRole('table',{name:'Conversion report'});
  expect(bridge.write).toHaveBeenCalledTimes(1);
  expect(within(report).getByText('Not converted')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('1 converted, 0 failed, 1 not converted.');
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(onClose).toHaveBeenCalledTimes(1);
});

it('says when nothing matched, keeps a refused folder pick and stays shut while the app is busy',async()=>{
  const {convert}=setup({scan:vi.fn(async()=>({files:[],skipped:[],truncated:false,totalBytes:0})),pickFolder:vi.fn(async role=>{if(role==='destination')throw new Error('The destination folder cannot be inside the source.');return 'C:\\old scores';})});
  fireEvent.click(screen.getByRole('button',{name:'Choose source folder…'}));await screen.findByText('C:\\old scores');
  fireEvent.click(screen.getByRole('button',{name:'Choose destination folder…'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('cannot be inside the source');
  expect(screen.getByText('No folder chosen')).toBeInTheDocument();expect(convert()).toBeDisabled();
  cleanup();
  const busy=setup({},true);await choose();expect(busy.convert()).toBeDisabled();
});

it('shows a no-match message when the scan finds nothing',async()=>{
  const {convert}=setup({scan:vi.fn(async()=>({files:[],skipped:[],truncated:false,totalBytes:0}))});
  await choose();fireEvent.click(convert());
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('No matching files were found.'));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('tells the user to narrow the choice when a limit hid files, even if none were listed',async()=>{
  const {convert}=setup({scan:vi.fn(async()=>({files:[],skipped:[],truncated:true,totalBytes:0}))});
  await choose();fireEvent.click(convert());
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(/No matching files were found\..*Choose a subfolder/));
});

it('cannot be closed while a folder picker is open',async()=>{
  let answer:(folder:string|null)=>void=()=>{};
  const {onClose}=setup({pickFolder:vi.fn(()=>new Promise<string|null>(resolve=>{answer=resolve;}))});
  fireEvent.click(screen.getByRole('button',{name:'Choose source folder…'}));
  expect(screen.getByRole('button',{name:'Close'})).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(onClose).not.toHaveBeenCalled();
  answer('C:\\old scores');await screen.findByText('C:\\old scores');
  expect(screen.getByRole('button',{name:'Close'})).toBeEnabled();
});

it('moves focus off Convert once a run is done',async()=>{
  const {convert}=setup();await choose();fireEvent.click(convert());
  await screen.findByRole('table',{name:'Conversion report'});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Close'})).toHaveFocus());
});

it('forgets the folders on the native side when it closes',async()=>{
  const {bridge}=setup();
  expect(bridge.reset).not.toHaveBeenCalled();
  cleanup();
  expect(bridge.reset).toHaveBeenCalledTimes(1);
});

it('ends a file check under way when Cancel is used, and reports the file as not converted rather than failed',async()=>{
  let seen:AbortSignal|undefined;
  const slow:Probe=(_bytes,options)=>new Promise(resolve=>{seen=options?.signal;options?.signal?.addEventListener('abort',()=>resolve({ok:false,error:'The check was cancelled.'}));});
  const bridge:BatchBridge={reset:vi.fn(async()=>{}),pickFolder:vi.fn(async role=>role==='source'?'C:\\old scores':'C:\\converted'),scan:vi.fn(async()=>scan),read:vi.fn(async()=>xml),write:vi.fn(async()=>({relative:'x.gp',renamed:false}))};
  render(<BatchConvertDialog busy={false} bridge={bridge} probe={slow} onClose={vi.fn()}/>);
  await choose();fireEvent.click(screen.getByRole('button',{name:'Convert'}));
  fireEvent.click(await screen.findByRole('button',{name:'Cancel conversion'}));
  const report=await screen.findByRole('table',{name:'Conversion report'});
  expect(seen?.aborted).toBe(true);
  expect(within(report).getAllByText('Not converted')).toHaveLength(2);
  expect(within(report).queryByText('Failed')).not.toBeInTheDocument();
  expect(bridge.write).not.toHaveBeenCalled();
});

it('renders localized row details when language changes',async()=>{
  const {convert}=setup();
  await choose();
  fireEvent.click(convert());
  const report=await screen.findByRole('table',{name:'Conversion report'});
  expect(within(report).getByText('1 track, 1 bar. Saved as old/a.gp.')).toBeInTheDocument();
  setLanguagePreference('et');
  await waitFor(()=>expect(within(report).getByText('1 rada, 1 takt. Salvestatud nimega old/a.gp.')).toBeInTheDocument());
  setLanguagePreference('de');
  await waitFor(()=>expect(within(report).getByText('1 Spur, 1 Takt. Gespeichert als old/a.gp.')).toBeInTheDocument());
});
