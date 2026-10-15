// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { music,target } from '../editor/fixtures';
import type { HarmonyChord,HarmonyChordDialogProps,HarmonyCommand,HarmonyLibraryEntry } from '../editor/harmony-types';
import { HarmonyChordDialog } from './HarmonyChordDialog';
afterEach(cleanup);
const legacy:HarmonyChord={name:'Legacy untouched',nameMode:'manual',recipe:null,firstFret:0,frets:[0,12,-1,1,0,24],fingers:[0,4,-1,1,-2,4],barreFrets:[0,12,0],showName:false,showDiagram:false,showFingering:false};
function props(value:HarmonyChord|null=null) {
  const commands:HarmonyCommand[]=[],saved:HarmonyLibraryEntry[]=[],removed:string[]=[],closed:string[]=[],score=music();
  const input:HarmonyChordDialogProps={score,target,selection:null,value,busy:false,library:{format:'TabPlayerHarmonyLibrary',version:1,entries:[]},onEdit:command=>commands.push(command),onClose:()=>closed.push('closed'),onLibraryPut:async entry=>{saved.push(entry);},onLibraryRemove:async id=>{removed.push(id);}};
  return {input,commands,saved,removed,closed};
}
it('unchanged_apply_preserves_legacy_first_fret_wide_shape_flags_fingers_and_barre_order',()=>{
  const {input,commands}=props(legacy),before=model.JsonConverter.scoreToJson(input.score);render(<HarmonyChordDialog {...input}/>);
  expect(screen.getByLabelText('First fret')).toHaveValue(0);fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));
  expect(commands).toEqual([{type:'setHarmonyChord',target,chord:legacy,fillEmptyBeat:false}]);expect(model.JsonConverter.scoreToJson(input.score)).toBe(before);
});
it('formula_root_alteration_omission_slash_bass_and_finger_controls_emit_one_exact_chord',()=>{
  const {input,commands}=props();render(<HarmonyChordDialog {...input}/>);
  fireEvent.change(screen.getByLabelText('Root letter'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('Root accidental'),{target:{value:'-1'}});fireEvent.change(screen.getByLabelText('Formula'),{target:{value:'7'}});
  fireEvent.change(screen.getByLabelText('Alter degree 9'),{target:{value:'-1'}});fireEvent.click(screen.getByLabelText('Omit degree 5'));fireEvent.click(screen.getByLabelText('Slash bass'));fireEvent.change(screen.getByLabelText('Bass letter'),{target:{value:'2'}});
  fireEvent.change(screen.getByLabelText('String 1 finger'),{target:{value:'0'}});fireEvent.click(screen.getByLabelText('Show fingering'));expect(commands).toEqual([]);
  expect(screen.getByLabelText('Chord name')).toHaveValue('Db7(b9,no5)/E');fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));
  expect(commands).toEqual([{type:'setHarmonyChord',target,chord:{name:'Db7(b9,no5)/E',nameMode:'theory',recipe:{root:{step:1,alteration:-1},formula:'7',alterations:[{degree:9,shift:-1}],omissions:[5],bass:{step:2,alteration:0}},firstFret:1,frets:[-1,-1,-1,-1,-1,-1],fingers:[0,-2,-2,-2,-2,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:false},fillEmptyBeat:false}]);
});
it('generated_alternative_selection_and_manual_fret_edits_keep_the_score_independent',()=>{
  const {input,commands}=props();input.score.tracks[0].staves[0].stringTuning.tunings=[64,60,67];const before=model.JsonConverter.scoreToJson(input.score);render(<HarmonyChordDialog {...input}/>);
  fireEvent.click(screen.getByRole('button',{name:'Generate shapes'}));fireEvent.click(screen.getByRole('button',{name:'Use shape 2'}));
  expect(screen.getByLabelText('String 1 fret')).toHaveValue(0);expect(screen.getByLabelText('String 2 fret')).toHaveValue(0);expect(screen.getByLabelText('String 3 fret')).toHaveValue(12);
  fireEvent.change(screen.getByLabelText('String 3 fret'),{target:{value:'1'}});expect(screen.getByLabelText('Name mode')).toHaveValue('manual');
  fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'’my custom chord'}});fireEvent.change(screen.getByLabelText('Barre frets'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Open string 3'}));
  fireEvent.change(screen.getByLabelText('String 1 fret'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('String 2 fret'),{target:{value:'1'}});
  expect(screen.getByLabelText('String 3 finger')).toHaveValue('-2');fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));
  expect(commands[0]).toMatchObject({type:'setHarmonyChord',chord:{name:'my custom chord',nameMode:'manual',recipe:null,frets:[1,1,0],barreFrets:[1]}});expect(model.JsonConverter.scoreToJson(input.score)).toBe(before);
});
it('text_only_edit_and_empty_beat_fill_are_separate_explicit_commands',()=>{
  const first=props(legacy),view=render(<HarmonyChordDialog {...first.input}/>);fireEvent.change(screen.getByLabelText('Beat text'),{target:{value:'quiet entrance'}});fireEvent.click(screen.getByRole('button',{name:'Apply beat text'}));expect(first.commands).toEqual([{type:'setBeatText',target,text:'quiet entrance'}]);
  view.unmount();const second=props();second.input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes=[];render(<HarmonyChordDialog {...second.input}/>);fireEvent.click(screen.getByLabelText('Fill empty beat with diagram notes'));fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(second.commands[0]).toMatchObject({type:'setHarmonyChord',fillEmptyBeat:true});
});
it('source_context_changes_downgrade_stale_theory_without_relabeling_and_zero_strings_apply',()=>{
  const {input,commands}=props({...legacy,name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,0,0],fingers:[-2,-2,-2]});input.score.tracks[0].staves[0].stringTuning.tunings=[64,60,67];
  const view=render(<HarmonyChordDialog {...input}/>);expect(screen.getByLabelText('Name mode')).toHaveValue('theory');input.score.tracks[0].staves[0].capo=1;view.rerender(<HarmonyChordDialog {...input} value={structuredClone(input.value)}/>);expect(screen.getByLabelText('Name mode')).toHaveValue('manual');expect(screen.getByLabelText('Chord name')).toHaveValue('C');
  view.unmount();input.score.tracks[0].staves[0].stringTuning.tunings=[];const empty={...legacy,name:'N.C.',frets:[],fingers:[]};render(<HarmonyChordDialog {...input} value={empty}/>);fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(commands).toEqual([{type:'setHarmonyChord',target,chord:empty,fillEmptyBeat:false}]);
});
it('library_save_recall_and_remove_use_callbacks_without_editing_the_score',async()=>{
  const {input,commands,saved,removed}=props(legacy),entry:HarmonyLibraryEntry={id:'d1fb4ba1-6491-4bc9-932d-e194f72be671',label:'My shape',chord:legacy,tuning:[...input.score.tracks[0].staves[0].tuning],capo:0,transposition:0};input.library.entries=[entry];const before=model.JsonConverter.scoreToJson(input.score);render(<HarmonyChordDialog {...input}/>);
  fireEvent.change(screen.getByLabelText('Personal chord'),{target:{value:entry.id}});fireEvent.click(screen.getByRole('button',{name:'Recall library chord'}));expect(screen.getByLabelText('First fret')).toHaveValue(0);
  fireEvent.change(screen.getByLabelText('Library label'),{target:{value:'Saved legacy'}});fireEvent.click(screen.getByRole('button',{name:'Save to library'}));await waitFor(()=>expect(saved).toHaveLength(1));expect(saved[0]).toMatchObject({label:'Saved legacy',chord:legacy,tuning:entry.tuning,capo:0,transposition:0});
  fireEvent.click(screen.getByRole('button',{name:'Delete library chord'}));await waitFor(()=>expect(removed).toEqual([entry.id]));expect(commands).toEqual([]);expect(model.JsonConverter.scoreToJson(input.score)).toBe(before);
});
it('modal_traps_focus_restores_opener_and_keeps_close_available_when_busy',()=>{
  const {input,closed}=props(),opener=document.createElement('button');document.body.append(opener);opener.focus();const view=render(<HarmonyChordDialog {...input}/>),name=screen.getByLabelText('Chord name'),cancel=screen.getByRole('button',{name:'Cancel'});expect(name).toHaveFocus();fireEvent.keyDown(name,{key:'Tab',shiftKey:true});expect(cancel).toHaveFocus();fireEvent.keyDown(cancel,{key:'Tab'});expect(name).toHaveFocus();
  view.rerender(<HarmonyChordDialog {...input} busy/>);expect(name).toBeDisabled();expect(cancel).toHaveFocus();expect(within(screen.getByRole('dialog')).getByRole('button',{name:'Apply chord'})).toBeDisabled();fireEvent.keyDown(cancel,{key:'Escape'});expect(closed).toEqual(['closed']);view.unmount();expect(opener).toHaveFocus();opener.remove();
});
it('library_theory_recall_regenerates_for_the_current_staff_and_incompatible_manual_recall_rejects',()=>{
  const {input,commands}=props(),theory:HarmonyChord={name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,0,0],fingers:[-2,-2,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false};
  input.score.tracks[0].staves[0].stringTuning.tunings=[65,61,68];input.library.entries=[{id:'d1fb4ba1-6491-4bc9-932d-e194f72be671',label:'C in old tuning',chord:theory,tuning:[64,60,67],capo:0,transposition:0},{id:'d1fb4ba1-6491-4bc9-932d-e194f72be672',label:'Incompatible manual',chord:legacy,tuning:[64,59,55,50,45,40],capo:0,transposition:0}];
  const before=model.JsonConverter.scoreToJson(input.score);render(<HarmonyChordDialog {...input}/>);
  fireEvent.change(screen.getByLabelText('Personal chord'),{target:{value:input.library.entries[0].id}});fireEvent.click(screen.getByRole('button',{name:'Recall library chord'}));
  expect(screen.getByLabelText('Chord name')).toHaveValue('C');expect(screen.getByLabelText('First fret')).toHaveValue(11);for(let string=1;string<=3;string++)expect(screen.getByLabelText(`String ${string} fret`)).toHaveValue(11);expect(screen.getByLabelText('Show name')).not.toBeChecked();expect(commands).toEqual([]);
  fireEvent.change(screen.getByLabelText('Personal chord'),{target:{value:input.library.entries[1].id}});fireEvent.click(screen.getByRole('button',{name:'Recall library chord'}));expect(screen.getByRole('alert')).toHaveTextContent('matching instrument context');expect(screen.getByLabelText('First fret')).toHaveValue(11);expect(model.JsonConverter.scoreToJson(input.score)).toBe(before);
});
it('empty_search_results_are_visible_and_remove_is_one_explicit_command',()=>{
  const {input,commands}=props();render(<HarmonyChordDialog {...input}/>);fireEvent.change(screen.getByLabelText('Formula'),{target:{value:'13'}});fireEvent.click(screen.getByRole('button',{name:'Generate shapes'}));expect(screen.getByRole('alert')).toHaveTextContent('No shapes found');expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Remove chord'}));expect(commands).toEqual([{type:'setHarmonyChord',target,chord:null,fillEmptyBeat:false}]);
});
it('equivalent_accepted_snapshots_and_library_renders_preserve_the_unsaved_draft',()=>{
  const {input,commands}=props(legacy),view=render(<HarmonyChordDialog {...input}/>);fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Unsaved name'}});fireEvent.change(screen.getByLabelText('First fret'),{target:{value:'7'}});
  view.rerender(<HarmonyChordDialog {...input} value={structuredClone(legacy)} library={{...input.library,entries:[]}}/>);expect(screen.getByLabelText('Chord name')).toHaveValue('Unsaved name');expect(screen.getByLabelText('First fret')).toHaveValue(7);expect(commands).toEqual([]);
});
it('reselecting_an_unchanged_open_string_preserves_its_imported_finger',()=>{
  const {input}=props(legacy);render(<HarmonyChordDialog {...input}/>);fireEvent.click(screen.getByRole('button',{name:'Open string 1'}));expect(screen.getByLabelText('String 1 finger')).toHaveValue('0');
});
it('out_of_range_sounding_selection_is_reported_without_crashing_the_dialog',()=>{
  const {input,commands}=props();input.score.tracks[0].staves[0].transpositionPitch=127;input.selection={kind:'notes',notes:[{target,noteIndex:0}]};render(<HarmonyChordDialog {...input}/>);expect(screen.getByRole('alert')).toHaveTextContent('0 to 127');expect(commands).toEqual([]);
});
it.each(['0, 0, 1','1, 1','1','1,'])('edited_barres_%s_reject_without_emitting_a_command',barres=>{
  const {input,commands}=props({...legacy,name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},frets:[0,0,0],fingers:[-2,-2,-2],barreFrets:[]});input.score.tracks[0].staves[0].stringTuning.tunings=[64,60,67];render(<HarmonyChordDialog {...input}/>);
  fireEvent.change(screen.getByLabelText('Barre frets'),{target:{value:barres}});fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(commands).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent(/barre/i);
});
it('an_edited_barre_cannot_cross_an_open_or_muted_string',()=>{
  const {input,commands}=props({...legacy,frets:[1,0,1],fingers:[1,-2,1],barreFrets:[]});input.score.tracks[0].staves[0].stringTuning.tunings=[64,60,67];render(<HarmonyChordDialog {...input}/>);
  fireEvent.change(screen.getByLabelText('Barre frets'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(commands).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent(/barre/i);
  fireEvent.click(screen.getByRole('button',{name:'Mute string 2'}));fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(commands).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent(/barre/i);
});
it('unchanged_passively_recalled_legacy_barres_remain_exact_on_apply',()=>{
  const {input,commands}=props();input.library.entries=[{id:'d1fb4ba1-6491-4bc9-932d-e194f72be671',label:'Legacy recall',chord:legacy,tuning:[...input.score.tracks[0].staves[0].tuning],capo:0,transposition:0}];render(<HarmonyChordDialog {...input}/>);
  fireEvent.change(screen.getByLabelText('Personal chord'),{target:{value:input.library.entries[0].id}});fireEvent.click(screen.getByRole('button',{name:'Recall library chord'}));fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(commands).toEqual([{type:'setHarmonyChord',target,chord:legacy,fillEmptyBeat:false}]);
});
it('initial_library_loading_keeps_focus_at_the_top_then_focuses_the_chord_name',()=>{
  const {input}=props(),opener=document.createElement('button');document.body.append(opener);opener.focus();
  const view=render(<HarmonyChordDialog {...input} busy/>),dialog=screen.getByRole('dialog'),cancel=screen.getByRole('button',{name:'Cancel'});
  expect(dialog).toHaveFocus();expect(cancel).not.toHaveFocus();
  fireEvent.keyDown(dialog,{key:'Tab'});expect(cancel).toHaveFocus();
  dialog.focus();view.rerender(<HarmonyChordDialog {...input}/>);expect(screen.getByLabelText('Chord name')).toHaveFocus();
  view.unmount();expect(opener).toHaveFocus();opener.remove();
});
it('compares_generated_shapes_with_passive_diagrams_and_marks_the_selected_shape',()=>{
  const {input}=props();input.score.tracks[0].staves[0].stringTuning.tunings=[64,60,67];render(<HarmonyChordDialog {...input}/>);
  const advanced=screen.getByText('Alterations and omissions').closest('details');expect(advanced).not.toHaveAttribute('open');
  expect(screen.getByLabelText('Root letter').closest('details')).toBeNull();expect(screen.getByLabelText('Formula').closest('details')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Generate shapes'}));
  const second=screen.getByRole('button',{name:'Use shape 2'});expect(within(second).getByRole('group',{name:'Chord diagram preview'})).toBeInTheDocument();expect(second.querySelector('[role=button],button,[tabindex]')).toBeNull();
  fireEvent.click(second);expect(second).toHaveAttribute('aria-pressed','true');expect(screen.getByRole('button',{name:'Use shape 1'})).toHaveAttribute('aria-pressed','false');
  fireEvent.change(screen.getByLabelText('String 3 fret'),{target:{value:'1'}});expect(second).toHaveAttribute('aria-pressed','false');
});

it('diagram_positions_remain_keyboard_editable_after_the_comparison_relayout',async()=>{
  const user=userEvent.setup(),{input,commands,closed}=props(),before=model.JsonConverter.scoreToJson(input.score);render(<HarmonyChordDialog {...input}/>);
  const position=screen.getByRole('button',{name:'String 1 fret 1: F4'});position.focus();await user.keyboard('{Enter}');
  expect(screen.getByLabelText('String 1 fret')).toHaveValue(1);expect(commands).toEqual([]);expect(model.JsonConverter.scoreToJson(input.score)).toBe(before);
  await user.keyboard('{Escape}');expect(closed).toEqual(['closed']);
});
