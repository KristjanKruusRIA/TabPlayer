// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { MidiChord,MidiInBridge,MidiInStatus,MidiInStatusEvent } from '../audio/midi-in';
import { setLanguagePreference } from '../i18n';
import { MidiCapturePanel } from './MidiCapturePanel';
import { DEFAULT_MIDI_CAPTURE,MIDI_CAPTURE_KEY,activeStringMapping,readMidiCapturePreferences } from './midi-capture-preferences';
import { midiCaptureSession } from './midi-capture-session';

afterEach(()=>{cleanup();setLanguagePreference('en');vi.restoreAllMocks();localStorage.clear();});
const idle:MidiInStatus={session:0,state:'stopped',port:'',message:'',chords:0,dropped:0,belowFloor:0};
function fake(){
  const bridge:MidiInBridge={
    ports:vi.fn(async()=>[{id:'0',name:'USB MIDI'}]),start:vi.fn(async()=>7),configure:vi.fn(async()=>{}),stop:vi.fn(async()=>{}),
    status:vi.fn(async()=>idle),subscribe:vi.fn(async(_onChord:(chord:MidiChord)=>void,_onStatus:(status:MidiInStatusEvent)=>void)=>()=>{}),
  };
  return bridge;
}
function renderOpen(bridge:MidiInBridge){
  const view=render(<MidiCapturePanel bridge={bridge}/>);
  const section=view.container.querySelector('details.midi-capture-panel') as HTMLDetailsElement;section.open=true;fireEvent(section,new Event('toggle'));
  return view;
}
const mapping=()=>screen.getByLabelText('MIDI guitar strings') as HTMLSelectElement;

describe('MidiCapturePanel MIDI guitar mapping',()=>{
  it('offers off, lowest first and highest first, starts on off, and saves the choice',async()=>{
    const bridge=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    expect(mapping().value).toBe('off');
    expect(Array.from(mapping().options).map(option=>[option.value,option.textContent])).toEqual([
      ['off','Off (keyboard)'],['lowestFirst','Channel 1 is the bottom tab line'],['highestFirst','Channel 1 is the top tab line'],
    ]);
    expect(localStorage.getItem(MIDI_CAPTURE_KEY)).toBeNull();
    fireEvent.change(mapping(),{target:{value:'highestFirst'}});
    expect(readMidiCapturePreferences().stringMapping).toBe('highestFirst');
    expect(mapping().value).toBe('highestFirst');
  });
  it('shows a stored mapping, and repairs a stored value that is not one of the three',async()=>{
    localStorage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({...DEFAULT_MIDI_CAPTURE,stringMapping:'lowestFirst'}));
    const first=renderOpen(fake());
    expect(mapping().value).toBe('lowestFirst');
    first.unmount();
    localStorage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({...DEFAULT_MIDI_CAPTURE,stringMapping:{evil:true}}));
    renderOpen(fake());
    expect(mapping().value).toBe('off');
  });
  it('can be changed while the input runs, without disabling the control, and without touching the native side',async()=>{
    const bridge=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(screen.getByLabelText('Input'),{target:{value:'USB MIDI'}});
    fireEvent.click(screen.getByRole('button',{name:'Start MIDI input'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop MIDI input'})).toBeInTheDocument());
    mapping().focus();
    fireEvent.change(mapping(),{target:{value:'lowestFirst'}});
    expect(mapping()).not.toBeDisabled();expect(document.activeElement).toBe(mapping());
    expect(readMidiCapturePreferences().stringMapping).toBe('lowestFirst');
    expect(bridge.configure).not.toHaveBeenCalled();
  });
  it('resets the window, the floor and the mapping to their defaults, and tells a running session',async()=>{
    const bridge=fake();
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(screen.getByLabelText('Input'),{target:{value:'USB MIDI'}});
    fireEvent.change(screen.getByLabelText('Chord window'),{target:{value:'200'}});
    fireEvent.change(screen.getByLabelText('Velocity floor'),{target:{value:'50'}});
    fireEvent.change(mapping(),{target:{value:'lowestFirst'}});
    fireEvent.click(screen.getByRole('button',{name:'Start MIDI input'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop MIDI input'})).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:'Reset to defaults'}));
    expect(readMidiCapturePreferences()).toEqual({...DEFAULT_MIDI_CAPTURE,port:'USB MIDI'});
    expect(mapping().value).toBe('off');
    expect(bridge.configure).toHaveBeenLastCalledWith(7,{chordWindowMs:60,minVelocity:1});
  });
  it('is available in Estonian and German with their own words',async()=>{
    for(const [language,label,reset] of [['et','MIDI-kitarri keeled','Lähtesta vaikeväärtused'],['de','MIDI-Gitarrensaiten','Auf Standard zurücksetzen']] as const){
      setLanguagePreference(language);
      const view=renderOpen(fake());
      expect(screen.getByLabelText(label)).toBeInTheDocument();
      expect(screen.getByRole('button',{name:reset})).toBeInTheDocument();
      view.unmount();
    }
  });
  it('is held in the View menu section marked to keep the menu open',async()=>{
    const view=renderOpen(fake());
    expect(view.container.querySelector('details.midi-capture-panel[data-menu-keep]')?.contains(mapping())).toBe(true);
    await act(async()=>{});
  });
});

describe('MidiCapturePanel string count and counts',()=>{
  const warning=(text:RegExp)=>screen.queryByText(text);
  it('warns while the mapping is on and the selected track does not have six strings, saying where channels land',async()=>{
    const bridge=fake();
    localStorage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({...DEFAULT_MIDI_CAPTURE,stringMapping:'lowestFirst'}));
    renderOpen(bridge);
    const session=midiCaptureSession(bridge);
    act(()=>session.setTrackStrings(7));
    expect(warning(/^This track has 7 strings, not 6\. Channels 1 to 6 are written on strings 2 to 7, counted from the bottom tab line/)).toBeInTheDocument();
    act(()=>session.setTrackStrings(4));
    expect(warning(/^This track has 4 strings, not 6\. Channels 1 to 4 are written on strings 1 to 4/)).toBeInTheDocument();
    fireEvent.change(mapping(),{target:{value:'highestFirst'}});
    expect(warning(/^This track has 4 strings, not 6\. Channels 1 to 4 are written on strings 4 to 1/)).toBeInTheDocument();
    act(()=>session.setTrackStrings(8));
    expect(warning(/Channels 1 to 6 are written on strings 8 to 3/)).toBeInTheDocument();
    act(()=>session.setTrackStrings(6));
    expect(warning(/This track has/)).toBeNull();
    act(()=>session.setTrackStrings(null));
    expect(warning(/This track has/)).toBeNull();
    act(()=>session.setTrackStrings(5));
    fireEvent.change(mapping(),{target:{value:'off'}});
    expect(warning(/This track has/)).toBeNull();
  });
  it('says in Estonian and German how many strings the track has',async()=>{
    for(const [language,pattern] of [['et',/^Sellel rajal on 7 keelt, mitte 6\./],['de',/^Diese Spur hat 7 Saiten, nicht 6\./]] as const){
      setLanguagePreference(language);
      localStorage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({...DEFAULT_MIDI_CAPTURE,stringMapping:'lowestFirst'}));
      const bridge=fake(),view=renderOpen(bridge);
      act(()=>midiCaptureSession(bridge).setTrackStrings(7));
      expect(screen.getByText(pattern)).toBeInTheDocument();
      view.unmount();
    }
  });
  it('counts notes written on another string and notes not written again, each with its own plural, and clears them at the next start',async()=>{
    const bridge=fake(),session=midiCaptureSession(bridge);
    renderOpen(bridge);
    await screen.findByRole('option',{name:'USB MIDI'});
    fireEvent.change(screen.getByLabelText('Input'),{target:{value:'USB MIDI'}});
    fireEvent.click(screen.getByRole('button',{name:'Start MIDI input'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop MIDI input'})).toBeInTheDocument());
    expect(screen.queryByText(/written on another string/)).toBeNull();
    act(()=>{session.countRelocated();session.countSkipped(2);});
    expect(screen.getByText('1 note was written on another string, because its channel has no string on this track.')).toBeInTheDocument();
    expect(screen.getByText('2 notes were not written again: their pitches were already there.')).toBeInTheDocument();
    act(()=>{session.countRelocated(2);session.countSkipped(-1);});
    expect(screen.getByText('3 notes were written on another string, because their channels have no string on this track.')).toBeInTheDocument();
    // Only the fixed lines are live; the numbers change with every chord and are not announced.
    expect(screen.getByText('3 notes were written on another string, because their channels have no string on this track.').closest('[aria-live]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Stop MIDI input'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Start MIDI input'})).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:'Start MIDI input'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop MIDI input'})).toBeInTheDocument());
    expect(screen.queryByText(/written on another string/)).toBeNull();
  });
  it('keeps the chosen mapping for the session when storage refuses to save it',async()=>{
    renderOpen(fake());
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
    fireEvent.change(mapping(),{target:{value:'highestFirst'}});
    expect(mapping().value).toBe('highestFirst');
    // The chord path reads the same value the select shows, not the stale stored one.
    expect(activeStringMapping()).toBe('highestFirst');
    vi.restoreAllMocks();
    fireEvent.change(mapping(),{target:{value:'off'}});
    expect(activeStringMapping()).toBe('off');
    expect(readMidiCapturePreferences().stringMapping).toBe('off');
  });
});
