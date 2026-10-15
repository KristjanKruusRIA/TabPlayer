import { beforeEach,expect,it,vi } from 'vitest';
import { model } from '@coderline/alphatab';
import type { HarmonyChord,HarmonyLibrary,HarmonyLibraryEntry } from '../editor/harmony-types';
import { music } from '../editor/fixtures';
import { blankProject } from '../project';
import { getHarmonyChord,setHarmonyChordSource } from './chord-source';
import { createHarmonyLibraryEntry,readHarmonyLibrary,putHarmonyLibraryEntry,removeHarmonyLibraryEntry,recallHarmonyLibraryEntry } from './library';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
const id='ca4af764-86e2-4ddd-9c26-a1be3368bdf7';
const manual=():HarmonyChord=>({name:' exact legacy name ',nameMode:'manual',recipe:null,firstFret:0,
  frets:[0,19,-1,2,30,0],fingers:[-2,1,-1,0,4,-2],barreFrets:[0,19,19],showName:false,showDiagram:false,showFingering:false});
const theory=():HarmonyChord=>({name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},
  firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false});
function staff(tuning=[64,59,55,50,45,40],capo=0,transposition=0) {
  const value=new model.Staff();value.stringTuning.tunings=[...tuning];value.capo=capo;value.transpositionPitch=transposition;return value;
}
const entry=():HarmonyLibraryEntry=>({id,label:'Personal chord',chord:manual(),tuning:[64,59,55,50,45,40],capo:0,transposition:0});
const library=(entries:HarmonyLibraryEntry[]=[]):HarmonyLibrary=>({format:'TabPlayerHarmonyLibrary',version:1,entries});
beforeEach(()=>invoke.mockReset());

it('uses_only_typed_library_commands_and_propagates_native_failures',async()=>{
  const record=entry(),stored=library([record]);invoke.mockResolvedValueOnce(library()).mockResolvedValueOnce(stored).mockResolvedValueOnce(library());
  expect(await readHarmonyLibrary()).toEqual(library());expect(await putHarmonyLibraryEntry(record)).toEqual(stored);expect(await removeHarmonyLibraryEntry(id)).toEqual(library());
  expect(invoke.mock.calls).toEqual([['harmony_library_read'],['harmony_library_put',{entry:record}],['harmony_library_remove',{id}]]);
  invoke.mockRejectedValueOnce(new Error('Corrupt library'));await expect(readHarmonyLibrary()).rejects.toThrow('Corrupt library');
});

it('rejects_invalid_contexts_labels_shapes_ids_and_unknown_native_records',async()=>{
  for(const change of [{label:''},{label:'🎸'.repeat(201)},{tuning:Array(13).fill(60)},{tuning:[60,128]},
    {capo:-1},{capo:128},{transposition:128},{id:'../outside'},{path:'outside.json'},
    {chord:{...manual(),fingers:[5,1,-1,0,4,-2]}}]){
    await expect(putHarmonyLibraryEntry({...entry(),...change} as HarmonyLibraryEntry)).rejects.toThrow();
  }
  await expect(removeHarmonyLibraryEntry('../outside')).rejects.toThrow();expect(invoke).not.toHaveBeenCalled();
  for(const value of [{...library(),path:'outside.json'},library([entry(),{...entry(),id:id.toUpperCase()}]),
    library([{...entry(),chord:{...theory(),name:'Wrong theory name'}}])]){
    invoke.mockResolvedValueOnce(value);await expect(readHarmonyLibrary()).rejects.toThrow();
  }
  invoke.mockResolvedValueOnce(library([{...entry(),label:'🎸'.repeat(200),tuning:[],capo:127,transposition:-127}]));
  expect((await readHarmonyLibrary()).entries[0].label).toBe('🎸'.repeat(200));
});

it.each(['tuning','frets','fingers','barreFrets'] as const)('rejects_sparse_%s_before_native_invocation',async field=>{
  invoke.mockResolvedValue(library());
  for(const entirelySparse of [true,false]){
    const record=entry(),owner=field==='tuning'?record:record.chord,length=field==='barreFrets'?1:6;
    if(entirelySparse)(owner as unknown as Record<string,unknown>)[field]=Array(length);
    else delete (owner as unknown as Record<string,number[]>)[field][length-1];
    await expect(putHarmonyLibraryEntry(record)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  }
});

it('recalls_matching_legacy_manual_and_untuned_name_only_snapshots_as_independent_drafts',()=>{
  const record=entry(),before=structuredClone(record),destination=staff(),staffBefore=JSON.stringify(destination);
  const draft=recallHarmonyLibraryEntry(record,destination);expect(draft).toEqual(record.chord);
  draft.frets[0]=12;draft.fingers[0]=4;draft.barreFrets.push(5);expect(record).toEqual(before);expect(JSON.stringify(destination)).toBe(staffBefore);
  const untuned={...record,tuning:[],chord:{...manual(),frets:[],fingers:[]}};
  expect(recallHarmonyLibraryEntry(untuned,staff([]))).toEqual(untuned.chord);
});

it.each(['tuning','capo','offset','count'] as const)('rejects_incompatible_manual_%s_context_before_draft_apply',kind=>{
  const record=entry(),destination=staff();if(kind==='tuning')destination.stringTuning.tunings=[65,59,55,50,45,40];
  else if(kind==='capo')destination.capo=1;else if(kind==='offset')destination.transpositionPitch=1;else destination.stringTuning.tunings=[];
  const before=JSON.stringify(destination);expect(()=>recallHarmonyLibraryEntry(record,destination)).toThrow(/context|match|compatible/i);
  expect(JSON.stringify(destination)).toBe(before);expect(record).toEqual(entry());
});

it('regenerates_and_independently_checks_theory_recall_in_a_different_sounding_context',()=>{
  const record={...entry(),chord:theory()},destination=staff([64,59,55,50,45,40],2,12),before=structuredClone(record),staffBefore=JSON.stringify(destination);
  const draft=recallHarmonyLibraryEntry(record,destination);expect(draft.name).toBe('C');expect(draft.recipe).toEqual(theory().recipe);
  expect(draft.showName).toBe(false);expect(draft.showFingering).toBe(false);
  const pitches=draft.frets.flatMap((fret,index)=>fret<0?[]:[destination.tuning[index]+2-12+fret]);
  expect([...new Set(pitches.map(pitch=>pitch%12))].sort((a,b)=>a-b)).toEqual([0,4,7]);
  expect(pitches.every(pitch=>pitch>=0&&pitch<=127)).toBe(true);expect(record).toEqual(before);expect(JSON.stringify(destination)).toBe(staffBefore);
  expect(()=>recallHarmonyLibraryEntry(record,staff([127]))).toThrow(/shape|search|tuned/i);
});

it('saving_a_stale_context_uses_effective_manual_snapshot_without_altering_raw_provenance',()=>{
  const score=music(),owner=score.tracks[0].staves[0],raw=theory(),chord=new model.Chord();
  Object.assign(chord,{name:raw.name,firstFret:raw.firstFret,strings:[...raw.frets],barreFrets:[],showName:raw.showName,showDiagram:raw.showDiagram,showFingering:raw.showFingering});
  owner.addChord('owned',chord);setHarmonyChordSource(chord,raw);owner.capo=1;
  const before=model.JsonConverter.scoreToJson(score),rawBefore=structuredClone(raw),saved=createHarmonyLibraryEntry(id,'Saved',raw,owner);
  expect(saved.chord).toEqual({...raw,nameMode:'manual',recipe:null});expect(saved.capo).toBe(1);expect(raw).toEqual(rawBefore);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(getHarmonyChord(chord).nameMode).toBe('manual');
  owner.capo=0;expect(getHarmonyChord(chord)).toEqual(theory());
});

it('library_does_not_dirty_or_change_document_or_emit_document_transport_commands',async()=>{
  const project=blankProject(),score=music(),settings={position:3.25,playing:true},before=JSON.stringify({project,score:model.JsonConverter.scoreToJson(score),settings});
  invoke.mockResolvedValueOnce(library([entry()])).mockResolvedValueOnce(library([{...entry(),label:'Updated'}])).mockResolvedValueOnce(library());
  await putHarmonyLibraryEntry(entry());await putHarmonyLibraryEntry({...entry(),label:'Updated'});await removeHarmonyLibraryEntry(id);
  expect(JSON.stringify({project,score:model.JsonConverter.scoreToJson(score),settings})).toBe(before);
  expect(invoke.mock.calls.map(call=>call[0])).toEqual(['harmony_library_put','harmony_library_put','harmony_library_remove']);
  const record=createHarmonyLibraryEntry(id,'Draft',manual(),score.tracks[0].staves[0]);recallHarmonyLibraryEntry(record,score.tracks[0].staves[0]);
  expect(JSON.stringify({project,score:model.JsonConverter.scoreToJson(score),settings})).toBe(before);
});
