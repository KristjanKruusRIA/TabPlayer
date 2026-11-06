// @vitest-environment jsdom
import { act,cleanup,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { afterEach,describe,expect,it,vi } from 'vitest';

afterEach(cleanup);
import { TunerPanel } from './TunerPanel';
import { centsBetween,frequencyOf,nearestNote,noteName,type TunerBridge,type TunerReading } from './tuner';

const STANDARD=[64,59,55,50,45,40];
function fakeBridge(reading:(strings:number[])=>TunerReading){
  let session=0;
  return {
    inputs:vi.fn(async()=>[{id:'mic',name:'Microphone',default:true},{id:'line',name:'Line in',default:false}]),
    start:vi.fn(async(_id:string|null)=>++session),
    stop:vi.fn(async(_session:number|null)=>{}),
    read:vi.fn(async(strings:number[])=>reading(strings)),
  } satisfies TunerBridge;
}
const reading=()=>document.querySelector('.tuner-reading')!;
const quiet:TunerReading={running:true,error:null,level:-120,pitch:null,strings:[]};

describe('tuner math',()=>{
  it('names notes and measures cents against the chosen reference',()=>{
    expect(noteName(40)).toBe('E2');expect(noteName(66)).toBe('F#4');
    expect(frequencyOf(69)).toBe(440);expect(frequencyOf(69,432)).toBe(432);
    expect(nearestNote(110)).toEqual({midi:45,name:'A2',cents:0});
    expect(nearestNote(frequencyOf(40)*2**(12/1200))).toMatchObject({name:'E2',cents:12});
    expect(nearestNote(432,432)).toMatchObject({name:'A4',cents:0});
    expect(centsBetween(frequencyOf(64)*2**(-20/1200),frequencyOf(64))).toBeCloseTo(-20,6);
  });
});

describe('TunerPanel',()=>{
  it('lists inputs, listens to the chosen one and shows the nearest note and its cents',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>({...quiet,level:-20,pitch:{frequency:frequencyOf(45)*2**(8/1200),clarity:0.95}}));
    const {unmount}=render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));
    await waitFor(()=>expect(screen.getByRole('option',{name:'Microphone (default)'})).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Input'),'line');
    await user.click(screen.getByRole('button',{name:'Start listening'}));
    expect(bridge.start).toHaveBeenCalledExactlyOnceWith('line');
    await waitFor(()=>expect(reading()).toHaveTextContent('A2'));
    expect(reading()).toHaveTextContent('+8.0 cents');
    // Screen readers hear the note, not every cents update.
    expect(screen.getByRole('status')).toHaveTextContent(/^A2$/);
    expect(bridge.read).toHaveBeenLastCalledWith([]);
    // Unmounting stops listening.
    unmount();expect(bridge.stop).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('says in tune within three cents and asks for a note while it hears none',async()=>{
    const user=userEvent.setup();let frequency:number|null=null;
    const bridge=fakeBridge(()=>({...quiet,level:-30,pitch:frequency===null?null:{frequency,clarity:0.9}}));
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(reading()).toHaveTextContent('Play a single note.'));
    frequency=frequencyOf(64)*2**(2/1200);
    await waitFor(()=>expect(reading()).toHaveTextContent('In tune'));
    expect(screen.getByRole('status')).toHaveTextContent('E4, In tune');
    await user.click(screen.getByRole('button',{name:'Stop listening'}));
    expect(bridge.stop).toHaveBeenCalledOnce();expect(reading()).toBeNull();
  });

  it('checks every open string of the track at once against the reference',async()=>{
    const user=userEvent.setup();
    const bridge=fakeBridge(strings=>({...quiet,strings:strings.map((target,index)=>index===1?target*2**(-20/1200):index===5?null:target)}));
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));
    await user.selectOptions(screen.getByLabelText('Mode'),'strings');
    await user.clear(screen.getByLabelText('Reference A4 (Hz)'));await user.type(screen.getByLabelText('Reference A4 (Hz)'),'442');
    await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(screen.getByRole('row',{name:/String 2 \(B3\)/})).toHaveTextContent('-20.0 cents'));
    expect(screen.getByRole('row',{name:/String 1 \(E4\)/})).toHaveTextContent('In tune');
    expect(screen.getByRole('row',{name:/String 6 \(E2\)/})).toHaveTextContent('Not heard');
    const targets=bridge.read.mock.calls.at(-1)![0];
    expect(targets).toHaveLength(6);expect(targets[0]).toBeCloseTo(frequencyOf(64,442),9);
  });

  it('offers only chromatic mode for a track without strings, refuses a bad reference, and reports failures',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>quiet);bridge.start.mockRejectedValueOnce(new Error('Access denied.'));
    render(<TunerPanel tuning={[]} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));
    expect(screen.getByRole('option',{name:'All strings of this track'})).toBeDisabled();
    await user.clear(screen.getByLabelText('Reference A4 (Hz)'));await user.type(screen.getByLabelText('Reference A4 (Hz)'),'500');
    expect(screen.getByRole('alert')).toHaveTextContent('415 to 466');
    await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('The tuner could not listen: Access denied.'));
    expect(screen.getByRole('button',{name:'Start listening'})).toHaveAttribute('aria-pressed','false');
  });

  it('shows why capture stopped when the device goes away',async()=>{
    const user=userEvent.setup();let running=true;
    const bridge=fakeBridge(()=>({...quiet,running,error:running?null:'The input device was disconnected.'}));
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await act(async()=>{running=false;});
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('The tuner stopped: The input device was disconnected.'));
    expect(screen.getByRole('button',{name:'Start listening'})).toBeInTheDocument();
  });

  it('keeps listening while switching input, even if a read during the restart looks stopped',async()=>{
    const user=userEvent.setup();let restarting=false;
    const bridge=fakeBridge(()=>({...quiet,running:!restarting,pitch:{frequency:110,clarity:0.9}}));
    let finish!:()=>void;
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={5}/>);
    await user.click(screen.getByText('Tuner'));await waitFor(()=>expect(screen.getByRole('option',{name:'Line in'})).toBeInTheDocument());
    await user.click(screen.getByRole('button',{name:'Start listening'}));await waitFor(()=>expect(reading()).toHaveTextContent('A2'));
    bridge.start.mockImplementationOnce(()=>{restarting=true;return new Promise<number>(done=>{finish=()=>{restarting=false;done(2);};});});
    await user.selectOptions(screen.getByLabelText('Input'),'line');
    await new Promise(done=>setTimeout(done,40));
    expect(screen.getByRole('button',{name:'Stop listening'})).toBeInTheDocument();
    await act(async()=>{finish();});
    expect(bridge.start).toHaveBeenLastCalledWith('line');expect(bridge.stop).not.toHaveBeenCalled();
    await waitFor(()=>expect(reading()).toHaveTextContent('A2'));
  });

  it('stops capture when unmounted while a start is still pending, and when the section is collapsed',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>quiet);let finish!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>(done=>{finish=()=>done(7);}));
    const {unmount}=render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    unmount();expect(bridge.stop).not.toHaveBeenCalled();
    // The start that was on its way is ended by its own session once it arrives.
    await act(async()=>{finish();});expect(bridge.stop).toHaveBeenCalledExactlyOnceWith(7);
    cleanup();
    const again=fakeBridge(()=>quiet);render(<TunerPanel tuning={STANDARD} bridge={again} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(again.read).toHaveBeenCalled());
    await user.click(screen.getByText('Tuner'));
    await waitFor(()=>expect(again.stop).toHaveBeenCalledExactlyOnceWith(1));
  });

  it('stops when a section around it is collapsed, such as the Practice popover',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>quiet);
    render(<details open data-testid="outer"><summary>Practice</summary><TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/></details>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(bridge.read).toHaveBeenCalled());
    await user.click(screen.getByText('Practice'));
    await waitFor(()=>expect(bridge.stop).toHaveBeenCalledExactlyOnceWith(1));
  });

  it('waits a moment before calling a quiet input silent, and clears a passing read failure',async()=>{
    const user=userEvent.setup();let failing=true;
    const bridge=fakeBridge(()=>{if(failing)throw new Error('busy');return quiet;});
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('The tuner could not listen: busy'));
    failing=false;
    await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
    expect(reading()).toHaveTextContent('Play a single note.');
  });

  it('starts normally after a collapse during a start that failed',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>quiet);let fail!:()=>void;
    bridge.start.mockImplementationOnce(()=>new Promise<number>((_done,reject)=>{fail=()=>reject(new Error('Timed out.'));}));
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await user.click(screen.getByText('Tuner'));await act(async()=>{fail();});
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Stop listening'})).toBeInTheDocument());
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it('lists inputs again on each open and keeps a choice that is still there',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>quiet);
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await waitFor(()=>expect(screen.getByRole('option',{name:'Line in'})).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Input'),'line');
    bridge.inputs.mockResolvedValueOnce([{id:'mic',name:'Microphone',default:true},{id:'line',name:'Line in',default:false},{id:'usb',name:'USB interface',default:false}]);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByText('Tuner'));
    await waitFor(()=>expect(screen.getByRole('option',{name:'USB interface'})).toBeInTheDocument());
    expect(screen.getByLabelText('Input')).toHaveValue('line');
  });

  it('falls back to chromatic when the selected track has no strings',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>({...quiet,level:-20,pitch:{frequency:110,clarity:0.9}}));
    const {rerender}=render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.selectOptions(screen.getByLabelText('Mode'),'strings');
    await user.click(screen.getByRole('button',{name:'Start listening'}));
    expect(screen.getByText(/Finish the higher strings in chromatic mode/)).toBeInTheDocument();
    rerender(<TunerPanel tuning={[]} bridge={bridge} interval={10}/>);
    expect(screen.getByLabelText('Mode')).toHaveValue('chromatic');
    await waitFor(()=>expect(bridge.read).toHaveBeenLastCalledWith([]));
    expect(reading()).toHaveTextContent('A2');
  });

  it('says when the input is silent, which is what a refused microphone gives',async()=>{
    const user=userEvent.setup(),bridge=fakeBridge(()=>quiet);
    render(<TunerPanel tuning={STANDARD} bridge={bridge} interval={10}/>);
    await user.click(screen.getByText('Tuner'));await user.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(reading()).toHaveTextContent('Nothing is heard from this input.'),{timeout:3000});
  });
});
