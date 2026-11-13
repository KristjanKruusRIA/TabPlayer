// @vitest-environment jsdom
import {useCallback,useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type {BackingSettings} from '../edit-types';
import {BackingPanel} from './BackingPanel';
import type {BackingTimeline} from './backing-waveform-types';
import {referenceSyncTiming} from './reference-sync';
import {useReferenceSyncEdit} from './useReferenceSyncEdit';

afterEach(cleanup);
const owner={documentId:'doc',activationId:'active'},documentRevision={documentId:'doc',revision:1};
const timeline:BackingTimeline={generation:1,durationTick:7680,tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,startTick:0,endTick:3840,startMs:0,endMs:2000,meterNumerator:4,meterDenominator:4},{bar:1,occurrence:0,startTick:3840,endTick:7680,startMs:2000,endMs:4000,meterNumerator:4,meterDenominator:4}]};
const backing:BackingSettings={assetId:'asset',offsetMs:120,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}],referenceSync:{entryAudioMs:1120.25,exitAudioMs:7120.75},mix:{gain:.7,pan:-.2,mute:false,solo:true}};
function setup(patch:{settings?:BackingSettings|null;missing?:boolean;ready?:boolean;busy?:boolean;onCommit?:(settings:BackingSettings)=>Promise<void>}={}) {
  const begin=vi.fn(),release=vi.fn(),onCommit=vi.fn(patch.onCommit??(async()=>{})),onEdit=vi.fn(),onModeChange=vi.fn(async()=>{}),onFromScore=vi.fn(async()=>{}),onWriteScore=vi.fn(async()=>{}),keys=vi.fn();
  function Harness() {
    const [leases,setLeases]=useState(0),[panelVisible,setPanelVisible]=useState(true),settings=patch.missing?undefined:patch.settings===undefined?backing:patch.settings;
    const beginOperation=useCallback(()=>{begin();setLeases(value=>value+1);return()=>{release();setLeases(value=>value-1);};},[]);
    const edit=useReferenceSyncEdit({owner,document:documentRevision,sourceKey:settings?'asset':null,settings:settings??null,timeline,durationMs:10000,visible:{number:true,waveform:true},busy:patch.busy||leases>0,beginOperation,isCurrent:()=>true,onCommit});
    const current=edit.preview??settings,timing=current?.referenceSync?referenceSyncTiming(current,timeline.occurrences,10000):null;
    return <div onKeyDown={keys} onKeyUp={keys}>{panelVisible&&<BackingPanel settings={settings} assets={{}} onEdit={onEdit} stageBacking={async()=>null} stageEmbeddedBacking={async()=>null} beginOperation={beginOperation} durationMs={10000} busy={patch.busy||leases>0} reference={{timing,edit,ready:patch.ready??true,onModeChange,onFromScore,onWriteScore}}/>}<button onClick={()=>edit.begin('entry','waveform')}>Begin waveform edit</button><button onClick={()=>setPanelVisible(false)}>Hide panel</button><output aria-label="Active reference edit">{edit.active?.surface??'none'}</output></div>;
  }
  return {view:render(<Harness/>),begin,release,onCommit,onEdit,onModeChange,onFromScore,onWriteScore,keys};
}
const entry=()=>screen.getByRole('spinbutton',{name:'Entry (ms)'});
const exit=()=>screen.getByRole('spinbutton',{name:'Exit (ms)'});

it('offers explicit timing conversions in the existing panel without starting an edit for disclosure or focus',()=>{
  const p=setup();
  expect(screen.getByRole('combobox',{name:'Timing'})).toHaveValue('reference');
  expect(entry()).toHaveValue('1000.25');expect(exit()).toHaveValue('7000.75');
  expect(entry()).toHaveAccessibleDescription('Enter applies; Escape or blur cancels.');
  fireEvent.focus(entry());fireEvent.click(screen.getByText('From score'));
  expect(p.begin).not.toHaveBeenCalled();expect(p.onEdit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox',{name:'Timing'}),{target:{value:'score'}});
  fireEvent.click(screen.getByRole('button',{name:'Replace sync points'}));fireEvent.click(screen.getByRole('button',{name:'Add sync points'}));
  const write=screen.getByRole('button',{name:'Write score tempos'});expect(write).toHaveAccessibleDescription('Replaces score tempo changes.');fireEvent.click(write);
  expect(p.onModeChange).toHaveBeenCalledWith('score');expect(p.onFromScore.mock.calls).toEqual([['replace'],['add']]);expect(p.onWriteScore).toHaveBeenCalledOnce();expect(p.begin).not.toHaveBeenCalled();
});

it('displays converted endpoint noise compactly without changing persisted precision on unchanged Enter',()=>{
  const settings:BackingSettings={...backing,offsetMs:0,referenceSync:{entryAudioMs:1000.1234567,exitAudioMs:7000.000000000001}},original=structuredClone(settings),p=setup({settings});
  expect(entry()).toHaveValue('1000.1234567');expect(exit()).toHaveValue('7000');
  for(const input of [entry(),exit()]){fireEvent.focus(input);fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input);}
  expect(screen.getByLabelText('Active reference edit')).toHaveTextContent('none');expect(p.begin).not.toHaveBeenCalled();expect(p.release).not.toHaveBeenCalled();expect(p.onCommit).not.toHaveBeenCalled();expect(p.onEdit).not.toHaveBeenCalled();expect(settings).toEqual(original);
});

it('Escape closes From score and returns focus to its summary without editing history',()=>{
  const p=setup(),summary=screen.getByText('From score'),details=summary.closest('details')!;
  fireEvent.click(summary);expect(details).toHaveAttribute('open');const replace=screen.getByRole('button',{name:'Replace sync points'});replace.focus();
  fireEvent.keyDown(replace,{key:'Escape'});fireEvent.keyUp(replace,{key:'Escape'});
  expect(details).not.toHaveAttribute('open');expect(summary).toHaveFocus();expect(p.begin).not.toHaveBeenCalled();expect(p.onFromScore).not.toHaveBeenCalled();expect(p.onEdit).not.toHaveBeenCalled();expect(p.keys).not.toHaveBeenCalled();
});

it.each(['loading','score only','embedded','busy'] as const)('disables persisted timing actions for %s',state=>{
  setup(state==='loading'?{ready:false}:state==='score only'?{settings:null}:state==='embedded'?{missing:true}:{busy:true});
  expect(screen.getByRole('combobox',{name:'Timing'})).toBeDisabled();expect(entry()).toBeDisabled();expect(exit()).toBeDisabled();
  fireEvent.click(screen.getByText('From score'));
  for(const name of ['Replace sync points','Add sync points','Write score tempos'])expect(screen.getByRole('button',{name})).toBeDisabled();
});

it('keeps Audio follows score selectable while legacy endpoints and score writing are unavailable',()=>{
  const p=setup({settings:{...backing,referenceSync:null}});
  expect(screen.getByRole('combobox',{name:'Timing'})).toHaveValue('score');expect(entry()).toBeDisabled();expect(exit()).toBeDisabled();expect(screen.getByRole('button',{name:'Write score tempos'})).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox',{name:'Timing'}),{target:{value:'reference'}});expect(p.onModeChange).toHaveBeenCalledWith('reference');
});

it('preserves fractional source values and applies one offset-aware command on Enter then blur',async()=>{
  let finish!:()=>void;const p=setup({onCommit:()=>new Promise<void>(resolve=>{finish=resolve;})}),input=entry();
  fireEvent.focus(input);expect(p.begin).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'1025.375'}});
  expect(p.begin).toHaveBeenCalledOnce();expect(input).toHaveValue('1025.375');expect(input).toBeEnabled();expect(exit()).toBeDisabled();
  expect(screen.getByLabelText('Backing gain')).toBeDisabled();expect(screen.getByRole('combobox',{name:'Timing'})).toBeDisabled();expect(screen.getByRole('button',{name:'Write score tempos'})).toBeDisabled();
  expect(p.onCommit).not.toHaveBeenCalled();expect(p.onEdit).not.toHaveBeenCalled();
  fireEvent.keyDown(input,{key:'Enter'});fireEvent.keyDown(input,{key:'Enter',repeat:true});fireEvent.blur(input);
  expect(p.onCommit).toHaveBeenCalledOnce();expect(p.onCommit).toHaveBeenCalledWith({...backing,referenceSync:{entryAudioMs:1145.375,exitAudioMs:7120.75}},documentRevision);expect(p.release).not.toHaveBeenCalled();
  await act(async()=>finish());await waitFor(()=>expect(p.release).toHaveBeenCalledOnce());expect(p.onEdit).not.toHaveBeenCalled();
});

it('keeps custom numeric draft precision when applying an endpoint edit',async()=>{
  const p=setup(),input=entry();fireEvent.change(input,{target:{value:'1025.123456789'}});
  expect(input).toHaveValue('1025.123456789');fireEvent.keyDown(input,{key:'Enter'});await waitFor(()=>expect(p.release).toHaveBeenCalledOnce());
  expect(p.onCommit).toHaveBeenCalledOnce();expect(p.onCommit).toHaveBeenCalledWith({...backing,referenceSync:{entryAudioMs:1145.123456789,exitAudioMs:7120.75}},documentRevision);
});

it('collapsing Sync timing cancels a pending number edit and suppresses its later rejection until settlement releases the lease',async()=>{
  let reject!:(reason:Error)=>void;const p=setup({onCommit:()=>new Promise<void>((_resolve,no)=>{reject=no;})}),input=entry();
  fireEvent.change(input,{target:{value:'1100'}});fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input);
  expect(p.onCommit).toHaveBeenCalledOnce();expect(p.release).not.toHaveBeenCalled();fireEvent.click(screen.getByText('Sync timing'));
  await waitFor(()=>expect(screen.getByLabelText('Active reference edit')).toHaveTextContent('none'));expect(p.release).not.toHaveBeenCalled();
  await act(async()=>reject(new Error('Stale hidden edit rejected.')));
  expect(p.release).toHaveBeenCalledOnce();expect(screen.queryByRole('alert',{hidden:true})).not.toBeInTheDocument();expect(p.onCommit).toHaveBeenCalledOnce();
});

it('number arrows preview 1ms and Shift10ms without key-up commit or note shortcuts',async()=>{
  const p=setup(),input=exit();
  fireEvent.keyDown(input,{key:'ArrowUp'});fireEvent.keyUp(input,{key:'ArrowUp'});fireEvent.keyDown(input,{key:'ArrowDown',shiftKey:true});fireEvent.keyUp(input,{key:'ArrowDown'});
  expect(input).toHaveValue('6991.75');expect(p.begin).toHaveBeenCalledOnce();expect(p.onCommit).not.toHaveBeenCalled();expect(p.keys).not.toHaveBeenCalled();
  fireEvent.keyDown(input,{key:'Enter'});await waitFor(()=>expect(p.release).toHaveBeenCalledOnce());
  expect(p.onCommit).toHaveBeenCalledWith({...backing,referenceSync:{entryAudioMs:1120.25,exitAudioMs:7111.75}},documentRevision);
});

it.each(['Escape','blur'] as const)('%s discards the numeric preview without persisting',action=>{
  const p=setup(),input=entry();fireEvent.change(input,{target:{value:'1100'}});
  if(action==='Escape')fireEvent.keyDown(input,{key:action});else fireEvent.blur(input);
  expect(input).toHaveValue('1000.25');expect(p.release).toHaveBeenCalledOnce();expect(p.onCommit).not.toHaveBeenCalled();expect(p.onEdit).not.toHaveBeenCalled();
});

it.each(['','-','1.','1e','Infinity'])('invalid numeric text %j cannot apply the last valid preview',text=>{
  const p=setup(),input=entry();fireEvent.change(input,{target:{value:'1100'}});fireEvent.change(input,{target:{value:text}});
  expect(input).toHaveValue(text);expect(input).toHaveAttribute('aria-invalid','true');fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input);
  expect(input).toHaveValue('1000.25');expect(p.onCommit).not.toHaveBeenCalled();expect(p.release).toHaveBeenCalledOnce();
});

it('disables sidebar numbers while the shared waveform surface owns the endpoint edit',()=>{
  setup();fireEvent.click(screen.getByRole('button',{name:'Begin waveform edit'}));expect(entry()).toBeDisabled();expect(exit()).toBeDisabled();expect(screen.getByLabelText('Backing gain')).toBeDisabled();
});

it.each(['number','waveform'] as const)('panel unmount cancels only its own number edit while %s owns the shared hook',surface=>{
  const p=setup();if(surface==='number')fireEvent.change(entry(),{target:{value:'1100'}});else fireEvent.click(screen.getByRole('button',{name:'Begin waveform edit'}));
  fireEvent.click(screen.getByRole('button',{name:'Hide panel'}));
  expect(screen.getByLabelText('Active reference edit')).toHaveTextContent(surface==='number'?'none':'waveform');expect(p.release).toHaveBeenCalledTimes(surface==='number'?1:0);expect(p.onCommit).not.toHaveBeenCalled();
});

it('shows a rejected numeric commit and restores the committed source value',async()=>{
  const p=setup({onCommit:async()=>{throw new Error('Reference exit exceeds source duration.');}}),input=exit();
  fireEvent.change(input,{target:{value:'8000'}});fireEvent.keyDown(input,{key:'Enter'});
  expect(await screen.findByRole('alert')).toHaveTextContent('Reference exit exceeds source duration.');await waitFor(()=>expect(input).toHaveValue('7000.75'));expect(p.release).toHaveBeenCalledOnce();
});

it('processing draft owns a usable field outside disabled mix ancestors and disables backing siblings',()=>{
 const p=setup();const input=screen.getByRole('spinbutton',{name:'Semitones'});fireEvent.change(input,{target:{value:'2'}});
 expect(input).toBeEnabled();expect(screen.getByRole('spinbutton',{name:'Cents'})).toBeDisabled();expect(screen.getByLabelText('Backing gain')).toBeDisabled();expect(entry()).toBeDisabled();expect(screen.getByRole('button',{name:'Replace backing'})).toBeDisabled();
 fireEvent.keyDown(input,{key:'Escape'});expect(p.release).toHaveBeenCalledOnce();expect(screen.getByLabelText('Backing gain')).toBeEnabled();expect(p.onEdit).not.toHaveBeenCalled();
});
it.each(['score only','embedded'])('does not show committed processing controls for %s',mode=>{setup(mode==='score only'?{settings:null}:{missing:true});expect(screen.queryByText('Pitch & filter')).not.toBeInTheDocument();});

it('an embedded backing, which has no processing controls, still says the practice key shift applies to it',()=>{
  const props={settings:undefined,embedded:new Uint8Array([1]),assets:{},onEdit:()=>{},stageBacking:async()=>null,stageEmbeddedBacking:async()=>null,beginOperation:()=>()=>{}};
  const {rerender}=render(<BackingPanel {...props}/>);
  expect(screen.queryByText(/practice key shift/)).not.toBeInTheDocument();
  rerender(<BackingPanel {...props} keyShift={3}/>);
  const hint=screen.getByText('The practice key shift of +3 applies to this backing track.');
  expect(hint.closest('[role=status],[aria-live]')).toBeNull();
});
