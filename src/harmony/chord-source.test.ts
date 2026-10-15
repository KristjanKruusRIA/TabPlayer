import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import type { HarmonyChord } from '../editor/harmony-types';
import { music } from '../editor/fixtures';
import { scoreFromJson } from '../model-clone';
import { copyHarmonyChord,copyHarmonySources,getHarmonyChord,setHarmonyChordSource,validateHarmonyChord } from './chord-source';

const definition=():HarmonyChord=>({name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false});
function install(score=music(),value=definition()) {
  const chord=new model.Chord();Object.assign(chord,{name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});
  score.tracks[0].staves[0].addChord('authored',chord);setHarmonyChordSource(chord,value);return {score,chord,staff:chord.staff};
}

it('merges_live_public_fields_and_returns_independent_owned_snapshots',()=>{
  const value=definition(),{chord}=install(music(),value);value.fingers[1]=4;
  const first=getHarmonyChord(chord);expect(first).toEqual(definition());first.recipe!.root.step=4;first.fingers[1]=0;first.frets[0]=8;
  expect(getHarmonyChord(chord)).toEqual(definition());chord.showName=true;chord.firstFret=0;chord.barreFrets=[0,3,3];
  expect(getHarmonyChord(chord)).toMatchObject({firstFret:0,showName:true,barreFrets:[0,3,3],nameMode:'theory'});
});

it.each(['tuning','capo','offset','untuned','percussion'] as const)('effective_snapshot_downgrades_stale_%s_without_rewriting_source',kind=>{
  const {score,chord,staff}=install(),before=model.JsonConverter.scoreToJson(score),tuning=[...staff.tuning];
  if(kind==='tuning')staff.stringTuning.tunings=tuning.map(pitch=>pitch+1);
  else if(kind==='capo')staff.capo=1;else if(kind==='offset')staff.transpositionPitch=1;else if(kind==='untuned')staff.stringTuning.tunings=[];else staff.isPercussion=true;
  const stale=getHarmonyChord(chord);expect(stale).toEqual({...definition(),nameMode:'manual',recipe:null});
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());copyHarmonySources(score,copy);
  const copied=copy.tracks[0].staves[0].getChord('authored')!;expect(getHarmonyChord(copied)).toEqual(stale);
  for(const owner of [staff,copied.staff]){owner.stringTuning.tunings=[...tuning];owner.capo=0;owner.transpositionPitch=0;owner.isPercussion=false;}
  expect(getHarmonyChord(chord)).toEqual(definition());expect(getHarmonyChord(copied)).toEqual(definition());expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('copies_raw_provenance_to_new_ids_and_evaluates_the_destination_context',()=>{
  const {chord,staff}=install();staff.capo=1;expect(getHarmonyChord(chord).nameMode).toBe('manual');
  const destination=new model.Chord();Object.assign(destination,{name:'C',firstFret:1,strings:[0,1,0,2,3,-1],showName:false,showDiagram:true,showFingering:false});
  const target=music().tracks[0].staves[0];target.addChord('new-id',destination);copyHarmonyChord(chord,destination);
  expect(getHarmonyChord(destination)).toEqual(definition());const snapshot=getHarmonyChord(destination);snapshot.fingers[1]=4;expect(getHarmonyChord(chord).fingers[1]).toBe(1);
});

it('legacy_manual_first_fret_zero_wide_hidden_and_zero_string_definitions_survive_passive_copies',()=>{
  for(const frets of [[0,19,-1,2,30,0],[]]){
    const value:HarmonyChord={...definition(),name:' exact legacy name ',nameMode:'manual',recipe:null,firstFret:0,frets,fingers:frets.map(()=>-1),barreFrets:[0,19,19],showName:false,showDiagram:false,showFingering:false};
    const score=music();if(!frets.length)score.tracks[0].staves[0].stringTuning.tunings=[];const {chord}=install(score,value);
    const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());copyHarmonySources(score,copy);
    expect(getHarmonyChord(chord)).toEqual(value);expect(getHarmonyChord(copy.tracks[0].staves[0].getChord('authored')!)).toEqual(value);
  }
});

it('keeps_an_all_muted_theory_name_valid_without_a_played_shape_and_defaults_legacy_fingers',()=>{
  const value={...definition(),frets:[],fingers:[]},{chord,staff}=install(music(),value);staff.stringTuning.tunings=[];expect(getHarmonyChord(chord)).toEqual(value);
  const legacy=new model.Chord();legacy.name='unparsed';legacy.firstFret=0;legacy.strings=[0,10,-1];expect(getHarmonyChord(legacy)).toMatchObject({name:'unparsed',nameMode:'manual',recipe:null,firstFret:0,fingers:[-2,-2,-2]});
});

it.each(['frets','fingers','barreFrets'] as const)('rejects_sparse_%s_before_recording_a_snapshot_that_json_would_change_to_null',field=>{
  const value=definition();value[field]=Array(field==='barreFrets'?1:6);const chord=new model.Chord();
  expect(()=>validateHarmonyChord(value)).toThrow();expect(()=>setHarmonyChordSource(chord,value)).toThrow();expect(getHarmonyChord(chord).nameMode).toBe('manual');
});

it.each(['alterations','omissions'] as const)('rejects_sparse_recipe_%s_in_the_pure_validator',field=>{
  const value=definition();value.recipe![field]=Array(1);expect(()=>validateHarmonyChord(value)).toThrow();
});
