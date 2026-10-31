import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import {
  copyMasterTimeSignatureSource,copyTimeSignatureSources,getTimeSignatureExportIntent,
  initializeTimeSignatureSource,setTimeSignatureIntent,
} from './time-signature-source';

const mixed='GP export cannot represent mixed common/cut and numeric measure choices. Export a uniform measure range or use consistent choices.';
const inherited='GP export cannot resolve inherited common/cut choices for every selected measure. Set each selected 4/4 or 2/2 measure explicitly before exporting changed choices.';
function score(values:boolean[],meters:number[][]=values.map(()=>[4,4])) {
  const result=new model.Score();
  values.forEach((value,index)=>{
    const master=new model.MasterBar();master.timeSignatureCommon=value;
    [master.timeSignatureNumerator,master.timeSignatureDenominator]=meters[index];result.addMasterBar(master);
  });
  return result;
}
function edit(target:model.Score,index:number,value:boolean) {
  target.masterBars[index].timeSignatureCommon=value;setTimeSignatureIntent(target.masterBars[index],value);
}

it('known_global_flag_applies_only_to_eligible_meters',()=>{
  const target=score([false,false,true,true],[[4,4],[2,2],[3,4],[6,8]]);
  initializeTimeSignatureSource(target,true);
  expect(target.masterBars.map(master=>master.timeSignatureCommon)).toEqual([true,true,true,true]);
  initializeTimeSignatureSource(target,false);
  expect(target.masterBars.map(master=>master.timeSignatureCommon)).toEqual([false,false,true,true]);
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
});

it('inherited_numeric_is_not_explicit_false',()=>{
  const target=score([false]);initializeTimeSignatureSource(target,null);
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
  edit(target,0,false);expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
  initializeTimeSignatureSource(target,false);edit(target,0,false);
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
  initializeTimeSignatureSource(target,true);edit(target,0,false);
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
  initializeTimeSignatureSource(target,true); // Native replay rebuilds the imported baseline for Undo.
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
  edit(target,0,true);expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
});

it('actual_public_changes_and_return_to_known_baseline_are_resolved_without_mutating_markers',()=>{
  const target=score([false]);initializeTimeSignatureSource(target,true);
  target.masterBars[0].timeSignatureCommon=false;
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
  edit(target,0,false);target.masterBars[0].timeSignatureCommon=true;
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
});

it('no_source_models_and_unmarked_new_masters_use_actual_booleans',()=>{
  expect(getTimeSignatureExportIntent(score([false,false]))).toEqual({changed:true,value:false});
  expect(getTimeSignatureExportIntent(score([true,true]))).toEqual({changed:true,value:true});
  expect(()=>getTimeSignatureExportIntent(score([true,false]))).toThrow(mixed);
  const target=score([false]);initializeTimeSignatureSource(target,null);
  target.masterBars=[];target.addMasterBar(new model.MasterBar());
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
});

it('changed_export_is_uniform_or_rejects_unresolved_inheritance',()=>{
  const target=score([false,false]);initializeTimeSignatureSource(target,null);edit(target,0,false);
  expect(()=>getTimeSignatureExportIntent(target)).toThrow(inherited);
  expect(()=>getTimeSignatureExportIntent(target)).toThrow(inherited);
  edit(target,1,true);expect(()=>getTimeSignatureExportIntent(target)).toThrow(mixed);
  target.masterBars[1].timeSignatureNumerator=3;
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
  target.masterBars[0].timeSignatureNumerator=6;
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
});

it('markers_follow_master_objects_after_aligned_clone_removal_reorder_and_excerpt',()=>{
  const source=score([false,false,false]);initializeTimeSignatureSource(source,null);edit(source,1,false);edit(source,2,true);
  const destination=score([false,false,true]);copyTimeSignatureSources(source,destination);
  destination.masterBars.shift();destination.masterBars.reverse();
  expect(()=>getTimeSignatureExportIntent(destination)).toThrow(mixed);
  destination.masterBars.pop();
  expect(getTimeSignatureExportIntent(destination)).toEqual({changed:true,value:true});
  edit(destination,0,false);
  expect(getTimeSignatureExportIntent(destination)).toEqual({changed:true,value:false});
  source.masterBars=[source.masterBars[2]];
  expect(getTimeSignatureExportIntent(source)).toEqual({changed:true,value:true});
});

it('context_copies_preserve_inherited_and_explicit_baselines_without_aliasing',()=>{
  const source=score([false]);initializeTimeSignatureSource(source,null);
  const inheritedMaster=new model.MasterBar();copyMasterTimeSignatureSource(source.masterBars[0],inheritedMaster);
  source.masterBars.push(inheritedMaster);
  expect(getTimeSignatureExportIntent(source)).toEqual({changed:false,value:null});
  edit(source,0,false);
  expect(()=>getTimeSignatureExportIntent(source)).toThrow(inherited);
  copyMasterTimeSignatureSource(source.masterBars[0],inheritedMaster);
  expect(getTimeSignatureExportIntent(source)).toEqual({changed:true,value:false});
  const known=score([false]);initializeTimeSignatureSource(known,true);
  const numericDefault=new model.MasterBar();copyMasterTimeSignatureSource(known.masterBars[0],numericDefault);
  known.masterBars=[numericDefault];
  expect(getTimeSignatureExportIntent(known)).toEqual({changed:true,value:false});
});

it('copying_a_no_source_score_does_not_attach_inherited_archive_intent',()=>{
  const source=score([false]),destination=score([false]);initializeTimeSignatureSource(destination,null);
  copyTimeSignatureSources(source,destination);
  expect(getTimeSignatureExportIntent(destination)).toEqual({changed:true,value:false});
});

it('editing_an_inherited_clone_does_not_author_its_source',()=>{
  const source=score([false]),destination=score([false]);initializeTimeSignatureSource(source,null);
  copyTimeSignatureSources(source,destination);edit(destination,0,false);
  expect(getTimeSignatureExportIntent(destination)).toEqual({changed:true,value:false});
  expect(getTimeSignatureExportIntent(source)).toEqual({changed:false,value:null});
});
