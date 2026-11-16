// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { InstrumentView } from '../instruments/InstrumentView';
import { TrackSettingsPanel } from '../workstation/TrackSettingsPanel';
import { setBanjoDrone } from './banjo-drone';

afterEach(()=>{cleanup();localStorage.clear();});
const target={track:0,staff:0,bar:0,voice:0,beat:0};
/** An open G banjo, optionally with the drone starting at fret 5, holding the drone string at neck fret 7. */
function build(strings=5,drone=0) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.playbackInfo.program=25;
  staff.stringTuning.tunings=strings===5?[62,59,55,50,67]:[64,59,55,50,45,40];if(drone)setBanjoDrone(staff,drone);
  track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Quarter;
  const note=new model.Note();note.string=1;note.fret=drone?7:2;beat.addNote(note);
  voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());return score;
}
/** The Tuning dialog of the track, which holds the Capo section with the partial capo and the banjo drone. */
const panel=(score:model.Score,props:{locked?:boolean}={})=>{const onEdit=vi.fn();render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit} {...props}/>);if(!props.locked)fireEvent.click(screen.getByRole('button',{name:/^Edit tuning/}));return onEdit;};
const dialog=()=>within(screen.getByRole('dialog',{name:'Tuning'}));
// Applying the values a staff already has records nothing, so each press first changes the capo.
let capoStep=0;
const applied=(onEdit:ReturnType<typeof vi.fn>)=>{capoStep+=1;fireEvent.change(dialog().getByLabelText('Capo'),{target:{value:String(capoStep)}});fireEvent.click(dialog().getByRole('button',{name:'Keep fingering'}));const settings=onEdit.mock.calls.at(-1)![0].settings;if(screen.queryByRole('dialog'))return settings;fireEvent.click(screen.getByRole('button',{name:/^Edit tuning/}));return settings;};
const drone=()=>dialog().getByRole('checkbox',{name:/Short drone string/});

it('shows the staff drone and sends nothing about it until changed',()=>{
  const onEdit=panel(build(5,5));
  expect(drone()).toBeChecked();
  expect(dialog().getByLabelText('Drone string starts at fret')).toHaveValue(5);
  expect(applied(onEdit)).not.toHaveProperty('droneFret');
  const fret=dialog().getByLabelText('Drone string starts at fret');
  fireEvent.focus(fret);fireEvent.blur(fret);
  expect(applied(onEdit)).not.toHaveProperty('droneFret');
});
it('turns the drone on with the standard fret and off with 0',()=>{
  const onEdit=panel(build());
  expect(dialog().getByLabelText('Drone string starts at fret')).toBeDisabled();
  fireEvent.click(drone());
  expect(applied(onEdit).droneFret).toBe(5);
  cleanup();
  const again=panel(build(5,5));
  fireEvent.click(drone());
  expect(applied(again).droneFret).toBe(0);
});
it('records nothing while the fret is typed, settles it on blur or Enter, settles a fret typed but not left when the dialog is applied, and holds the apply buttons back for an invalid draft',()=>{
  const fret=()=>dialog().getByLabelText('Drone string starts at fret');
  // Typed, not left: nothing is recorded until the dialog is applied, and then the typed fret is not dropped.
  const first=panel(build(5,5));
  fireEvent.change(fret(),{target:{value:'7'}});expect(first).not.toHaveBeenCalled();expect(applied(first).droneFret).toBe(7);
  cleanup();
  // Enter settles the field and does not apply the dialog.
  const onEdit=panel(build(5,5));
  fireEvent.change(fret(),{target:{value:'6'}});expect(fireEvent.keyDown(fret(),{key:'Enter'})).toBe(false);
  expect(onEdit).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'Tuning'})).toBeInTheDocument();
  expect(applied(onEdit).droneFret).toBe(6);
  cleanup();
  const again=panel(build(5,5));
  fireEvent.change(fret(),{target:{value:'40'}});fireEvent.blur(fret());
  expect(dialog().getAllByRole('alert').map(node=>node.textContent).join(' ')).toContain('Use a drone fret from 1 to 12');
  fireEvent.click(dialog().getByRole('button',{name:'Keep fingering'}));expect(again).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'Tuning'})).toBeInTheDocument();
  fireEvent.change(fret(),{target:{value:'6'}});fireEvent.blur(fret());expect(applied(again).droneFret).toBe(6);
});
it('offers no drone on a staff that is not 5-string, and a finalized score cannot open the dialog',()=>{
  panel(build(6));
  expect(drone()).toBeDisabled();
  expect(dialog().getByText('The banjo drone needs a 5-string staff.')).toBeInTheDocument();
  cleanup();
  const onEdit=panel(build(5,5),{locked:true});
  expect(screen.getByRole('button',{name:/^Edit tuning/})).toBeDisabled();expect(onEdit).not.toHaveBeenCalled();
});
it('reads out the drone and names the instrument view targets with the drone pitch',()=>{
  const entry={target,busy:false,onEdit:vi.fn()};
  render(<InstrumentView score={build(5,5)} track={0} staff={0} notes={[]} entry={entry}/>);
  expect(document.querySelector('.instrument-detail')!.textContent).toContain('Banjo drone from fret 5 · string 1 fret numbers follow the neck');
  // The written note, neck fret 7, sounds A4; fret 3 does not exist on the drone string.
  expect(screen.getByRole('button',{name:'Remove string 1, fret 7 (A4)'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/String 1, fret 3 does not exist/})).toHaveAttribute('aria-disabled','true');
  fireEvent.click(screen.getByRole('button',{name:'String 1, fret 8 (A#4)'}));
  expect(entry.onEdit).toHaveBeenCalledWith({type:'setNote',target,string:1,fret:8},{string:1,fret:8});
});
