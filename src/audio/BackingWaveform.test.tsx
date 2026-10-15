// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {BackingWaveform} from './BackingWaveform';
import type {BackingSettings} from '../edit-types';
import type {BackingWaveform as WaveformData,BackingWaveformProps,BackingTimeline,WaveformSourceInput} from './backing-waveform-types';
import {useReferenceSyncEdit} from './useReferenceSyncEdit';
import {referenceSyncTiming} from './reference-sync';

// Projection has an independently tested Task 3 producer. These deterministic seams
// isolate view transactions from timing implementation while that producer runs.
const projection=vi.hoisted(()=>({grid:vi.fn(),selection:vi.fn(),move:vi.fn(),clock:vi.fn(),tick:vi.fn()}));
vi.mock('./backing-timeline',()=>({projectBackingGrid:projection.grid,projectBackingSelection:projection.selection,moveBackingAnchor:projection.move,scoreTimeToAudioMs:projection.clock,scoreTickToAudioMs:projection.tick}));
const owner={documentId:'doc',activationId:'active'},documentRevision={documentId:'doc',revision:1};
const source:WaveformSourceInput={kind:'asset',assetId:'asset'};
const timeline:BackingTimeline={generation:1,durationTick:7680,tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,startTick:0,endTick:3840,startMs:0,endMs:2000,meterNumerator:4,meterDenominator:4},{bar:0,occurrence:1,startTick:3840,endTick:7680,startMs:2000,endMs:4000,meterNumerator:4,meterDenominator:4}]};
const grid=[{key:'one',bar:0,occurrence:0,ratio:0,tick:0,audioMs:1000,kind:'bar' as const},{key:'beat',bar:0,occurrence:0,ratio:.5,tick:1920,audioMs:4000,kind:'beat' as const},{key:'repeat',bar:0,occurrence:1,ratio:0,tick:3840,audioMs:6000,kind:'bar' as const}];
const settings:BackingSettings={assetId:'asset',offsetMs:120,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1120},{bar:0,occurrence:1,ratio:.5,audioMs:8120}],mix:{gain:.7,pan:-.2,mute:false,solo:true}};
function data(input:WaveformSourceInput=source,channels:1|2=2):WaveformData {return {owner,document:documentRevision,source:input.kind==='asset'?input:{kind:'embedded',sourceKey:input.sourceKey,sha256:input.sha256},durationMs:10000,sampleRate:1000,frameCount:10000,channels,bucketCount:2,peaks:[{min:[-.5,-1],max:[1,.25]},{min:[0,-.25],max:[.5,.5]}]};}
function props(patch:Partial<BackingWaveformProps>={}):BackingWaveformProps {return {document:documentRevision,source,filename:'C:/Music/Harbour rhythm.wav',bridge:{owner,read:vi.fn(async()=>data())},timeline,selection:{points:[{tick:0,anchor:{bar:0,occurrence:0,ratio:0}}],spans:[]},settings:structuredClone(settings),effectiveBacking:settings,scoreTimeMs:null,enabled:true,busy:false,beginOperation:vi.fn(()=>vi.fn()),isCurrent:()=>true,onEdit:vi.fn(async()=>{}),...patch};}
let resize:(width:number)=>void;
beforeEach(()=>{
  vi.clearAllMocks();
  projection.grid.mockImplementation((_t,_b,start,end)=>grid.filter(line=>line.audioMs>=start&&line.audioMs<=end));
  projection.selection.mockReturnValue({points:[1000,6000],spans:[{startMs:1000,endMs:2000},{startMs:6000,endMs:7000}]});
  projection.clock.mockImplementation((_t,_b,ms)=>ms-120);
  projection.tick.mockImplementation((_t,_b,tick)=>tick/960*500);
  projection.move.mockImplementation((backing:BackingSettings,index:number,sourceMs:number,_t:BackingTimeline,duration:number)=>{
    if(!Number.isFinite(sourceMs)||sourceMs<0||sourceMs>duration)throw new Error('Outside source duration');
    const next=structuredClone(backing);next.anchors[index].audioMs=sourceMs+backing.offsetMs;
    const ordered=[...next.anchors].sort((a,b)=>a.bar-b.bar||a.occurrence-b.occurrence||a.ratio-b.ratio);
    if(ordered.some((anchor,i)=>anchor.audioMs<0||(i>0&&anchor.audioMs<=ordered[i-1].audioMs)))throw new Error('Sync points must remain in order');return next;
  });
  vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  vi.stubGlobal('ResizeObserver',class {constructor(callback:ResizeObserverCallback){resize=width=>callback([{contentRect:{width}} as ResizeObserverEntry],this as unknown as ResizeObserver);}observe(){resize(1000);}disconnect(){}});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,right:1000,width:1000,top:0,bottom:100,height:100,x:0,y:0,toJSON:()=>{}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function ready(p=props()) {const view=render(<BackingWaveform {...p}/>);await screen.findByRole('img',{name:'Backing audio waveform'});return {view,p};}
const handle=()=>screen.getByRole('slider',{name:'Sync point 1, measure 1, occurrence 1'});
function dragStart(element=handle()) {fireEvent.pointerDown(element,{pointerId:1,clientX:100,button:0});return element;}

it('original_embedded_is_real_read_only_and_empty_states_are_truthful',async()=>{
  const embedded:WaveformSourceInput={kind:'embedded',sourceKey:'a'.repeat(64),sha256:'b'.repeat(64),bytesBase64:'AQ=='};
  const p=props({source:embedded,settings:null,bridge:{owner,read:vi.fn(async()=>data(embedded,1))}});
  const {view}=await ready(p);expect(screen.getByText(/Original embedded audio.*read.only/i)).toBeVisible();
  expect(view.container.querySelectorAll('[data-waveform-channel]')).toHaveLength(1);
  expect(view.container.querySelector('[data-waveform-channel]')?.getAttribute('d')).toContain('M');
  expect(screen.getByRole('button',{name:'Add sync point'})).toBeDisabled();expect(screen.getByRole('button',{name:'Delete sync point'})).toBeDisabled();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();expect(p.onEdit).not.toHaveBeenCalled();
  const read=vi.fn();view.rerender(<BackingWaveform {...props({source:null,settings:null,effectiveBacking:null,bridge:{owner,read}})}/>);
  expect(screen.getByText('Score only — no backing audio.')).toBeVisible();expect(read).not.toHaveBeenCalled();expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('loading error Retry and preparing score timing contain no invented waveform',async()=>{
  const read=vi.fn().mockRejectedValueOnce(new Error('Cannot decode audio')).mockResolvedValueOnce(data());
  const p=props({bridge:{owner,read},timeline:null}),view=render(<BackingWaveform {...p}/>);
  expect(screen.getByText('Loading waveform…')).toBeVisible();expect(screen.queryByRole('img')).not.toBeInTheDocument();
  await screen.findByRole('alert');expect(screen.getByText('Cannot decode audio')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await screen.findByRole('img');expect(screen.getByText('Preparing score timing…')).toBeVisible();expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('[data-waveform-channel]')).toHaveLength(2);
  expect(screen.getByText('Harbour rhythm.wav')).toHaveAttribute('title',p.filename);
});

it('zoom_pan_and_selection_are_view_only and clock updates leave peaks and grid stable',async()=>{
  const {p,view}=await ready(props({scoreTimeMs:2120}));
  const path=view.container.querySelector('[data-waveform-channel]'),gridCalls=projection.grid.mock.calls.length;
  expect(view.container.querySelectorAll('.backing-waveform-selection-span')).toHaveLength(2);
  expect(view.container.querySelectorAll('.backing-waveform-selection-point')).toHaveLength(2);
  expect(screen.getByRole('button',{name:'Zoom out'})).toBeDisabled();expect(screen.getByText('100%')).toBeVisible();
  for(const percent of [200,400,800,1600]){fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));expect(screen.getByText(`${percent}%`)).toBeVisible();}
  expect(screen.getByRole('button',{name:'Zoom in'})).toBeDisabled();
  const viewport=screen.getByRole('region',{name:'Backing source timeline'});fireEvent.scroll(viewport,{target:{scrollLeft:99999}});expect(viewport.scrollLeft).toBe(15000);
  fireEvent.click(screen.getByRole('button',{name:'Fit'}));expect(screen.getByText('100%')).toBeVisible();expect(viewport.scrollLeft).toBe(0);
  act(()=>resize(500));expect(view.container.querySelector('.backing-waveform-content')).toHaveStyle({width:'500px'});
  const beforeClock=projection.grid.mock.calls.length;view.rerender(<BackingWaveform {...p} scoreTimeMs={3120}/>);
  expect(projection.grid.mock.calls.length).toBe(beforeClock);expect(view.container.querySelector('[data-waveform-channel]')).toBe(path);
  view.rerender(<BackingWaveform {...p} scoreTimeMs={3120} settings={structuredClone(p.settings)} selection={structuredClone(p.selection)} timeline={{...timeline}}/>);
  expect(projection.grid.mock.calls.length).toBe(beforeClock);
  expect(view.container.querySelectorAll('.backing-waveform-playhead')).toHaveLength(1);expect(view.container.querySelector('.backing-waveform-playhead')).toHaveStyle({left:'30%'});
  expect(gridCalls).toBeGreaterThan(0);expect(p.onEdit).not.toHaveBeenCalled();expect(p.bridge.read).toHaveBeenCalledOnce();
});

it('pointer preview commits one changed setting and survives its own busy lease',async()=>{
  const release=vi.fn(),pending=new Promise<void>(()=>{}),onEdit=vi.fn((_command:Parameters<BackingWaveformProps['onEdit']>[0])=>pending),p=props({beginOperation:vi.fn(()=>release),onEdit});
  const {view}=await ready(p),slider=dragStart();expect(p.beginOperation).toHaveBeenCalledOnce();
  view.rerender(<BackingWaveform {...p} busy/>);fireEvent.pointerMove(slider,{pointerId:1,clientX:110});
  expect(slider).toHaveAttribute('aria-valuenow','1100');expect(onEdit).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Zoom in'})).toBeDisabled();
  expect(slider).toHaveAttribute('aria-disabled','false');expect(screen.getByRole('slider',{name:'Sync point 2, measure 1, occurrence 2'})).toHaveAttribute('aria-disabled','true');
  fireEvent.pointerUp(slider,{pointerId:1,clientX:110});expect(onEdit).toHaveBeenCalledOnce();
  expect(onEdit.mock.calls[0][0]).toEqual({type:'setBacking',backing:{...settings,anchors:[{...settings.anchors[0],audioMs:1220},settings.anchors[1]]}});
  fireEvent.lostPointerCapture(slider,{pointerId:1});expect(release).not.toHaveBeenCalled();view.unmount();expect(release).toHaveBeenCalledOnce();
});

it.each(['noop','escape','pointercancel','lostcapture','blur','unmount','stale'] as const)('pointer %s leaves history unchanged and releases exactly once',async mode=>{
  const release=vi.fn(),current={value:true},p=props({beginOperation:()=>release,isCurrent:()=>current.value}),{view}=await ready(p),slider=dragStart();
  if(mode!=='noop')fireEvent.pointerMove(slider,{pointerId:1,clientX:110});
  if(mode==='noop')fireEvent.pointerUp(slider,{pointerId:1,clientX:100});
  if(mode==='escape')fireEvent.keyDown(slider,{key:'Escape'});
  if(mode==='pointercancel')fireEvent.pointerCancel(slider,{pointerId:1});
  if(mode==='lostcapture')fireEvent.lostPointerCapture(slider,{pointerId:1});
  if(mode==='blur')fireEvent.blur(slider);
  if(mode==='unmount')view.unmount();
  if(mode==='stale'){current.value=false;fireEvent.pointerUp(slider,{pointerId:1});}
  expect(p.onEdit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();view.unmount();expect(release).toHaveBeenCalledOnce();
});

it.each(['revision','source','settings','activation'] as const)('a changed %s cancels a preview before release',async change=>{
  const release=vi.fn(),p=props({beginOperation:()=>release}),{view}=await ready(p),slider=dragStart();fireEvent.pointerMove(slider,{pointerId:1,clientX:110});
  const changed:Partial<BackingWaveformProps>=change==='revision'?{document:{...documentRevision,revision:2}}:change==='source'?{source:{kind:'asset',assetId:'next'}}:change==='settings'?{settings:{...settings,offsetMs:121}}:{bridge:{...p.bridge,owner:{...owner,activationId:'next'}}};
  view.rerender(<BackingWaveform {...p} {...changed}/>);fireEvent.pointerUp(slider,{pointerId:1});
  expect(p.onEdit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
});

it('rejected commit restores the committed handle and holds its lease until settlement',async()=>{
  let reject!:(error:Error)=>void;const release=vi.fn(),onEdit=vi.fn(()=>new Promise<void>((_yes,no)=>{reject=no;}));
  await ready(props({beginOperation:()=>release,onEdit}));const slider=dragStart();fireEvent.pointerMove(slider,{pointerId:1,clientX:110});fireEvent.pointerUp(slider,{pointerId:1,clientX:110});
  expect(release).not.toHaveBeenCalled();await act(async()=>reject(new Error('Edit rejected')));
  expect(slider).toHaveAttribute('aria-valuenow','1000');expect(screen.getByRole('alert')).toHaveTextContent('Edit rejected');expect(release).toHaveBeenCalledOnce();
});

it('focused keyboard arrows preview 1ms or Shift10ms and commit once on key-up without score shortcuts',async()=>{
  const release=vi.fn(),p=props({beginOperation:()=>release}),keys=vi.fn();render(<div onKeyDown={keys}><BackingWaveform {...p}/></div>);await screen.findByRole('img');const slider=handle();slider.focus();
  expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('Measure 1, occurrence 1'));
  fireEvent.keyDown(slider,{key:'ArrowRight'});fireEvent.keyDown(slider,{key:'ArrowRight',shiftKey:true,repeat:true});
  expect(slider).toHaveAttribute('aria-valuenow','1011');expect(p.onEdit).not.toHaveBeenCalled();expect(keys).not.toHaveBeenCalled();
  fireEvent.keyUp(slider,{key:'ArrowRight'});await waitFor(()=>expect(release).toHaveBeenCalledOnce());expect(p.onEdit).toHaveBeenCalledOnce();
  expect(p.onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{...settings,anchors:[{...settings.anchors[0],audioMs:1131},settings.anchors[1]]}});
});

it.each(['Escape','blur','Home','End'] as const)('keyboard %s cancels or leaves the handle unchanged',async key=>{
  const release=vi.fn(),p=props({beginOperation:vi.fn(()=>release)});await ready(p);const slider=handle();slider.focus();
  if(key==='Escape'||key==='blur'){fireEvent.keyDown(slider,{key:'ArrowLeft'});if(key==='blur')fireEvent.blur(slider);else fireEvent.keyDown(slider,{key});expect(release).toHaveBeenCalledOnce();}
  else {fireEvent.keyDown(slider,{key});fireEvent.keyUp(slider,{key});expect(p.beginOperation).not.toHaveBeenCalled();}
  expect(p.onEdit).not.toHaveBeenCalled();expect(slider).toHaveAttribute('aria-valuenow','1000');
});

it('selects a real repeated beat for Add and the exact selected index for Delete',async()=>{
  const p=props();await ready(p);fireEvent.click(screen.getByRole('button',{name:'Measure 1, occurrence 2, position 0.00'}));
  expect(p.onEdit).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Add sync point'}));
  await waitFor(()=>expect(p.onEdit).toHaveBeenCalledOnce());
  expect(p.onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{...settings,anchors:[...settings.anchors,{bar:0,occurrence:1,ratio:0,audioMs:6120}]}});
  fireEvent.click(handle());fireEvent.click(screen.getByRole('button',{name:'Delete sync point'}));await waitFor(()=>expect(p.onEdit).toHaveBeenCalledTimes(2));
  expect(p.onEdit).toHaveBeenLastCalledWith({type:'setBacking',backing:{...settings,anchors:[settings.anchors[1]]}});
});

it('crossed-neighbor preview is rejected without an edit',async()=>{
  const p=props(),release=vi.fn();await ready({...p,beginOperation:()=>release});const slider=dragStart();fireEvent.pointerMove(slider,{pointerId:1,clientX:900});fireEvent.pointerUp(slider,{pointerId:1,clientX:900});
  expect(p.onEdit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('Sync points must remain in order');expect(release).toHaveBeenCalledOnce();
});

it('keyboard own-busy preview waits for its corresponding key-up and no-op returns create no edit',async()=>{
  const release=vi.fn(),p=props({beginOperation:vi.fn(()=>release)}),{view}=await ready(p),slider=handle();slider.focus();
  fireEvent.keyDown(slider,{key:'ArrowRight'});view.rerender(<BackingWaveform {...p} busy/>);
  fireEvent.keyDown(slider,{key:'ArrowRight',shiftKey:true});fireEvent.keyUp(slider,{key:'Shift'});
  expect(slider).toHaveAttribute('aria-valuenow','1011');expect(p.onEdit).not.toHaveBeenCalled();
  fireEvent.keyUp(slider,{key:'ArrowRight'});await waitFor(()=>expect(release).toHaveBeenCalledOnce());expect(p.onEdit).toHaveBeenCalledOnce();
  view.rerender(<BackingWaveform {...p}/>);slider.focus();fireEvent.keyDown(slider,{key:'ArrowLeft'});fireEvent.keyDown(slider,{key:'ArrowRight'});fireEvent.keyUp(slider,{key:'ArrowRight'});
  expect(p.onEdit).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledTimes(2);
});

it('duplicate Add and externally changed selected indices cannot create unintended edits',async()=>{
  const p=props(),{view}=await ready(p);fireEvent.click(screen.getByRole('button',{name:'Measure 1, occurrence 1, position 0.00'}));fireEvent.click(screen.getByRole('button',{name:'Add sync point'}));
  expect(p.onEdit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('Sync points must remain in order');
  fireEvent.click(handle());expect(screen.getByRole('button',{name:'Delete sync point'})).toBeEnabled();
  view.rerender(<BackingWaveform {...p} settings={{...settings,anchors:[settings.anchors[1]]}}/>);
  expect(screen.getByRole('button',{name:'Delete sync point'})).toBeDisabled();
});

it('a one-frame peak has a real source-width segment and commit settlement after unmount releases once',async()=>{
  let finish!:()=>void;const release=vi.fn(),p=props({beginOperation:()=>release,onEdit:()=>new Promise<void>(resolve=>{finish=resolve;})});
  const single={...data(),bucketCount:1,peaks:[{min:[1,-1] as [number,number],max:[1,-1] as [number,number]}]};p.bridge={owner,read:async()=>single};
  const {view}=await ready(p);expect(view.container.querySelector('[data-waveform-channel]')).toHaveAttribute('d','M0 28L0 28H1000');
  const slider=dragStart();fireEvent.pointerMove(slider,{pointerId:1,clientX:110});fireEvent.pointerUp(slider,{pointerId:1,clientX:110});
  view.unmount();expect(release).toHaveBeenCalledOnce();await act(async()=>finish());expect(release).toHaveBeenCalledOnce();
});

it('window blur cancels an active preview even while the handle retains focus',async()=>{
  const release=vi.fn(),p=props({beginOperation:()=>release});await ready(p);const slider=dragStart();fireEvent.pointerMove(slider,{pointerId:1,clientX:110});
  fireEvent(window,new Event('blur'));fireEvent.pointerUp(slider,{pointerId:1,clientX:110});
  expect(p.onEdit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();expect(slider).toHaveAttribute('aria-valuenow','1000');
});

it('fractional source coordinates with negative offset keep stationary and returned gestures out of history',async()=>{
  const fractional={...settings,offsetMs:-120,anchors:[{...settings.anchors[0],audioMs:.1},settings.anchors[1]]};
  const release=vi.fn(),p=props({settings:fractional,effectiveBacking:fractional,beginOperation:()=>release});await ready(p);
  const slider=dragStart();fireEvent.pointerUp(slider,{pointerId:1,clientX:100});expect(p.onEdit).not.toHaveBeenCalled();
  slider.focus();fireEvent.keyDown(slider,{key:'ArrowRight'});fireEvent.keyDown(slider,{key:'ArrowLeft'});fireEvent.keyUp(slider,{key:'ArrowLeft'});
  expect(p.onEdit).not.toHaveBeenCalled();expect(slider).toHaveAttribute('aria-valuenow','120.1');expect(release).toHaveBeenCalledTimes(2);
});

it('zoomed ruler distinguishes each actual subsecond source tick',async()=>{
  const {view}=await ready();fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
  const labels=[...view.container.querySelectorAll('.backing-waveform-time')].map(element=>element.textContent);
  expect(labels).toContain('0:01.5');expect(labels).toContain('0:02.0');expect(new Set(labels).size).toBe(labels.length);
});

const referenceSettings:BackingSettings={...settings,anchors:[{bar:0,occurrence:1,ratio:0,audioMs:3120}],referenceSync:{entryAudioMs:1120,exitAudioMs:7120}};
function ReferenceWaveform({p}:{p:BackingWaveformProps}) {
  const edit=useReferenceSyncEdit({owner:p.bridge.owner,document:p.document,sourceKey:p.source?.kind==='asset'?p.source.assetId:null,settings:p.settings,timeline:p.timeline,durationMs:10000,visible:{number:true,waveform:p.enabled},busy:p.busy,beginOperation:p.beginOperation,isCurrent:p.isCurrent,onCommit:(backing)=>p.onEdit({type:'setBacking',backing})});
  return <BackingWaveform {...p} reference={{edit,timing:p.settings&&p.timeline?referenceSyncTiming(p.settings,p.timeline.occurrences,10000):null}}/>;
}
async function readyReference(p=props({settings:referenceSettings,effectiveBacking:referenceSettings})) {const view=render(<ReferenceWaveform p={p}/>);await screen.findByRole('img');return {p,view};}

it('shows distinct reference endpoints and derived tempos without allowing endpoint deletion or view-only edits',async()=>{
  const {p,view}=await readyReference();const entry=screen.getByRole('slider',{name:'Entry bracket'}),exit=screen.getByRole('slider',{name:'Exit bracket'});
  expect(entry).toHaveAttribute('aria-valuenow','1000');expect(exit).toHaveAttribute('aria-valuenow','7000');
  expect(screen.getByText('120 BPM')).toBeVisible();expect(screen.getByText('60 BPM')).toBeVisible();expect(view.container.querySelectorAll('[data-waveform-channel]')).toHaveLength(2);
  fireEvent.focus(entry);fireEvent.click(entry);expect(screen.getByText(/Entry.*Source 1,000 ms/)).toBeVisible();expect(screen.getByRole('button',{name:'Delete sync point'})).toBeDisabled();
  fireEvent.keyDown(entry,{key:'Delete'});fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));fireEvent.click(screen.getByRole('button',{name:'Fit'}));
  expect(p.beginOperation).not.toHaveBeenCalled();expect(p.onEdit).not.toHaveBeenCalled();
});

it('reference keyboard uses the shared lease, keeps its own busy handle enabled, and commits only on the matching key-up',async()=>{
  const release=vi.fn(),p=props({settings:referenceSettings,effectiveBacking:referenceSettings,beginOperation:vi.fn(()=>release)}),{view}=await readyReference(p);
  const entry=screen.getByRole('slider',{name:'Entry bracket'});entry.focus();fireEvent.keyDown(entry,{key:'ArrowRight'});view.rerender(<ReferenceWaveform p={{...p,busy:true}}/>);
  expect(entry).toHaveAttribute('aria-disabled','false');expect(screen.getByRole('slider',{name:'Exit bracket'})).toHaveAttribute('aria-disabled','true');expect(screen.getByRole('slider',{name:'Sync point 1, measure 1, occurrence 2'})).toHaveAttribute('aria-disabled','true');
  fireEvent.keyDown(entry,{key:'ArrowRight',shiftKey:true});fireEvent.keyUp(entry,{key:'Shift'});expect(p.onEdit).not.toHaveBeenCalled();expect(entry).toHaveAttribute('aria-valuenow','1011');
  fireEvent.keyUp(entry,{key:'ArrowRight'});await waitFor(()=>expect(release).toHaveBeenCalledOnce());expect(p.onEdit).toHaveBeenCalledExactlyOnceWith({type:'setBacking',backing:{...referenceSettings,referenceSync:{entryAudioMs:1131,exitAudioMs:7120}}});
});

it.each(['pointercancel','lostcapture','blur','escape','hide'] as const)('reference %s cancels shared preview without a score edit',async action=>{
  const release=vi.fn(),p=props({settings:referenceSettings,effectiveBacking:referenceSettings,beginOperation:()=>release}),{view}=await readyReference(p),entry=screen.getByRole('slider',{name:'Entry bracket'});
  dragStart(entry);fireEvent.pointerMove(entry,{pointerId:1,clientX:110});expect(entry).toHaveAttribute('aria-valuenow','1100');expect(screen.getByText('126.32 BPM')).toBeVisible();
  if(action==='pointercancel')fireEvent.pointerCancel(entry,{pointerId:1});if(action==='lostcapture')fireEvent.lostPointerCapture(entry,{pointerId:1});if(action==='blur')fireEvent.blur(entry);if(action==='escape')fireEvent.keyDown(entry,{key:'Escape'});if(action==='hide')view.rerender(<ReferenceWaveform p={{...p,enabled:false}}/>);
  fireEvent.pointerUp(entry,{pointerId:1,clientX:110});expect(p.onEdit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();if(action==='hide')expect(screen.queryByRole('slider')).not.toBeInTheDocument();else expect(entry).toHaveAttribute('aria-valuenow','1000');
});

it('reference pointer-up commits once and exact source-edge brackets remain reachable',async()=>{
  const p=props({settings:referenceSettings,effectiveBacking:referenceSettings});await readyReference(p);const exit=screen.getByRole('slider',{name:'Exit bracket'});
  dragStart(exit);fireEvent.pointerMove(exit,{pointerId:1,clientX:110});fireEvent.pointerUp(exit,{pointerId:1,clientX:110});fireEvent.pointerUp(exit,{pointerId:1,clientX:110});
  await waitFor(()=>expect(p.onEdit).toHaveBeenCalledOnce());expect(p.onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{...referenceSettings,referenceSync:{entryAudioMs:1120,exitAudioMs:7220}}});
  cleanup();const edge={...referenceSettings,referenceSync:{entryAudioMs:120,exitAudioMs:10120}};await readyReference(props({settings:edge,effectiveBacking:edge}));
  expect(screen.getByRole('slider',{name:'Entry bracket'})).toHaveAttribute('data-edge','start');expect(screen.getByRole('slider',{name:'Exit bracket'})).toHaveAttribute('data-edge','end');
});

it('signed stored reference points expose physical source limits and preview only the grid while playback stays committed',async()=>{
  const signed={...referenceSettings,offsetMs:-120,anchors:[{bar:0,occurrence:1,ratio:0,audioMs:-70}],referenceSync:{entryAudioMs:-120,exitAudioMs:9880}},p=props({settings:signed,effectiveBacking:signed,scoreTimeMs:1000});
  const {view}=await readyReference(p),interior=screen.getByRole('slider',{name:'Sync point 1, measure 1, occurrence 2'});
  expect(interior).toHaveAttribute('aria-valuemin','0');expect(interior).toHaveAttribute('aria-valuenow','50');
  const playhead=screen.getByLabelText('Native playback position'),left=playhead.style.left,entry=screen.getByRole('slider',{name:'Entry bracket'});
  dragStart(entry);fireEvent.pointerMove(entry,{pointerId:1,clientX:101});expect(entry).toHaveAttribute('aria-valuenow','10');expect(playhead.style.left).toBe(left);
  expect(projection.grid).toHaveBeenLastCalledWith(timeline,expect.objectContaining({referenceSync:{entryAudioMs:-110,exitAudioMs:9880}}),0,10000);
  expect(projection.clock).toHaveBeenLastCalledWith(timeline,signed,1000);expect(p.onEdit).not.toHaveBeenCalled();view.unmount();
});
