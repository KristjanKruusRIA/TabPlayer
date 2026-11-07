// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {AmpCapture} from './AmpCapture';
import {CaptureNotices} from './CaptureNotices';
import {ExportDialog} from '../export/ExportDialog';
import type {AmpCapture as AmpCaptureRef,TrackSound} from '../edit-types';
import type {CaptureEntry,CaptureStatus} from './amp-capture';

const library:{entries:CaptureEntry[];status:Record<string,CaptureStatus>;importing:CaptureEntry|null|Error;gate:Promise<void>|null;statusGate:Promise<void>|null;asked:string[][]}={entries:[],status:{},importing:null,gate:null,statusGate:null,asked:[]};
const calls={remove:[] as string[]};
const native=async(command:string,args?:{id?:string;ids?:string[]})=>{
  if(command==='nam_capture_list')return structuredClone(library.entries);
  if(command==='nam_capture_status'){library.asked.push(args!.ids!);await library.statusGate;return (args!.ids!).map(id=>library.status[id]??{id,state:library.entries.some(e=>e.id===id)?'ready':'missing',message:null});}
  if(command==='nam_capture_import'){await library.gate;const importing=library.importing;if(importing instanceof Error)throw importing;if(importing&&!library.entries.some(entry=>entry.id===importing.id))library.entries.push(importing);return importing;}
  if(command==='nam_capture_remove'){calls.remove.push(args!.id!);library.entries=library.entries.filter(e=>e.id!==args!.id);return;}
  return [];
};
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn((command:string,args?:unknown)=>native(command,args as {id?:string;ids?:string[]}))}));
const entry=(id:string,name:string):CaptureEntry=>({id,name,bytes:1000});
const A='a'.repeat(32),B='b'.repeat(32),GONE='d'.repeat(32);
beforeEach(()=>{library.entries=[entry(A,'Plexi crunch'),entry(B,'JCM lead')];library.status={};library.importing=null;library.gate=null;library.statusGate=null;library.asked=[];calls.remove.length=0;});
afterEach(()=>{cleanup();localStorage.clear();});
const ref=(id=A,levelDb=0,name='Plexi crunch'):AmpCaptureRef=>({id,name,levelDb});
const soundWith=(capture?:AmpCaptureRef):TrackSound=>{const sound=soundPreset('crunch');sound.effects.amp.enabled=true;if(capture)sound.effects.amp.capture=capture;return sound;};
const last=(onEdit:ReturnType<typeof vi.fn>)=>onEdit.mock.calls.at(-1)?.[0].sound.effects.amp;
const notice=()=>document.querySelector('.sound-ir-notice');
const picker=()=>screen.findByRole('combobox',{name:'Amp capture'});

it('lists the library and offers the built-in amp',async()=>{
  render(<SoundPanel trackId="t" sound={soundWith(ref(B,0,'JCM lead'))} onEdit={vi.fn()}/>);
  const select=await picker();
  await waitFor(()=>expect([...select.querySelectorAll('option')].map(o=>o.textContent)).toEqual(['Built-in amp (model above)','Plexi crunch','JCM lead']));
  expect(select).toHaveValue(B);
  await new Promise(done=>setTimeout(done,20));expect(notice()).toBeNull();
  expect(await screen.findByText('The drive knob is not used while a capture plays.')).toBeInTheDocument();
});
it('shows the drive note only while the capture can play',async()=>{
  const drive='The drive knob is not used while a capture plays.';
  const {rerender}=render(<AmpCapture value={ref(GONE,0,'Gone')} onChange={vi.fn()}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  expect(screen.queryByText(drive)).toBeNull();
  library.status[A]={id:A,state:'unreadable',message:null};
  rerender(<AmpCapture value={ref(A)} onChange={vi.fn()}/>);
  await waitFor(()=>expect(notice()?.textContent).toMatch(/cannot be read/));
  expect(screen.queryByText(drive)).toBeNull();
  library.status[B]={id:B,state:'unsupported',message:null};
  rerender(<AmpCapture value={ref(B,0,'JCM lead')} onChange={vi.fn()}/>);
  await waitFor(()=>expect(notice()?.textContent).toMatch(/cannot play/));
  expect(screen.queryByText(drive)).toBeNull();
  library.status={};
  rerender(<AmpCapture value={ref(A)} onChange={vi.fn()}/>);
  expect(await screen.findByText(drive)).toBeInTheDocument();expect(notice()).toBeNull();
});
it('keeps the notice through a library refresh, and never shows the status of another capture',async()=>{
  let release!:()=>void;
  const {rerender}=render(<AmpCapture value={ref(GONE,0,'Gone')} onChange={vi.fn()}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  const asked=library.asked.length;
  library.statusGate=new Promise<void>(done=>{release=done;});
  const {announceCaptureLibrary}=await import('./amp-capture');announceCaptureLibrary();
  await waitFor(()=>expect(library.asked.length).toBeGreaterThan(asked));
  // The answer for the refresh has not arrived: the notice stays, and does not blink away and back.
  expect(notice()).not.toBeNull();
  library.status[A]={id:A,state:'unreadable',message:null};
  rerender(<AmpCapture value={ref(A)} onChange={vi.fn()}/>);
  await waitFor(()=>expect(library.asked.some(ids=>ids[0]===A)).toBe(true));
  expect(notice()).toBeNull();
  release();
  await waitFor(()=>expect(notice()?.textContent).toMatch(/“Plexi crunch” cannot be read/));
});
it('writes one edit with the capture when one is picked, keeping the level, and none for the current one',async()=>{
  const onEdit=vi.fn();
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  const select=await picker();
  await waitFor(()=>expect(select.querySelectorAll('option').length).toBe(3));
  fireEvent.change(select,{target:{value:A}});
  expect(onEdit).toHaveBeenCalledTimes(1);expect(last(onEdit).capture).toEqual(ref());
  rerender(<SoundPanel trackId="t" sound={soundWith(ref(A,3))} onEdit={onEdit}/>);
  fireEvent.change(select,{target:{value:A}});expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.change(select,{target:{value:B}});
  expect(last(onEdit).capture).toEqual({id:B,name:'JCM lead',levelDb:3});
});
it('removes the capture when the built-in amp is chosen, and records nothing when there is none',async()=>{
  const onEdit=vi.fn();
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith(ref())} onEdit={onEdit}/>);
  const select=await picker();
  fireEvent.change(select,{target:{value:''}});
  expect('capture' in last(onEdit)).toBe(false);
  rerender(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  fireEvent.change(select,{target:{value:''}});expect(onEdit).toHaveBeenCalledTimes(1);
});
it('trims the level on blur or Enter, only when it changed and is in range',async()=>{
  const onEdit=vi.fn();
  render(<SoundPanel trackId="t" sound={soundWith(ref(A,1))} onEdit={onEdit}/>);
  const level=await screen.findByLabelText('Capture level (dB)');
  fireEvent.change(level,{target:{value:'-'}});fireEvent.change(level,{target:{value:'-4.'}});
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(level,{target:{value:'-4.5'}});fireEvent.blur(level);
  expect(last(onEdit).capture).toEqual({id:A,name:'Plexi crunch',levelDb:-4.5});
  fireEvent.change(level,{target:{value:'5'}});fireEvent.keyDown(level,{key:'Enter'});
  expect(last(onEdit).capture.levelDb).toBe(5);
  const edits=onEdit.mock.calls.length;
  fireEvent.change(level,{target:{value:'1'}});fireEvent.blur(level);
  fireEvent.change(level,{target:{value:'13'}});fireEvent.blur(level);
  fireEvent.change(level,{target:{value:''}});fireEvent.blur(level);
  // Only the change back to 1 differs from the stored level of the sound shown; 13 and an empty field write nothing.
  expect(onEdit.mock.calls.length).toBe(edits);
});
it('imports a file, refreshes the list and chooses it',async()=>{
  const onEdit=vi.fn();library.importing=entry('c'.repeat(32),'Vox AC30');
  render(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import capture…'}));
  await waitFor(()=>expect(last(onEdit)?.capture).toEqual({id:'c'.repeat(32),name:'Vox AC30',levelDb:0}));
  expect(await screen.findByText('Imported “Vox AC30”.')).toBeInTheDocument();
  expect(screen.getByRole('option',{name:'Vox AC30'})).toBeInTheDocument();
});
it('writes nothing when the track changed while the file dialog was open, and when it is cancelled or refused',async()=>{
  const onEdit=vi.fn();let open!:()=>void;
  library.gate=new Promise<void>(done=>{open=done;});library.importing=entry('c'.repeat(32),'Vox AC30');
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith(ref(A))} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import capture…'}));
  rerender(<SoundPanel trackId="other" sound={soundWith(ref(B,4,'JCM lead'))} onEdit={onEdit}/>);
  open();
  expect(await screen.findByText(/The track changed meanwhile/)).toBeInTheDocument();
  expect(onEdit).not.toHaveBeenCalled();
  library.gate=null;library.importing=null;
  fireEvent.click(screen.getByRole('button',{name:'Import capture…'}));
  await new Promise(done=>setTimeout(done,20));expect(screen.queryByRole('alert')).toBeNull();
  library.importing=new Error('This file is not a NAM capture.');
  fireEvent.click(screen.getByRole('button',{name:'Import capture…'}));
  expect((await screen.findByRole('alert')).textContent).toBe('This file is not a NAM capture.');
  expect(onEdit).not.toHaveBeenCalled();
});
it('writes nothing when the picker is gone before the file dialog closes',async()=>{
  const onEdit=vi.fn();let open!:()=>void;
  library.gate=new Promise<void>(done=>{open=done;});library.importing=entry('c'.repeat(32),'Vox AC30');
  const view=render(<SoundPanel trackId="t" sound={soundWith(ref(A))} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import capture…'}));
  view.unmount();
  open();
  await new Promise(done=>setTimeout(done,30));
  expect(onEdit).not.toHaveBeenCalled();
  const {invoke}=await import('@tauri-apps/api/core');
  expect(vi.mocked(invoke).mock.calls.some(call=>call[0]==='nam_capture_import')).toBe(true);
});
it('says to choose the capture from the list when an edit was busy as the dialog closed',async()=>{
  const onChange=vi.fn();let open!:()=>void;
  library.gate=new Promise<void>(done=>{open=done;});library.importing=entry('c'.repeat(32),'Vox AC30');
  const {rerender}=render(<AmpCapture value={ref(A)} scope="t" onChange={onChange}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import capture…'}));
  rerender(<AmpCapture value={ref(A)} scope="t" busy onChange={onChange}/>);
  open();
  expect(await screen.findByText(/Imported “Vox AC30”\. .*choose it from the list/)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
it('removes a library capture without touching the sound, and cannot remove what the library lacks',async()=>{
  const onEdit=vi.fn();
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith(ref())} onEdit={onEdit}/>);
  const remove=screen.getByRole('button',{name:'Remove capture from library'});
  await waitFor(()=>expect(remove).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(remove);
  await waitFor(()=>expect(calls.remove).toEqual([A]));
  expect(await screen.findByText(/Removed “Plexi crunch” from the library/)).toBeInTheDocument();
  expect(onEdit).not.toHaveBeenCalled();
  rerender(<SoundPanel trackId="t" sound={soundWith(ref(GONE,0,'Gone'))} onEdit={onEdit}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  expect(remove).toHaveAttribute('aria-disabled','true');
});
it('says plainly that a missing, unreadable or unsupported capture plays the built-in amp, and changes nothing',async()=>{
  const onEdit=vi.fn(),sound=soundWith(ref(GONE,2,'Shared amp')),before=structuredClone(sound);
  const {rerender}=render(<SoundPanel trackId="t" sound={sound} onEdit={onEdit}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toBe("The capture “Shared amp” is not in this computer's capture library, so the built-in amp plays instead. Import the file to use it; the document is unchanged.");
  expect(screen.getByRole('option',{name:'Shared amp (not in this library)'})).toBeInTheDocument();
  expect(onEdit).not.toHaveBeenCalled();expect(sound).toEqual(before);
  library.status[A]={id:A,state:'unsupported',message:'This NAM architecture is not supported.'};
  rerender(<SoundPanel trackId="t" sound={soundWith(ref(A))} onEdit={onEdit}/>);
  await waitFor(()=>expect(notice()?.textContent).toMatch(/cannot play \(This NAM architecture is not supported\), so the built-in amp plays instead/));
  library.status[B]={id:B,state:'unreadable',message:'The file has changed since it was imported.'};
  rerender(<SoundPanel trackId="t" sound={soundWith(ref(B,0,'JCM lead'))} onEdit={onEdit}/>);
  await waitFor(()=>expect(notice()?.textContent).toBe('The capture “JCM lead” cannot be read (The file has changed since it was imported), so the built-in amp plays instead. The document is unchanged.'));
});
it('refuses every change while busy, with the controls kept focusable',async()=>{
  const onChange=vi.fn();
  render(<AmpCapture value={ref(A)} busy onChange={onChange}/>);
  const select=await picker(),level=screen.getByLabelText('Capture level (dB)');
  const importButton=screen.getByRole('button',{name:'Import capture…'});
  expect(importButton).toHaveAttribute('aria-disabled','true');expect(importButton).not.toBeDisabled();
  expect(select).toHaveAttribute('aria-disabled','true');expect(select).not.toBeDisabled();
  await waitFor(()=>expect(select.querySelectorAll('option').length).toBe(3));
  fireEvent.change(select,{target:{value:B}});
  fireEvent.change(level,{target:{value:'4'}});fireEvent.blur(level);
  fireEvent.click(importButton);
  await new Promise(done=>setTimeout(done,20));
  expect(onChange).not.toHaveBeenCalled();
  const {invoke}=await import('@tauri-apps/api/core');
  expect(vi.mocked(invoke).mock.calls.some(call=>call[0]==='nam_capture_import')).toBe(false);
});
it('shows the missing capture at the document level naming the track, only for an amp that is on, and asks nothing when none is named',async()=>{
  const sounds={lead:soundWith(ref(GONE,0,'Shared amp')),rhythm:soundWith()};
  const {rerender}=render(<CaptureNotices sounds={sounds} trackNames={{lead:'Lead guitar',rhythm:'Rhythm'}}/>);
  expect((await screen.findByRole('status')).textContent).toBe("Lead guitar: The capture “Shared amp” is not in this computer's capture library, so the built-in amp plays instead. Import the file to use it; the document is unchanged.");
  expect(library.asked).toEqual([[GONE]]);
  const off=soundWith(ref(GONE,0,'Gone'));off.effects.amp.enabled=false;
  rerender(<CaptureNotices sounds={{a:soundWith(ref(A)),b:off}}/>);
  await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
  library.asked=[];rerender(<CaptureNotices sounds={{rhythm:soundWith()}}/>);
  await new Promise(done=>setTimeout(done,20));expect(library.asked).toEqual([]);
});
it('updates the document-level notice when the library gains the file',async()=>{
  render(<CaptureNotices sounds={{lead:soundWith(ref(GONE,0,'Shared amp'))}}/>);
  await screen.findByRole('status');
  library.entries.push(entry(GONE,'Shared amp'));
  const {announceCaptureLibrary}=await import('./amp-capture');announceCaptureLibrary();
  await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
});
it('says in the audio export that a capture is missing, and only there',async()=>{
  const score=new model.Score();for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());const track=new model.Track();track.name='Lead';score.addTrack(track);
  const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
  render(<ExportDialog score={score} layout={layout} busy={false} currentSpeedAvailable={true} sounds={{'base/0':soundWith(ref(GONE,0,'Shared amp'))}} trackNames={{'base/0':'Lead'}} onExport={()=>{}} onCancel={()=>{}}/>);
  expect(screen.queryByText(/Shared amp/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Export format'),{target:{value:'wav'}});
  expect((await screen.findByText(/Shared amp/)).textContent).toMatch(/^Lead: The capture “Shared amp” is not in this computer's capture library/);
});
