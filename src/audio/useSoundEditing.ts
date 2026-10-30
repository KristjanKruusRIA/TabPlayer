import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type React from 'react';
import { chainOrder, completeSound, defaultEffects, effectBlocks, laterFields } from '../document-settings';
import type { EditCommand, EffectBlock, FxSettings, TrackSound } from '../edit-types';
import type { NativePlaybackController } from './NativePlaybackController';
import type { AudioDeviceInfo } from './bridge';
import { factorySound, factorySounds } from './factory-sounds';
import { copyPedal, copySound, deleteSoundPreset, renameSoundPreset, saveSoundPreset, soundClipboard, soundLibrary, subscribeSoundClipboard, subscribeSoundLibrary } from './sound-library';
import { blockNames, presetName, soundPreset, voiceNames } from './sound-model';
import type { VoiceId } from './sound-model';

const noSubscribe=()=>()=>{},noState=()=>null;

/** A pedalboard's effects and how to change them: the track's own, or the second one after it. A second board
 * left with no pedal switched on is removed. */
export interface Board {effects:FxSettings;second:boolean;name:(label:string)=>string;write:(change:(effects:FxSettings)=>void)=>Promise<boolean>;
  /** The whole sound as it would be after `change`, without recording or playing anything. */
  build:(change:(effects:FxSettings)=>void)=>TrackSound}
export interface SoundEditingInput {trackId:string;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean;shown?:boolean}

/** Everything the Sound task does to a track's sound: each change is one undoable `setTrackSound` edit, a preview
 * never records one, and the same logic serves the inspector panel and the full-area rig. */
const liveEveryMs=70;
export function useSoundEditing({trackId,sound,onEdit,playback,busy=false,shown=true}:SoundEditingInput) {
  const playbackState=useSyncExternalStore(playback?.subscribe??noSubscribe,playback?.getState??noState);
  const current=completeSound(sound??soundPreset('gm'));const [devices,setDevices]=useState<AudioDeviceInfo[]>([]);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let alive=true;if(playback)void playback.devices().then(items=>{if(alive)setDevices(items);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[playback]);
  /** Records `next` as one undoable edit; resolves to whether it was accepted. */
  const record=(next:TrackSound)=>Promise.resolve(onEdit({type:'setTrackSound',trackId,sound:next})).then(()=>true,e=>{setError(String(e));return false;});
  // Hosts may give a playback surface without sound previews.
  const previewer=playback&&typeof playback.soundPreview==='function'?playback:null;
  const [previewChoice,setPreviewChoice]=useState(''),[previewLabel,setPreviewLabel]=useState(''),previewRequest=useRef(0),previewSelect=useRef<HTMLSelectElement>(null);
  // The controller may end a preview itself, with its track or document, so it decides what is shown.
  const playing=previewer?.soundPreview(),activePreview=playing?.track===trackId?playing:null,showingPreview=!!previewChoice&&!!activePreview;
  /** Ends this track's preview; a preview still being started is dropped. */
  const endPreview=()=>{previewRequest.current++;setPreviewChoice('');return previewer&&previewer.soundPreview()?.track===trackId?Promise.resolve(previewer.previewSound(trackId,null)).catch(e=>setError(String(e))):Promise.resolve();};
  /** Applies `next` as one undoable edit. A preview ends at once, so the edit is what plays and edits keep their order. */
  const save=(next:TrackSound)=>{
    // A drag being heard ends once its edit is recorded, so the sound never steps back to the old one in between.
    const heard=live.current.active;
    if(!heard&&(previewChoice||activePreview)){void endPreview();setStatus('Preview ended.');}
    return record(next).then(ok=>{if(heard)void endLive();return ok;});
  };
  const first:Board={effects:current.effects,second:false,name:label=>label,
    build:change=>{const next=structuredClone(current);change(next.effects);return next;},write:change=>save(first.build(change))};
  const second:Board|null=current.effects.second?{effects:current.effects.second,second:true,name:label=>`Second pedalboard: ${label}`,
    build:change=>{const next=structuredClone(current),board=next.effects.second!;change(board);if(effectBlocks.every(block=>!board[block].enabled))delete next.effects.second;return next;},
    write:change=>save(second!.build(change))}:null;
  /** Sets one field of `block`. A field added after sounds could be saved is left out while 0, as the native player writes it. */
  const setField=(effects:FxSettings,block:EffectBlock,key:string,value:unknown)=>{if(value===0&&laterFields(block).includes(key))delete (effects[block] as unknown as Record<string,unknown>)[key];else Object.assign(effects[block],{[key]:value});};
  const fx=(board:Board,block:EffectBlock,key:string,value:unknown)=>board.write(effects=>setField(effects,block,key,value));
  // Hearing a drag. The sound being dragged plays through the preview path, which the player applies as a mix change on the
  // running plan (no re-preparation, 10 ms crossfade, newest settings win), at most once every `liveEveryMs`. Nothing is
  // recorded until the drag ends.
  // Each request names the track it is for, so what is still in flight when the track changes cannot reach another one.
  const live=useRef<{active:boolean;track:string|null;pending:{track:string;sound:TrackSound}|null;sending:boolean;timer:ReturnType<typeof setTimeout>|null;lastSent:number}>({active:false,track:null,pending:null,sending:false,timer:null,lastSent:0});
  const liveApi=useRef({send:()=>{},schedule:()=>{},end:()=>Promise.resolve() as Promise<void>});
  const sendLive=()=>{
    const state=live.current;state.timer=null;
    if(!state.active||state.sending||!state.pending||!previewer)return;
    const {track,sound}=state.pending;state.pending=null;state.sending=true;state.lastSent=Date.now();
    void Promise.resolve(previewer.previewSound(track,sound)).catch(e=>setError(String(e))).finally(()=>{state.sending=false;if(state.active&&state.pending)liveApi.current.schedule();});
  };
  const scheduleLive=()=>{
    const state=live.current;if(state.timer||state.sending)return;
    const wait=Math.max(0,liveEveryMs-(Date.now()-state.lastSent));
    if(wait===0)liveApi.current.send();else state.timer=setTimeout(()=>liveApi.current.send(),wait);
  };
  /** Plays `next` in place of the track's sound while a control is being dragged. */
  const hear=(next:TrackSound)=>{
    if(!previewer||busy||showingPreview)return;
    const state=live.current;
    // A drag that began on another track ends first; its sound is never played on this one.
    if(state.active&&state.track!==trackId){state.pending=null;void liveApi.current.end();}
    state.active=true;state.track=trackId;state.pending={track:trackId,sound:structuredClone(next)};scheduleLive();
  };
  /** Stops hearing a drag and goes back to the saved sound of the track it was for. Resolves once the player has. */
  const endLive=()=>{
    const state=live.current;if(!state.active)return Promise.resolve();
    const track=state.track;state.active=false;state.pending=null;if(state.timer){clearTimeout(state.timer);state.timer=null;}
    const settle=()=>previewer&&track!==null&&!previewChoice&&previewer.soundPreview()?.track===track?Promise.resolve(previewer.previewSound(track,null)).catch(e=>setError(String(e))):Promise.resolve();
    // A request still in flight finishes first, so the old sound cannot come back after the end.
    return state.sending?new Promise<void>(resolve=>{const wait=()=>{if(state.sending)setTimeout(wait,5);else resolve(settle());};wait();}).then(()=>undefined):settle().then(()=>undefined);
  };
  liveApi.current={send:sendLive,schedule:scheduleLive,end:endLive};
  /** Plays one field of `block` at `value` for as long as a control is dragged. */
  const hearField=(board:Board,block:EffectBlock,key:string,value:unknown)=>hear(board.build(effects=>setField(effects,block,key,value)));
  /** Puts a copy of `block` from the track's pedalboard on the second one, switched on; the second board starts with every pedal off. */
  const duplicate=(block:EffectBlock)=>{const next=structuredClone(current),board=next.effects.second??=defaultEffects();(board as unknown as Record<string,unknown>)[block]={...structuredClone(current.effects[block]),enabled:true};void save(next).then(ok=>{if(ok)setStatus(`Duplicated the ${blockNames[block]} pedal onto the second pedalboard.`);});};
  /** Quarter notes per cycle when `block`'s rate follows the tempo, or 0 for its free rate. */
  const syncOf=(board:Board,block:EffectBlock)=>Number((board.effects[block] as {syncQuarterNotes?:number}).syncQuarterNotes??0);
  /** Sets `block` to follow the tempo at `value` quarter notes per cycle; 0 returns it to its free rate, which saves no sync. */
  const sync=(board:Board,block:EffectBlock,value:number)=>board.write(effects=>{const settings=effects[block] as {syncQuarterNotes?:number};if(value)settings.syncQuarterNotes=value;else delete settings.syncQuarterNotes;});
  const order=chainOrder(current.effects);
  const movedBlock=useRef<{block:EffectBlock;step:-1|1;from:string}|null>(null);
  /** Puts `block` at place `to` along the chain, as one edit; the default order is saved as no order. */
  const place=(block:EffectBlock,to:number)=>{
    const at=order.indexOf(block);if(at<0||to<0||to>=order.length||to===at)return;
    const next=structuredClone(current),names=[...order];names.splice(at,1);names.splice(to,0,block);
    if(names.every((name,index)=>name===effectBlocks[index]))delete next.effects.order;else next.effects.order=names;
    movedBlock.current={block,step:to>at?1:-1,from:order.join()};void save(next).then(ok=>{if(ok)setStatus(`${blockNames[block]} is now ${to+1} of ${names.length} in the chain.`);});
  };
  /** Swaps `block` with its neighbour `step` places along the chain. */
  const move=(block:EffectBlock,step:-1|1)=>place(block,order.indexOf(block)+step);
  const library=useSyncExternalStore(subscribeSoundLibrary,soundLibrary),clipboard=useSyncExternalStore(subscribeSoundClipboard,soundClipboard);
  const [chosen,setChosen]=useState(''),[name,setName]=useState(''),[status,setStatus]=useState(''),[confirming,setConfirming]=useState(false);
  const entry=library.find(item=>item.name===chosen),savedSelect=useRef<HTMLSelectElement>(null);
  const [factoryChoice,setFactoryChoice]=useState(''),factory=factorySounds.find(item=>item.id===factoryChoice),factoryNote=useId();
  /** Applies a named factory sound to the track, keeping its instrument. */
  const applyFactoryId=(id:string)=>{const found=factorySounds.find(item=>item.id===id);if(!found)return;const applied=found.name,appliedTo=trackId;void save(factorySound(found.id,current.voiceId)!).then(ok=>{if(ok&&shownTrack.current===appliedTo)setStatus(`Applied “${applied}”.`);});};
  const applyFactory=()=>applyFactoryId(factoryChoice);
  /** Applies a saved sound by name. */
  const applySaved=(savedName:string)=>{const item=library.find(candidate=>candidate.name===savedName);if(!item)return;const applied=item.name,appliedTo=trackId;void save(structuredClone(item.sound)).then(ok=>{if(ok&&shownTrack.current===appliedTo)setStatus(`Applied “${applied}”.`);});};
  // Messages and an open confirmation belong to the track they were shown for.
  const shownTrack=useRef(trackId);
  // A drag being heard ends with its track, and with the view.
  useEffect(()=>()=>{void liveApi.current.end();},[trackId]);
  useEffect(()=>{shownTrack.current=trackId;setStatus('');setConfirming(false);setPreviewChoice('');setFactoryChoice('');},[trackId]);
  // A preview lasts only while its track's panel is shown.
  useEffect(()=>()=>{if(previewer?.soundPreview()?.track===trackId)void Promise.resolve(previewer.previewSound(trackId,null)).catch(()=>{});},[previewer,trackId]);
  useEffect(()=>{if(!shown&&previewer?.soundPreview()?.track===trackId){previewRequest.current++;setPreviewChoice('');void Promise.resolve(previewer.previewSound(trackId,null)).catch(e=>setError(String(e)));}},[shown,previewer,trackId]);
  // A preview the player ended itself leaves nothing to keep.
  const previewGone=!!previewChoice&&!activePreview;
  useEffect(()=>{if(previewGone)setPreviewChoice('');},[previewGone]);
  /** Starts previewing `value`: `preset:`, `factory:` or `saved:` followed by the id or name; an empty value ends the preview. */
  const choosePreview=(value:string)=>{
    if(!previewer)return;
    if(!value){void endPreview().then(()=>setStatus('Back to this track’s sound.'));return;}
    const split=value.indexOf(':'),kind=value.slice(0,split),id=value.slice(split+1),saved=library.find(item=>item.name===id);
    const named=factorySounds.find(item=>item.id===id);
    // A source previews the track's own sound through that source: only the instrument changes.
    const heard=kind==='voice'?{...structuredClone(current),voiceId:id==='auto'?null:id}:kind==='preset'?soundPreset(id as TrackSound['presetId'],current.voiceId):kind==='factory'?factorySound(id,current.voiceId):saved?.sound;
    const label=kind==='voice'?(id==='auto'?'Automatic':voiceNames[id as VoiceId]??id):kind==='preset'?presetName(id):`“${kind==='factory'?named?.name:id}”`;if(!heard)return;
    const request=++previewRequest.current,track=trackId;setPreviewChoice('');
    // A result that arrives after another choice, a cancel or a track change is dropped.
    void Promise.resolve(previewer.previewSound(track,structuredClone(heard))).then(()=>{if(request!==previewRequest.current||shownTrack.current!==track||previewer.soundPreview()?.track!==track)return;setPreviewChoice(value);setPreviewLabel(label);setError(null);setStatus(`Previewing ${label}. Keep it or cancel to go back to this track’s sound.`);},e=>{if(request===previewRequest.current)setError(String(e));});
  };
  /** Where focus returns after a preview is kept or cancelled; set by the surface showing the preview. */
  const previewReturn=useRef<(()=>void)|null>(null);
  const returnFocus=()=>{(previewReturn.current??(()=>previewSelect.current?.focus()))();};
  const cancelPreview=()=>{void endPreview().then(()=>setStatus('Back to this track’s sound.'));returnFocus();};
  const keepPreview=()=>{const kept=previewer?.soundPreview();if(kept?.track!==trackId)return;const label=previewLabel;void record(kept.sound).then(ok=>{if(ok){void endPreview();setStatus(`Kept ${label}.`);}returnFocus();});returnFocus();};
  const escapePreview=(event:React.KeyboardEvent)=>{if(event.key==='Escape'&&showingPreview){event.preventDefault();event.stopPropagation();cancelPreview();}};
  const orphanPreview=showingPreview&&previewChoice.startsWith('saved:')&&!library.some(item=>`saved:${item.name}`===previewChoice);
  const closeConfirm=()=>{setConfirming(false);savedSelect.current?.focus();};
  const report=(result:ReturnType<typeof saveSoundPreset>,done:string)=>{if(!result.ok){setStatus(result.error);return false;}setStatus(result.stored===false?`${done} It is kept until TabPlayer closes, because the sound library could not be stored.`:done);return true;};
  const pastePedal=(board:Board)=>{const pedal=clipboard.pedal;if(!pedal)return;board.write(effects=>{(effects as unknown as Record<string,unknown>)[pedal.block]=structuredClone(pedal.settings);});};
  const copyPedalOf=(board:Board,block:EffectBlock)=>{copyPedal(block,board.effects[block]);setStatus(`Copied the ${blockNames[block]} pedal.`);};
  const copyCurrentSound=()=>{copySound(current);setStatus('Copied this track’s sound.');};
  const pasteSound=()=>{if(clipboard.sound)void save(structuredClone(clipboard.sound));};
  const saveNamed=()=>{const result=saveSoundPreset(name,current);if(report(result,`${result.ok&&result.replaced?'Replaced':'Saved'} “${name.trim()}”.`)){setChosen(name.trim());setName('');}};
  const renameChosen=()=>{if(entry&&report(renameSoundPreset(entry.name,name),`Renamed “${entry.name}” to “${name.trim()}”.`)){setChosen(name.trim());setName('');}};
  const deleteChosen=()=>{if(entry&&report(deleteSoundPreset(entry.name),`Deleted “${entry.name}”.`))setChosen('');closeConfirm();};
  const selectOutput=(id:string)=>playback?.selectDevice(id||null);
  return {
    playbackState,current,devices,error,setError,status,setStatus,busy,playback:playback??null,record,save,
    trackId,first,second,fx,hearField,hear,endLive,duplicate,syncOf,sync,order,place,move,movedBlock,pastePedal,copyPedalOf,copyCurrentSound,pasteSound,clipboard,library,
    chosen,setChosen,name,setName,entry,confirming,setConfirming,savedSelect,closeConfirm,saveNamed,renameChosen,deleteChosen,applySaved,
    factoryChoice,setFactoryChoice,factory,factoryNote,applyFactory,applyFactoryId,
    previewer,previewChoice,previewLabel,showingPreview,previewSelect,previewReturn,choosePreview,cancelPreview,keepPreview,escapePreview,orphanPreview,
    selectOutput,restorePreset:()=>save(soundPreset(current.presetId,current.voiceId)),applyPreset:(id:TrackSound['presetId'])=>save(soundPreset(id,current.voiceId)),setVoice:(voiceId:string|null)=>save({...current,voiceId}),
  };
}
export type SoundEditing=ReturnType<typeof useSoundEditing>;
