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
  const bridge:NativeBridge={snapshot:async()=>snapshot(),readDocument:async()=>null,createBlankDocument:async()=>({project:blankProject(),path:null,token:'blank'}),replaceProject:async()=>snapshot(),
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
