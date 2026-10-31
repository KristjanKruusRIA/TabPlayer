// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { music,target } from './fixtures';
import { RangePanel } from './RangePanel';
import type { MusicSelection,RangeCommand } from './range-types';

afterEach(cleanup);
const selection:MusicSelection={kind:'notes',notes:[{target,noteIndex:0}]};
it('dispatches finite semitone, string, refinger, erase and selected-string sustain commands',()=>{
  const score=music(),commands:RangeCommand[]=[];
  render(<RangePanel score={score} target={target} selection={selection} busy={false} onSelection={()=>{}} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByText('1 note · 1 beat')).toBeInTheDocument();expect(screen.getByText(/Track 1.*Staff 1.*Voice 1/)).toBeInTheDocument();
  for(const label of ['Down semitone','Up semitone','Down octave','Up octave'])fireEvent.click(screen.getByRole('button',{name:label}));
  fireEvent.change(screen.getByLabelText('Semitones'),{target:{value:'7'}});fireEvent.click(screen.getByRole('button',{name:'Transpose selection'}));
  fireEvent.click(screen.getByRole('button',{name:'Move to higher string'}));fireEvent.click(screen.getByRole('button',{name:'Move to lower string'}));fireEvent.click(screen.getByRole('button',{name:'Re-finger selection'}));
  for(const string of [2,3,4,5,6])fireEvent.click(screen.getByLabelText(`String ${string}`));
  fireEvent.click(screen.getByRole('button',{name:'Enable let ring'}));fireEvent.click(screen.getByRole('button',{name:'Disable palm mute'}));fireEvent.click(screen.getByRole('button',{name:'Erase selected notes'}));
  expect(commands).toEqual([
    ...[-1,1,-12,12,7].map(semitones=>({type:'transposeSelection',selection,semitones})),
    {type:'moveSelectionStrings',selection,direction:'higher'},{type:'moveSelectionStrings',selection,direction:'lower'},
    {type:'refingerSelection',selection,maxFret:24},
    {type:'setSelectionSustain',selection,strings:[1],kind:'letRing',enabled:true},
    {type:'setSelectionSustain',selection,strings:[1],kind:'palmMute',enabled:false},
    {type:'eraseSelection',selection},
  ]);
});
it('selection actions and range scope only invoke onSelection',()=>{
  const score=music();score.addTrack(music().tracks[0]);const changes:(MusicSelection|null)[]=[],commands:RangeCommand[]=[];
  const range:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:1920},lanes:[{track:0,staff:0,voice:0}]}};
  render(<RangePanel score={score} target={target} selection={range} busy={false} onSelection={value=>changes.push(value)} onEdit={edit=>commands.push(edit)}/>);
  for(const label of ['Select bar','Select track','Select all','Clear selection'])fireEvent.click(screen.getByRole('button',{name:label}));
  fireEvent.change(screen.getByLabelText('Selection scope'),{target:{value:'all'}});fireEvent.click(screen.getByRole('button',{name:'Apply selection scope'}));
  expect(changes).toEqual([
    {kind:'bars',tracks:[0],firstBar:0,lastBar:0},{kind:'bars',tracks:[0],firstBar:0,lastBar:3},
    {kind:'bars',tracks:[0,1],firstBar:0,lastBar:3},null,
    {kind:'range',range:{...range.range,lanes:[{track:0,staff:0,voice:0},{track:1,staff:0,voice:0}]}},
  ]);expect(commands).toEqual([]);
});
it('invalid drafts and stale selections produce errors without dispatch',()=>{
  const score=music(),commands:RangeCommand[]=[],props={score,target,selection,busy:false,onSelection:()=>{},onEdit:(edit:RangeCommand)=>commands.push(edit)},view=render(<RangePanel {...props}/>);
  for(const value of ['0','128','1.5','']){fireEvent.change(screen.getByLabelText('Semitones'),{target:{value}});fireEvent.click(screen.getByRole('button',{name:'Transpose selection'}));expect(screen.getByRole('alert')).toHaveTextContent(/semitone/i);}
  fireEvent.change(screen.getByLabelText('Maximum fret'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Re-finger selection'}));expect(screen.getByRole('alert')).toHaveTextContent(/fret/i);
  expect(commands).toEqual([]);view.rerender(<RangePanel {...props} selection={{kind:'notes',notes:[{target:{...target,beat:999},noteIndex:0}]}}/>);expect(screen.getByRole('alert')).toHaveTextContent(/note|beat/i);expect(screen.getByRole('button',{name:'Erase selected notes'})).toBeDisabled();
});
it('resets drafts and errors on score or selection change and disables controls while busy',()=>{
  const score=music(),props={score,target,selection,busy:false,onSelection:()=>{},onEdit:()=>{}},view=render(<RangePanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Maximum fret'),{target:{value:'99'}});fireEvent.change(screen.getByLabelText('Semitones'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Transpose selection'}));expect(screen.getByRole('alert')).toBeInTheDocument();
  view.rerender(<RangePanel {...props} selection={{kind:'bars',tracks:[0],firstBar:0,lastBar:0}}/>);expect(screen.getByLabelText('Maximum fret')).toHaveValue(24);expect(screen.getByLabelText('Semitones')).toHaveValue(1);expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  view.rerender(<RangePanel {...props} score={music()}/>);expect(screen.getByLabelText('Maximum fret')).toHaveValue(24);
  view.rerender(<RangePanel {...props} busy/>);for(const button of screen.getAllByRole('button'))expect(button).toBeDisabled();for(const input of [...screen.getAllByRole('spinbutton'),...screen.getAllByRole('checkbox'),...screen.getAllByRole('combobox')])expect(input).toBeDisabled();
});
it('pitched lanes keep transpose and erase available while string-only controls are disabled',()=>{
  const score=music(),staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[];const note=staff.bars[0].voices[0].beats[0].notes[0];note.string=-1;note.fret=-1;note.octave=5;note.tone=0;
  render(<RangePanel score={score} target={target} selection={selection} busy={false} onSelection={()=>{}} onEdit={()=>{}}/>);
  expect(screen.getByRole('button',{name:'Up semitone'})).toBeEnabled();expect(screen.getByRole('button',{name:'Erase selected notes'})).toBeEnabled();expect(screen.getByRole('button',{name:'Move to higher string'})).toBeDisabled();expect(screen.getByRole('button',{name:'Re-finger selection'})).toBeDisabled();expect(screen.getByRole('button',{name:'Enable let ring'})).toBeDisabled();
});
it('shows declared empty lanes in the selection scope and disables string-only actions for mixed lanes',()=>{
  const score=music(),other=music().tracks[0];score.addTrack(other);other.staves[0].stringTuning.tunings=[];for(const bar of other.staves[0].bars)for(const beat of bar.voices[0].beats){beat.notes=[];beat.isEmpty=true;}
  const mixed:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:960},lanes:[{track:0,staff:0,voice:0},{track:1,staff:0,voice:0}]}};
  render(<RangePanel score={score} target={target} selection={mixed} busy={false} onSelection={()=>{}} onEdit={()=>{}}/>);
  expect(screen.getByText(/Track 2.*Staff 1.*Voice 1/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Enable let ring'})).toBeDisabled();expect(screen.getByRole('button',{name:'Up semitone'})).toBeEnabled();
});
it.each(['range','bars'] as const)('reads all-track %s scope after parent rerender and reapplies it idempotently',kind=>{
  const score=music();score.addTrack(music().tracks[0]);let current:MusicSelection=kind==='range'?{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:960},lanes:[{track:0,staff:0,voice:0}]}}:{kind:'bars',tracks:[0],firstBar:0,lastBar:0};
  const props={score,target,busy:false,onSelection:(value:MusicSelection|null)=>{if(value)current=value;},onEdit:()=>{}},view=render(<RangePanel {...props} selection={current}/>);
  fireEvent.change(screen.getByLabelText('Selection scope'),{target:{value:'all'}});fireEvent.click(screen.getByRole('button',{name:'Apply selection scope'}));view.rerender(<RangePanel {...props} selection={current}/>);
  expect(screen.getByLabelText('Selection scope')).toHaveValue('all');const accepted=JSON.stringify(current);fireEvent.click(screen.getByRole('button',{name:'Apply selection scope'}));expect(JSON.stringify(current)).toBe(accepted);
});
it('shows custom mixed scope without silently narrowing the selection',()=>{
  const score=music();score.addTrack(music().tracks[0]);score.addTrack(music().tracks[0]);const changes:(MusicSelection|null)[]=[];
  render(<RangePanel score={score} target={target} selection={{kind:'bars',tracks:[0,2],firstBar:0,lastBar:0}} busy={false} onSelection={value=>changes.push(value)} onEdit={()=>{}}/>);
  expect(screen.getByLabelText('Selection scope')).toHaveValue('custom');expect(screen.getByRole('button',{name:'Apply selection scope'})).toBeDisabled();expect(changes).toEqual([]);
});
it('applies ordered pick, brush and arpeggio patterns to the selection',()=>{
  const score=music(),commands:RangeCommand[]=[],bars:MusicSelection={kind:'bars',tracks:[0],firstBar:0,lastBar:1};
  render(<RangePanel score={score} target={target} selection={bars} busy={false} onSelection={()=>{}} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByLabelText('Stroke pattern')).toHaveValue('D U');
  fireEvent.click(screen.getByRole('button',{name:'Apply stroke pattern'}));
  fireEvent.click(screen.getByRole('button',{name:'All downstrokes'}));expect(screen.getByLabelText('Stroke pattern')).toHaveValue('D');
  fireEvent.change(screen.getByLabelText('Pattern technique'),{target:{value:'brush'}});
  fireEvent.change(screen.getByLabelText('Stroke pattern'),{target:{value:'d, d up -'}});fireEvent.click(screen.getByRole('button',{name:'Apply stroke pattern'}));
  fireEvent.change(screen.getByLabelText('Pattern technique'),{target:{value:'arpeggio'}});fireEvent.click(screen.getByRole('button',{name:'Clear strokes'}));
  fireEvent.click(screen.getByRole('button',{name:'Alternate picking'}));
  fireEvent.change(screen.getByLabelText('Stroke pattern'),{target:{value:'D sideways'}});fireEvent.click(screen.getByRole('button',{name:'Apply stroke pattern'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Use 1 to 16 steps of D, U or -.');
  expect(commands).toEqual([
    {type:'setSelectionStrokes',selection:bars,technique:'pick',pattern:['down','up']},
    {type:'setSelectionStrokes',selection:bars,technique:'brush',pattern:['down','down','up','none']},
    {type:'setSelectionStrokes',selection:bars,technique:'arpeggio',pattern:['none']},
  ]);
  expect(screen.getByLabelText('Stroke pattern')).toHaveValue('D sideways');
  fireEvent.change(screen.getByLabelText('Stroke pattern'),{target:{value:'constructor toString'}});fireEvent.click(screen.getByRole('button',{name:'Apply stroke pattern'}));
  expect(commands).toHaveLength(3);expect(screen.getByRole('alert')).toHaveTextContent('Use 1 to 16 steps');
});

it('ties and unties every selected note across voices as one command',()=>{
  const score=music(),commands:RangeCommand[]=[],bars:MusicSelection={kind:'bars',tracks:[0],firstBar:1,lastBar:1};
  render(<RangePanel score={score} target={target} selection={bars} busy={false} onSelection={()=>{}} onEdit={edit=>{commands.push(edit);if(edit.type==='setSelectionTies'&&edit.tied&&commands.length>1)throw new Error('Each selected note needs an earlier note.');}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Tie selected notes'}));
  fireEvent.click(screen.getByRole('button',{name:'Untie selected notes'}));
  expect(commands).toEqual([{type:'setSelectionTies',selection:bars,tied:true},{type:'setSelectionTies',selection:bars,tied:false}]);
  fireEvent.click(screen.getByRole('button',{name:'Tie selected notes'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Each selected note needs an earlier note.');
});
