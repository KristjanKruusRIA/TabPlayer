import {expect,it,vi} from 'vitest';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge} from './bridge';
import {blankProject} from '../project';
import {buildDocument,previewEdit,trackIdentity} from '../engine';

function fixture(onEdit=vi.fn(),latestMix?:(id:string)=>never){
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  return {bridge,onEdit,player:new NativePlaybackController({bridge,onEdit,latestMix})};
}
const sent=(bridge:NativeAudioBridge)=>vi.mocked(bridge.setMix).mock.calls.at(-1)?.[0];

it('plays a dragged mix through the native mix without editing the document, and goes back to the saved mix',async()=>{
  const {player,bridge,onEdit}=fixture();const project=blankProject(),built=buildDocument(project);
  await player.loadDocument(project,built,0,1);const guitar=trackIdentity(built.score.tracks[0]),saved=structuredClone(sent(bridge)??built.settings);
  const calls=vi.mocked(bridge.setMix).mock.calls.length;
  await player.previewMix(0,{gain:.4});
  expect(sent(bridge)?.mixes[guitar]).toMatchObject({gain:.4,pan:0,mute:false});
  await player.previewMix(0,{pan:-.5});
  expect(sent(bridge)?.mixes[guitar]).toMatchObject({gain:1,pan:-.5});
  expect(onEdit).not.toHaveBeenCalled();expect(bridge.prepare).toHaveBeenCalledTimes(1);
  expect(player.mix(built.score.tracks[0])).toMatchObject({volume:1,pan:0});
  await player.previewMix(0,null);
  expect(vi.mocked(bridge.setMix).mock.calls.length).toBe(calls+3);
  expect(sent(bridge)?.mixes[guitar]).toEqual(saved.mixes[guitar]);
  // Ending a preview that is not there sends nothing.
  await player.previewMix(0,null);expect(vi.mocked(bridge.setMix).mock.calls.length).toBe(calls+3);
  player.destroy();
});

it('holds a dragged mix to the range, refuses an unknown track and drops it with its document',async()=>{
  const {player,bridge}=fixture();const project=blankProject(),built=buildDocument(project);
  await player.loadDocument(project,built,0,1);const guitar=trackIdentity(built.score.tracks[0]);
  await player.previewMix(0,{gain:3,pan:-4});expect(sent(bridge)?.mixes[guitar]).toMatchObject({gain:1,pan:-1});
  await expect(player.previewMix(7,{gain:.5})).rejects.toThrow('Select an existing track.');
  const fresh=blankProject();await player.loadDocument(fresh,buildDocument(fresh),0,2);
  // A new document is prepared afresh, without the preview.
  expect(bridge.prepare).toHaveBeenCalledTimes(2);
  expect(vi.mocked(bridge.prepare).mock.calls[1][1].mixes[guitar]?.pan??0).toBe(0);
  player.destroy();
});

it('settles each mix edit when the edit is accepted, and reads back the newest mix, so a control does not step back',async()=>{
  let accepted:()=>void=()=>{};
  const onEdit=vi.fn(()=>new Promise<void>(resolve=>{accepted=resolve;}));
  const project=blankProject(),built=buildDocument(project),guitar=trackIdentity(built.score.tracks[0]);
  let newest:{gain:number;pan:number;mute:boolean;solo:boolean}|undefined;
  const {player}=fixture(onEdit,((id:string)=>id===guitar?newest:undefined) as never);
  await player.loadDocument(project,built,0,1);
  let settled=false;const done=player.setTrackVolume(0,.3).then(()=>{settled=true;});
  await Promise.resolve();expect(settled).toBe(false);
  expect(onEdit).toHaveBeenCalledWith({type:'setTrackMix',trackId:guitar,mix:expect.objectContaining({gain:.3})});
  // The host takes the edit: the newest document has the new mix before the loaded one does.
  newest={gain:.3,pan:0,mute:false,solo:false};accepted();await done;
  expect(settled).toBe(true);expect(player.mix(built.score.tracks[0])?.volume).toBe(.3);
  player.destroy();
});

it('settles a refused mix edit too, reporting why through the player state',async()=>{
  const {player}=fixture(vi.fn(async()=>{throw new Error('Edit refused.');}));
  const project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built,0,1);
  await expect(player.setPan(0,.2)).resolves.toBeUndefined();
  expect(player.getState().error).toContain('Edit refused.');
  player.destroy();
});

it('keeps a dragged mix until the player holds the accepted edit, so it never steps back; a refused edit ends it',async()=>{
  const project=blankProject(),built=buildDocument(project),guitar=trackIdentity(built.score.tracks[0]);
  const {player,bridge,onEdit}=fixture(vi.fn(async()=>{}));
  await player.loadDocument(project,built,0,1);
  const gain=()=>sent(bridge)?.mixes[guitar]?.gain;
  await player.previewMix(0,{gain:.4});await player.setTrackVolume(0,.4);
  // Accepted, but the newer document is not loaded yet: the sound stays at .4 rather than going back to 1.
  expect(gain()).toBe(.4);
  const edited=previewEdit(project,onEdit.mock.calls[0][0],built);
  await player.loadDocument(edited.project,edited,0,1);
  expect(gain()).toBe(.4);
  // The preview is gone: a later change to the saved mix is heard as it is.
  const louder=previewEdit(edited.project,{type:'setTrackMix',trackId:guitar,mix:{gain:.9,pan:0,mute:false,solo:false}},edited);
  await player.loadDocument(louder.project,louder,0,1);expect(gain()).toBe(.9);
  // A refused edit puts the saved mix back.
  const refusing=fixture(vi.fn(async()=>{throw new Error('Edit refused.');}));
  await refusing.player.loadDocument(project,built,0,1);
  await refusing.player.previewMix(0,{gain:.2});await refusing.player.setTrackVolume(0,.2);
  expect(sent(refusing.bridge)?.mixes[guitar]?.gain).toBe(1);
  player.destroy();refusing.player.destroy();
});
