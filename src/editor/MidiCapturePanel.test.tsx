// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { MidiChord,MidiInBridge,MidiInStatus,MidiInStatusEvent } from '../audio/midi-in';
import { setLanguagePreference } from '../i18n';
import { MidiCapturePanel } from './MidiCapturePanel';
import { MIDI_CAPTURE_KEY,readMidiCapturePreferences } from './midi-capture-preferences';

afterEach(()=>{cleanup();setLanguagePreference('en');localStorage.clear();});
const idle:MidiInStatus={session:0,state:'stopped',port:'',message:'',chords:0,dropped:0,belowFloor:0};
function fake(over:Partial<MidiInBridge>={}){
  const handlers={chord:(_chord:MidiChord)=>{},status:(_status:MidiInStatusEvent)=>{}};
  const order:string[]=[];
  const bridge:MidiInBridge={
    ports:vi.fn(async()=>[{id:'0',name:'USB MIDI'},{id:'1',name:'Other keys'}]),
    start:vi.fn(async()=>{order.push('start');return 7;}),
    configure:vi.fn(async()=>{}),
    stop:vi.fn(async()=>{}),
    status:vi.fn(async()=>idle),
    subscribe:vi.fn(async(onChord,onStatus)=>{order.push('subscribe');handlers.chord=onChord;handlers.status=onStatus;return ()=>{};}),
    ...over,
  };
  return {bridge,handlers,order};
}
const openSection=(container:HTMLElement)=>{const section=container.querySelector('details.midi-capture-panel') as HTMLDetailsElement;section.open=true;fireEvent(section,new Event('toggle'));};
function renderOpen(bridge:MidiInBridge){const view=render(<MidiCapturePanel bridge={bridge}/>);openSection(view.container);return view;}
const input=()=>screen.getByLabelText('Input') as HTMLSelectElement;
const action=()=>screen.getByRole('button',{name:/Start MIDI input|Stop MIDI input/});
const chord=(seq:number,notes:[number,number,number][],session=7):MidiChord=>({session,seq,atMs:seq*100,dropped:0,notes:notes.map(([key,velocity,channel])=>({key,velocity,channel}))});

describe('MidiCapturePanel',()=>{
  it('lists the inputs and opens none: nothing starts at launch, even with a remembered input',async()=>{
    localStorage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({port:'USB MIDI',chordWindowMs:60,minVelocity:1,stringMapping:'off'}));
    const {bridge}=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'Other keys'});
    expect(input().value).toBe('USB MIDI');
    expect(bridge.start).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing is opened until you press Start/)).toBeInTheDocument();
    expect(action()).toHaveTextContent('Start MIDI input');
  });

  it('keeps Start unavailable, without disabling it, until an input is chosen',async()=>{
    const {bridge}=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    expect(action()).toHaveAttribute('aria-disabled','true');expect(action()).not.toBeDisabled();
    fireEvent.click(action());expect(bridge.start).not.toHaveBeenCalled();
    fireEvent.change(input(),{target:{value:'Other keys'}});
    expect(action()).not.toHaveAttribute('aria-disabled');
    expect(readMidiCapturePreferences().port).toBe('Other keys');
  });

  it('attaches its listeners, starts with the chosen input and settings, and shows the chords that arrive',async()=>{
    const {bridge,handlers,order}=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(input(),{target:{value:'USB MIDI'}});
    fireEvent.change(screen.getByLabelText('Chord window'),{target:{value:'80'}});
    fireEvent.change(screen.getByLabelText('Velocity floor'),{target:{value:'20'}});
    fireEvent.click(action());
    await waitFor(()=>expect(action()).toHaveTextContent('Stop MIDI input'));
    expect(order.indexOf('subscribe')).toBeLessThan(order.indexOf('start'));
    expect(bridge.start).toHaveBeenCalledWith('USB MIDI',{chordWindowMs:80,minVelocity:20});
    expect(screen.getByText('Listening to USB MIDI.')).toHaveAttribute('role','status');
    expect(screen.getByText('No chord played yet.')).toBeInTheDocument();
    act(()=>handlers.chord(chord(1,[[60,100,0],[64,90,0],[67,80,2]])));
    expect(screen.getByText('Last chord: C4 E4 G4. Velocity 100, 90, 80. Channel 1, 3.')).toBeInTheDocument();
    // A chord of an old session changes nothing.
    act(()=>handlers.chord(chord(2,[[72,100,0]],6)));
    expect(screen.getByText(/Last chord: C4 E4 G4/)).toBeInTheDocument();
    fireEvent.click(action());
    await waitFor(()=>expect(bridge.stop).toHaveBeenCalledWith(7));
    await waitFor(()=>expect(action()).toHaveTextContent('Start MIDI input'));
  });

  it('keeps focus on a control that is busy, never disabling it',async()=>{
    let finish:(n:number)=>void=()=>{};
    const {bridge}=fake({start:vi.fn(()=>new Promise<number>(resolve=>{finish=resolve;}))});
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(input(),{target:{value:'USB MIDI'}});
    action().focus();fireEvent.click(action());
    await waitFor(()=>expect(action()).toHaveAttribute('aria-disabled','true'));
    expect(action()).not.toBeDisabled();expect(document.activeElement).toBe(action());
    expect(input()).not.toBeDisabled();expect(input()).toHaveAttribute('aria-disabled','true');
    fireEvent.click(action());expect(bridge.start).toHaveBeenCalledTimes(1);
    await act(async()=>{finish(7);});
    await waitFor(()=>expect(action()).toHaveTextContent('Stop MIDI input'));
    expect(document.activeElement).toBe(action());
  });

  it('saves a changed window and floor, and tells a running session about them',async()=>{
    const {bridge}=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(screen.getByLabelText('Chord window'),{target:{value:'120'}});
    expect(bridge.configure).not.toHaveBeenCalled();
    expect(readMidiCapturePreferences()).toMatchObject({chordWindowMs:120,minVelocity:1});
    fireEvent.change(input(),{target:{value:'USB MIDI'}});fireEvent.click(action());
    await waitFor(()=>expect(action()).toHaveTextContent('Stop MIDI input'));
    fireEvent.change(screen.getByLabelText('Velocity floor'),{target:{value:'40'}});
    expect(bridge.configure).toHaveBeenLastCalledWith(7,{chordWindowMs:120,minVelocity:40});
    expect(screen.getByLabelText('Chord window')).toHaveAttribute('aria-valuetext','120 ms');
  });

  it('says so when the device is lost or the input will not open, and lets the player start again',async()=>{
    const {bridge,handlers}=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(input(),{target:{value:'USB MIDI'}});fireEvent.click(action());
    await waitFor(()=>expect(action()).toHaveTextContent('Stop MIDI input'));
    act(()=>handlers.status({seq:20,session:7,state:'lost',port:'USB MIDI',message:'The MIDI input "USB MIDI" was disconnected.'}));
    expect(screen.getByText(/USB MIDI was disconnected/)).toHaveAttribute('role','status');
    expect(action()).toHaveTextContent('Start MIDI input');
    (bridge.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Access denied'));
    fireEvent.click(action());
    expect(await screen.findByText('The MIDI input could not start: Access denied')).toBeInTheDocument();
    expect(action()).toHaveTextContent('Start MIDI input');
  });

  it('tells the player when notes were lost to a flood',async()=>{
    const {bridge,handlers}=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(input(),{target:{value:'USB MIDI'}});fireEvent.click(action());
    await waitFor(()=>expect(action()).toHaveTextContent('Stop MIDI input'));
    act(()=>handlers.chord({...chord(1,[[60,100,0]]),dropped:250}));
    expect(screen.getByText(/250 notes were lost/)).toBeInTheDocument();
  });

  it('keeps a saved input that is not connected selectable and says so, and refreshes the list on request',async()=>{
    localStorage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({port:'Studio keys',chordWindowMs:60,minVelocity:1,stringMapping:'off'}));
    const {bridge}=fake();
    renderOpen(bridge);
    expect(await screen.findByRole('option',{name:'Studio keys (not connected)'})).toBeInTheDocument();
    expect(input().value).toBe('Studio keys');
    fireEvent.click(screen.getByRole('button',{name:'Refresh MIDI ports'}));
    await waitFor(()=>expect(bridge.ports).toHaveBeenCalledTimes(2));
  });

  it('shows the port list error instead of an empty list',async()=>{
    const {bridge}=fake({ports:vi.fn(async()=>{throw new Error('No MIDI service');})});
    renderOpen(bridge);
    // A listing that fails in the background is a quiet note, not an alert.
    expect(await screen.findByText('MIDI ports could not be listed: No MIDI service')).toHaveAttribute('role','status');
    expect(screen.queryByRole('alert')).toBeNull();
    // The same failure after the player pressed Refresh is an alert.
    fireEvent.click(screen.getByRole('button',{name:'Refresh MIDI ports'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('MIDI ports could not be listed: No MIDI service');
  });

  it('lists the ports only when the MIDI input section itself is opened, not at launch or with the menu around it',async()=>{
    const {bridge}=fake();
    const {container}=render(<details open><summary>View</summary><MidiCapturePanel bridge={bridge}/></details>);
    await waitFor(()=>expect(bridge.subscribe).toHaveBeenCalled());
    expect(bridge.ports).not.toHaveBeenCalled();
    openSection(container);
    await screen.findByRole('option',{name:'USB MIDI'});
    expect(bridge.ports).toHaveBeenCalledTimes(1);
    const section=container.querySelector('details.midi-capture-panel') as HTMLDetailsElement;
    section.open=false;fireEvent(section,new Event('toggle'));openSection(container);
    expect(bridge.ports).toHaveBeenCalledTimes(1);
  });

  it('says in the player\'s language that a start is waiting for the system, or needs a restart',async()=>{
    const {bridge}=fake({start:vi.fn(async()=>{throw new Error('open_pending: The MIDI input "USB MIDI" is still being opened by the system. Wait a moment, then press Start again.');})});
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(input(),{target:{value:'USB MIDI'}});fireEvent.click(action());
    expect(await screen.findByText('USB MIDI is still being opened by the system. Wait a moment, then press Start again.')).toBeInTheDocument();
    (bridge.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('open_stuck: The MIDI input "USB MIDI" has not answered the system for over 30 seconds. Restart TabPlayer to use it again.'));
    fireEvent.click(action());
    expect(await screen.findByText('USB MIDI has not answered the system for over 30 seconds. Restart TabPlayer to use it again.')).toBeInTheDocument();
    (bridge.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('open_busy_stuck: Several MIDI inputs have not answered the system for over 30 seconds. Restart TabPlayer to use MIDI input again.'));
    fireEvent.click(action());
    expect(await screen.findByText('Several MIDI inputs have not answered the system for over 30 seconds. Restart TabPlayer to use MIDI input again.')).toBeInTheDocument();
    setLanguagePreference('de');
    expect(await screen.findByText(/Mehrere MIDI-Eingänge haben das System länger als 30 Sekunden nicht beantwortet/)).toBeInTheDocument();
  });

  it('says quietly, without an alert, that the native side cannot be reached, as in a plain browser',async()=>{
    const {bridge}=fake({subscribe:vi.fn(async()=>{throw new Error('no native side');}),ports:vi.fn(async()=>{throw new Error('no native side');})});
    renderOpen(bridge);
    expect(await screen.findByText('MIDI input is not available: no native side')).toHaveAttribute('role','status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('shows a session the native side kept running across a reload, so it can be stopped',async()=>{
    const {bridge}=fake({status:vi.fn(async()=>({...idle,session:4,state:'running' as const,port:'USB MIDI'}))});
    renderOpen(bridge);
    await waitFor(()=>expect(action()).toHaveTextContent('Stop MIDI input'));
    fireEvent.click(action());await waitFor(()=>expect(bridge.stop).toHaveBeenCalledWith(4));
  });

  it('is available in Estonian and German with the terms of the MIDI output panel',async()=>{
    for(const [language,refresh,start] of [['et','Värskenda MIDI-porte','Alusta MIDI-sisendit'],['de','MIDI-Ports aktualisieren','MIDI-Eingang starten']] as const){
      setLanguagePreference(language);
      const {bridge}=fake();
      const view=renderOpen(bridge);
      await screen.findByRole('button',{name:refresh});
      expect(screen.getByRole('button',{name:start})).toBeInTheDocument();
      view.unmount();
    }
  });
});
