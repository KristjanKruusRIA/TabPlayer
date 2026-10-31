// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {CabinetNotices} from './CabinetNotices';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge} from './bridge';
import {cabinetIrFits,completeSound,defaultEffects,laterFields,soundProblem,applySettingsEdit,defaultDocumentSettings} from '../document-settings';
import type {CabinetIrRef,TrackSound} from '../edit-types';
import type {CabinetIrEntry,CabinetIrStatus} from './cabinet-ir';

const library:{entries:CabinetIrEntry[];status:Record<string,CabinetIrStatus>;importing:CabinetIrEntry|null|Error;gate:Promise<void>|null;asked:string[][]}={entries:[],status:{},importing:null,gate:null,asked:[]};
const calls={remove:[] as string[]};
const native=async(command:string,args?:{id?:string;ids?:string[]})=>{
  if(command==='cabinet_ir_list')return structuredClone(library.entries);
  if(command==='cabinet_ir_status'){library.asked.push(args!.ids!);return (args!.ids!).map(id=>library.status[id]??{id,state:library.entries.some(e=>e.id===id)?'ready':'missing',message:null});}
  if(command==='cabinet_ir_import'){await library.gate;const importing=library.importing;if(importing instanceof Error)throw importing;if(importing&&!library.entries.some(entry=>entry.id===importing.id))library.entries.push(importing);return importing;}
  if(command==='cabinet_ir_remove'){calls.remove.push(args!.id!);library.entries=library.entries.filter(e=>e.id!==args!.id);return;}
  throw new Error(`unexpected ${command}`);
};
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn((command:string,args?:{id?:string;ids?:string[]})=>native(command,args))}));
const entry=(id:string,name:string,durationMs=350):CabinetIrEntry=>({id,name,sampleRate:48000,channels:1,durationMs,bytes:1000});
const A='a'.repeat(32),B='b'.repeat(32);
beforeEach(async()=>{const {invoke}=await import('@tauri-apps/api/core');vi.mocked(invoke).mockImplementation((command:string,args?:unknown)=>native(command,args as {id?:string;ids?:string[]}) as never);library.entries=[entry(A,'Mesa 4x12'),entry(B,'Fender 2x12',700)];library.status={};library.importing=null;library.gate=null;library.asked=[];calls.remove.length=0;});
afterEach(()=>{cleanup();localStorage.clear();});
const ref=(id=A,levelDb=0,name='Mesa 4x12'):CabinetIrRef=>({id,name,levelDb});
const soundWith=(ir?:CabinetIrRef,model:TrackSound['effects']['cabinet']['model']='closed'):TrackSound=>{const sound=soundPreset('crunch');sound.effects.cabinet.model=model;if(ir)sound.effects.cabinet.ir=ir;return sound;};
const notice=()=>document.querySelector('.sound-ir-notice');
const last=(onEdit:ReturnType<typeof vi.fn>)=>onEdit.mock.calls.at(-1)?.[0].sound.effects.cabinet;

it('leaves the cabinet exactly as it was while no response is chosen',()=>{
  expect(defaultEffects().cabinet).toEqual({enabled:false,model:'open'});
  expect(laterFields('cabinet')).toEqual(['ir']);
  const older=soundPreset('lead');expect('ir' in older.effects.cabinet).toBe(false);
  expect(soundProblem(older)).toBeNull();expect(completeSound(older).effects.cabinet).toEqual(older.effects.cabinet);
});
it('accepts the references the native player accepts and refuses the rest',()=>{
  const good=ref();
  for(const value of [good,{...good,levelDb:-12},{...good,levelDb:12},{...good,name:'x'.repeat(64)},{...good,name:'日本語のキャビネット'},{...good,name:'a b'},null])expect(cabinetIrFits(value),JSON.stringify(value)).toBe(true);
  for(const value of [{...good,id:'A'.repeat(32)},{...good,id:'a'.repeat(31)},{...good,id:'g'.repeat(32)},{...good,name:''},{...good,name:' pad'},{...good,name:'pad '},{...good,name:'﻿x'},{...good,name:'x\u0085'},{...good,name:'bell\u0007'},{...good,name:'x'.repeat(65)},{...good,name:'lone\uD800'},{...good,levelDb:12.5},{...good,levelDb:Number.NaN},{...good,levelDb:'0'},{...good,extra:1},{id:good.id,name:good.name},[],'text',undefined,0])expect(cabinetIrFits(value),JSON.stringify(value)).toBe(false);
  const sound=soundWith(good);expect(soundProblem(sound)).toBeNull();
  sound.effects.cabinet.ir={...good,id:'zz'};expect(soundProblem(sound)).toBe('Invalid effect parameter.');
  // A hand-written null is read as none, as the native player reads it, so the document still opens.
  const nulled=soundWith();(nulled.effects.cabinet as unknown as Record<string,unknown>).ir=null;expect(soundProblem(nulled)).toBeNull();
});
it('applies a sound that names a response as one undoable settings edit and keeps it through a copy',()=>{
  const settings=defaultDocumentSettings();
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'t',sound:soundWith(ref())},{masterBars:[]} as never,['t']);
  expect(settings.sounds.t.effects.cabinet.ir).toEqual(ref());
  expect(()=>applySettingsEdit(settings,{type:'setTrackSound',trackId:'t',sound:soundWith({...ref(),levelDb:40})},{masterBars:[]} as never,['t'])).toThrow('Invalid effect parameter.');
  expect(settings.sounds.t.effects.cabinet.ir).toEqual(ref());
});
it('lists the library, shows the choice and offers the built-in cabinet',async()=>{
  render(<SoundPanel trackId="t" sound={soundWith(ref(B,0,'Fender 2x12'))} onEdit={vi.fn()}/>);
  const select=await screen.findByRole('combobox',{name:'Cabinet impulse response'});
  await waitFor(()=>expect([...select.querySelectorAll('option')].map(o=>o.textContent)).toEqual(['Built-in cabinet (model above)','Mesa 4x12 · 0.35 s','Fender 2x12 · 0.70 s']));
  expect(select).toHaveValue(B);
  await new Promise(done=>setTimeout(done,20));expect(notice()).toBeNull();
});
it('lists bundled responses beside the library and does not offer to remove them',async()=>{
  const name='Bass Amp · 8x10 Ampeg SVT 97';
  expect(cabinetIrFits({id:A,name,levelDb:0})).toBe(true);
  library.entries=[{...entry(A,name),bundled:true}];
  render(<SoundPanel trackId="t" sound={soundWith(ref(A,0,name))} onEdit={vi.fn()}/>);
  const select=await screen.findByRole('combobox',{name:'Cabinet impulse response'});
  await waitFor(()=>expect([...select.querySelectorAll('option')].map(o=>o.textContent)).toEqual(['Built-in cabinet (model above)',`${name} · 0.35 s`]));
  const remove=screen.getByRole('button',{name:'Remove cabinet impulse response from library'});
  expect(remove).toBeDisabled();
  expect(remove).toHaveAttribute('title','Bundled responses ship with TabPlayer.');
  expect(calls.remove).toEqual([]);
});
it('picks a response, keeps its level, and goes back to the built-in cabinet',async()=>{
  const onEdit=vi.fn();
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  const select=await screen.findByRole('combobox',{name:'Cabinet impulse response'});
  await waitFor(()=>expect(select.querySelectorAll('option').length).toBe(3));
  fireEvent.change(select,{target:{value:A}});
  expect(last(onEdit)).toEqual({enabled:true,model:'closed',ir:{id:A,name:'Mesa 4x12',levelDb:0}});
  rerender(<SoundPanel trackId="t" sound={soundWith(ref(A,3))} onEdit={onEdit}/>);
  fireEvent.change(select,{target:{value:B}});
  expect(last(onEdit).ir).toEqual({id:B,name:'Fender 2x12',levelDb:3});
  fireEvent.change(select,{target:{value:''}});
  expect('ir' in last(onEdit)).toBe(false);expect(last(onEdit).model).toBe('closed');
});
it('trims the level on blur or Enter and never while a number is half typed',async()=>{
  const onEdit=vi.fn();
  render(<SoundPanel trackId="t" sound={soundWith(ref(A,1))} onEdit={onEdit}/>);
  const level=await screen.findByLabelText('Cabinet impulse response level (dB)');
  fireEvent.change(level,{target:{value:'-'}});fireEvent.change(level,{target:{value:'-4.'}});
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(level,{target:{value:'-4.5'}});fireEvent.blur(level);
  expect(last(onEdit).ir).toEqual({id:A,name:'Mesa 4x12',levelDb:-4.5});
  fireEvent.change(level,{target:{value:'5'}});fireEvent.keyDown(level,{key:'Enter'});
  expect(last(onEdit).ir.levelDb).toBe(5);
  const edits=onEdit.mock.calls.length;
  fireEvent.change(level,{target:{value:'13'}});fireEvent.blur(level);
  fireEvent.change(level,{target:{value:''}});fireEvent.blur(level);
  expect(onEdit.mock.calls.length).toBe(edits);expect(level).toHaveValue(1);
});
it('imports a file, chooses it, and says what it did',async()=>{
  const onEdit=vi.fn();library.importing={...entry('c'.repeat(32),'Vox AC30',1000),notice:'Longer than 1 second, so the end was faded out and cut.'};
  render(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import cabinet impulse response'}));
  await waitFor(()=>expect(last(onEdit)?.ir).toEqual({id:'c'.repeat(32),name:'Vox AC30',levelDb:0}));
  expect(await screen.findByText(/Imported “Vox AC30” \(1\.00 s\)\. Longer than 1 second/)).toBeInTheDocument();
});
it('offers a response that already ships without copying it',async()=>{
  const onEdit=vi.fn();
  const name='Bass Amp · 8x10 Ampeg SVT 97';
  library.entries=[{...entry(A,name),bundled:true}];
  library.importing={...entry(A,name),bundled:true};
  render(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import cabinet impulse response'}));
  await waitFor(()=>expect(last(onEdit)?.ir).toEqual({id:A,name,levelDb:0}));
  expect(await screen.findByText(/already ships with TabPlayer, so nothing was copied/)).toBeInTheDocument();
  expect(library.entries).toHaveLength(1);
});
it('does nothing when the file dialog is cancelled and says why a file was refused',async()=>{
  const onEdit=vi.fn();
  render(<SoundPanel trackId="t" sound={soundWith()} onEdit={onEdit}/>);
  const button=await screen.findByRole('button',{name:'Import cabinet impulse response'});
  fireEvent.click(button);await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
  expect(onEdit).not.toHaveBeenCalled();
  library.importing=new Error('This recording is silent, so it cannot be a cabinet response.');
  fireEvent.click(button);
  expect((await screen.findByRole('alert')).textContent).toBe('This recording is silent, so it cannot be a cabinet response.');
  expect(onEdit).not.toHaveBeenCalled();
});
it('removes a response from the library without touching the sound',async()=>{
  const onEdit=vi.fn();
  render(<SoundPanel trackId="t" sound={soundWith(ref())} onEdit={onEdit}/>);
  const remove=screen.getByRole('button',{name:'Remove cabinet impulse response from library'});
  await waitFor(()=>expect(remove).toBeEnabled());
  fireEvent.click(remove);
  await waitFor(()=>expect(calls.remove).toEqual([A]));
  expect(await screen.findByText(/Removed “Mesa 4x12” from the library/)).toBeInTheDocument();
  expect(onEdit).not.toHaveBeenCalled();
});
it('cannot remove what the library does not hold, or when nothing is chosen',async()=>{
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith()} onEdit={vi.fn()}/>);
  const remove=screen.getByRole('button',{name:'Remove cabinet impulse response from library'});
  await screen.findByRole('combobox',{name:'Cabinet impulse response'});
  expect(remove).toBeDisabled();
  rerender(<SoundPanel trackId="t" sound={soundWith(ref('d'.repeat(32),0,'Gone'))} onEdit={vi.fn()}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  expect(remove).toBeDisabled();
});
it('says plainly that a missing response falls back to the built-in cabinet, and changes nothing',async()=>{
  const onEdit=vi.fn(),sound=soundWith(ref('d'.repeat(32),2,'Shared cab'),'combo'),before=structuredClone(sound);
  render(<SoundPanel trackId="t" sound={sound} onEdit={onEdit}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toBe("The impulse response “Shared cab” is not in this computer's cabinet library, so the built-in combo cabinet plays instead. Import the file to use it; the document is unchanged.");
  expect(screen.getByRole('combobox',{name:'Cabinet impulse response'})).toHaveValue('d'.repeat(32));
  expect(screen.getByRole('option',{name:'Shared cab (not in this library)'})).toBeInTheDocument();
  expect(onEdit).not.toHaveBeenCalled();expect(sound).toEqual(before);
});
it('says when a response is in the library but cannot be read',async()=>{
  library.status[A]={id:A,state:'unreadable',message:'The file has changed since it was imported.'};
  render(<SoundPanel trackId="t" sound={soundWith(ref(A),'bassStack')} onEdit={vi.fn()}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toBe('The impulse response “Mesa 4x12” cannot be read (The file has changed since it was imported), so the built-in bass stack cabinet plays instead. The document is unchanged.');
});
it('still works where the native library is unavailable',async()=>{
  const {invoke}=await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockRejectedValue(new Error('no native'));
  const onEdit=vi.fn();
  render(<SoundPanel trackId="t" sound={soundWith(ref())} onEdit={onEdit}/>);
  fireEvent.change(await screen.findByRole('combobox',{name:'Cabinet impulse response'}),{target:{value:''}});
  expect('ir' in last(onEdit)).toBe(false);
});

const missingId='d'.repeat(32);
function nativePlayer() {
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const player=new NativePlaybackController({bridge,onEdit:()=>{}});return {bridge,player};
}
it('tells playback to resolve the responses again when one is imported that the sound already names',async()=>{
  const {player,bridge}=nativePlayer(),refresh=vi.spyOn(player,'refreshSounds'),onEdit=vi.fn();
  library.importing=entry(missingId,'Shared cab');
  render(<SoundPanel trackId="t" sound={soundWith(ref(missingId,2,'Shared cab'))} onEdit={onEdit} playback={player}/>);
  await waitFor(()=>expect(notice()).not.toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'Import cabinet impulse response'}));
  await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));
  // The document gains no edit, and the notice is gone because the library holds the file.
  expect(onEdit).not.toHaveBeenCalled();
  await waitFor(()=>expect(notice()).toBeNull());
  expect(bridge.setMix).not.toHaveBeenCalled();
  player.destroy();
});
it('tells playback again when a response is removed', async()=>{
  const {player}=nativePlayer(),refresh=vi.spyOn(player,'refreshSounds');
  render(<SoundPanel trackId="t" sound={soundWith(ref())} onEdit={vi.fn()} playback={player}/>);
  const remove=screen.getByRole('button',{name:'Remove cabinet impulse response from library'});
  await waitFor(()=>expect(remove).toBeEnabled());
  fireEvent.click(remove);
  await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));
  player.destroy();
});
it('uses the sound as it is when the file dialog closes, not as it was when it opened',async()=>{
  const onEdit=vi.fn();let open!:()=>void;
  library.gate=new Promise<void>(done=>{open=done;});library.importing=entry('c'.repeat(32),'Vox AC30');
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith(ref(A,0))} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import cabinet impulse response'}));
  // While the dialog is open the level is trimmed and the response named is changed.
  rerender(<SoundPanel trackId="t" sound={soundWith(ref(B,4,'Fender 2x12'))} onEdit={onEdit}/>);
  open();
  await waitFor(()=>expect(last(onEdit)?.ir).toEqual({id:'c'.repeat(32),name:'Vox AC30',levelDb:4}));
  expect(onEdit).toHaveBeenCalledTimes(1);
});
it('changes no sound when the track is not the one the import began on', async()=>{
  const onEdit=vi.fn();let open!:()=>void;
  library.gate=new Promise<void>(done=>{open=done;});library.importing=entry('c'.repeat(32),'Vox AC30');
  const {rerender}=render(<SoundPanel trackId="t" sound={soundWith(ref(A,0))} onEdit={onEdit}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Import cabinet impulse response'}));
  rerender(<SoundPanel trackId="other" sound={soundWith(ref(B,4,'Fender 2x12'))} onEdit={onEdit}/>);
  open();
  expect(await screen.findByText(/The track changed meanwhile/)).toBeInTheDocument();
  expect(onEdit).not.toHaveBeenCalled();
});
it('shows the missing response at the document level, naming the track, without asking when none is named', async()=>{
  const sounds={lead:soundWith(ref(missingId,0,'Shared cab'),'combo'),rhythm:soundWith()};
  const {rerender}=render(<CabinetNotices sounds={sounds} trackNames={{lead:'Lead guitar',rhythm:'Rhythm'}}/>);
  expect((await screen.findByRole('status')).textContent).toBe("Lead guitar: The impulse response “Shared cab” is not in this computer's cabinet library, so the built-in combo cabinet plays instead. Import the file to use it; the document is unchanged.");
  expect(library.asked).toEqual([[missingId]]);
  // A response the library holds, or a cabinet that is off, says nothing.
  const quiet=soundWith(ref(A,0));const off=soundWith(ref(missingId,0,'Gone'));off.effects.cabinet.enabled=false;
  rerender(<CabinetNotices sounds={{a:quiet,b:off}}/>);
  await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
  // Nothing named: the library is not asked.
  library.asked=[];rerender(<CabinetNotices sounds={{rhythm:soundWith()}}/>);
  await new Promise(done=>setTimeout(done,20));expect(library.asked).toEqual([]);
});
it('updates the document-level notice when the library gains the file', async()=>{
  const sounds={lead:soundWith(ref(missingId,0,'Shared cab'))};
  render(<CabinetNotices sounds={sounds}/>);
  await screen.findByRole('status');
  library.entries.push(entry(missingId,'Shared cab'));
  const {announceCabinetLibrary}=await import('./cabinet-ir');announceCabinetLibrary();
  await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
});
