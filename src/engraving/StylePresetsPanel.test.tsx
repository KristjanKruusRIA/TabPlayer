// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { applySettingsEdit,defaultDocumentSettings } from '../document-settings';
import type { EngravingCommand,EngravingOverrides } from './types';
import { defaultEngraving } from './projection';
import { EngravingPanel } from './EngravingPanel';
import { StylePresetsPanel } from './StylePresetsPanel';
import type { SavedStyle } from './style-library';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
type Edit=Extract<EngravingCommand,{type:'setEngraving'}>;
const idA='ca4af764-86e2-4ddd-9c26-a1be3368bdf7';
let store:SavedStyle[]=[];
const reply=()=>({format:'tabplayer-style-library',version:1,entries:structuredClone(store)});
const styled=(patch:(value:EngravingOverrides)=>void)=>{const value=defaultEngraving();patch(value);return value;};
beforeEach(()=>{
  store=[];invoke.mockReset();
  invoke.mockImplementation(async(command:string,args?:{entry?:SavedStyle;id?:string})=>{
    if(command==='style_library_put'){const entry=structuredClone(args!.entry!),at=store.findIndex(item=>item.id===entry.id);if(at<0)store.push(entry);else store[at]=entry;}
    if(command==='style_library_remove')store=store.filter(item=>item.id!==args!.id);
    return reply();
  });
});
afterEach(cleanup);
const open=async()=>{const summary=screen.getByText('Saved styles');(summary.parentElement as HTMLDetailsElement).open=true;await waitFor(()=>expect(invoke).toHaveBeenCalledWith('style_library_read'));};
const mount=(value:EngravingOverrides,commands:Edit[],trackIds=['source/guitar'])=>render(<StylePresetsPanel score={music()} trackIds={trackIds} value={value} unapplied={false} busy={false} onEdit={edit=>{commands.push(edit);}}/>);

it('does_not_touch_the_library_until_opened_and_reads_failures_as_a_message',async()=>{
  const commands:Edit[]=[];mount(defaultEngraving(),commands);expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce('Invalid style library: damaged');await open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read saved styles');expect(commands).toEqual([]);
});

it('saves_the_document_style_without_profiles_and_applies_it_as_one_edit_keeping_staff_profiles',async()=>{
  const commands:Edit[]=[];
  const first=styled(value=>{value.stylesheet.hideDynamics=true;value.systemSpacing=1.25;value.profiles=[{trackId:'source/guitar',profile:'slash'}];});
  const view=mount(first,commands);await open();
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'  House style  '}});fireEvent.click(screen.getByRole('button',{name:'Save current style'}));
  await waitFor(()=>expect(store).toHaveLength(1));
  expect(store[0].name).toBe('House style');expect(store[0].engraving.profiles).toEqual([]);expect(store[0].engraving.stylesheet.hideDynamics).toBe(true);expect(store[0].engraving.systemSpacing).toBe(1.25);
  expect(await screen.findByRole('status')).toHaveTextContent('Saved House style.');expect(commands).toEqual([]);
  // A different document, with its own profile, takes the saved style.
  const other=styled(value=>{value.profiles=[{trackId:'source/guitar',profile:'numbered'}];});
  view.rerender(<StylePresetsPanel score={music()} trackIds={['source/guitar']} value={other} unapplied={false} busy={false} onEdit={edit=>{commands.push(edit);}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Apply saved style'}));
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({type:'setEngraving',engraving:{...store[0].engraving,profiles:[{trackId:'source/guitar',profile:'numbered'}]}});
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Applied House style.'));
});

it('applying_a_style_changes_only_engraving_settings_never_the_music',async()=>{
  const score=music(),before=model.JsonConverter.scoreToJson(score),commands:Edit[]=[];
  store=[{id:idA,name:'Loud',engraving:styled(value=>{value.stylesheet.brackets='similar';value.notation.tabRhythm='beams';})}];
  render(<StylePresetsPanel score={score} trackIds={['source/guitar']} value={defaultEngraving()} unapplied={false} busy={false} onEdit={edit=>{commands.push(edit);}}/>);await open();
  fireEvent.change(await screen.findByLabelText('Saved style'),{target:{value:idA}});fireEvent.click(screen.getByRole('button',{name:'Apply saved style'}));
  expect(commands).toHaveLength(1);
  const settings=defaultDocumentSettings(),others=structuredClone({...settings,engraving:undefined,page:undefined});
  applySettingsEdit(settings,commands[0],score,['source/guitar']);
  expect(settings.engraving.stylesheet.brackets).toBe('similar');expect(settings.engraving.notation.tabRhythm).toBe('beams');
  expect({...settings,engraving:undefined,page:undefined}).toEqual(others);expect(settings.page).toBeNull();
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('an_already_matching_style_and_an_unusable_one_send_no_edit',async()=>{
  const commands:Edit[]=[];store=[{id:idA,name:'Same',engraving:defaultEngraving()}];
  mount(defaultEngraving(),commands);await open();
  fireEvent.change(await screen.findByLabelText('Saved style'),{target:{value:idA}});fireEvent.click(screen.getByRole('button',{name:'Apply saved style'}));
  expect(commands).toEqual([]);expect(screen.getByRole('status')).toHaveTextContent('already matches');
  fireEvent.click(screen.getByRole('button',{name:'Force default style'}));expect(commands).toEqual([]);
});

it('force_default_style_is_one_edit_that_keeps_profiles',()=>{
  const commands:Edit[]=[];
  mount(styled(value=>{value.stylesheet.hideDynamics=true;value.profiles=[{trackId:'source/guitar',profile:'standard'},{trackId:'removed',profile:'slash'}];}),commands);
  fireEvent.click(screen.getByRole('button',{name:'Force default style'}));
  expect(commands).toEqual([{type:'setEngraving',engraving:{...defaultEngraving(),profiles:[{trackId:'source/guitar',profile:'standard'}]}}]);
  expect(invoke).not.toHaveBeenCalled();
});

it('updates_renames_and_deletes_a_saved_style_and_reports_invalid_names',async()=>{
  const commands:Edit[]=[];store=[{id:idA,name:'Old',engraving:defaultEngraving()}];
  mount(styled(value=>{value.stylesheet.barNumbers='hidden';}),commands);await open();
  fireEvent.change(await screen.findByLabelText('Saved style'),{target:{value:idA}});
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'bad\u0001'}});expect(screen.getByText('Style name contains characters that cannot be saved.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Save current style'})).toBeDisabled();expect(screen.getByRole('button',{name:'Update saved style'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'New name'}});fireEvent.click(screen.getByRole('button',{name:'Update saved style'}));
  await waitFor(()=>expect(store[0].name).toBe('New name'));expect(store).toHaveLength(1);expect(store[0].id).toBe(idA);expect(store[0].engraving.stylesheet.barNumbers).toBe('hidden');
  fireEvent.click(screen.getByRole('button',{name:'Delete saved style'}));await waitFor(()=>expect(store).toEqual([]));
  expect(commands).toEqual([]);
});

it('a_refused_write_shows_the_error_and_keeps_the_list',async()=>{
  const commands:Edit[]=[];mount(defaultEngraving(),commands);await open();
  invoke.mockRejectedValueOnce('Invalid style library: damaged');
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'Nope'}});fireEvent.click(screen.getByRole('button',{name:'Save current style'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('damaged');expect(store).toEqual([]);
});

it('is_part_of_the_engraving_panel_and_disabled_with_it_while_busy',async()=>{
  const commands:Edit[]=[];
  const view=render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>{commands.push(edit);}}/>);
  expect(screen.getByText('Saved styles')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Force default style'})).toBeEnabled();
  view.rerender(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy onEdit={edit=>{commands.push(edit);}}/>);
  expect(screen.getByRole('button',{name:'Force default style'})).toBeDisabled();expect(invoke).not.toHaveBeenCalled();
  await act(async()=>{});
});

const panel=(extra:{value?:EngravingOverrides;unapplied?:boolean;busy?:boolean;onEdit?:(edit:Edit)=>void|Promise<boolean>}={})=>
  <StylePresetsPanel score={music()} trackIds={['source/guitar']} value={extra.value??defaultEngraving()} unapplied={extra.unapplied??false} busy={extra.busy??false} onEdit={extra.onEdit??(()=>{})}/>;

it('says_applied_only_after_the_edit_is_known_to_have_succeeded',async()=>{
  let settle!:(ok:boolean)=>void;const sent:Edit[]=[];
  const onEdit=(edit:Edit)=>{sent.push(edit);return new Promise<boolean>(accept=>{settle=accept;});};
  store=[{id:idA,name:'Loud',engraving:styled(value=>{value.stylesheet.brackets='similar';})}];
  render(panel({onEdit}));await open();fireEvent.change(await screen.findByLabelText('Saved style'),{target:{value:idA}});
  fireEvent.click(screen.getByRole('button',{name:'Apply saved style'}));expect(sent).toHaveLength(1);expect(screen.getByRole('status')).toHaveTextContent('');
  await act(async()=>{settle(false);});
  expect(screen.getByRole('alert')).toHaveTextContent('Could not apply Loud; the document is unchanged.');expect(screen.getByRole('status')).not.toHaveTextContent('Applied');
  fireEvent.click(screen.getByRole('button',{name:'Apply saved style'}));await act(async()=>{settle(true);});
  expect(screen.getByRole('status')).toHaveTextContent('Applied Loud.');expect(screen.queryByRole('alert')).toBeNull();
});

it('an_unapplied_form_blocks_apply_and_force_with_a_hint_but_not_the_library',async()=>{
  store=[{id:idA,name:'Loud',engraving:defaultEngraving()}];
  const view=render(panel({unapplied:true}));await open();fireEvent.change(await screen.findByLabelText('Saved style'),{target:{value:idA}});
  expect(screen.getByRole('button',{name:'Apply saved style'})).toBeDisabled();expect(screen.getByRole('button',{name:'Force default style'})).toBeDisabled();
  expect(screen.getByText(/Apply or reset your engraving changes/)).toBeInTheDocument();expect(screen.getByText(/Save stores the style that is applied/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'Still saves'}});expect(screen.getByRole('button',{name:'Save current style'})).toBeEnabled();expect(screen.getByRole('button',{name:'Update saved style'})).toBeEnabled();expect(screen.getByRole('button',{name:'Delete saved style'})).toBeEnabled();
  view.rerender(panel({busy:true}));expect(screen.getByRole('button',{name:'Apply saved style'})).toBeDisabled();expect(screen.getByRole('button',{name:'Force default style'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Save current style'})).toBeEnabled();expect(screen.getByRole('button',{name:'Delete saved style'})).toBeEnabled();
});

it('the_form_with_unapplied_changes_disables_apply_in_the_engraving_panel',()=>{
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={()=>{}}/>);
  expect(screen.getByRole('button',{name:'Force default style'})).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'true'}});expect(screen.getByRole('button',{name:'Force default style'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'inherit'}});expect(screen.getByRole('button',{name:'Force default style'})).toBeEnabled();
});

it('force_and_the_name_are_disabled_while_a_library_action_runs',async()=>{
  let release!:()=>void;mount(defaultEngraving(),[]);await open();
  invoke.mockImplementationOnce(()=>new Promise(accept=>{release=()=>accept(reply());}));
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'Slow'}});fireEvent.click(screen.getByRole('button',{name:'Save current style'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Force default style'})).toBeDisabled());
  expect(screen.getByLabelText('Style name')).toBeDisabled();
  await act(async()=>{release();});expect(screen.getByLabelText('Style name')).toBeEnabled();
});

it('a_damaged_library_keeps_its_alert_and_is_not_called_empty_until_a_success_clears_it',async()=>{
  mount(defaultEngraving(),[]);invoke.mockRejectedValueOnce('Invalid style library: damaged');await open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read saved styles');
  expect(screen.queryByText('No saved styles yet')).toBeNull();expect(screen.getByText('Saved styles could not be read')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Style name'),{target:{value:'Typing'}});expect(screen.getByRole('alert')).toHaveTextContent('Could not read saved styles');
  fireEvent.click(screen.getByRole('button',{name:'Save current style'}));
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());expect(store).toHaveLength(1);expect(screen.getByRole('status')).toHaveTextContent('Saved Typing.');
});

it('a_removed_tracks_profile_does_not_turn_an_identical_style_into_an_edit',async()=>{
  const commands:Edit[]=[];store=[{id:idA,name:'Same',engraving:defaultEngraving()}];
  mount(styled(value=>{value.profiles=[{trackId:'removed',profile:'slash'}];}),commands);await open();
  fireEvent.change(await screen.findByLabelText('Saved style'),{target:{value:idA}});fireEvent.click(screen.getByRole('button',{name:'Apply saved style'}));
  expect(commands).toEqual([]);expect(screen.getByRole('status')).toHaveTextContent('already matches');
});
