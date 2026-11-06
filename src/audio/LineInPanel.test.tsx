// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { LineInPanel,useLineInRunning } from './LineInPanel';
import type { LineInBridge,LineInSettings,LineInStatus } from './line-in';
import { DEFAULT_LINE_IN,readLineInPreferences,soundForChoice,type LineInPreferences } from './line-in-preferences';
import { createLineInSession,type LineInSession } from './line-in-session';
import { soundPreset } from './sound-model';

const sessions:LineInSession[]=[];
afterEach(()=>{cleanup();for(const session of sessions.splice(0))session.dispose();});
const playing:LineInStatus={running:true,error:null,inputLevel:-24,latencyMs:14.6,inputRate:48000,outputRate:48000};
const idle:LineInStatus={...playing,running:false,latencyMs:null};
function fakeBridge(status:()=>LineInStatus=()=>playing){
  let session=0,started=false;
  const bridge={
    inputs:vi.fn(async()=>[{id:'mic',name:'Microphone',default:true},{id:'usb',name:'USB interface',default:false}]),
    start:vi.fn(async(_id:string|null)=>{started=true;return ++session;}),
    stop:vi.fn(async(_session:number|null)=>{started=false;}),
    set:vi.fn(async(_settings:LineInSettings)=>{}),
    // Before any start the native side is idle, as at app launch.
    status:vi.fn(async()=>started?status():idle),
  } satisfies LineInBridge;
  return bridge;
}
function sessionFor(bridge:LineInBridge){const session=createLineInSession(bridge,10);sessions.push(session);return session;}
function memory(initial:LineInPreferences=structuredClone(DEFAULT_LINE_IN)){
  let value=initial;
  return {read:vi.fn(()=>structuredClone(value)),save:vi.fn((next:LineInPreferences)=>{value=structuredClone(next);}),current:()=>value};
}

describe('Line-In preferences',()=>{
  it('reads what was saved and falls back for anything damaged',()=>{
    const store=new Map<string,string>(),storage={getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>{store.set(key,value);}};
    expect(readLineInPreferences(storage)).toEqual(DEFAULT_LINE_IN);
    store.set('tabplayer.lineIn',JSON.stringify({choice:'preset:lead',sound:soundPreset('lead'),level:7,inputId:'usb'}));
    expect(readLineInPreferences(storage)).toMatchObject({choice:'preset:lead',level:1,inputId:'usb',sound:{presetId:'lead'}});
    store.set('tabplayer.lineIn','{not json');
    expect(readLineInPreferences(storage)).toEqual(DEFAULT_LINE_IN);
    expect(soundForChoice('preset:nope')).toBeNull();expect(soundForChoice('saved:gone')).toBeNull();
  });
});

describe('Line-In session',()=>{
  it('sends only the newest of several quick changes, never an older one after a newer one',async()=>{
    const bridge=fakeBridge(),session=sessionFor(bridge);let release!:()=>void;
    bridge.set.mockImplementationOnce(()=>new Promise<void>(done=>{release=done;}));
    const at=(level:number):LineInSettings=>({sound:soundPreset('clean'),level,monitor:true});
    const first=session.update(at(0.1));void session.update(at(0.2));const last=session.update(at(0.3));
    release();await Promise.all([first,last]);
    expect(bridge.set.mock.calls.map(([settings])=>settings.level)).toEqual([0.1,0.3]);
  });

  it('picks up monitoring that is still running natively, so it can be stopped',async()=>{
    const bridge=fakeBridge();bridge.status.mockResolvedValue(playing);
    const session=sessionFor(bridge);
    await waitFor(()=>expect(session.get().running).toBe(true));
    await session.stop();expect(bridge.stop).toHaveBeenCalledWith(null);expect(session.get().running).toBe(false);
  });

  it('ends a start that a stop overtook',async()=>{
    const bridge=fakeBridge(),session=sessionFor(bridge);let finish!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>(done=>{finish=()=>done(5);}));
    const starting=session.start('',{sound:soundPreset('clean'),level:0.5,monitor:true});
    await waitFor(()=>expect(bridge.start).toHaveBeenCalled());
    await session.stop();finish();await starting;
    expect(bridge.stop).toHaveBeenLastCalledWith(5);expect(session.get().running).toBe(false);
  });

  it('shows no error when Stop ends a start, as the native side then refuses it',async()=>{
    const bridge=fakeBridge(),session=sessionFor(bridge);let refuse!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>((_done,reject)=>{refuse=()=>reject(new Error('Line-In was stopped.'));}));
    const starting=session.start('',{sound:soundPreset('clean'),level:0.5,monitor:true});
    await waitFor(()=>expect(bridge.start).toHaveBeenCalled());
    await session.stop();refuse();await starting;
    expect(session.get()).toMatchObject({running:false,pending:false,problem:null});
  });

  it('keeps a Stop pressed while moving to another input is still closing the old one',async()=>{
    const bridge=fakeBridge(),session=sessionFor(bridge);const settings:LineInSettings={sound:soundPreset('clean'),level:0.5,monitor:true};
    await session.start('mic',settings);expect(session.get().running).toBe(true);
    let closed!:()=>void;bridge.stop.mockImplementationOnce(()=>new Promise<void>(done=>{closed=done;}));
    const moving=session.start('usb',settings);await waitFor(()=>expect(bridge.stop).toHaveBeenCalledTimes(1));
    const stopping=session.stop();closed();await Promise.all([moving,stopping]);
    expect(bridge.start).toHaveBeenCalledTimes(1);expect(session.get()).toMatchObject({running:false,pending:false,problem:null});
  });
  it('keeps a newer change when an older one fails',async()=>{
    const bridge=fakeBridge(),session=sessionFor(bridge);let fail!:(error:Error)=>void;
    bridge.set.mockImplementationOnce(()=>new Promise<void>((_done,reject)=>{fail=reject;}));
    const at=(level:number):LineInSettings=>({sound:soundPreset('clean'),level,monitor:true});
    const first=session.update(at(0.1));void session.update(at(0.4));
    fail(new Error('Queue full.'));await first;
    await waitFor(()=>expect(bridge.set).toHaveBeenLastCalledWith(at(0.4)));
    await waitFor(()=>expect(session.get().problem).toBeNull());
  });

  it('applies an input chosen while a start is on its way',async()=>{
    const bridge=fakeBridge(),session=sessionFor(bridge);let finish!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>(done=>{finish=()=>done(1);}));
    const settings:LineInSettings={sound:soundPreset('clean'),level:0.5,monitor:true};
    const starting=session.start('mic',settings);await waitFor(()=>expect(bridge.start).toHaveBeenCalledWith('mic'));
    void session.start('usb',settings);finish();await starting;
    await waitFor(()=>expect(bridge.start).toHaveBeenLastCalledWith('usb'));
    expect(bridge.stop).toHaveBeenCalledWith(1);expect(session.get().running).toBe(true);
  });
});

describe('LineInPanel',()=>{
  it('sends the sound and level before monitoring starts, and shows the level and latency',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(),session=sessionFor(bridge),prefs=memory();
    render(<LineInPanel bridge={bridge} session={session} preferences={prefs}/>);
    await user.click(screen.getByText('Line-In'));
    await waitFor(()=>expect(screen.getByRole('option',{name:'USB interface'})).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Input'),'usb');
    bridge.set.mockClear();
    await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(bridge.start).toHaveBeenCalledWith('usb'));
    expect(bridge.set).toHaveBeenCalledWith({sound:DEFAULT_LINE_IN.sound,level:0.8,monitor:true});
    expect(bridge.set.mock.invocationCallOrder[0]).toBeLessThan(bridge.start.mock.invocationCallOrder[0]);
    await waitFor(()=>expect(screen.getByText('Latency about 15 ms')).toBeInTheDocument());
    const meter=screen.getByRole('meter',{name:'Input level'});
    expect(meter).toHaveAttribute('value','-24');expect(meter).toHaveAttribute('aria-valuetext','-24 dBFS');
    expect(prefs.current().inputId).toBe('usb');
  });

  it('moves running monitoring to a newly chosen input',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(),session=sessionFor(bridge);
    render(<LineInPanel bridge={bridge} session={session} preferences={memory()}/>);
    await user.click(screen.getByText('Line-In'));await waitFor(()=>expect(screen.getByRole('option',{name:'USB interface'})).toBeInTheDocument());
    await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop monitoring'})).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Input'),'usb');
    await waitFor(()=>expect(bridge.start).toHaveBeenLastCalledWith('usb'));
    expect(bridge.stop).toHaveBeenCalledWith(1);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop monitoring'})).toBeInTheDocument());
  });

  it('changes the sound and level live, remembers them, and keeps changes made during a start',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(),session=sessionFor(bridge),prefs=memory();let finish!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>(done=>{finish=()=>done(1);}));
    render(<LineInPanel bridge={bridge} session={session} preferences={prefs}/>);
    await user.click(screen.getByText('Line-In'));await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(bridge.start).toHaveBeenCalled());
    // A change while the start is still on its way is sent, not lost.
    fireEvent.change(screen.getByLabelText('Level'),{target:{value:'0.6'}});
    await waitFor(()=>expect(bridge.set).toHaveBeenLastCalledWith(expect.objectContaining({level:0.6})));
    await act(async()=>{finish();});
    await user.selectOptions(screen.getByLabelText('Sound'),'preset:lead');
    await waitFor(()=>expect(bridge.set).toHaveBeenLastCalledWith(expect.objectContaining({sound:expect.objectContaining({presetId:'lead'}),level:0.6})));
    expect(prefs.current()).toMatchObject({choice:'preset:lead',level:0.6});
  });

  it('lets Stop end a start that is still waiting on the device',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(),session=sessionFor(bridge);let finish!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>(done=>{finish=()=>done(3);}));
    render(<LineInPanel bridge={bridge} session={session} preferences={memory()}/>);
    await user.click(screen.getByText('Line-In'));await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(bridge.start).toHaveBeenCalled());
    await user.click(screen.getByRole('button',{name:'Stop monitoring'}));
    await act(async()=>{finish();});
    await waitFor(()=>expect(bridge.stop).toHaveBeenLastCalledWith(3));
    expect(screen.getByRole('button',{name:'Start monitoring'})).toBeInTheDocument();
  });

  it('keeps the remembered sound when its source is gone',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(),session=sessionFor(bridge);
    render(<LineInPanel bridge={bridge} session={session} preferences={memory({choice:'saved:Deleted',sound:soundPreset('crunch'),level:0.5,inputId:''})}/>);
    await user.click(screen.getByText('Line-In'));
    expect(screen.getByLabelText('Sound')).toHaveDisplayValue('Last used sound');
    await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(bridge.set).toHaveBeenCalledWith(expect.objectContaining({sound:expect.objectContaining({presetId:'crunch'}),level:0.5})));
  });

  it('reports a failed start, a refused sound and a device that stops',async()=>{
    const user=userEvent.setup();let running=true;
    const bridge=fakeBridge(()=>({...playing,running,error:running?null:'The input device was disconnected.'})),session=sessionFor(bridge);
    bridge.start.mockRejectedValueOnce(new Error('No input device.'));
    render(<LineInPanel bridge={bridge} session={session} preferences={memory()}/>);
    await user.click(screen.getByText('Line-In'));await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Line-In could not start: No input device.'));
    await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop monitoring'})).toBeInTheDocument());
    bridge.set.mockRejectedValueOnce(new Error('Unknown preset.'));
    await user.selectOptions(screen.getByLabelText('Sound'),'preset:lead');
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('The Line-In sound could not be changed: Unknown preset.'));
    await act(async()=>{running=false;});
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Line-In stopped: The input device was disconnected.'));
    expect(screen.getByRole('button',{name:'Start monitoring'})).toBeInTheDocument();
  });

  it('keeps monitoring when the panel goes away, as when another document opens, and shows it is on',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(),session=sessionFor(bridge);
    function Badge(){return <span data-testid="badge">{useLineInRunning(session)?'on':'off'}</span>;}
    const {unmount}=render(<><Badge/><LineInPanel bridge={bridge} session={session} preferences={memory()}/></>);
    expect(screen.getByTestId('badge')).toHaveTextContent('off');
    await user.click(screen.getByText('Line-In'));await user.click(screen.getByRole('button',{name:'Start monitoring'}));
    await waitFor(()=>expect(screen.getByTestId('badge')).toHaveTextContent('on'));
    // Collapsing the section and unmounting the panel (a document switch remounts the editor) keep it going.
    await user.click(screen.getByText('Line-In'));unmount();
    await new Promise(done=>setTimeout(done,40));
    expect(bridge.stop).not.toHaveBeenCalled();expect(session.get().running).toBe(true);
    render(<LineInPanel bridge={bridge} session={session} preferences={memory()}/>);
    expect(screen.getByRole('button',{name:'Stop monitoring'})).toBeInTheDocument();
  });
});
