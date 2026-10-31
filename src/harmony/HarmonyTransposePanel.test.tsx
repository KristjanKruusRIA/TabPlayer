// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import type { HarmonyChord,HarmonyCommand } from '../editor/harmony-types';
import type { MusicSelection } from '../editor/range-types';
import { music,target } from '../editor/fixtures';
import { applyHarmonyEdit } from './edits';
import { HarmonyTransposePanel } from './HarmonyTransposePanel';

afterEach(cleanup);
type TransposeCommand=Extract<HarmonyCommand,{type:'transposeHarmony'}>;
const selection:MusicSelection={kind:'bars',tracks:[0],firstBar:0,lastBar:0};
const apply=()=>fireEvent.click(screen.getByRole('button',{name:'Transpose harmony'}));
it('emits exactly one signed semitone command and independent include flags',()=>{
  const score=music(),commands:TransposeCommand[]=[];render(<HarmonyTransposePanel score={score} selection={selection} busy={false} onEdit={command=>commands.push(command)}/>);
  expect(screen.getByText('Harmony transposition')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('Signed semitones'),{target:{value:'-12'}});fireEvent.click(screen.getByLabelText('Transpose key signatures'));fireEvent.click(screen.getByLabelText('Transpose theory chords'));apply();
  expect(commands).toEqual([{type:'transposeHarmony',selection,interval:{kind:'semitones',semitones:-12},includeKeySignatures:true,includeChords:true}]);
});
it('emits the exact named interval number quality direction and extra-octave DTO',()=>{
  const commands:TransposeCommand[]=[];render(<HarmonyTransposePanel score={music()} selection={selection} busy={false} onEdit={command=>commands.push(command)}/>);
  fireEvent.change(screen.getByLabelText('Transposition mode'),{target:{value:'chromatic'}});fireEvent.change(screen.getByLabelText('Interval number'),{target:{value:'5'}});fireEvent.change(screen.getByLabelText('Interval quality'),{target:{value:'diminished'}});fireEvent.change(screen.getByLabelText('Interval direction'),{target:{value:'down'}});fireEvent.change(screen.getByLabelText('Extra octaves'),{target:{value:'2'}});apply();
  expect(commands).toEqual([{type:'transposeHarmony',selection,interval:{kind:'chromatic',number:5,quality:'diminished',direction:'down',octaves:2},includeKeySignatures:false,includeChords:false}]);
});
it('diatonic mode clears and disables chord/key flags and sends signed degree steps',()=>{
  const commands:TransposeCommand[]=[];render(<HarmonyTransposePanel score={music()} selection={selection} busy={false} onEdit={command=>commands.push(command)}/>);
  fireEvent.click(screen.getByLabelText('Transpose key signatures'));fireEvent.click(screen.getByLabelText('Transpose theory chords'));fireEvent.change(screen.getByLabelText('Transposition mode'),{target:{value:'diatonic'}});
  expect(screen.getByLabelText('Transpose key signatures')).not.toBeChecked();expect(screen.getByLabelText('Transpose key signatures')).toBeDisabled();expect(screen.getByLabelText('Transpose theory chords')).not.toBeChecked();expect(screen.getByLabelText('Transpose theory chords')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Signed diatonic steps'),{target:{value:'-2'}});apply();expect(commands).toEqual([{type:'transposeHarmony',selection,interval:{kind:'diatonic',steps:-2},includeKeySignatures:false,includeChords:false}]);
  fireEvent.change(screen.getByLabelText('Transposition mode'),{target:{value:'semitones'}});expect(screen.getByLabelText('Transpose key signatures')).toBeEnabled();expect(screen.getByLabelText('Transpose key signatures')).not.toBeChecked();
});
it('uses strict command validation for no-op overflow fractional and incompatible-quality drafts',()=>{
  const commands:TransposeCommand[]=[];render(<HarmonyTransposePanel score={music()} selection={selection} busy={false} onEdit={command=>commands.push(command)}/>);
  for(const value of ['0','128','1.5','']){fireEvent.change(screen.getByLabelText('Signed semitones'),{target:{value}});apply();expect(screen.getByRole('alert')).toBeInTheDocument();expect(commands).toEqual([]);}
  fireEvent.change(screen.getByLabelText('Transposition mode'),{target:{value:'chromatic'}});fireEvent.change(screen.getByLabelText('Interval number'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('Interval quality'),{target:{value:'perfect'}});apply();expect(screen.getByRole('alert')).toHaveTextContent(/quality/i);expect(commands).toEqual([]);
  fireEvent.change(screen.getByLabelText('Interval number'),{target:{value:'1'}});apply();expect(screen.getByRole('alert')).toHaveTextContent(/nonzero/i);expect(commands).toEqual([]);fireEvent.change(screen.getByLabelText('Interval number'),{target:{value:'3'}});
  fireEvent.change(screen.getByLabelText('Interval quality'),{target:{value:'major'}});fireEvent.change(screen.getByLabelText('Extra octaves'),{target:{value:''}});apply();expect(screen.getByRole('alert')).toBeInTheDocument();expect(commands).toEqual([]);
  fireEvent.change(screen.getByLabelText('Extra octaves'),{target:{value:'0'}});apply();expect(commands).toHaveLength(1);expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('disables apply with a visible selection hint and every control while busy',()=>{
  const score=music(),commands:TransposeCommand[]=[],props={score,selection:null,busy:false,onEdit:(command:TransposeCommand)=>commands.push(command)},view=render(<HarmonyTransposePanel {...props}/>);
  expect(screen.getByRole('button',{name:'Transpose harmony'})).toBeDisabled();expect(screen.getByText(/select music.*music selection/i)).toBeInTheDocument();apply();expect(commands).toEqual([]);
  view.rerender(<HarmonyTransposePanel {...props} selection={selection} busy/>);for(const control of [...screen.getAllByRole('combobox'),...screen.getAllByRole('spinbutton'),...screen.getAllByRole('checkbox'),...screen.getAllByRole('button')])expect(control).toBeDisabled();
});
const theory=():HarmonyChord=>({name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true});
it('counts selected manual and context-changed chord references once per beat without mutating sources',()=>{
  const score=music(),staff=score.tracks[0].staves[0],beats=staff.bars[0].voices[0].beats;
  applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:{...theory(),name:' exact manual ',nameMode:'manual',recipe:null},fillEmptyBeat:false},0);beats[1].chordId=beats[0].chordId;
  applyHarmonyEdit(score,{type:'setHarmonyChord',target:{...target,beat:2},chord:theory(),fillEmptyBeat:false},1);staff.capo=1;
  const before=model.JsonConverter.scoreToJson(score),view=render(<HarmonyTransposePanel score={score} selection={selection} busy={false} onEdit={()=>{}}/>);
  expect(screen.getByLabelText('Skipped chord references')).toHaveTextContent('3 manual or context-changed chord references will be skipped');expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  view.rerender(<HarmonyTransposePanel score={score} selection={{kind:'notes',notes:[{target:{...target,beat:2},noteIndex:0}]}} busy={false} onEdit={()=>{}}/>);expect(screen.getByLabelText('Skipped chord references')).toHaveTextContent('1 manual or context-changed chord reference will be skipped');
});
it('reports a stale selection without dispatch and clears local errors on selection replacement',()=>{
  const score=music(),commands:TransposeCommand[]=[],props={score,selection,busy:false,onEdit:(command:TransposeCommand)=>commands.push(command)},view=render(<HarmonyTransposePanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Signed semitones'),{target:{value:'0'}});apply();expect(screen.getByRole('alert')).toBeInTheDocument();
  view.rerender(<HarmonyTransposePanel {...props} selection={{kind:'bars',tracks:[99],firstBar:0,lastBar:0}}/>);expect(screen.getByRole('alert')).toHaveTextContent(/track/i);expect(screen.getByRole('button',{name:'Transpose harmony'})).toBeDisabled();expect(commands).toEqual([]);
  view.rerender(<HarmonyTransposePanel {...props} selection={{...selection}}/>);expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
