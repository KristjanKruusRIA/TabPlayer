import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { getTimeSignatureExportIntent,setTimeSignatureIntent } from '../editor/time-signature-source';
import { readStylesheetTimeSignatures,writeStylesheetTimeSignatures } from './stylesheet';

const current='Content/Stylesheets/score.gpss',legacyPath='Content/BinaryStylesheet';
const yes=Uint8Array.of(0x5a,4,0x2a,2,8,1),no=Uint8Array.of(0x5a,4,0x2a,2,8,0);
const absent=Uint8Array.of(0x08,1),bad=Uint8Array.of(0x5a,4,0x2a);
const legacy=(value:boolean)=>Uint8Array.of(0,0,0,1,24,...new TextEncoder().encode('Staff/drawTimeSignatureC'),0,Number(value));
function score(values:boolean[]=[false]) {
  const target=new model.Score();
  for(const value of values){const master=new model.MasterBar();master.timeSignatureCommon=value;target.addMasterBar(master);}
  return target;
}
function edit(target:model.Score,value:boolean,index=0) {
  target.masterBars[index].timeSignatureCommon=value;setTimeSignatureIntent(target.masterBars[index],value);
}
const snapshot=(entries:Record<string,Uint8Array>)=>Object.fromEntries(Object.entries(entries).map(([path,bytes])=>[path,Array.from(bytes)]));

it('known_global_flag_applies_only_to_eligible_meters_and_current_entry_has_precedence',()=>{
  const target=score([true,true,false,false]);
  target.masterBars.forEach((master,index)=>{[master.timeSignatureNumerator,master.timeSignatureDenominator]=[[4,4],[2,2],[3,4],[6,8]][index];});
  readStylesheetTimeSignatures(target,{[current]:no,[legacyPath]:legacy(true)});
  expect(target.masterBars.map(master=>master.timeSignatureCommon)).toEqual([false,false,false,false]);
  readStylesheetTimeSignatures(target,{[current]:yes,[legacyPath]:legacy(false)});
  expect(target.masterBars.map(master=>master.timeSignatureCommon)).toEqual([true,true,false,false]);
});

it('present_current_absence_is_unknown_and_never_falls_back_to_legacy',()=>{
  const target=score([false,true]);readStylesheetTimeSignatures(target,{[current]:absent,[legacyPath]:legacy(true)});
  expect(target.masterBars.map(master=>master.timeSignatureCommon)).toEqual([false,true]);
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
  readStylesheetTimeSignatures(target,{[legacyPath]:legacy(true)});
  expect(target.masterBars.map(master=>master.timeSignatureCommon)).toEqual([true,true]);
  readStylesheetTimeSignatures(target,{});
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
});

it('malformed_active_style_fails_before_any_model_or_marker_publication',()=>{
  const target=score();readStylesheetTimeSignatures(target,{[current]:yes});
  expect(()=>readStylesheetTimeSignatures(target,{[current]:bad,[legacyPath]:legacy(false)})).toThrow(/^Unsupported GP common\/cut stylesheet:/);
  expect(target.masterBars[0].timeSignatureCommon).toBe(true);
  expect(getTimeSignatureExportIntent(target)).toEqual({changed:false,value:null});
  expect(()=>readStylesheetTimeSignatures(target,{[legacyPath]:bad})).toThrow(/^Unsupported GP common\/cut stylesheet:/);
});

it.each<Record<string,Uint8Array>>([
  {[current]:yes,[legacyPath]:legacy(true),'Content/Stylesheets/scoreview1.gpss':no},
  {[current]:absent,[legacyPath]:legacy(true),'Content/Stylesheets/scoreview2.gpss':bad},
  {[current]:yes,[legacyPath]:bad,'Content/Stylesheets/scoreview1.gpss':no},
])('unchanged_export_preserves_all_source_styles_at_the_already_built_score_boundary: %j',entries=>{
  const target=score(),before=snapshot(entries);readStylesheetTimeSignatures(target,entries);target.title='Unrelated edit';
  const output=writeStylesheetTimeSignatures(target,entries);
  expect(output).not.toBe(entries);expect(snapshot(output)).toEqual(before);expect(snapshot(entries)).toEqual(before);
  for(const path of Object.keys(entries))expect(output[path]).toBe(entries[path]);
});

it('known_value_command_returning_to_baseline_bypasses_view_and_legacy_parsing',()=>{
  const entries={[current]:yes,[legacyPath]:bad,'Content/Stylesheets/scoreview1.gpss':bad},target=score();
  readStylesheetTimeSignatures(target,entries);edit(target,false);edit(target,true);
  expect(snapshot(writeStylesheetTimeSignatures(target,entries))).toEqual(snapshot(entries));
});

it('changed_export_patches_current_and_legacy_atomically_in_detached_arrays',()=>{
  const entries={[current]:yes,[legacyPath]:legacy(true),'Content/unknown.bin':Uint8Array.of(9,8,7)},before=snapshot(entries),target=score();
  readStylesheetTimeSignatures(target,entries);edit(target,false);
  const output=writeStylesheetTimeSignatures(target,entries);
  expect(output[current]).toEqual(no);expect(output[legacyPath]).toEqual(legacy(false));
  expect(output[current]).not.toBe(entries[current]);expect(output[legacyPath]).not.toBe(entries[legacyPath]);
  expect(output['Content/unknown.bin']).toBe(entries['Content/unknown.bin']);expect(snapshot(entries)).toEqual(before);
  expect(snapshot(writeStylesheetTimeSignatures(target,entries))).toEqual(snapshot(output));
});

it('changed_export_keeps_missing_current_absent_and_patches_only_generated_legacy',()=>{
  const target=score([true]),entries={[legacyPath]:legacy(false)};
  const output=writeStylesheetTimeSignatures(target,entries);
  expect(output[current]).toBeUndefined();expect(output[legacyPath]).toEqual(legacy(true));expect(entries[legacyPath]).toEqual(legacy(false));
  expect(()=>writeStylesheetTimeSignatures(target,{})).toThrow(/legacy|BinaryStylesheet/i);
  expect(()=>writeStylesheetTimeSignatures(target,{[current]:no})).toThrow(/legacy|BinaryStylesheet/i);
});

it('mixed_and_inherited_changes_reject_without_modifying_any_archive_bytes_or_intent',()=>{
  const entries={[current]:absent,[legacyPath]:legacy(true),'Content/Stylesheets/scoreview1.gpss':no,'Content/unknown.bin':bad};
  const before=snapshot(entries),target=score([false,false]);readStylesheetTimeSignatures(target,entries);edit(target,false);
  const inherited='GP export cannot resolve inherited common/cut choices for every selected measure. Set each selected 4/4 or 2/2 measure explicitly before exporting changed choices.';
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow(inherited);
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow(inherited);
  edit(target,true,1);
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow('GP export cannot represent mixed common/cut and numeric measure choices. Export a uniform measure range or use consistent choices.');
  expect(snapshot(entries)).toEqual(before);
});

it('no_eligible_bars_preserve_every_style_byte_even_on_a_new_model',()=>{
  const target=score([true,false]);target.masterBars.forEach(master=>master.timeSignatureNumerator=3);
  const entries={[current]:bad,[legacyPath]:bad,'Content/Stylesheets/scoreview1.gpss':bad};
  expect(snapshot(writeStylesheetTimeSignatures(target,entries))).toEqual(snapshot(entries));
});

it.each(['Content/Stylesheets/scoreview1.gpss','Content/Stylesheets/scoreview12.gpss'])('changed_view_guard_rejects_conflicting_original_overrides_with_path: %s',path=>{
  const entries={[current]:yes,[legacyPath]:legacy(true),[path]:yes,'Content/unknown.bin':bad},before=snapshot(entries),target=score();
  readStylesheetTimeSignatures(target,entries);edit(target,false);
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow(new RegExp(path.replaceAll('.','\\.')));
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow(/imported view style conflicts with the changed full-score choice/i);
  expect(snapshot(entries)).toEqual(before);expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
});

it('changed_view_guard_preserves_absent_equal_and_unrecognized_view_bytes',()=>{
  const entries:Record<string,Uint8Array>={[current]:yes,[legacyPath]:legacy(true),'Content/Stylesheets/scoreview1.gpss':absent,
    'Content/Stylesheets/scoreview2.gpss':no,'Content/Stylesheets/scoreview0.gpss':bad,
    'Content/Stylesheets/scoreview01.gpss':bad,'Content/Stylesheets/nested/scoreview1.gpss':bad,
    'Content/Stylesheets/other.gpss':bad},before=snapshot(entries),target=score();
  readStylesheetTimeSignatures(target,entries);edit(target,false);
  const output=writeStylesheetTimeSignatures(target,entries);
  for(const path of Object.keys(entries).filter(path=>path!==current&&path!==legacyPath))expect(output[path]).toBe(entries[path]);
  expect(snapshot(entries)).toEqual(before);
});

it('malformed_recognized_view_and_legacy_reject_only_changed_projection_atomically',()=>{
  const target=score(),entries={[current]:yes,[legacyPath]:legacy(true),'Content/Stylesheets/scoreview1.gpss':bad},before=snapshot(entries);
  readStylesheetTimeSignatures(target,entries);edit(target,false);
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow(/Content\/Stylesheets\/scoreview1\.gpss/);
  expect(snapshot(entries)).toEqual(before);
  const malformedLegacy={...entries,[legacyPath]:bad,'Content/Stylesheets/scoreview1.gpss':no},legacyBefore=snapshot(malformedLegacy);
  expect(()=>writeStylesheetTimeSignatures(target,malformedLegacy)).toThrow(/^Unsupported GP common\/cut stylesheet:/);
  expect(snapshot(malformedLegacy)).toEqual(legacyBefore);
});

it('explicit_false_after_inherited_import_patches_both_styles_without_resolving_numeric_defaults',()=>{
  const target=score(),entries={[current]:absent,[legacyPath]:legacy(true)};
  readStylesheetTimeSignatures(target,entries);edit(target,false);
  const output=writeStylesheetTimeSignatures(target,entries);
  expect(output[current]).toEqual(Uint8Array.of(8,1,0x5a,4,0x2a,2,8,0));
  expect(output[legacyPath]).toEqual(legacy(false));
});

it('uniform_true_after_known_false_patches_both_styles_while_noneligible_values_are_ignored',()=>{
  const target=score([false,false,true]),entries={[current]:no,[legacyPath]:legacy(false)};
  target.masterBars[1].timeSignatureNumerator=2;target.masterBars[1].timeSignatureDenominator=2;
  target.masterBars[2].timeSignatureNumerator=3;
  readStylesheetTimeSignatures(target,entries);edit(target,true);edit(target,true,1);
  const output=writeStylesheetTimeSignatures(target,entries);
  expect(output[current]).toEqual(yes);expect(output[legacyPath]).toEqual(legacy(true));
  expect(entries[current]).toEqual(no);expect(entries[legacyPath]).toEqual(legacy(false));
});

it('malformed_changed_current_rejects_without_modifying_valid_legacy_or_marker_state',()=>{
  const target=score(),entries={[current]:bad,[legacyPath]:legacy(true),'Content/unknown.bin':absent},before=snapshot(entries);
  readStylesheetTimeSignatures(target,{[current]:yes});edit(target,false);
  expect(()=>writeStylesheetTimeSignatures(target,entries)).toThrow(/^Unsupported GP common\/cut stylesheet:/);
  expect(snapshot(entries)).toEqual(before);expect(getTimeSignatureExportIntent(target)).toEqual({changed:true,value:false});
});
