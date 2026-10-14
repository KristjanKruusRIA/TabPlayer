// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { TechniquePanel } from './TechniquePanel';
import { StructurePanel } from './StructurePanel';
import { MeasurePanel } from './MeasurePanel';
import { CurveEditor } from './CurveEditor';
import { ChordDialog } from './ChordDialog';
import { music, target } from './fixtures';
afterEach(cleanup);
it('all technique families dispatch finite selected-string commands and refresh readback',()=>{
  const score=music(),onEdit=vi.fn(),props={score,target,string:6,busy:false,onEdit};const view=render(<TechniquePanel {...props}/>);
  fireEvent.click(screen.getByLabelText('Palm mute'));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{palmMute:true}});
  for(const label of ['Accent','Dynamics','Left-hand finger','Right-hand finger','Slide in','Slide out','Vibrato','Ornament','Harmonic type','Trill speed','Pick stroke','Brush direction','Tremolo speed'])expect(screen.getByLabelText(label)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Tie to next note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:{target:{...target,beat:1},string:6},kind:'tie'});
  fireEvent.click(screen.getByRole('button',{name:'Break tie'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:null,kind:'tie'});
  score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isPalmMute=true;view.rerender(<TechniquePanel {...props}/>);expect(screen.getByLabelText('Palm mute')).toBeChecked();view.rerender(<TechniquePanel {...props} score={music()}/>);expect(screen.getByLabelText('Palm mute')).not.toBeChecked();
  view.rerender(<TechniquePanel {...props} busy/>);expect(screen.getByLabelText('Palm mute')).toBeDisabled();
});
it.each([
  ['Let ring','letRing'],['Palm mute','palmMute'],['Dead note','dead'],['Ghost note','ghost'],['Staccato','staccato'],['Left-hand tapping','leftHandTapped'],
] as const)('accessible %s dispatch uses selected string', (label,key)=>{
  const onEdit=vi.fn();render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);fireEvent.click(screen.getByLabelText(label));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{[key]:true}});
});
it.each([
  ['Accent','accent','3'],['Dynamics','dynamics','2'],['Left-hand finger','leftFinger','2'],['Right-hand finger','rightFinger','3'],['Slide in','slideIn','1'],['Slide out','slideOut','4'],['Vibrato','vibrato','2'],['Ornament','ornament','1'],
] as const)('accessible %s dispatch uses finite enum',(label,key,value)=>{
  const onEdit=vi.fn();render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);fireEvent.change(screen.getByLabelText(label),{target:{value}});expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{[key]:Number(value)}});
});
it('harmonic trill pick brush tremolo controls dispatch complete field values',()=>{
  const onEdit=vi.fn();render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Harmonic type'),{target:{value:'3'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{harmonic:{type:3,value:12}}});
  fireEvent.click(screen.getByLabelText('Trill'));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{trill:{pitch:69,speed:16}}});
  fireEvent.change(screen.getByLabelText('Pick stroke'),{target:{value:'2'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setBeatTechniques',target,patch:{pickStroke:2}});
  fireEvent.change(screen.getByLabelText('Brush direction'),{target:{value:'3'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setBeatTechniques',target,patch:{brushType:3}});
  fireEvent.click(screen.getByLabelText('Tremolo picking'));expect(onEdit).toHaveBeenLastCalledWith({type:'setBeatTechniques',target,patch:{tremolo:{speed:16,style:0}}});
});
it('copy voice range controls issue one replace-range command',()=>{
  const score=music(),staff=score.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice();const beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  const onEdit=vi.fn();render(<StructurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()}/>);fireEvent.change(screen.getByLabelText('Copy from measure'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Copy through measure'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Copy voice range'}));expect(onEdit).toHaveBeenLastCalledWith({type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:1,endBar:2});
});
it('curve editor emits quarter-tone endpoints and supports keyboard inputs',()=>{
  const onChange=vi.fn();render(<CurveEditor label="Bend" value={null} onChange={onChange}/>);
  fireEvent.click(screen.getByLabelText('Enable Bend'));fireEvent.change(screen.getByLabelText('Bend point 2 value'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Apply Bend curve'}));
  expect(onChange).toHaveBeenLastCalledWith({type:1,style:0,points:[{offset:0,value:0},{offset:60,value:4}]});
});
it('voice staff and layout controls dispatch exact commands',()=>{
  const onEdit=vi.fn();render(<StructurePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit} onSelect={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Add voice'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addVoice',track:0,staff:0});
  fireEvent.click(screen.getByRole('button',{name:'Add staff'}));expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'addStaff',track:0}));
});
it('staff tuning uses named notes, validates drafts and refreshes from history',()=>{
  const score=music(),onEdit=vi.fn(),props={score,target,string:6,busy:false,onEdit,onSelect:vi.fn()};const view=render(<StructurePanel {...props}/>);const input=screen.getByLabelText('Staff tuning (notes, high to low)');expect(input).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.change(input,{target:{value:'E4 B3 G3 D3 A2 Db2'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setStaffSettings',settings:expect.objectContaining({tuning:[64,59,55,50,45,37]})}));onEdit.mockClear();
  fireEvent.change(input,{target:{value:'E4 bad'}});fireEvent.click(screen.getByRole('button',{name:'Apply staff settings'}));expect(onEdit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent(/note|octave/i);
  view.rerender(<StructurePanel {...props} score={music()}/>);expect(input).toHaveValue('E4 B3 G3 D3 A2 E2');
});
it('staff preset readback resets Custom on staff selection and percussion disables tuning',()=>{
  const score=music(),staff=score.tracks[0].staves[0],second=new model.Staff();second.stringTuning.tunings=[...staff.tuning];score.tracks[0].addStaff(second);const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);second.addBar(bar);
  const props={score,target,string:6,busy:false,onEdit:vi.fn(),onSelect:vi.fn()},view=render(<StructurePanel {...props}/>);fireEvent.change(screen.getByLabelText('Staff tuning preset'),{target:{value:'custom'}});expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('custom');view.rerender(<StructurePanel {...props} target={{...target,staff:1}}/>);expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-6-standard-e');second.isPercussion=true;view.rerender(<StructurePanel {...props} target={{...target,staff:1}}/>);expect(screen.getByLabelText('Staff tuning preset')).toBeDisabled();expect(screen.getByLabelText('Staff tuning (notes, high to low)')).toBeDisabled();
});
it('measure meter and tempo controls dispatch current musical values',()=>{
  const onEdit=vi.fn();render(<MeasurePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Time numerator'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'Apply measure settings'}));expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setMeasureSettings',bar:0,numerator:3,denominator:4}));
});
it('chord dialog has accessible focus and saves per-string positions',()=>{
  const onChange=vi.fn(),onClose=vi.fn();render(<ChordDialog strings={6} value={null} onChange={onChange} onClose={onClose}/>);
  const input=screen.getByLabelText('Chord name');expect(input).toHaveFocus();fireEvent.change(input,{target:{value:'Am'}});fireEvent.click(screen.getByRole('button',{name:'Apply chord'}));expect(onChange).toHaveBeenCalledWith({name:'Am',firstFret:1,frets:[-1,-1,-1,-1,-1,-1]});expect(onClose).toHaveBeenCalled();
});
it('chord dialog traps keyboard focus and Escape closes',()=>{
  const onClose=vi.fn();render(<ChordDialog strings={6} value={null} onChange={vi.fn()} onClose={onClose}/>);const name=screen.getByLabelText('Chord name'),cancel=screen.getByRole('button',{name:'Cancel'});
  fireEvent.keyDown(name,{key:'Tab',shiftKey:true});expect(cancel).toHaveFocus();fireEvent.keyDown(cancel,{key:'Tab'});expect(name).toHaveFocus();fireEvent.keyDown(name,{key:'Escape'});expect(onClose).toHaveBeenCalled();
});
