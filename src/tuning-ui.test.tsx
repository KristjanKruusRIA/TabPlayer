// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { DocumentController } from './controller';
import { blankProject, type EditCommand } from './project';
import type { NativeBridge } from './bridge';

vi.mock('./ScoreView',()=>({ScoreView:()=>null}));
vi.mock('./export/useExportCoordinator',()=>({useExportCoordinator:()=>({busy:false,progress:undefined,run:async()=>true,cancel:async()=>{}})}));
vi.mock('./audio/NativePlaybackController',()=>({NativePlaybackController:class {
  state={ready:true,playing:false,time:0,endTime:4000,measure:0,speed:100,metronome:false,error:null};
  subscribe=()=>()=>{};getState=()=>this.state;loadDocument=async()=>{};beforeScoreChange=()=>{};destroy=()=>{};
  devices=async()=>[];deviceId=()=>null;backingDurationMs=()=>undefined;mix=()=>undefined;
}}));
afterEach(cleanup);
async function setup() {
  let edits:EditCommand[]=[],cursor=0;const snapshot=()=>({project:{...blankProject(),edits:edits.slice(0,cursor)},canUndo:cursor>0,canRedo:cursor<edits.length,dirty:cursor>0,path:null});
  const bridge:NativeBridge={snapshot:async()=>snapshot(),readDocument:async()=>({project:blankProject(),path:null,token:'open'}),createBlankDocument:async()=>({project:blankProject(),path:null,token:'blank'}),replaceProject:async()=>{edits=[];cursor=0;return snapshot();},
    applyEdit:async command=>{edits=edits.slice(0,cursor);edits.push(command);cursor++;return snapshot();},undo:async()=>{cursor--;return snapshot();},redo:async()=>{cursor++;return snapshot();},saveProject:async()=>null,exportGp:async()=>false,askUnsaved:async()=>'discard',confirmExport:async()=>false};
  const controller=await DocumentController.create(bridge);render(<App controller={controller}/>);return controller;
}
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const trackLabel='Tuning (notes, high to low)',staffLabel='Staff tuning (notes, high to low)';
it('App retunes from note names and refreshes both fields and string labels through undo redo',async()=>{
  const controller=await setup();expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');
  expect(within(screen.getByLabelText('String')).getByRole('option',{name:'6 · E4'})).toHaveValue('6');
  change(trackLabel,'Eb4 B3 G3 D3 A2 E2');click('Apply tuning');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning[0]).toBe(63));
  expect(screen.getByLabelText(trackLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2');expect(screen.getByLabelText(staffLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2');expect(within(screen.getByLabelText('String')).getByRole('option',{name:'6 · D#4'})).toHaveValue('6');
  click('Undo');await waitFor(()=>expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2'));expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');
  click('Redo');await waitFor(()=>expect(screen.getByLabelText(staffLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2'));
  change(staffLabel,'E4 B3 G3 D3 A2 Db2');click('Apply staff settings');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning.at(-1)).toBe(37));
  expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 C#2');expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 C#2');expect(within(screen.getByLabelText('String')).getByRole('option',{name:'1 · C#2'})).toHaveValue('1');
  click('Undo');await waitFor(()=>expect(screen.getByLabelText(staffLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2'));
});
it('App invalid tuning notes leave music history and selection unchanged',async()=>{
  const controller=await setup(),before=controller.getState().snapshot.project,score=controller.getState().score;
  for(const [label,button,text] of [[trackLabel,'Apply tuning','E4 bad'],[staffLabel,'Apply staff settings','C-2']]) {
    change(label,text);click(button);expect(screen.getByLabelText(label)).toHaveValue(text);expect(screen.getByRole('alert')).toHaveTextContent(/note|C-1|G9/);expect(controller.getState().snapshot.project).toEqual(before);expect(controller.getState().score).toBe(score);expect(screen.getByLabelText('String')).toHaveValue('6');change(label,'E4 B3 G3 D3 A2 E2');
  }
});
it('App presets fill drafts only and rejected string counts preserve the draft, notes and history',async()=>{
  const controller=await setup();await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3});
  const before=controller.getState().snapshot.project;change('Tuning preset','bass-6-standard-b');expect(screen.getByLabelText(trackLabel)).toHaveValue('C3 G2 D2 A1 E1 B0');expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');expect(controller.getState().snapshot.project).toBe(before);
  click('Apply tuning');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning).toEqual([48,43,38,33,28,23]));expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('bass-6-standard-b');
  const applied=controller.getState(),note=applied.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(note.string).toBe(6);expect(note.fret).toBe(3);
  change('Tuning preset','guitar-9-standard-csharp');click('Apply tuning');await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Retuning must keep the current string count.'));expect(controller.getState().score).toBe(applied.score);expect(controller.getState().snapshot.project).toBe(applied.snapshot.project);expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2 B1 F#1 C#1');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-standard-csharp');
  change('Staff tuning preset','bass-4-standard-e');click('Apply staff settings');await waitFor(()=>expect(controller.getState().busy).toBe(false));expect(controller.getState().score).toBe(applied.score);expect(screen.getByLabelText(staffLabel)).toHaveValue('G2 D2 A1 E1');
});
it('App new-track presets distinguish six-string bass from guitar and refresh across selection and Open',async()=>{
  const controller=await setup(),before=controller.getState().snapshot.project;change('New track name','Bass six');change('New track tuning preset','bass-6-standard-b');expect(controller.getState().snapshot.project).toBe(before);expect(screen.getByLabelText('New track tuning')).toHaveValue('C3 G2 D2 A1 E1 B0');change('MIDI instrument','25');expect(screen.getByLabelText('New track tuning')).toHaveValue('C3 G2 D2 A1 E1 B0');change('MIDI instrument','33');click('Add track');await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(2));click('Track 2: Bass six');expect(screen.getByLabelText('Tuning preset')).toHaveValue('bass-6-standard-b');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('bass-6-standard-b');
  change('Tuning preset','custom');expect(screen.getByLabelText('Tuning preset')).toHaveValue('custom');click('Track 1: Guitar');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-6-standard-e');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-6-standard-e');click('Track 2: Bass six');expect(screen.getByLabelText('Tuning preset')).toHaveValue('bass-6-standard-b');
  click('Open');await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(1));expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-6-standard-e');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-6-standard-e');
});
it('App nine-string guitar presets commit through staff history and Custom stays editable',async()=>{
  const controller=await setup();change('New track name','Guitar nine');change('New track tuning preset','guitar-9-standard-csharp');change('MIDI instrument','25');click('Add track');await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(2));click('Track 2: Guitar nine');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-standard-csharp');
  change('Staff tuning preset','guitar-9-drop-b');expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(25);click('Apply staff settings');await waitFor(()=>expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(23));expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-drop-b');click('Undo');await waitFor(()=>expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-9-standard-csharp'));click('Redo');await waitFor(()=>expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-drop-b'));
  change('Staff tuning preset','custom');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('custom');change(staffLabel,'E4 B3 G3 D3 A2 E2 B1 F#1 D1');click('Apply staff settings');await waitFor(()=>expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(26));expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('custom');
  change('Staff tuning preset','guitar-9-standard-csharp');click('Add staff');await waitFor(()=>expect(controller.getState().score.tracks[1].staves).toHaveLength(2));expect(controller.getState().score.tracks[1].staves[1].tuning).toEqual([64,59,55,50,45,40,35,30,25]);expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(26);
});
