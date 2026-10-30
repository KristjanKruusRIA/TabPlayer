// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import type { HarmonyChord } from '../editor/harmony-types';
import { ChordDiagramPreview } from './ChordDiagramPreview';
afterEach(cleanup);
it('labels_custom_nonmonotonic_strings_in_the_supplied_sounding_context_and_highlights_the_root',()=>{
  const staff=new model.Staff();staff.stringTuning.tunings=[67,48,64];staff.capo=2;staff.transpositionPitch=1;staff.displayTranspositionPitch=24;
  const chord:HarmonyChord={name:'G#',nameMode:'theory',recipe:{root:{step:4,alteration:1},formula:'major',alterations:[],omissions:[],bass:null},firstFret:0,frets:[0,2,-1],fingers:[-2,2,-1],barreFrets:[],showName:true,showDiagram:true,showFingering:true},before=[...staff.tuning],changes:number[][]=[];
  const view=render(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot onToggle={(string,fret)=>changes.push([string,fret])}/>);
  expect(screen.getByLabelText('String 1 open: G#4, root')).toBeInTheDocument();expect(screen.getByLabelText('String 2 fret 2: D#3')).toBeInTheDocument();expect(screen.getByLabelText('String 3 muted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'String 1 fret 3: B4'}));expect(changes).toEqual([[0,3]]);
  fireEvent.click(screen.getByRole('button',{name:'String 1 muted'}));expect(changes).toEqual([[0,3],[0,-1]]);
  expect(staff.tuning).toEqual(before);expect([staff.capo,staff.transpositionPitch,staff.displayTranspositionPitch]).toEqual([2,1,24]);
  view.rerender(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot={false} onToggle={null}/>);expect(screen.queryByLabelText('String 1 open: G#4, root')).not.toBeInTheDocument();expect(screen.getByLabelText('String 1 open: G#4')).toBeInTheDocument();expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('shows_wide_legacy_frets_and_zero_string_diagrams_without_normalizing_them',()=>{
  const staff=new model.Staff();staff.stringTuning.tunings=[64,40];const chord:HarmonyChord={name:'Legacy',nameMode:'manual',recipe:null,firstFret:0,frets:[0,24],fingers:[-2,4],barreFrets:[0,24,0],showName:false,showDiagram:false,showFingering:false};
  const before=structuredClone(chord),view=render(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot onToggle={null}/>);expect(screen.getByLabelText('String 2 fret 24: E4')).toBeInTheDocument();expect(chord).toEqual(before);
  staff.stringTuning.tunings=[];view.rerender(<ChordDiagramPreview chord={{...chord,frets:[],fingers:[]}} staff={staff} highlightRoot onToggle={null}/>);expect(screen.getByText('Name-only chord; no strings.')).toBeInTheDocument();
});
