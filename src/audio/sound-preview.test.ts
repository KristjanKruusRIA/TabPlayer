import {expect,it,vi} from 'vitest';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge} from './bridge';
import {blankProject} from '../project';
import {buildDocument,previewEdit,trackIdentity} from '../engine';
import {soundPreset} from './SoundPanel';

function fixture(){
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const onEdit=vi.fn();return {bridge,onEdit,player:new NativePlaybackController({bridge,onEdit})};
}
const sent=(bridge:NativeAudioBridge)=>vi.mocked(bridge.setMix).mock.calls.at(-1)?.[0];

it('previews a sound on one track through the native mix without editing the document, and restores it',async()=>{
  const {player,bridge,onEdit}=fixture();const project=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project,built=buildDocument(project);
  await player.loadDocument(project,built,0,1);const [guitar,bass]=built.score.tracks.map(trackIdentity),saved=structuredClone(built.settings);
  const lead=soundPreset('lead');
  await player.previewSound(guitar,lead);
  expect(sent(bridge)?.sounds[guitar]).toEqual(lead);expect(sent(bridge)?.sounds[bass]).toBeUndefined();
  expect(player.soundPreview()).toEqual({track:guitar,sound:lead});
  expect(onEdit).not.toHaveBeenCalled();expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(built.settings).toEqual(saved);
  // The preview is a copy: changing the passed sound afterwards changes nothing.
  lead.effects.delay.mix=.9;expect(player.soundPreview()?.sound.effects.delay.mix).toBe(soundPreset('lead').effects.delay.mix);
  // Another preview replaces it; ending it sends the saved settings again.
  await player.previewSound(guitar,soundPreset('crunch'));expect(sent(bridge)?.sounds[guitar]).toEqual(soundPreset('crunch'));
  await player.previewSound(guitar,null);expect(sent(bridge)).toEqual(saved);expect(player.soundPreview()).toBeNull();
  player.destroy();
});

it('keeps a preview over saved edits, and ends it with its document or track',async()=>{
  const {player,bridge}=fixture();const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}),built=buildDocument(added.project);
  await player.loadDocument(added.project,built,0,1);const bass=trackIdentity(built.score.tracks[1]);
  await player.previewSound(bass,soundPreset('bass'));
  const mixed=previewEdit(added.project,{type:'setTrackMix',trackId:bass,mix:{gain:.5,pan:0,mute:false,solo:false}},built);
  await player.loadDocument(mixed.project,mixed,0,1);
  expect(sent(bridge)?.mixes[bass].gain).toBe(.5);expect(sent(bridge)?.sounds[bass]).toEqual(soundPreset('bass'));
  const removed=previewEdit(mixed.project,{type:'removeTrack',track:1},mixed);await player.loadDocument(removed.project,removed,0,1);
  expect(player.soundPreview()).toBeNull();
  await player.previewSound(trackIdentity(removed.score.tracks[0]),soundPreset('lead'));
  const fresh=blankProject();await player.loadDocument(fresh,buildDocument(fresh),0,2);expect(player.soundPreview()).toBeNull();
  player.destroy();
});

it('ends a kept preview with the edited document even when the edit is still loading',async()=>{
  const {player,bridge}=fixture();const project=blankProject(),built=buildDocument(project);
  await player.loadDocument(project,built,0,1);const guitar=trackIdentity(built.score.tracks[0]);
  await player.previewSound(guitar,soundPreset('lead'));
  // Keep records the sound, then ends the preview while the host's load of the edited document waits.
  const kept=previewEdit(project,{type:'setTrackSound',trackId:guitar,sound:soundPreset('lead')},built);
  await Promise.all([player.loadDocument(kept.project,kept,0,1),player.previewSound(guitar,null)]);
  expect(sent(bridge)?.sounds[guitar]).toEqual(soundPreset('lead'));
  // A later reload, such as focus, still uses the edited document.
  await player.setFocus(guitar,.5);expect(sent(bridge)?.sounds[guitar]).toEqual(soundPreset('lead'));
  player.destroy();
});

it('refuses previews of unknown tracks or sounds the native player would reject',async()=>{
  const {player,bridge}=fixture();const project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built,0,1);
  const guitar=trackIdentity(built.score.tracks[0]),bad=soundPreset('lead');bad.effects.delay.quarterNotes=3;
  await expect(player.previewSound('base/9',soundPreset('lead'))).rejects.toThrow('Select an existing track.');
  await expect(player.previewSound(guitar,bad)).rejects.toThrow('Invalid effect parameter.');
  expect(player.soundPreview()).toBeNull();expect(bridge.setMix).not.toHaveBeenCalled();
  player.destroy();
});

it('sends a newer document last when a mix change queued during preparation is applied',async()=>{
  let releaseStatus:(()=>void)|null=null,gate=false;
  const {bridge,onEdit}=fixture();bridge.status=vi.fn(()=>gate?new Promise<null>(resolve=>{releaseStatus=()=>resolve(null);}):Promise.resolve(null));
  const player=new NativePlaybackController({bridge,onEdit});
  const first=blankProject();await player.loadDocument(first,buildDocument(first),0,1);
  const fresh=blankProject(),freshBuilt=buildDocument(fresh),guitar=trackIdentity(freshBuilt.score.tracks[0]);gate=true;
  const preparing=player.loadDocument(fresh,freshBuilt,0,1);await new Promise(resolve=>setTimeout(resolve,0));
  const mix=(gain:number)=>({gain,pan:0,mute:false,solo:false});
  const queued=previewEdit(fresh,{type:'setTrackMix',trackId:guitar,mix:mix(.2)},freshBuilt);await player.loadDocument(queued.project,queued,0,1);
  const newer=previewEdit(queued.project,{type:'setTrackMix',trackId:guitar,mix:mix(.9)},queued);
  gate=false;releaseStatus!();const latest=player.loadDocument(newer.project,newer,0,1);
  await preparing;await latest;await new Promise(resolve=>setTimeout(resolve,10));
  expect(sent(bridge)?.mixes[guitar].gain).toBe(.9);
  await player.setFocus(guitar,.5);expect(sent(bridge)?.mixes[guitar].gain).toBe(.9);
  player.destroy();
});
