// @vitest-environment jsdom
import { act,cleanup,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { MidiChord,MidiInBridge,MidiInStatusEvent } from '../audio/midi-in';
import { MidiCaptureIndicator } from './MidiCapturePanel';
import { createMidiCaptureSession,midiCaptureSession,useMidiCaptureBadge } from './midi-capture-session';

afterEach(cleanup);
function fake(){
  const handlers={chord:(_chord:MidiChord)=>{},status:(_status:MidiInStatusEvent)=>{}};
  const bridge:MidiInBridge={
    ports:vi.fn(async()=>[]),start:vi.fn(async()=>3),configure:vi.fn(async()=>{}),stop:vi.fn(async()=>{}),
    status:vi.fn(async()=>({session:0,state:'stopped' as const,port:'',message:'',chords:0,dropped:0,belowFloor:0})),
    subscribe:vi.fn(async(onChord,onStatus)=>{handlers.chord=onChord;handlers.status=onStatus;return ()=>{};}),
  };
  return {bridge,handlers};
}
const chord=(seq:number):MidiChord=>({session:3,seq,atMs:seq,dropped:0,notes:[{key:60,velocity:90,channel:0}]});

describe('useMidiCaptureBadge',()=>{
  it('re-renders App-level consumers when the badge changes and not for each chord',async()=>{
    const {bridge,handlers}=fake(),session=createMidiCaptureSession(bridge);
    let renders=0;
    function Consumer(){renders++;return <span data-testid="badge">{useMidiCaptureBadge(session)}</span>;}
    render(<Consumer/>);
    expect(screen.getByTestId('badge')).toHaveTextContent('off');
    await act(async()=>{await session.start('USB MIDI',{chordWindowMs:60,minVelocity:1});});
    expect(screen.getByTestId('badge')).toHaveTextContent('on');
    const before=renders;
    act(()=>{for(let seq=1;seq<=200;seq++)handlers.chord(chord(seq));});
    expect(session.get().chords).toBe(200);
    expect(renders).toBe(before);
    act(()=>handlers.status({seq:1,session:3,state:'lost',port:'USB MIDI',message:''}));
    expect(screen.getByTestId('badge')).toHaveTextContent('lost');
    expect(renders).toBe(before+1);
  });

  it('shows a dot while listening and, when the device is lost, a different dot announced through a live region',async()=>{
    const {bridge,handlers}=fake(),session=midiCaptureSession(bridge);
    const {container}=render(<MidiCaptureIndicator bridge={bridge}/>);
    const live=container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toHaveTextContent('');expect(screen.queryByRole('img')).toBeNull();
    await act(async()=>{await session.start('USB MIDI',{chordWindowMs:60,minVelocity:1});});
    expect(screen.getByRole('img',{name:'MIDI input on'})).not.toHaveClass('is-lost');
    expect(container.querySelector('[aria-live="polite"]')).toBe(live);
    act(()=>handlers.status({seq:1,session:3,state:'lost',port:'USB MIDI',message:''}));
    expect(screen.getByRole('img',{name:'MIDI input lost'})).toHaveClass('is-lost');
    expect(live).toHaveTextContent('MIDI input lost');
    await act(async()=>{await session.stop();});
    expect(screen.queryByRole('img')).toBeNull();expect(live).toHaveTextContent('');
  });
});
