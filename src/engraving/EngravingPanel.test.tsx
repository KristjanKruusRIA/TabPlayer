// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { scoreFromJson } from '../model-clone';
import type { EngravingCommand,EngravingOverrides } from './types';
import { defaultEngraving } from './projection';
import { withFonts } from './fonts';
import { defaultHeaderFooter } from './header-footer';
import { EngravingPanel } from './EngravingPanel';

afterEach(cleanup);
const sourceDefaults:EngravingOverrides={stylesheet:{hideDynamics:null,brackets:'inherit',extendBarLines:null,systemSeparators:null,tuning:null,chords:'inherit',singleNames:'inherit',multiNames:'inherit',firstNames:'inherit',otherNames:'inherit',firstNameDirection:'inherit',otherNameDirection:'inherit',barNumbers:'inherit',multiRests:'inherit',hideEmptyStaves:null,hideEmptyFirstSystem:null,singleStaffBrackets:null},notation:{tabRhythm:'inherit',fingering:'inherit',smallGraceTab:null,extendBendArrows:null,extendLineEffects:null,parenthesizeTiedBends:null,showTiedBendNumbers:null,showDiveWhammyZeros:null},systemSpacing:null,profiles:[]};
type Edit=Extract<EngravingCommand,{type:'setEngraving'}>;

it('engraving_panel_roundtrips_source_choices_and_profiles_as_one_complete_command',()=>{
  const score=music(),before=model.JsonConverter.scoreToJson(score),commands:Edit[]=[];score.stylesheet.hideDynamics=true;
  render(<EngravingPanel score={score} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  const dynamics=screen.getByLabelText('Hide dynamics');expect(dynamics).toHaveValue('inherit');expect(within(dynamics).getByRole('option',{name:'Source/default (Yes)'})).toBeInTheDocument();expect(commands).toEqual([]);
  fireEvent.change(dynamics,{target:{value:'false'}});fireEvent.change(screen.getByLabelText('Brackets'),{target:{value:'similar'}});
  fireEvent.change(screen.getByLabelText('Chord diagrams'),{target:{value:'both'}});fireEvent.change(screen.getByLabelText('Tab rhythm'),{target:{value:'connected'}});
  fireEvent.change(screen.getByLabelText('Fingering'),{target:{value:'abovePiano'}});fireEvent.change(screen.getByLabelText('Guitar notation profile'),{target:{value:'slash'}});
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:'175.5'}});expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([{type:'setEngraving',engraving:{...sourceDefaults,stylesheet:{...sourceDefaults.stylesheet,hideDynamics:false,brackets:'similar',chords:'both'},notation:{...sourceDefaults.notation,tabRhythm:'connected',fingering:'abovePiano'},systemSpacing:1.755,profiles:[{trackId:'source/guitar',profile:'slash'}]}}]);
  expect(score.tracks[0].staves[0].showSlash).toBe(false);score.stylesheet.hideDynamics=false;expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('reset_emits_source_defaults_once_and_applied_value_or_document_resets_drafts',()=>{
  const score=music(),commands:Edit[]=[],value=defaultEngraving();value.stylesheet.hideDynamics=true;value.profiles=[{trackId:'removed',profile:'numbered'},{trackId:'source/guitar',profile:'standard'}];
  const props={score,trackIds:['source/guitar'],value,busy:false,onEdit:(edit:Edit)=>commands.push(edit)},view=render(<EngravingPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'false'}});view.rerender(<EngravingPanel {...props} busy/>);
  for(const control of [screen.getByLabelText('Hide dynamics'),screen.getByRole('button',{name:'Apply engraving'}),screen.getByRole('button',{name:'Reset to source/default'})])expect(control).not.toBeDisabled();
  for(const button of [screen.getByRole('button',{name:'Apply engraving'}),screen.getByRole('button',{name:'Reset to source/default'})])expect(button).toHaveAttribute('aria-disabled','true');
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));expect(commands).toEqual([]);
  view.rerender(<EngravingPanel {...props} value={defaultEngraving()}/>);expect(screen.getByLabelText('Hide dynamics')).toHaveValue('inherit');expect(screen.getByLabelText('Guitar notation profile')).toHaveValue('source');
  view.rerender(<EngravingPanel {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(commands[0].engraving.profiles).toEqual([{trackId:'source/guitar',profile:'standard'}]);
  fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));expect(commands[1]).toEqual({type:'setEngraving',engraving:sourceDefaults});expect(screen.getByLabelText('Hide dynamics')).toHaveValue('inherit');
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:'200'}});view.rerender(<EngravingPanel {...props} score={music()}/>);expect(screen.getByLabelText('System spacing (%)')).toHaveValue(null);expect(commands).toHaveLength(2);
});

it('invalid_spacing_does_not_dispatch_and_profiles_offer_only_applicable_choices',()=>{
  const score=music(),piano=scoreFromJson(model.JsonConverter.scoreToJson(music()),new Settings()).tracks[0];piano.name='Piano';piano.staves[0].stringTuning.tunings=[];score.addTrack(piano);
  const drums=scoreFromJson(model.JsonConverter.scoreToJson(music()),new Settings()).tracks[0];drums.name='Drums';drums.staves[0].isPercussion=true;score.addTrack(drums);score.finish(new Settings());
  const commands:Edit[]=[];render(<EngravingPanel score={score} trackIds={['g','p','d']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(within(screen.getByLabelText('Piano notation profile')).getByRole('option',{name:'Tablature'})).toBeDisabled();expect(within(screen.getByLabelText('Drums notation profile')).getByRole('option',{name:'Numbered'})).toBeDisabled();expect(within(screen.getByLabelText('Piano notation profile')).getByRole('option',{name:'Standard + tablature'})).toBeEnabled();
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:'24.9'}});fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(commands).toEqual([]);expect(screen.getByRole('alert')).toHaveTextContent('25%');
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(commands).toEqual([]);
});

it('apply_and_reset_surface_controller_errors',()=>{
  const value=defaultEngraving();value.stylesheet.hideDynamics=true;
  const props={score:music(),trackIds:['g'],value,busy:false,onEdit:()=>{throw new Error('Native document changed; retry.');}};
  render(<EngravingPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'false'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(screen.getByRole('alert')).toHaveTextContent('Native document changed; retry.');
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'inherit'}});expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));expect(screen.getByRole('alert')).toHaveTextContent('Native document changed; retry.');
});

it('equivalent_accepted_values_and_parent_renders_preserve_unsubmitted_drafts',()=>{
  const accepted=defaultEngraving(),commands:Edit[]=[],props={score:music(),trackIds:['g'],value:accepted,busy:false,onEdit:(edit:Edit)=>commands.push(edit)},view=render(<EngravingPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:'175'}});fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'true'}});
  view.rerender(<EngravingPanel {...props} value={structuredClone(accepted)} trackIds={['g']} busy/>);
  expect(screen.getByLabelText('System spacing (%)')).toHaveValue(175);expect(screen.getByLabelText('Hide dynamics')).toHaveValue('true');
  const equivalent={...structuredClone(accepted),stylesheet:Object.fromEntries(Object.entries(accepted.stylesheet).reverse()) as EngravingOverrides['stylesheet']};
  view.rerender(<EngravingPanel {...props} value={equivalent} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByLabelText('System spacing (%)')).toHaveValue(175);expect(screen.getByLabelText('Hide dynamics')).toHaveValue('true');expect(commands).toEqual([]);
  const changed={...accepted,systemSpacing:1.25};view.rerender(<EngravingPanel {...props} value={changed}/>);
  expect(screen.getByLabelText('System spacing (%)')).toHaveValue(125);expect(screen.getByLabelText('Hide dynamics')).toHaveValue('inherit');
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:'200'}});view.rerender(<EngravingPanel {...props} value={structuredClone(changed)} trackIds={['replacement']}/>);
  expect(screen.getByLabelText('System spacing (%)')).toHaveValue(125);expect(commands).toEqual([]);
});

it('typography_fields_commit_on_blur_or_enter_and_apply_as_one_command',()=>{
  const score=music(),commands:Edit[]=[];
  render(<EngravingPanel score={score} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByRole('combobox',{name:'Music font'})).toHaveValue('bravura');
  fireEvent.change(screen.getByRole('combobox',{name:'Text font'}),{target:{value:'serif'}});
  const text=screen.getByLabelText('Text size (%)'),title=screen.getByLabelText('Title size (%)'),tab=screen.getByLabelText('Tab number size (%)');
  // Typing alone changes nothing: half a number must not rewrite the setting.
  fireEvent.change(text,{target:{value:'1'}});expect(text).toHaveValue(1);fireEvent.change(text,{target:{value:'125'}});fireEvent.blur(text);
  fireEvent.change(title,{target:{value:'140'}});fireEvent.keyDown(title,{key:'Enter'});
  fireEvent.change(tab,{target:{value:'110'}});fireEvent.blur(tab);
  expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([{type:'setEngraving',engraving:{...sourceDefaults,typography:{family:'serif',textScale:1.25,titleScale:1.4,tabScale:1.1}}}]);
});

it('out_of_range_typography_is_reported_and_leaves_the_draft_unchanged',()=>{
  const commands:Edit[]=[];
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  const text=screen.getByLabelText('Text size (%)'),tab=screen.getByLabelText('Tab number size (%)');
  fireEvent.change(text,{target:{value:'250'}});fireEvent.blur(text);expect(screen.getByRole('alert')).toHaveTextContent('Text size must be between 50% and 200%.');expect(text).toHaveValue(null);
  fireEvent.change(tab,{target:{value:'70'}});fireEvent.blur(tab);expect(screen.getByRole('alert')).toHaveTextContent('Tab number size must be between 75% and 150%.');
  // The draft is still the document's own, so Apply changes nothing and records nothing.
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(commands).toEqual([]);
});

it('default_typography_is_never_sent_and_an_applied_one_fills_the_form',()=>{
  const commands:Edit[]=[],value=defaultEngraving();value.typography={family:'mono',textScale:null,titleScale:2,tabScale:null};
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={value} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByRole('combobox',{name:'Text font'})).toHaveValue('mono');expect(screen.getByLabelText('Title size (%)')).toHaveValue(200);
  fireEvent.change(screen.getByRole('combobox',{name:'Text font'}),{target:{value:'inherit'}});
  const title=screen.getByLabelText('Title size (%)');fireEvent.change(title,{target:{value:''}});fireEvent.blur(title);
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([{type:'setEngraving',engraving:sourceDefaults}]);expect('typography' in commands[0].engraving).toBe(false);
});

it('loading_a_preset_fills_the_form_without_editing_and_keeps_spacing_and_profiles',()=>{
  const commands:Edit[]=[],value=defaultEngraving();value.systemSpacing=1.5;value.profiles=[{trackId:'source/guitar',profile:'slash'}];
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={value} busy={false} onEdit={edit=>commands.push(edit)}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load Rock preset'}));
  expect(commands).toEqual([]);expect(screen.getByLabelText('Tab rhythm')).toHaveValue('beams');expect(screen.getByRole('combobox',{name:'Text font'})).toHaveValue('sans');
  expect(screen.getByLabelText('Tab number size (%)')).toHaveValue(115);expect(screen.getByLabelText('System spacing (%)')).toHaveValue(150);expect(screen.getByLabelText('Guitar notation profile')).toHaveValue('slash');
  fireEvent.click(screen.getByRole('button',{name:'Load Jazz preset'}));expect(screen.getByLabelText('Tab rhythm')).toHaveValue('hidden');expect(screen.getByLabelText('Tab number size (%)')).toHaveValue(null);expect(screen.getByLabelText('Chord diagrams')).toHaveValue('both');
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toHaveLength(1);expect(commands[0].engraving.typography).toEqual({family:'serif',textScale:1.15,titleScale:1.4,tabScale:null});
  expect([commands[0].engraving.systemSpacing,commands[0].engraving.profiles]).toEqual([1.5,[{trackId:'source/guitar',profile:'slash'}]]);
});

it('typography_and_presets_refuse_changes_while_busy_without_losing_focus',()=>{
  const commands:Edit[]=[],props={score:music(),trackIds:['source/guitar'],value:defaultEngraving(),busy:false,onEdit:(edit:Edit)=>commands.push(edit)},view=render(<EngravingPanel {...props}/>);
  const family=screen.getByRole('combobox',{name:'Text font'});family.focus();
  view.rerender(<EngravingPanel {...props} busy/>);
  expect(family).toHaveFocus();expect(family).toBeEnabled();expect(family).toHaveAttribute('aria-disabled','true');
  fireEvent.change(family,{target:{value:'mono'}});expect(family).toHaveValue('inherit');
  const text=screen.getByLabelText('Text size (%)');fireEvent.change(text,{target:{value:'150'}});fireEvent.blur(text);
  fireEvent.click(screen.getByRole('button',{name:'Load Classic preset'}));expect(screen.getByLabelText('Tab rhythm')).toHaveValue('inherit');
  fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'notoSerif'}});expect(screen.getByRole('combobox',{name:'Lyrics font'})).toHaveValue('inherit');
  view.rerender(<EngravingPanel {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([]);
});

it('typography_labels_unchanged_in_english',()=>{
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={()=>undefined}/>);
  expect(screen.getByText('Typography')).toBeInTheDocument();
  expect(screen.getByRole('combobox',{name:'Text font'})).toBeInTheDocument();
  for(const label of ['Text size (%)','Title size (%)','Tab number size (%)'])expect(screen.getByLabelText(label)).toBeInTheDocument();
  expect(within(screen.getByRole('combobox',{name:'Text font'})).getAllByRole('option').map(option=>option.textContent)).toEqual(['Source/default','Sans-serif','Serif','Monospace']);
  expect(screen.getByLabelText('Text size (%)')).toHaveAttribute('placeholder','Source/default (100%)');
});

it('role_grid_fills_draft_and_apply_sends_one_set_engraving',()=>{
  const commands:Edit[]=[];
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'notoSerif'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Lyrics italic'}),{target:{value:'on'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Markers font'}),{target:{value:'notoSansMono'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Markers bold'}),{target:{value:'off'}});
  const header=screen.getByLabelText('Page header size (%)');fireEvent.change(header,{target:{value:'150'}});fireEvent.blur(header);
  fireEvent.change(screen.getByRole('combobox',{name:'Music font'}),{target:{value:'petaluma'}});
  // Nothing is sent until Apply.
  expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([{type:'setEngraving',engraving:{...sourceDefaults,fonts:{music:'petaluma',roles:{lyrics:{font:'notoSerif',italic:true},markers:{font:'notoSansMono',bold:false},pageHeader:{size:1.5}}}}}]);
});

it('apply_unchanged_fonts_records_nothing',()=>{
  const commands:Edit[]=[];
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  // Choosing and un-choosing leaves an empty draft ({}), which must go out exactly as the document already is: no fonts key at all.
  fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'notoSerif'}});fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'inherit'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Music font'}),{target:{value:'leland'}});fireEvent.change(screen.getByRole('combobox',{name:'Music font'}),{target:{value:'bravura'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([]);
  // Applying a real change afterwards still goes out, and still without an empty fonts key.
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'true'}});fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toHaveLength(1);expect('fonts' in commands[0].engraving).toBe(false);
});

it('applied_fonts_fill_the_form_and_reset_the_draft_after_undo_or_redo',()=>{
  const commands:Edit[]=[],applied=withFonts(defaultEngraving(),{music:'leland',roles:{lyrics:{font:'notoSerif',bold:false}}}),props={score:music(),trackIds:['source/guitar'],busy:false,onEdit:(edit:Edit)=>commands.push(edit)};
  const view=render(<EngravingPanel {...props} value={applied}/>);
  expect(screen.getByRole('combobox',{name:'Music font'})).toHaveValue('leland');expect(screen.getByRole('combobox',{name:'Lyrics font'})).toHaveValue('notoSerif');expect(screen.getByRole('combobox',{name:'Lyrics bold'})).toHaveValue('off');
  // An equal value keeps an unsent draft; a different font choice (undo or redo) replaces it.
  fireEvent.change(screen.getByRole('combobox',{name:'Markers font'}),{target:{value:'notoSans'}});
  view.rerender(<EngravingPanel {...props} value={structuredClone(applied)}/>);expect(screen.getByRole('combobox',{name:'Markers font'})).toHaveValue('notoSans');
  view.rerender(<EngravingPanel {...props} value={withFonts(defaultEngraving(),{roles:{lyrics:{font:'notoSerif',bold:true}}})}/>);
  expect(screen.getByRole('combobox',{name:'Markers font'})).toHaveValue('inherit');expect(screen.getByRole('combobox',{name:'Music font'})).toHaveValue('bravura');expect(screen.getByRole('combobox',{name:'Lyrics bold'})).toHaveValue('on');
  view.rerender(<EngravingPanel {...props} value={defaultEngraving()}/>);
  expect(screen.getByRole('combobox',{name:'Lyrics font'})).toHaveValue('inherit');
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([]);
});

it('fonts_count_as_unapplied_changes_for_saved_styles',()=>{
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={()=>undefined}/>);
  expect(screen.queryByText(/Apply or reset your engraving changes/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'notoSerif'}});expect(screen.getByText(/Apply or reset your engraving changes/)).toBeInTheDocument();
  // An emptied draft is the same as no fonts.
  fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'inherit'}});expect(screen.queryByText(/Apply or reset your engraving changes/)).not.toBeInTheDocument();
});

it('reset_clears_fonts_and_sends_the_default',()=>{
  const commands:Edit[]=[],value=withFonts(defaultEngraving(),{roles:{lyrics:{font:'notoSerif'}}});
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={value} busy={false} onEdit={edit=>commands.push(edit)}/>);
  fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));
  expect(commands).toEqual([{type:'setEngraving',engraving:sourceDefaults}]);expect(screen.getByRole('combobox',{name:'Lyrics font'})).toHaveValue('inherit');
});

it('font_notes_come_from_the_score_text_and_the_font_status',()=>{
  const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics=['中'];
  const value=withFonts(defaultEngraving(),{music:'petaluma',roles:{lyrics:{font:'notoSerif'}}});
  const props={score,trackIds:['source/guitar'],value,busy:false,onEdit:()=>undefined},view=render(<EngravingPanel {...props} fontStatus={{failed:['NotoSerif-Italic.ttf'],substituted:['a','b']}}/>);
  expect(screen.getByText('Noto Serif has no glyph for ‘中’ (Lyrics); it is drawn from the fallback font.')).toBeInTheDocument();
  expect(screen.getByText('2 music symbols are not in Petaluma and are drawn from Bravura.')).toBeInTheDocument();
  expect(screen.getByText(/A font could not be loaded: Noto Serif Italic\./)).toBeInTheDocument();
  // The substitution count belongs to the font on screen, not to an unapplied choice in the form.
  fireEvent.change(screen.getByRole('combobox',{name:'Music font'}),{target:{value:'leland'}});
  expect(screen.queryByText(/music symbols are not in/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'Music font'}),{target:{value:'petaluma'}});
  expect(screen.getByText('2 music symbols are not in Petaluma and are drawn from Bravura.')).toBeInTheDocument();
  view.rerender(<EngravingPanel {...props}/>);expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
});

it('page_header_and_footer_text_comes_from_the_given_bands',()=>{
  const score=music(),bands=defaultHeaderFooter();bands.first.header.right='中';
  const value=withFonts(defaultEngraving(),{roles:{pageHeader:{font:'notoSerif'}}});
  const props={score,trackIds:['source/guitar'],value,busy:false,onEdit:()=>undefined},view=render(<EngravingPanel {...props}/>);
  expect(screen.queryByText(/has no glyph/)).not.toBeInTheDocument();
  view.rerender(<EngravingPanel {...props} headerFooter={bands}/>);
  expect(screen.getByText('Noto Serif has no glyph for ‘中’ (Page header); it is drawn from the fallback font.')).toBeInTheDocument();
});

it('role_size_errors_use_the_panel_alert',()=>{
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={()=>undefined}/>);
  const size=screen.getByLabelText('Lyrics size (%)');fireEvent.change(size,{target:{value:'300'}});fireEvent.blur(size);
  expect(screen.getByRole('alert')).toHaveTextContent('Lyrics size must be between 50% and 200%.');
});

it('reset_and_apply_that_change_nothing_record_nothing_but_still_refill_the_form',()=>{
  const commands:Edit[]=[];
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={defaultEngraving()} busy={false} onEdit={edit=>commands.push(edit)}/>);
  fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));expect(commands).toEqual([]);
  // An unsent draft is dropped by Reset even when the document is already at the defaults.
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'true'}});fireEvent.change(screen.getByRole('combobox',{name:'Lyrics font'}),{target:{value:'notoSerif'}});
  fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));
  expect(commands).toEqual([]);expect(screen.getByLabelText('Hide dynamics')).toHaveValue('inherit');expect(screen.getByRole('combobox',{name:'Lyrics font'})).toHaveValue('inherit');
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(commands).toEqual([]);
});

it('apply and reset keep staff groups and gaps',()=>{
  const commands:Edit[]=[],value=defaultEngraving();value.stylesheet.hideDynamics=true;value.staffGroups=[{trackIds:['source/guitar','b'],kind:'brace'}];value.staffGaps=[{trackId:'source/guitar',scale:2}];
  render(<EngravingPanel score={music()} trackIds={['source/guitar']} value={value} busy={false} onEdit={edit=>commands.push(edit)}/>);
  // Each gesture changes something, since choosing what the document already has records nothing.
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'false'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));
  expect(commands).toHaveLength(2);
  for(const command of commands){expect(command.engraving.staffGroups).toEqual(value.staffGroups);expect(command.engraving.staffGaps).toEqual(value.staffGaps);}
});

it('apply sends the staff groups and gaps changed elsewhere together with a change made in the form',()=>{
  const commands:Edit[]=[],first=defaultEngraving();first.staffGroups=[{trackIds:['source/guitar','b'],kind:'brace'}];
  const props={score:music(),trackIds:['source/guitar'],busy:false,onEdit:(edit:Edit)=>commands.push(edit)},view=render(<EngravingPanel {...props} value={first}/>);
  const next=defaultEngraving();next.staffGroups=[{trackIds:['source/guitar','c'],kind:'bracket'}];next.staffGaps=[{trackId:'source/guitar',scale:3}];
  view.rerender(<EngravingPanel {...props} value={next}/>);
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'true'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toHaveLength(1);expect(commands[0].engraving.staffGroups).toEqual(next.staffGroups);expect(commands[0].engraving.staffGaps).toEqual(next.staffGaps);
});

it('apply records nothing when only the staff groups or gaps changed outside the panel',()=>{
  const commands:Edit[]=[],first=defaultEngraving();first.staffGroups=[{trackIds:['source/guitar','b'],kind:'brace'}];
  const props={score:music(),trackIds:['source/guitar'],busy:false,onEdit:(edit:Edit)=>commands.push(edit)},view=render(<EngravingPanel {...props} value={first}/>);
  const next=defaultEngraving();next.staffGroups=[{trackIds:['source/guitar','c'],kind:'bracket'}];next.staffGaps=[{trackId:'source/guitar',scale:3}];
  view.rerender(<EngravingPanel {...props} value={next}/>);
  // Nothing in the form differs from the document, and the groups and gaps are not part of the form, so neither Apply nor Reset has anything to record.
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));
  expect(commands).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Reset to source/default'}));
  expect(commands).toEqual([]);
});
