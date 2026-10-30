import {expect,it,vi} from 'vitest';
import {DocumentController} from './controller';
import type {NativeBridge} from './bridge';
import {blankProject} from './project';
import {defaultMix} from './document-settings';
import type {BackingSettings,BackingProcessing} from './edit-types';
import type {DocumentSnapshot} from './workspace/types';
const assetId='a'.repeat(64),neutral:BackingProcessing={semitones:0,cents:0,filter:'none'};
const backing=():BackingSettings=>({assetId,offsetMs:120,anchors:[],mix:defaultMix(),referenceSync:{entryAudioMs:1120,exitAudioMs:3120}});
async function harness(initial=backing()){
 let current=blankProject(),revision=0;current.assets[assetId]={filename:'backing.wav',mediaType:'audio/wav',byteLength:44};current.edits=[{type:'setBacking',backing:initial}];
 const record=():DocumentSnapshot=>({documentId:'score-a',revision,snapshot:{project:structuredClone(current),path:null,dirty:false,canUndo:true,canRedo:true}});
 const bridge:NativeBridge={documentId:'score-a',snapshot:async()=>record(),cancelAsset:async()=>true,applyEdit:vi.fn(async command=>{current={...current,edits:[...current.edits,structuredClone(command)]};revision++;return record();}),undo:async()=>record(),redo:async()=>record(),setLock:vi.fn() as never,saveProject:async()=>null,exportGp:async()=>true,readBackingAsset:vi.fn(async()=>new Uint8Array()),askUnsaved:async()=> 'discard',confirmExport:async()=>true};
 return {bridge,controller:await DocumentController.create(bridge)};
}
it.each([undefined,null,neutral])('default-equivalent %j preserves live redo and score identity',async processing=>{const {bridge,controller}=await harness(),before=controller.getState();const next=backing();if(processing!==undefined)next.processing=processing;await controller.edit({type:'setBacking',backing:next});expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);expect(controller.getState().snapshot.canRedo).toBe(true);});
it('identical nonneutral processing preserves redo while changed raw pairs and filters persist',async()=>{const initial={...backing(),processing:{semitones:1,cents:-50,filter:'none'} as BackingProcessing},{bridge,controller}=await harness(initial),before=controller.getState();await controller.edit({type:'setBacking',backing:structuredClone(initial)});expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().snapshot).toBe(before.snapshot);
 for(const processing of [{semitones:0,cents:50,filter:'none'},{semitones:-1,cents:100,filter:'none'},{...neutral,filter:'bassEnhance'}] as BackingProcessing[]){await controller.edit({type:'setBacking',backing:{...initial,processing}});expect(controller.getState().settings.backing).toEqual({...initial,processing});expect(controller.getState().score).toBe(before.score);expect(controller.getState().snapshot.project.assets).toEqual(before.snapshot.project.assets);}expect(bridge.applyEdit).toHaveBeenCalledTimes(3);expect(bridge.readBackingAsset).not.toHaveBeenCalled();});
it.each([undefined,{...neutral,cents:.5},{...neutral,unknown:1},{...neutral,filter:'invalid'}])('validates invalid processing %j before semantic no-op',async processing=>{const {bridge,controller}=await harness(),before=controller.getState();await expect(controller.edit({type:'setBacking',backing:{...backing(),processing} as BackingSettings})).rejects.toThrow();expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().snapshot.canRedo).toBe(true);});
