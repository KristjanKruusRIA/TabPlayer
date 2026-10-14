// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { DocumentController } from './controller';
import { blankProject, type EditCommand } from './project';
import type { NativeBridge } from './bridge';

vi.mock('./ScoreView',()=>({ScoreView:({onSelect}: {onSelect: (target: unknown, string: number)=>void}) =>
  <button onClick={()=>onSelect({track:0,staff:0,bar:0,voice:0,beat:1},5)}>Select rendered note</button>}));
afterEach(cleanup);

async function setup() {
  let edits: EditCommand[]=[]; let cursor=0;
  const snapshot=()=>({project:{...blankProject(),edits:edits.slice(0,cursor)},canUndo:cursor>0,canRedo:cursor<edits.length,dirty:cursor>0,path:null});
  const bridge: NativeBridge={snapshot:async()=>snapshot(),readDocument:async()=>null,replaceProject:async()=>snapshot(),
    applyEdit:async command=>{edits=edits.slice(0,cursor);edits.push(command);cursor++;return snapshot();},
    undo:async()=>{cursor--;return snapshot();},redo:async()=>{cursor++;return snapshot();},
    saveProject:async()=>null,exportGp:async()=>false,askUnsaved:async()=> 'discard',confirmExport:async()=>false};
  const controller=await DocumentController.create(bridge); render(<App controller={controller}/>); return controller;
}
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const currentBeat=(controller:DocumentController,index=0)=>controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[index];

it('selects rendered notes and enters frets on empty strings to form chords',async()=>{
  const c=await setup(); click('Select rendered note'); expect(screen.getByLabelText('Beat')).toHaveValue(2);
  expect(screen.getByLabelText('String')).toHaveValue('5'); change('Fret','7'); click('Set note');
  await waitFor(()=>expect(currentBeat(c,1).notes[0]?.fret).toBe(7));
  change('String','6');change('Fret','3');click('Set note');
  await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(2));
  click('Remove note');await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(1));
  click('Make rest');await waitFor(()=>expect(currentBeat(c,1).isRest).toBe(true));
});
it('edits rhythm, reports overflow, and supports undo and redo',async()=>{
  const c=await setup();change('Duration','2');click('Apply rhythm');
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('overfill'));
  expect(c.getState().snapshot.project.edits).toHaveLength(0);
  change('Duration','8');click('Apply rhythm');await waitFor(()=>expect(currentBeat(c).duration).toBe(8));
  click('Undo');await waitFor(()=>expect(currentBeat(c).duration).toBe(4));
  click('Redo');await waitFor(()=>expect(currentBeat(c).duration).toBe(8));
});
it('navigates beats and strings and accepts fret keys when the score has focus',async()=>{
  const c=await setup();const workspace=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(workspace,{key:'ArrowRight'});fireEvent.keyDown(workspace,{key:'ArrowDown'});
  expect(screen.getByLabelText('Beat')).toHaveValue(2);expect(screen.getByLabelText('String')).toHaveValue('5');
  fireEvent.keyDown(workspace,{key:'7'});fireEvent.keyDown(workspace,{key:'Enter'});
  await waitFor(()=>expect(currentBeat(c,1).notes[0]?.fret).toBe(7));
});
it('repairs selection after deleting the last beat, measure, and track',async()=>{
  const c=await setup();change('Beat','4');click('Delete beat');
  await waitFor(()=>expect(screen.getByLabelText('Beat')).toHaveValue(3));
  change('Measure','4');click('Remove measure');await waitFor(()=>expect(screen.getByLabelText('Measure')).toHaveValue(3));
  click('Append measure');await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(4));
  expect(screen.getByLabelText('Measure')).toHaveValue(3);
  click('Add track');await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(2));
  click('Track 2: Bass');click('Remove track');await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(1));
  expect(screen.getByRole('button',{name:'Track 1: Guitar'})).toHaveAttribute('aria-pressed','true');
  expect(Number((screen.getByLabelText('String') as HTMLSelectElement).value)).toBeLessThanOrEqual(6);
});
it('inserts a beat into an empty voice and changes score information and tuning',async()=>{
  const c=await setup();for(let i=0;i<4;i++){click('Delete beat');await waitFor(()=>expect(c.getState().score.tracks[0].staves[0].bars[0].voices[0].beats).toHaveLength(3-i));}
  expect(screen.getByRole('button',{name:'Set note'})).toBeDisabled();
  click('Insert beat');await waitFor(()=>expect(currentBeat(c)).toBeDefined());
  change('Title','My study');change('Artist','Band');change('Initial tempo','90');click('Apply score info');
  await waitFor(()=>expect(c.getState().score.title).toBe('My study'));
  change('Tuning (MIDI, high to low)','64,59,55,50,45,38');click('Apply tuning');
  await waitFor(()=>expect(c.getState().score.tracks[0].staves[0].tuning.at(-1)).toBe(38));
});
