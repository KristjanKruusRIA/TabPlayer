// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { NativePlaybackController } from '../audio/NativePlaybackController';
import type { NativeAudioBridge } from '../audio/bridge';
import type { EditCommand } from '../edit-types';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { MixerView } from './MixerView';

beforeEach(()=>{vi.useFakeTimers();});
afterEach(()=>{cleanup();vi.useRealTimers();});

const sized=(element:HTMLElement)=>{element.getBoundingClientRect=()=>({top:100,left:0,right:36,bottom:234,height:134,width:36,x:0,y:100,toJSON:()=>({})});};
const settle=()=>act(async()=>{await vi.advanceTimersByTimeAsync(200);});

/** The real player against a fake native bridge and a host that takes edits the way the app does: the edit settles after
 * a delay, and the newest document is ahead of the one the player last loaded until the host loads it. */
async function rig() {
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  let project=blankProject(),built=buildDocument(project);
  const edits:EditCommand[]=[],editDelayMs=40;
  const player:NativePlaybackController=new NativePlaybackController({
    bridge,
    latestMix:id=>built.settings.mixes[id],
    onEdit:async command=>{
      edits.push(command);
      await new Promise(resolve=>setTimeout(resolve,editDelayMs));
      const next=previewEdit(project,command,built);project=next.project;built=next;
      // The host loads the newer document later, as an effect after rendering.
      setTimeout(()=>{void player.loadDocument(project,built,0,1);},20);
    },
  });
  await player.loadDocument(project,built,0,1);
  const id=trackIdentity(built.score.tracks[0]);
  const gains=()=>vi.mocked(bridge.setMix).mock.calls.map(call=>call[0].mixes[id]?.gain);
  return {bridge,player,edits,gains,view:()=><MixerView score={built.score} selected={0} busy={false} onSelect={()=>{}} player={player}/>};
}

it('is heard while a fader moves, saved as one undoable edit on release, and never steps back to the old level',async()=>{
  const {bridge,edits,gains,view}=await rig();
  const mounted=render(view());
  const fader=screen.getByRole('slider',{name:'Volume Guitar'});sized(fader);
  const thumb=fader.querySelector('.tp-fader-thumb')!;
  const before=vi.mocked(bridge.setMix).mock.calls.length;

  fireEvent.pointerDown(thumb,{clientY:100,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:136,pointerId:1});
  await settle();
  // 36 px up-to-down of 120 px of travel is -0.3 from full level: heard now, before the button comes up, and nothing recorded.
  expect(gains().at(-1)).toBe(.7);
  expect(vi.mocked(bridge.setMix).mock.calls.length).toBeGreaterThan(before);
  expect(edits).toHaveLength(0);
  fireEvent.pointerMove(thumb,{clientY:148,pointerId:1});
  await settle();
  expect(gains().at(-1)).toBe(.6);expect(edits).toHaveLength(0);
  expect(bridge.prepare).toHaveBeenCalledTimes(1);

  fireEvent.pointerUp(thumb,{clientY:148,pointerId:1});
  // One edit for the whole drag, and the fader stays where it was left while the edit is on its way.
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject({type:'setTrackMix',mix:{gain:.6}});
  expect(fader).toHaveAttribute('aria-valuenow','0.6');
  await settle();
  mounted.rerender(view());
  expect(fader).toHaveAttribute('aria-valuenow','0.6');
  expect(edits).toHaveLength(1);
  // The sound after the drag is the saved one, and it was never sent at the old level after the drag began.
  expect(gains().at(-1)).toBe(.6);
  const sentSinceDrag=gains().slice(before);
  expect(sentSinceDrag).not.toContain(1);
  expect(sentSinceDrag.every(gain=>gain===.7||gain===.6)).toBe(true);
});

it('puts the sound back when a drag is cancelled, and records nothing',async()=>{
  const {edits,gains,view}=await rig();
  render(view());
  const fader=screen.getByRole('slider',{name:'Volume Guitar'});sized(fader);
  const thumb=fader.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:100,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:136,pointerId:1});
  await settle();expect(gains().at(-1)).toBe(.7);
  fireEvent.keyDown(fader,{key:'Escape'});
  await settle();
  expect(edits).toHaveLength(0);expect(gains().at(-1)).toBe(1);
  expect(fader).toHaveAttribute('aria-valuenow','1');
});

it('records one edit per pan key press, and pressing toward the value it already has records nothing',async()=>{
  const {edits,view}=await rig();
  render(view());
  const pan=screen.getByRole('slider',{name:'Pan Guitar'});
  fireEvent.keyDown(pan,{key:'ArrowRight'});
  await settle();
  expect(edits).toHaveLength(1);expect(edits[0]).toMatchObject({type:'setTrackMix',mix:{pan:.05}});
  fireEvent.keyDown(pan,{key:'Home'});fireEvent.keyDown(pan,{key:'Home'});
  await settle();
  expect(edits).toHaveLength(2);
});
