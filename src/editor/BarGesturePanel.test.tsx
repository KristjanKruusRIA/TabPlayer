// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { BarGesturePanel } from './BarGesturePanel';
import type { BarGestureCommand } from './gestures-types';
import { music,reopened } from './fixtures';
import { applyBarGestureEdit } from './bar-gestures';

afterEach(cleanup);
function selected() {
  const score=music(),master=score.masterBars[1],bar=score.tracks[0].staves[0].bars[1];
  master.timeSignatureNumerator=7;master.timeSignatureDenominator=8;master.isDoubleBar=true;master.tripletFeel=4;
  master.beamingRules=new model.BeamingRules();master.beamingRules.groups.set(8,[2,2,3]);bar.clefOttava=3;bar.simileMark=1;
  return score;
}

it('bar_panel_dispatches_named_finite_commands with one-based measure labels and imported readback',()=>{
  const score=selected(),commands:BarGestureCommand[]=[];
  render(<BarGesturePanel score={score} track={0} staff={0} bar={1} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByText('Measure 2')).toBeInTheDocument();
  const octave=screen.getByLabelText('Clef octave');expect(octave).toHaveValue('3');
  expect(within(octave).getAllByRole('option').map(option=>option.textContent)).toEqual(['15ma · two octaves up','8va · octave up','Regular','8vb · octave down','15mb · two octaves down']);
  expect(screen.getByLabelText('Simile')).toHaveValue('single');expect(screen.getByLabelText('Double bar')).toBeChecked();
  const feel=screen.getByLabelText('Rhythmic feel');expect(feel).toHaveValue('4');
  expect(within(feel).getAllByRole('option').map(option=>option.textContent)).toEqual(['Straight','Triplet sixteenths','Triplet eighths','Dotted sixteenths','Dotted eighths','Scottish sixteenths','Scottish eighths']);
  expect(screen.getByLabelText('Custom beaming')).toBeChecked();expect(screen.getByLabelText('Beaming unit')).toHaveValue('8');expect(screen.getByLabelText('Beaming groups')).toHaveValue('2, 2, 3');
  fireEvent.change(octave,{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Apply clef octave'}));
  fireEvent.change(screen.getByLabelText('Simile'),{target:{value:'none'}});fireEvent.click(screen.getByRole('button',{name:'Apply simile'}));
  fireEvent.click(screen.getByLabelText('Double bar'));fireEvent.change(feel,{target:{value:'6'}});
  fireEvent.change(screen.getByLabelText('Beaming unit'),{target:{value:'16'}});fireEvent.change(screen.getByLabelText('Beaming groups'),{target:{value:'4, 4 6'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply measure gestures'}));
  expect(commands).toEqual([
    {type:'setBarGestures',track:0,staff:0,bar:1,clefOttava:0},
    {type:'setSimile',track:0,staff:0,bar:1,kind:'none'},
    {type:'setMasterBarGestures',bar:1,commonTime:false,doubleBar:false,tripletFeel:6,beaming:{unit:16,groups:[4,4,6]}},
  ]);
  for(const command of commands)applyBarGestureEdit(score,command);
  expect(score.tracks[0].staves[0].bars[1].clefOttava).toBe(0);expect(score.tracks[0].staves[0].bars[1].simileMark).toBe(0);expect(score.masterBars[1].beamingRules?.groups.get(16)).toEqual([4,4,6]);
});

it('clears the explicit beaming override and authors common/cut display through finite DTOs',()=>{
  const score=music(),commands:BarGestureCommand[]=[];score.masterBars[0].timeSignatureNumerator=2;score.masterBars[0].timeSignatureDenominator=2;
  render(<BarGesturePanel score={score} track={0} staff={0} bar={0} busy={false} onEdit={edit=>commands.push(edit)}/>);
  expect(screen.getByLabelText('Beaming groups')).toBeDisabled();fireEvent.click(screen.getByLabelText('Common / cut time'));
  fireEvent.click(screen.getByRole('button',{name:'Apply measure gestures'}));
  expect(commands).toEqual([{type:'setMasterBarGestures',bar:0,commonTime:true,doubleBar:false,tripletFeel:0,beaming:null}]);
  applyBarGestureEdit(score,commands[0]);expect(reopened(score).masterBars[0].timeSignatureCommon).toBe(true);
});

it('invalid beaming input reports an actionable error without dispatching a history entry',()=>{
  const score=selected(),commands:BarGestureCommand[]=[];
  render(<BarGesturePanel score={score} track={0} staff={0} bar={1} busy={false} onEdit={edit=>commands.push(edit)}/>);
  for(const value of ['2, x, 3','2, 2','2, 0, 5','2, 1.5, 3.5','']) {
    fireEvent.change(screen.getByLabelText('Beaming groups'),{target:{value}});fireEvent.click(screen.getByRole('button',{name:'Apply measure gestures'}));
    expect(screen.getByRole('alert')).toHaveTextContent(/positive whole numbers.*7/i);expect(commands).toHaveLength(0);
  }
  fireEvent.change(screen.getByLabelText('Beaming groups'),{target:{value:'2,2,3'}});fireEvent.click(screen.getByRole('button',{name:'Apply measure gestures'}));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(commands).toHaveLength(1);
});

it('resets drafts and errors on score or selection change and disables every action while busy',()=>{
  const score=selected(),props={score,track:0,staff:0,bar:1,busy:false,onEdit:()=>{}},view=render(<BarGesturePanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Beaming groups'),{target:{value:'invalid'}});fireEvent.click(screen.getByRole('button',{name:'Apply measure gestures'}));expect(screen.getByRole('alert')).toBeInTheDocument();
  view.rerender(<BarGesturePanel {...props} score={reopened(score)}/>);expect(screen.getByLabelText('Beaming groups')).toHaveValue('2, 2, 3');expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  view.rerender(<BarGesturePanel {...props} bar={0}/>);expect(screen.getByText('Measure 1')).toBeInTheDocument();expect(screen.getByLabelText('Clef octave')).toHaveValue('2');expect(screen.getByLabelText('Custom beaming')).not.toBeChecked();
  view.rerender(<BarGesturePanel {...props} busy/>);
  for(const input of screen.getAllByRole('combobox'))expect(input).toBeDisabled();for(const button of screen.getAllByRole('button'))expect(button).toBeDisabled();expect(screen.getByLabelText('Beaming groups')).toBeDisabled();
});

it('reads either double-simile half as a two-measure repeat and permits clearing it',()=>{
  const score=music(),commands:BarGestureCommand[]=[];applyBarGestureEdit(score,{type:'setSimile',track:0,staff:0,bar:2,kind:'double'});
  render(<BarGesturePanel score={score} track={0} staff={0} bar={3} busy={false} onEdit={edit=>{commands.push(edit);applyBarGestureEdit(score,edit);}}/>);
  expect(screen.getByLabelText('Simile')).toHaveValue('double');fireEvent.change(screen.getByLabelText('Simile'),{target:{value:'none'}});fireEvent.click(screen.getByRole('button',{name:'Apply simile'}));
  expect(commands).toEqual([{type:'setSimile',track:0,staff:0,bar:3,kind:'none'}]);expect(score.tracks[0].staves[0].bars.slice(2).map(bar=>bar.simileMark)).toEqual([0,0]);
});
