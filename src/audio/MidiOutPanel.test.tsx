// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { ChannelMix,EditCommand } from '../edit-types';
import { MidiOutPanel } from './MidiOutPanel';
import type { MidiOutBridge,MidiOutOwner,MidiOutStatus } from './midi-out';
import { readMidiOutDelay,saveMidiOutDelay } from './midi-out-preferences';

afterEach(()=>{cleanup();localStorage.clear();});
const quiet:MidiOutStatus={ports:[],sent:0,dropped:0,late:0,maxLateMs:0};
function fakeBridge(status:MidiOutStatus=quiet){
  return {
    ports:vi.fn(async(_owner?:MidiOutOwner)=>[{id:'0',name:'Microsoft GS Wavetable Synth'},{id:'1',name:'USB MIDI'}]),
    setDelay:vi.fn(async(_ms:number)=>{}),
    status:vi.fn(async()=>status),
    testLog:vi.fn(async()=>[]),
  } satisfies MidiOutBridge;
}
const mix:ChannelMix={gain:0.7,pan:-0.2,mute:false,solo:false,interpretation:{style:'pick'}};
const output=()=>screen.getByLabelText('Output') as HTMLSelectElement;

describe('MidiOutPanel',()=>{
  it('routes the track to a port as one mix edit that keeps the rest of the mix, and records nothing for the current choice',async()=>{
    const bridge=fakeBridge(),onEdit=vi.fn((_edit:EditCommand)=>{});
    const {rerender}=render(<MidiOutPanel trackId="base/0" mix={mix} onEdit={onEdit} bridge={bridge}/>);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(output(),{target:{value:'USB MIDI'}});
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackMix',trackId:'base/0',mix:{...mix,midiPort:'USB MIDI'}});
    rerender(<MidiOutPanel trackId="base/0" mix={{...mix,midiPort:'USB MIDI'}} onEdit={onEdit} bridge={bridge}/>);
    fireEvent.change(output(),{target:{value:'USB MIDI'}});
    expect(onEdit).toHaveBeenCalledTimes(1);
    // Back to the internal sound drops the port and nothing else.
    fireEvent.change(output(),{target:{value:''}});
    expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackMix',trackId:'base/0',mix});
  });

  it('keeps a saved port that is not connected and says the track plays internally',async()=>{
    render(<MidiOutPanel trackId="base/0" mix={{...mix,midiPort:'Studio synth'}} onEdit={vi.fn()} bridge={fakeBridge()}/>);
    expect(await screen.findByRole('option',{name:'Studio synth (not connected)'})).toBeInTheDocument();
    expect(output().value).toBe('Studio synth');
    expect(screen.getByText(/^Studio synth is not connected/)).toHaveAttribute('role','status');
  });

  it('shows whether the routed track is being sent, has no channel left, or its port failed',async()=>{
    const routed={...mix,midiPort:'USB MIDI'};
    const port=(extra:object)=>({ports:[{name:'USB MIDI',open:true,error:null,tracks:[],overflowTracks:[],...extra}],sent:3,dropped:0,late:0,maxLateMs:0});
    const {unmount}=render(<MidiOutPanel trackId="base/0" mix={routed} onEdit={vi.fn()} bridge={fakeBridge(port({tracks:['base/0']}))} interval={10}/>);
    expect(await screen.findByText('Sent to USB MIDI.')).toHaveAttribute('role','status');unmount();
    const second=render(<MidiOutPanel trackId="base/0" mix={routed} onEdit={vi.fn()} bridge={fakeBridge(port({overflowTracks:['base/0']}))} interval={10}/>);
    expect(await screen.findByText(/no free MIDI channel/)).toHaveAttribute('role','status');second.unmount();
    const third=render(<MidiOutPanel trackId="base/0" mix={routed} onEdit={vi.fn()} bridge={fakeBridge(port({tracks:['base/0'],sharedPercussion:['base/0','base/2']}))} interval={10}/>);
    expect(await screen.findByText(/share one drum kit/)).toHaveAttribute('role','status');third.unmount();
    render(<MidiOutPanel trackId="base/0" mix={routed} onEdit={vi.fn()} bridge={fakeBridge(port({open:false,error:'Access denied'}))} interval={10}/>);
    expect(await screen.findByText(/^USB MIDI cannot be used \(Access denied\)/)).toHaveAttribute('role','status');
  });

  it('lists ports once for every track, and again only on Refresh',async()=>{
    const bridge=fakeBridge();
    const {rerender}=render(<MidiOutPanel key="base/0" trackId="base/0" mix={mix} onEdit={vi.fn()} bridge={bridge}/>);
    await screen.findByRole('option',{name:'USB MIDI'});
    rerender(<MidiOutPanel key="base/1" owner={{documentId:'d',activationId:'a'}} trackId="base/1" mix={mix} onEdit={vi.fn()} bridge={bridge}/>);
    expect(screen.getByRole('option',{name:'USB MIDI'})).toBeInTheDocument();expect(bridge.ports).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'Refresh MIDI ports'}));expect(bridge.ports).toHaveBeenCalledTimes(2);
    expect(bridge.ports).toHaveBeenLastCalledWith({documentId:'d',activationId:'a'});
  });

  it('remembers the delay for every track and sends it',async()=>{
    const bridge=fakeBridge();
    render(<MidiOutPanel trackId="base/0" mix={{...mix,midiPort:'USB MIDI'}} onEdit={vi.fn()} bridge={bridge}/>);
    fireEvent.change(screen.getByRole('slider',{name:/^MIDI delay/}),{target:{value:'40'}});
    expect(bridge.setDelay).toHaveBeenLastCalledWith(40);expect(readMidiOutDelay()).toBe(40);
    expect(screen.getByRole('slider',{name:/^MIDI delay/})).toHaveAttribute('aria-valuetext','40 ms');
  });

  it('reads damaged or out-of-range delays safely',()=>{
    saveMidiOutDelay(9999);expect(readMidiOutDelay()).toBe(500);
    localStorage.setItem('tabplayer.midiOutDelay','nonsense');expect(readMidiOutDelay()).toBe(0);
  });

  it('reports a port list that cannot be read, and ignores choices while busy',async()=>{
    const bridge=fakeBridge();bridge.ports.mockRejectedValueOnce(new Error('No MIDI service'));
    const onEdit=vi.fn();
    render(<MidiOutPanel trackId="base/0" mix={mix} onEdit={onEdit} bridge={bridge} busy/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('MIDI ports could not be listed: No MIDI service');
    expect(output()).not.toBeDisabled();expect(output()).toHaveAttribute('aria-disabled','true');
    fireEvent.change(output(),{target:{value:'USB MIDI'}});expect(onEdit).not.toHaveBeenCalled();
  });
});
