import { FretboardArt } from './instrument-art';
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { InstrumentView } from './InstrumentView';

afterEach(()=>{cleanup();localStorage.clear();});
function music(percussion=false,program=25) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.name='Track';track.playbackInfo.program=program;
  staff.stringTuning.tunings=[64,59,55,50,45,40];staff.isPercussion=percussion;track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
  if(percussion)track.playbackInfo.primaryChannel=track.playbackInfo.secondaryChannel=9;
  const bar=new model.Bar(),voice=new model.Voice();
  for(const [string,fret] of [[1,0],[5,1],[3,5]]){
    const beat=new model.Beat();beat.duration=model.Duration.Quarter;
    const note=new model.Note();
    if(percussion)note.percussionArticulation=[38,36,51][string%3];else{note.string=string;note.fret=fret;}
    beat.addNote(note);voice.addBeat(beat);
  }
  bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());
  return {score,all:buildPlaybackPlan(score,1).notes};
}
const marks=(container:HTMLElement,selector:string)=>[...container.querySelectorAll(selector)];

/** Playback moves notes many times a second. The hardware is a memoised layer that React must not touch while it does. */
it('keeps the neck\'s drawing, strings and fret numbers when the lit notes change',()=>{
  const {score,all}=music(),{container,rerender}=render(<InstrumentView score={score} track={0} staff={0} notes={[all[0]]}/>);
  const before=marks(container,'[data-instrument-part], [data-string-row], [data-fret-boundary], [data-fret-number]');
  expect(before.length).toBeGreaterThan(40);
  expect(container.querySelectorAll('g[data-note-id]')).toHaveLength(1);
  for(const lit of [[all[1]],[all[0],all[2]],[],[all[1]]]){
    rerender(<InstrumentView score={score} track={0} staff={0} notes={lit}/>);
    expect(container.querySelectorAll('g[data-note-id]')).toHaveLength(lit.length);
  }
  const after=marks(container,'[data-instrument-part], [data-string-row], [data-fret-boundary], [data-fret-number]');
  expect(after).toHaveLength(before.length);
  after.forEach((node,index)=>expect(node).toBe(before[index]));
});

it('draws a heavier, wound look on the low strings of a six-string neck, graded by string',()=>{
  const {score,all}=music(),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={[all[0]]}/>);
  const thickness=(string:number)=>Number(container.querySelector(`[data-string-row="${string}"] rect`)!.getAttribute('height'));
  // String 1 is the lowest and the thickest.
  for(let string=1;string<6;string++)expect(thickness(string)).toBeGreaterThan(thickness(string+1));
  const wound=(string:number)=>container.querySelector(`[data-string-row="${string}"] line[stroke-dasharray]`);
  expect([4,5,6].map(string=>wound(string))).toEqual([null,null,null]);
  for(const string of [1,2,3])expect(wound(string)).not.toBeNull();
});

it('lets the number of strings and their tuning drive the drawing',()=>{
  const {score,all}=music();
  const {container,rerender}=render(<InstrumentView score={score} track={0} staff={0} notes={[all[0]]}/>);
  expect(container.querySelectorAll('[data-string-row]')).toHaveLength(6);
  expect(container.querySelector('[data-string-row="1"] title')!.textContent).toBe('String 1 · E2');
  expect(container.querySelectorAll('[data-instrument-part="neck-pickup"] [data-pickup-string]')).toHaveLength(6);
  score.tracks[0].staves[0].stringTuning.tunings=[43,38,33,28];
  rerender(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  expect(container.querySelectorAll('[data-string-row]')).toHaveLength(4);
  expect(container.querySelector('[data-string-row="1"] title')!.textContent).toBe('String 1 · E1');
  // Four strings: the lowest two are wound.
  expect([1,2,3,4].map(string=>container.querySelector(`[data-string-row="${string}"] line[stroke-dasharray]`)===null)).toEqual([false,false,true,true]);
});
it('draws all strings as wound on a bass neck',()=>{
  const {score}=music(false,33);
  score.tracks[0].staves[0].stringTuning.tunings=[43,38,33,28];
  const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  expect(container.querySelectorAll('[data-string-row]')).toHaveLength(4);
  const wound=(string:number)=>container.querySelector(`[data-string-row="${string}"] line[stroke-dasharray]`);
  expect([1,2,3,4].map(string=>wound(string)!==null)).toEqual([true,true,true,true]);

});

it('keeps the keys\' drawing when the lit keys change, and lights only the notes sounding',()=>{
  const {score,all}=music(false,0),{container,rerender}=render(<InstrumentView score={score} track={0} staff={0} notes={[all[0]]}/>);
  const before=marks(container,'[data-key-art]');expect(before.length).toBeGreaterThan(30);
  for(const lit of [[all[1]],[all[0],all[2]],[]]){
    rerender(<InstrumentView score={score} track={0} staff={0} notes={lit}/>);
    expect(container.querySelectorAll('g[data-key][data-active="true"]')).toHaveLength(lit.length);
  }
  marks(container,'[data-key-art]').forEach((node,index)=>expect(node).toBe(before[index]));
  // Every key still has its note name for the pointer.
  expect(container.querySelector('[data-key="60"] title')!.textContent).toBe('C4');
});

it('keeps the piano-key class on every key in entry mode, so lit keys are drawn by their own styles',()=>{
  const {score}=music(false,0),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={[]} entry={{target:{track:0,staff:0,bar:0,voice:0,beat:0},busy:false,onEdit:()=>{}}}/>);
  const keys=[...container.querySelectorAll('g[data-key]')];
  expect(keys.length).toBeGreaterThan(30);
  for(const key of keys){expect(key).toHaveClass('piano-key');expect(key).toHaveClass('entry-target');}
  // The key the beat holds is lit, and its mark sits inside a group the lit styles reach.
  const lit=container.querySelector('g[data-key][data-active="true"]');
  expect(lit).not.toBeNull();expect(lit).toHaveClass('active');expect(lit!.querySelector('.key-hit')).not.toBeNull();
});

it('keeps the kit\'s drawing when the struck pieces change',()=>{
  const {score,all}=music(true),{container,rerender}=render(<InstrumentView score={score} track={0} staff={0} notes={[all[0]]}/>);
  const before=marks(container,'[data-drum-art]');expect(before).toHaveLength(17);
  for(const lit of [[all[1]],[all[0],all[2]],[]]){
    rerender(<InstrumentView score={score} track={0} staff={0} notes={lit}/>);
    expect(container.querySelectorAll('[data-drum][data-active="true"]').length).toBeLessThanOrEqual(lit.length);
  }
  marks(container,'[data-drum-art]').forEach((node,index)=>expect(node).toBe(before[index]));
});

it('uses no SVG filter in any instrument drawing, so a highlight repaints nothing expensive',()=>{
  for(const [percussion,program,mode] of [[false,25,'guitar'],[false,0,'keys'],[true,0,'drums']] as const){
    const {score,all}=music(percussion,program),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={[all[0]]}/>);
    if(mode==='keys'&&!percussion)fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'both'}});
    expect(container.querySelectorAll('filter, [filter], feTurbulence, feGaussianBlur')).toHaveLength(0);
    cleanup();
  }
});

it('gives each neck a tuner per string, and only the guitar a middle pickup',()=>{
  const draw=(strings:number,mode:'guitar'|'bass')=>render(<svg><FretboardArt strings={strings} openKeys="" mode={mode} leftHanded={false} maxFret={24}/></svg>).container;
  const guitar=draw(6,'guitar'),bass=draw(4,'bass');
  expect(guitar.querySelectorAll('[data-tuner]')).toHaveLength(6);expect(guitar.querySelector('[data-instrument-part="middle-pickup"]')).toBeInTheDocument();
  expect(bass.querySelectorAll('[data-tuner]')).toHaveLength(4);expect(bass.querySelector('[data-instrument-part="middle-pickup"]')).toBeNull();
  expect(bass.querySelectorAll('[data-instrument-part="neck-pickup"] [data-pickup-string]')).toHaveLength(4);
});
