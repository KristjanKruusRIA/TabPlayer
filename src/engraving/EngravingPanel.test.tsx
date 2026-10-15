// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { scoreFromJson } from '../model-clone';
import type { EngravingCommand,EngravingOverrides } from './types';
import { defaultEngraving } from './projection';
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
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'false'}});view.rerender(<EngravingPanel {...props} busy/>);expect(screen.getByLabelText('Hide dynamics')).toBeDisabled();expect(screen.getByRole('button',{name:'Apply engraving'})).toBeDisabled();expect(screen.getByRole('button',{name:'Reset to source/default'})).toBeDisabled();
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
  fireEvent.change(screen.getByLabelText('System spacing (%)'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(commands).toEqual([{type:'setEngraving',engraving:sourceDefaults}]);
});

it('apply_and_reset_surface_controller_errors',()=>{
  const props={score:music(),trackIds:['g'],value:defaultEngraving(),busy:false,onEdit:()=>{throw new Error('Native document changed; retry.');}};
  render(<EngravingPanel {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Apply engraving'}));expect(screen.getByRole('alert')).toHaveTextContent('Native document changed; retry.');
  fireEvent.change(screen.getByLabelText('Hide dynamics'),{target:{value:'false'}});expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
