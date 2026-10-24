// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { tuningPresets } from '../tuning-presets';
import { SavedTuningsDialog } from './SavedTuningsDialog';
import { putTuningLibraryEntry,type SavedTuning,type TuningLibrary } from './library';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
const idA='ca4af764-86e2-4ddd-9c26-a1be3368bdf7',idB='0f3b6f0e-1111-4222-8333-944455556666';
const openD=[62,57,54,50,45,38];
let store:SavedTuning[];
const envelope=():TuningLibrary=>({format:'tabplayer-tuning-library',version:1,entries:structuredClone(store)});
function nativeStore(){
  invoke.mockImplementation(async(command:string,args?:{entry?:SavedTuning;id?:string})=>{
    if(command==='tuning_library_put'){const entry=structuredClone(args!.entry!),at=store.findIndex(item=>item.id===entry.id);if(at<0)store.push(entry);else store[at]=entry;}
    if(command==='tuning_library_remove')store=store.filter(item=>item.id!==args!.id);
    return envelope();
  });
}
beforeEach(()=>{store=[];invoke.mockReset();nativeStore();});
afterEach(cleanup);
function setup(notes='E4 B3 G3 D3 A2 E2',name='') {
  const onUse=vi.fn(),onClose=vi.fn(),view=render(<SavedTuningsDialog notes={notes} name={name} onUse={onUse} onClose={onClose}/>);
  return {onUse,onClose,view};
}
const nameBox=()=>screen.getByLabelText('Saved tuning name') as HTMLInputElement;
const pitchBox=()=>screen.getByLabelText('Saved tuning pitches (notes, high to low)') as HTMLInputElement;
const button=(name:string)=>screen.getByRole('button',{name});
const type=(box:HTMLElement,value:string)=>fireEvent.change(box,{target:{value}});
const putCalls=()=>invoke.mock.calls.filter(call=>call[0]==='tuning_library_put').map(call=>call[1].entry as SavedTuning);

it('lists the 25 built-ins with full note and octave text and never offers to change them',async()=>{
  setup();
  const guitar=screen.getByRole('group',{name:'Guitar · 6 strings'});
  expect(screen.getAllByRole('button',{name:/\b[A-G][#b]?-?\d\b/}).filter(row=>row.className==='saved-tuning-row')).toHaveLength(tuningPresets.length);
  fireEvent.click(within(guitar).getByRole('button',{name:/^Drop D/}));
  expect(nameBox()).toHaveValue('Drop D');expect(pitchBox()).toHaveValue('E4 B3 G3 D3 A2 D2');
  expect(button('Save changes')).toBeDisabled();expect(button('Delete')).toBeDisabled();
  fireEvent.click(button('Save as new'));
  await waitFor(()=>expect(screen.getByRole('region',{name:'Personal'})).toHaveTextContent('Drop D'));
  expect(putCalls()).toHaveLength(1);expect(putCalls()[0]).toMatchObject({name:'Drop D',tuning:[64,59,55,50,45,38]});
  expect(document.querySelectorAll('.saved-tuning-row')).toHaveLength(tuningPresets.length+1);
  expect(within(guitar).getByRole('button',{name:/^Drop D/})).toHaveAttribute('aria-pressed','false');
});
it('keeps same-pitch entries distinct by identity and deletes only the selected one',async()=>{
  store=[{id:idA,name:'Mine',tuning:openD},{id:idB,name:'Mine',tuning:openD}];
  setup();const personal=await screen.findByRole('region',{name:'Personal'});
  await waitFor(()=>expect(within(personal).getAllByRole('button')).toHaveLength(2));
  const [first,second]=within(personal).getAllByRole('button');expect(first).toHaveTextContent('D4 A3 F#3 D3 A2 D2');expect(second).toHaveTextContent('D4 A3 F#3 D3 A2 D2');
  fireEvent.click(second);expect(second).toHaveAttribute('aria-pressed','true');expect(first).toHaveAttribute('aria-pressed','false');
  fireEvent.click(button('Delete'));await waitFor(()=>expect(within(personal).getAllByRole('button')).toHaveLength(1));
  expect(invoke).toHaveBeenCalledWith('tuning_library_remove',{id:idB});expect(store.map(item=>item.id)).toEqual([idA]);
  expect(button('Delete')).toBeDisabled();expect(document.activeElement).toBe(nameBox());expect(pitchBox()).toHaveValue('D4 A3 F#3 D3 A2 D2');
});
it('saves a trimmed new entry and renames the selected one with the same id and pitches',async()=>{
  const {onUse}=setup();type(pitchBox(),'D4 A3 F#3 D3 A2 D2');type(nameBox(),'  Open D  ');
  expect(button('Save changes')).toBeDisabled();
  fireEvent.click(button('Save as new'));
  const personal=screen.getByRole('region',{name:'Personal'});await waitFor(()=>expect(within(personal).getByRole('button')).toHaveTextContent('Open D'));
  const [saved]=putCalls();expect(saved).toMatchObject({name:'Open D',tuning:openD});expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(nameBox()).toHaveValue('Open D');
  type(nameBox(),'Renamed');fireEvent.click(button('Save changes'));
  await waitFor(()=>expect(within(personal).getByRole('button')).toHaveTextContent('Renamed'));
  expect(putCalls()[1]).toEqual({id:saved.id,name:'Renamed',tuning:openD});expect(store).toHaveLength(1);
  fireEvent.click(button('Delete'));await waitFor(()=>expect(store).toHaveLength(0));
  expect(onUse).not.toHaveBeenCalled();
});
it('Use tuning copies only pitches and name to the caller, then closes; Cancel changes nothing',()=>{
  const {onUse,onClose}=setup('E4 B3 G3 D3 A2 E2','Draft');
  fireEvent.click(button('Cancel'));expect(onClose).toHaveBeenCalledTimes(1);expect(onUse).not.toHaveBeenCalled();
  type(pitchBox(),'d4 a3 f#3 d3 a2 d2');type(nameBox(),'  Custom  ');
  fireEvent.click(button('Use tuning'));expect(onUse).toHaveBeenCalledWith('D4 A3 F#3 D3 A2 D2','Custom');expect(onClose).toHaveBeenCalledTimes(2);
  expect(putCalls()).toHaveLength(0);
});
it('an empty name allows Use but not Save, and invalid pitches block both',()=>{
  const {onUse}=setup('E4 B3 G3 D3 A2 E2','');
  expect(button('Save as new')).toBeDisabled();expect(button('Use tuning')).toBeEnabled();
  fireEvent.click(button('Use tuning'));expect(onUse).toHaveBeenCalledWith('E4 B3 G3 D3 A2 E2','');
  type(nameBox(),'x'.repeat(81));expect(button('Save as new')).toBeDisabled();expect(nameBox()).toHaveAttribute('aria-invalid','true');
  type(nameBox(),'Fine');type(pitchBox(),'E4 nope');expect(button('Save as new')).toBeDisabled();expect(button('Use tuning')).toBeDisabled();expect(pitchBox()).toHaveAttribute('aria-invalid','true');
});
it('editing pitches clears the selected identity and name so Save changes stays disabled',async()=>{
  store=[{id:idA,name:'Mine',tuning:openD}];setup();
  const row=await screen.findByRole('button',{name:/^Mine/});fireEvent.click(row);expect(nameBox()).toHaveValue('Mine');expect(button('Save changes')).toBeEnabled();expect(button('Delete')).toBeEnabled();
  type(pitchBox(),'D4 A3 F#3 D3 A2 C2');expect(nameBox()).toHaveValue('');expect(row).toHaveAttribute('aria-pressed','false');
  type(nameBox(),'Mine');expect(button('Save changes')).toBeDisabled();expect(button('Delete')).toBeDisabled();expect(button('Save as new')).toBeEnabled();
  type(pitchBox(),'D4 A3 F#3 D3 A2 D2');expect(button('Save changes')).toBeDisabled();
});
it('storage errors stay inline and keep the details and last list',async()=>{
  store=[{id:idA,name:'Mine',tuning:openD}];setup();
  const row=await screen.findByRole('button',{name:/^Mine/});fireEvent.click(row);type(nameBox(),'Renamed');
  invoke.mockRejectedValueOnce('disk full');fireEvent.click(button('Save changes'));
  expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  expect(nameBox()).toHaveValue('Renamed');expect(pitchBox()).toHaveValue('D4 A3 F#3 D3 A2 D2');expect(screen.getByRole('button',{name:/^Mine/})).toHaveAttribute('aria-pressed','true');
  invoke.mockRejectedValueOnce(new Error('cannot delete'));fireEvent.click(button('Delete'));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('cannot delete'));expect(screen.getByRole('button',{name:/^Mine/})).toBeInTheDocument();
});
it('a failed initial read is reported without losing the editable draft',async()=>{
  invoke.mockReset();invoke.mockRejectedValue('corrupt library');setup('E4 B3 G3 D3 A2 E2','Draft');
  expect(await screen.findByRole('alert')).toHaveTextContent('corrupt library');expect(nameBox()).toHaveValue('Draft');expect(button('Use tuning')).toBeEnabled();
});
it('another open dialog refreshes after a save, without touching its details',async()=>{
  setup('E4 B3 G3 D3 A2 E2','First');
  const second=render(<SavedTuningsDialog notes="G2 D2 A1 E1" name="Second" onUse={vi.fn()} onClose={vi.fn()}/>);
  const names=screen.getAllByLabelText('Saved tuning name') as HTMLInputElement[];
  await act(async()=>{await putTuningLibraryEntry({id:idA,name:'Shared',tuning:openD});});
  for(const region of screen.getAllByRole('region',{name:'Personal'}))expect(region).toHaveTextContent('Shared');
  expect(names.map(input=>input.value)).toEqual(['First','Second']);second.unmount();
});
it('ignores late responses after close and after unmount',async()=>{
  let release!:(value:TuningLibrary)=>void;const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
  invoke.mockReset();invoke.mockReturnValueOnce(new Promise<TuningLibrary>(resolve=>{release=resolve;}));
  const {view}=setup();view.unmount();
  await act(async()=>{release({format:'tabplayer-tuning-library',version:1,entries:[{id:idA,name:'Late',tuning:openD}]});});
  expect(screen.queryByText('Late')).not.toBeInTheDocument();expect(spy).not.toHaveBeenCalled();
  // A mutation still in flight when the dialog unmounts must not touch state either; the library itself is still written.
  invoke.mockReset();nativeStore();let finish!:()=>void;
  invoke.mockImplementationOnce(async()=>envelope());
  const again=setup('E4 B3 G3 D3 A2 E2','Name');await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  invoke.mockImplementationOnce(()=>new Promise<TuningLibrary>(resolve=>{finish=()=>{store.push({id:idB,name:'Name',tuning:[64,59,55,50,45,40]});resolve(envelope());};}));
  fireEvent.click(button('Save as new'));await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(2));again.view.unmount();await act(async()=>{finish();});
  expect(spy).not.toHaveBeenCalled();expect(store).toHaveLength(1);spy.mockRestore();
});
it('closes on Escape, labels the modal dialog and keeps Tab inside it',()=>{
  const {onClose}=setup();const dialog=screen.getByRole('dialog',{name:'Saved tunings'});expect(dialog).toHaveAttribute('aria-modal','true');expect(nameBox()).toHaveFocus();
  const use=button('Use tuning'),first=document.querySelector<HTMLElement>('.saved-tuning-row')!;use.focus();fireEvent.keyDown(use,{key:'Tab'});expect(first).toHaveFocus();
  fireEvent.keyDown(first,{key:'Tab',shiftKey:true});expect(use).toHaveFocus();
  fireEvent.keyDown(dialog,{key:'Escape'});expect(onClose).toHaveBeenCalled();
});

it('a save that settles after the user picks another row leaves that row and its name alone',async()=>{
  let release!:()=>void;
  invoke.mockImplementation(async(command:string,args?:{entry?:SavedTuning})=>{
    if(command==='tuning_library_put'){await new Promise<void>(accept=>{release=accept;});store.push(structuredClone(args!.entry!));}
    return envelope();
  });
  const {onUse}=setup('C4 G3 C3 G2 C2','Mine');await act(async()=>{});
  fireEvent.click(button('Save as new'));await act(async()=>{});
  fireEvent.click(within(screen.getByRole('group',{name:'Guitar · 6 strings'})).getByRole('button',{name:/^Standard E/}));
  await act(async()=>{release();await new Promise(accept=>setTimeout(accept,0));});
  expect(screen.getByRole('button',{name:/^Mine/})).toHaveAttribute('aria-pressed','false');
  expect(nameBox()).toHaveValue('Standard E');expect(pitchBox()).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.click(button('Use tuning'));expect(onUse).toHaveBeenCalledWith('E4 B3 G3 D3 A2 E2','Standard E');
});

it('keeps a pending save focusable and ignores repeat activation',async()=>{
  let release!:()=>void;
  invoke.mockImplementation(async(command:string,args?:{entry?:SavedTuning})=>{
    if(command==='tuning_library_put'){await new Promise<void>(accept=>{release=accept;});store.push(structuredClone(args!.entry!));}
    return envelope();
  });
  setup('C4 G3 C3 G2 C2','Mine');await act(async()=>{});
  const save=button('Save as new');save.focus();fireEvent.click(save);await act(async()=>{});
  expect(save).not.toBeDisabled();expect(save).toHaveAttribute('aria-disabled','true');expect(document.activeElement).toBe(save);
  fireEvent.click(save);await act(async()=>{});expect(putCalls()).toHaveLength(1);
  await act(async()=>{release();await new Promise(accept=>setTimeout(accept,0));});
  expect(save).not.toHaveAttribute('aria-disabled');
});

it('keeps a failed read visible after a row is selected and blocks saving over it',async()=>{
  invoke.mockRejectedValueOnce(new Error('Invalid tuning library: bad'));
  setup();await act(async()=>{});
  expect(screen.getByRole('alert')).toHaveTextContent('Could not read saved tunings');
  fireEvent.click(within(screen.getByRole('group',{name:'Guitar · 6 strings'})).getByRole('button',{name:/^Drop D/}));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not read saved tunings');expect(screen.getByText('Personal tunings are unavailable.')).toBeInTheDocument();
  expect(button('Save as new')).toBeDisabled();
});
