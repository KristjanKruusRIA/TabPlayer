// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {ScoreOverview} from './ScoreOverview';
import type {ScoreOverviewModel} from './overview';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const small:ScoreOverviewModel={barCount:4,sections:[{bar:2,text:'Chorus'}],tracks:[
  {index:0,name:'Guitar',cells:['empty','rest','music','rest']},
  {index:1,name:'Drums',cells:['rest','music','empty','rest']},
]};
beforeEach(()=>{
  // jsdom has no layout: declare the complete scroll viewport, including its 144px name column and 28px ruler.
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(112);
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const cell=(name:string)=>screen.getByRole('gridcell',{name});

it('names real content and sections, keeps one tab stop, and selects empty/rest cells',()=>{
  const onSelect=vi.fn();render(<ScoreOverview model={small} target={target} playbackBar={null} onSelect={onSelect} onExit={()=>{}}/>);
  expect(screen.getByRole('grid',{name:'Written measure overview'})).toHaveAttribute('aria-colcount','5');
  expect(screen.getByRole('columnheader',{name:'Measure 3, Chorus'})).toBeInTheDocument();
  expect(cell('Guitar, measure 1, empty')).toHaveAttribute('tabindex','0');
  expect(screen.getAllByRole('gridcell').filter(node=>node.tabIndex===0)).toHaveLength(1);
  fireEvent.click(cell('Guitar, measure 1, empty'));fireEvent.click(cell('Guitar, measure 2, rest'));
  expect(onSelect.mock.calls).toEqual([[0,0],[0,1]]);expect(cell('Guitar, measure 2, rest')).toHaveFocus();
});

it('moves focus independently of selection and consumes all owned keys including bounds',()=>{
  const onSelect=vi.fn(),onExit=vi.fn(),ancestor=vi.fn();
  render(<div onKeyDown={ancestor}><ScoreOverview model={small} target={target} playbackBar={null} onSelect={onSelect} onExit={onExit}/></div>);
  cell('Guitar, measure 1, empty').focus();
  const key=(key:string)=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});fireEvent(document.activeElement!,event);expect(event.defaultPrevented).toBe(true);};
  key('ArrowLeft');key('ArrowUp');key('ArrowRight');expect(cell('Guitar, measure 2, rest')).toHaveFocus();
  expect(cell('Guitar, measure 1, empty')).toHaveAttribute('aria-selected','true');expect(onSelect).not.toHaveBeenCalled();
  key('ArrowDown');expect(cell('Drums, measure 2, music')).toHaveFocus();
  key('End');key('ArrowRight');key('ArrowDown');expect(cell('Drums, measure 4, rest')).toHaveFocus();
  key('Home');expect(cell('Drums, measure 1, rest')).toHaveFocus();
  key('Enter');fireEvent.keyUp(document.activeElement!,{key:'Enter'});key(' ');fireEvent.keyUp(document.activeElement!,{key:' '});key('Escape');
  expect(onSelect.mock.calls).toEqual([[1,0],[1,0]]);expect(onExit).toHaveBeenCalledTimes(1);expect(ancestor).not.toHaveBeenCalled();
});

it('leaves Tab and modified application shortcuts available to ancestors',()=>{
  const ancestor=vi.fn(),onSelect=vi.fn(),onExit=vi.fn();
  render(<div onKeyDown={ancestor}><ScoreOverview model={small} target={target} playbackBar={null} onSelect={onSelect} onExit={onExit}/></div>);
  const first=cell('Guitar, measure 1, empty');
  for(const init of [{key:'Tab'},{key:'ArrowRight',shiftKey:true},{key:' ',ctrlKey:true},{key:'Home',metaKey:true},{key:'Escape',altKey:true}]) {
    const event=new KeyboardEvent('keydown',{...init,bubbles:true,cancelable:true});fireEvent(first,event);expect(event.defaultPrevented).toBe(false);
  }
  expect(ancestor).toHaveBeenCalledTimes(5);expect(onSelect).not.toHaveBeenCalled();expect(onExit).not.toHaveBeenCalled();
});

it('updates a separate actual playback marker without moving focus or selection',()=>{
  const readCell=vi.fn(()=>'empty'),cells=[...small.tracks[0].cells];
  Object.defineProperty(cells,0,{get:readCell});
  const model={...small,tracks:[{...small.tracks[0],cells},small.tracks[1]]};
  const props={model,target,onSelect:vi.fn(),onExit:vi.fn()};const view=render(<ScoreOverview {...props} playbackBar={1}/>);
  const first=cell('Guitar, measure 1, empty');first.focus();
  const readsBeforeTick=readCell.mock.calls.length;
  expect(screen.getByRole('img',{name:'Playback measure 2'})).toBeInTheDocument();
  view.rerender(<ScoreOverview {...props} playbackBar={2}/>);
  expect(screen.getByRole('img',{name:'Playback measure 3'})).toBeInTheDocument();expect(first).toHaveFocus();expect(first).toHaveAttribute('aria-selected','true');expect(props.onSelect).not.toHaveBeenCalled();expect(readCell).toHaveBeenCalledTimes(readsBeforeTick);
  view.rerender(<ScoreOverview {...props} playbackBar={null}/>);expect(screen.queryByRole('img')).not.toBeInTheDocument();
  view.rerender(<ScoreOverview {...props} playbackBar={4000}/>);expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('bounds a 32-track 2000-bar grid while retaining focus during scrolling and at the last bar',()=>{
  const model:ScoreOverviewModel={barCount:2000,sections:[],tracks:Array.from({length:32},(_,index)=>({index,name:`Track ${index+1}`,cells:Array(2000).fill('rest')}))};
  render(<ScoreOverview model={model} target={target} playbackBar={null} onSelect={()=>{}} onExit={()=>{}}/>);
  const grid=screen.getByRole('grid'),first=cell('Track 1, measure 1, rest');first.focus();
  expect(screen.getAllByRole('gridcell').length).toBeLessThan(400);
  fireEvent.scroll(grid,{target:{scrollLeft:28000,scrollTop:560}});
  expect(first).toHaveFocus();expect(screen.getAllByRole('gridcell').length).toBeLessThan(400);
  expect(cell('Track 21, measure 1001, rest')).toBeInTheDocument();
  fireEvent.keyDown(first,{key:'End'});
  const last=cell('Track 1, measure 2000, rest');expect(last).toHaveFocus();expect(grid.scrollLeft).toBeGreaterThan(55000);expect(grid.scrollTop).toBe(0);
  expect(screen.getAllByRole('gridcell').length).toBeLessThan(400);expect(screen.getAllByRole('gridcell').filter(node=>node.tabIndex===0)).toEqual([last]);
  fireEvent.scroll(grid,{target:{scrollLeft:55400,scrollTop:812}});expect(last).toHaveFocus();
  expect(cell('Track 32, measure 2000, rest')).toBeInTheDocument();expect(screen.getAllByRole('gridcell').length).toBeLessThan(400);
});

it.each([false,true])('bounds retained focus before rendering a smaller model when hidden=%s',(hidden)=>{
  const onSelect=vi.fn(),props={target,playbackBar:null,onSelect,onExit:vi.fn()};
  const draw=(model:ScoreOverviewModel,isHidden:boolean)=><><button>Mixer control</button><div hidden={isHidden}><ScoreOverview {...props} model={model}/></div></>;
  const view=render(draw(small,false));
  fireEvent.click(cell('Drums, measure 4, rest'));onSelect.mockClear();
  if(hidden){view.rerender(draw(small,true));screen.getByRole('button',{name:'Mixer control'}).focus();}
  const smaller:ScoreOverviewModel={barCount:2,sections:[],tracks:[{...small.tracks[0],cells:['empty','rest']}]};
  expect(()=>view.rerender(draw(smaller,hidden))).not.toThrow();
  expect(onSelect).not.toHaveBeenCalled();
  if(hidden){expect(screen.getByRole('button',{name:'Mixer control'})).toHaveFocus();view.rerender(draw(smaller,false));}
  const remaining=cell('Guitar, measure 2, rest');
  expect(screen.getAllByRole('gridcell').filter(node=>node.tabIndex===0)).toEqual([remaining]);
  remaining.focus();fireEvent.keyDown(remaining,{key:'Enter'});expect(onSelect).toHaveBeenCalledExactlyOnceWith(0,1);
});

const passageOf=(...bars:number[])=>({first:bars[0],last:bars[bars.length-1],bars:bars.map(bar=>({bar,from:0,to:3840,length:3840}))});

it('marks the loop on the ruler and as one bracket over its bars, without taking clicks from the cells',()=>{
  const onSelect=vi.fn();
  render(<ScoreOverview model={small} target={target} playbackBar={null} loop={passageOf(1,2)} onSelect={onSelect} onExit={()=>{}}/>);
  const bracket=screen.getByRole('img',{name:'Loop: bars 2 to 3'});
  expect(bracket).toHaveClass('score-overview-loop');
  // 144px name column, 28px per bar, 28px ruler: two tracks sit under it.
  expect(bracket).toHaveStyle({left:'172px',width:'56px',height:'56px'});
  expect(screen.getByRole('columnheader',{name:'Measure 2'})).toHaveAttribute('data-loop','true');
  expect(screen.getByRole('columnheader',{name:'Measure 3, Chorus'})).toHaveAttribute('data-loop','true');
  expect(screen.getByRole('columnheader',{name:'Measure 1'})).not.toHaveAttribute('data-loop');
  expect(screen.getByRole('columnheader',{name:'Measure 4'})).not.toHaveAttribute('data-loop');
  fireEvent.click(cell('Guitar, measure 3, music'));expect(onSelect).toHaveBeenCalledWith(0,2);
});

it('draws a loop that skips bars as separate brackets, and names a single bar',()=>{
  render(<ScoreOverview model={small} target={target} playbackBar={null} loop={passageOf(0,2,3)} onSelect={()=>{}} onExit={()=>{}}/>);
  expect(screen.getByRole('img',{name:'Loop: bar 1'})).toHaveStyle({left:'144px',width:'28px'});
  expect(screen.getByRole('img',{name:'Loop: bars 3 to 4'})).toHaveStyle({left:'200px',width:'56px'});
});

it('shows no loop mark without a loop, and keeps the playhead apart from it',()=>{
  const view=render(<ScoreOverview model={small} target={target} playbackBar={1} onSelect={()=>{}} onExit={()=>{}}/>);
  expect(view.container.querySelector('.score-overview-loop')).toBeNull();expect(view.container.querySelector('[data-loop]')).toBeNull();
  view.rerender(<ScoreOverview model={small} target={target} playbackBar={1} loop={passageOf(1)} onSelect={()=>{}} onExit={()=>{}}/>);
  expect(screen.getByRole('img',{name:'Playback measure 2'})).toBeInTheDocument();expect(screen.getByRole('img',{name:'Loop: bar 2'})).toBeInTheDocument();
});

it('clips a loop longer than the score to its last bar',()=>{
  render(<ScoreOverview model={small} target={target} playbackBar={null} loop={passageOf(2,3,4,5)} onSelect={()=>{}} onExit={()=>{}}/>);
  expect(screen.getByRole('img',{name:'Loop: bars 3 to 4'})).toHaveStyle({width:'56px'});
});
