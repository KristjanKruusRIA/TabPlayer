// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { InstrumentView } from './InstrumentView';

afterEach(()=>{cleanup();localStorage.clear();});
/** One guitar beat holding E2 (string 1 fret 0) and C4 (string 5 fret 1), or one snare hit. */
function music(percussion=false) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.name=percussion?'Drums':'Guitar';track.playbackInfo.program=25;
  staff.stringTuning.tunings=[64,59,55,50,45,40];staff.isPercussion=percussion;track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
  if(percussion)track.playbackInfo.primaryChannel=track.playbackInfo.secondaryChannel=9;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Quarter;
  if(percussion){const note=new model.Note();note.percussionArticulation=38;beat.addNote(note);}
  else for(const [string,fret] of [[1,0],[5,1]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
  voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());
  return {score,notes:buildPlaybackPlan(score,1).notes};
}
const numberX=(container:HTMLElement,fret:number)=>Number(container.querySelector(`[data-fret-number="${fret}"]`)!.getAttribute('x'));

it('mirrors the neck for left-handed players and keeps fret numbers upright and in mirrored order',()=>{
  const {score,notes}=music(),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  const left=screen.getByRole('checkbox',{name:'Left-handed'});
  expect(left).not.toBeChecked();expect(numberX(container,0)).toBeLessThan(numberX(container,12));
  expect(container.querySelector('[data-handedness]')).toHaveAttribute('data-handedness','right');
  fireEvent.click(left);
  const mirror=container.querySelector('[data-handedness="left"]')!;
  expect(mirror.getAttribute('transform')).toMatch(/^matrix\(-1 0 0 1 \d+(\.\d+)? 0\)$/);
  // The nut is now on the right; numbers are outside the mirror, so their text is not reversed.
  expect(numberX(container,0)).toBeGreaterThan(numberX(container,12));
  expect(mirror.querySelector('[data-fret-number]')).toBeNull();
  // Notes keep their strings and frets inside the mirrored drawing.
  expect([...mirror.querySelectorAll('g[data-note-id]')].map(node=>[node.getAttribute('data-string'),node.getAttribute('data-fret')]).sort()).toEqual([['1','0'],['5','1']]);
  expect(screen.getByRole('img',{name:'Guitar fretboard, left-handed'})).toBeInTheDocument();
  // The choice is remembered for the next view.
  cleanup();render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  expect(screen.getByRole('checkbox',{name:'Left-handed'})).toBeChecked();
});

it('shows the neck and the keyboard together with the same notes',()=>{
  const {score,notes}=music(),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'both'}});
  expect(screen.getByRole('img',{name:'Guitar fretboard'})).toBeInTheDocument();
  expect(screen.getByRole('img',{name:'Keyboard'})).toBeInTheDocument();
  expect(container.querySelectorAll('g[data-note-id]')).toHaveLength(2);
  expect([...container.querySelectorAll('g[data-key][data-active="true"]')].map(node=>Number(node.getAttribute('data-key'))).sort((a,b)=>a-b)).toEqual([40,60]);
  expect(screen.getByRole('heading')).toHaveTextContent('Guitar · Neck + keys');
  // Handedness applies to the neck of the combined view too.
  fireEvent.click(screen.getByRole('checkbox',{name:'Left-handed'}));
  expect(container.querySelector('[data-handedness="left"]')).not.toBeNull();
});

it('marks the same staff on both instruments, keeps the chosen neck, and shows Auto after moving to drums',()=>{
  const score=new model.Score(),track=new model.Track();track.name='Bass';track.playbackInfo.program=0;score.addTrack(track);score.addMasterBar(new model.MasterBar());
  for(const [string,fret] of [[1,3],[4,5]]){const staff=new model.Staff();staff.stringTuning.tunings=[43,38,33,28];track.addStaff(staff);const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Quarter;const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());const notes=buildPlaybackPlan(score,1).notes;
  const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'bass'}});
  fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'both'}});
  expect(screen.getByRole('img',{name:'Bass fretboard'})).toBeInTheDocument();
  // Staff 2's G2 sounds on another staff: neither instrument marks it.
  expect([...container.querySelectorAll('g[data-key][data-active="true"]')].map(node=>Number(node.getAttribute('data-key')))).toEqual([31]);
  expect(container.querySelectorAll('g[data-note-id]')).toHaveLength(1);
  cleanup();
  const drums=music(true),guitar=music(),view=render(<InstrumentView score={guitar.score} track={0} staff={0} notes={guitar.notes}/>);
  fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'both'}});
  view.rerender(<InstrumentView score={drums.score} track={0} staff={0} notes={drums.notes}/>);
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('auto');
  expect(screen.getByRole('img',{name:'Drum kit'})).toBeInTheDocument();
});

it('keeps drums and keys without a neck: no combined mode or handedness for percussion',()=>{
  const {score,notes}=music(true);render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  expect(screen.getByRole('option',{name:'Neck + keys'})).toBeDisabled();
  expect(screen.queryByRole('checkbox',{name:'Left-handed'})).toBeNull();
  cleanup();
  const guitar=music();render(<InstrumentView score={guitar.score} track={0} staff={0} notes={guitar.notes}/>);
  fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'keys'}});
  expect(screen.queryByRole('checkbox',{name:'Left-handed'})).toBeNull();
});
