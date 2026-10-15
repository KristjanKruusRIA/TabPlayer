// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import type { PlanNote } from '../audio/types';
import { InstrumentView } from './InstrumentView';

afterEach(cleanup);
const guitar = [64,59,55,50,45,40];
function scoreWith(tunings: number[][] = [guitar], program = 25, percussion = false) {
  const score = new model.Score(), track = new model.Track(); track.name = percussion ? 'Drums' : program >= 32 && program < 40 ? 'Bass' : 'Guitar'; track.playbackInfo.program = program;
  score.addTrack(track); score.addMasterBar(new model.MasterBar());
  for (const tuning of tunings) {
    const staff = new model.Staff(); staff.stringTuning.tunings = [...tuning]; staff.isPercussion = percussion; track.addStaff(staff);
    const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(); beat.isEmpty = false; beat.duration = model.Duration.Quarter;
    voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar);
  }
  if (percussion) track.playbackInfo.primaryChannel = track.playbackInfo.secondaryChannel = 9;
  return score;
}
function stringNote(score: model.Score, string: number, fret: number, staff = 0) {
  const note = new model.Note(); note.string = string; note.fret = fret; score.tracks[0].staves[staff].bars[0].voices[0].beats[0].addNote(note); return note;
}
function finish(score: model.Score) { score.finish(new Settings()); return buildPlaybackPlan(score, 1).notes; }
function activeMarks(container: HTMLElement) { return container.querySelectorAll('[data-note-id]'); }

it('shows every simultaneous guitar note at its actual string and fret with capo pitches', () => {
  const score = scoreWith(); score.tracks[0].staves[0].capo = 2; stringNote(score,6,3); stringNote(score,1,5);
  const notes = finish(score), {container} = render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  expect(screen.getByRole('img',{name:'Guitar fretboard'})).toBeInTheDocument(); expect(container.querySelectorAll('[data-string-row]')).toHaveLength(6);
  expect(container.querySelector('[data-string="6"][data-fret="3"]')).toHaveTextContent('A4'); expect(container.querySelector('[data-string="1"][data-fret="5"]')).toHaveTextContent('B2');
  expect(screen.getByText(/Capo 2/)).toBeInTheDocument(); expect(container.querySelector('[data-string-row="6"]')).toHaveTextContent('F#4'); expect(activeMarks(container)).toHaveLength(2);
});

it.each([
  [25,[64,59,55,50,45,40],'Guitar'], [25,[64,59,55,50,45,40,35],'Guitar'], [25,[64,59,55,50,45,40,35,30],'Guitar'], [25,[64,59,55,50,45,40,35,30,25],'Guitar'],
  [33,[43,38,33,28],'Bass'], [33,[43,38,33,28,23],'Bass'], [33,[48,43,38,33,28,23],'Bass'],
] as const)('uses actual string count for program %i and tuning %j', (program, tuning, mode) => {
  const score = scoreWith([[...tuning]],program); stringNote(score,1,0); const notes=finish(score);
  const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>); expect(screen.getByRole('img',{name:`${mode} fretboard`})).toBeInTheDocument();
  expect(container.querySelectorAll('[data-string-row]')).toHaveLength(tuning.length); expect(container.querySelector('[data-string="1"][data-fret="0"]')).toBeInTheDocument();
});

it('extends the fretboard for notes past fret 24 and honors playback transposition', () => {
  const score=scoreWith(); score.tracks[0].staves[0].transpositionPitch=12; stringNote(score,1,31); const notes=finish(score);
  const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>); expect(container.querySelector('[data-fret-column="31"]')).toBeInTheDocument();
  expect(container.querySelector('[data-string="1"][data-fret="31"]')).toHaveTextContent('B3'); expect(container.querySelector('[data-string-row="1"]')).toHaveTextContent('E1');
});

it('limits fretboard geometry to the selected staff and reports sounding notes from other staves', () => {
  const score=scoreWith([guitar,[43,38,33,28]]); stringNote(score,6,0); stringNote(score,4,5,1); const notes=finish(score);
  const {container,rerender}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>); expect(activeMarks(container)).toHaveLength(1); expect(screen.getByText('C3',{selector:'.instrument-note'})).toBeInTheDocument();
  rerender(<InstrumentView score={score} track={0} staff={1} notes={notes}/>); expect(container.querySelectorAll('[data-string-row]')).toHaveLength(4); expect(container.querySelector('[data-string="4"][data-fret="5"]')).toHaveTextContent('C3');
});

it('manual keyboard override shows all simultaneous pitches across the selected track staves', () => {
  const score=scoreWith([guitar,guitar]); stringNote(score,6,0); stringNote(score,5,4); stringNote(score,6,9,1); const notes=finish(score);
  const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>); fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'keys'}});
  expect(screen.getByRole('img',{name:'Keyboard'})).toBeInTheDocument(); for (const key of [64,63,73]) expect(container.querySelector(`[data-key="${key}"][data-active="true"]`)).toBeInTheDocument();
  expect(container.querySelector('[data-key="63"]')).toHaveAttribute('data-key-color','black'); expect(container.querySelector('[data-key="64"]')).toHaveAttribute('data-key-color','white');
  expect(screen.getByText('D#4',{selector:'.instrument-note'})).toBeInTheDocument();
});

it('starts compact and changes size without resetting mode, artwork, notes or score source', () => {
  const score=scoreWith();stringNote(score,6,3);stringNote(score,1,5);const notes=finish(score),before=model.JsonConverter.scoreToJson(score);
  const {container,rerender,unmount}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  expect(screen.getByRole('button',{name:'Expand instrument view'})).toHaveAttribute('aria-expanded','false');
  fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'keys'}});
  const keyboard=screen.getByRole('img',{name:'Keyboard'}),playing=container.querySelector('.instrument-playing')!.textContent;
  fireEvent.click(screen.getByRole('button',{name:'Expand instrument view'}));
  expect(screen.getByRole('button',{name:'Compact instrument view'})).toHaveAttribute('aria-expanded','true');
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('keys');
  expect(screen.getByRole('img',{name:'Keyboard'})).toBe(keyboard);
  expect(container.querySelector('.instrument-playing')).toHaveTextContent(playing!);
  for(const note of notes) expect(container.querySelector(`[data-key="${note.key}"][data-active="true"]`)).toBeInTheDocument();
  rerender(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  expect(screen.getByText('No notes sounding')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Compact instrument view'}));
  expect(screen.getByRole('img',{name:'Keyboard'})).toBe(keyboard);
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('keys');
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  unmount();render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  expect(screen.getByRole('button',{name:'Expand instrument view'})).toHaveAttribute('aria-expanded','false');
});

it('keyboard range retains extreme simultaneous notes rather than clipping them', () => {
  const score=scoreWith([[]],0); const beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0];
  for (const key of [0,61,127]) {const note=new model.Note();note.octave=Math.floor(key/12);note.tone=key%12;beat.addNote(note);}
  const notes=finish(score),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  for (const key of [0,61,127]) expect(container.querySelector(`[data-key="${key}"][data-active="true"]`)).toBeInTheDocument();
  expect(screen.getByText('C-1',{selector:'.instrument-note'})).toBeInTheDocument(); expect(screen.getByText('G9',{selector:'.instrument-note'})).toBeInTheDocument();
});

it('drums highlight kick, snare, toms and cymbals together and retain auxiliary percussion labels', () => {
  const score=scoreWith([[],[]],0,true);
  for (const [index,key] of [36,38,41,47,50,42,49,51,52,55,54,81].entries()) {const note=new model.Note(); note.percussionArticulation=key; score.tracks[0].staves[index%2].bars[0].voices[0].beats[0].addNote(note);}
  const notes=finish(score),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>); expect(screen.getByRole('img',{name:'Drum kit'})).toBeInTheDocument();
  for (const piece of ['kick','snare','floor-tom','low-tom','high-tom','hi-hat','crash','ride','china','splash']) expect(container.querySelector(`[data-drum="${piece}"][data-active="true"]`)).toBeInTheDocument();
  expect(screen.getByText('Tambourine',{selector:'.instrument-note'})).toBeInTheDocument(); expect(screen.getByText('Open triangle',{selector:'.instrument-note'})).toBeInTheDocument();
});

it('drums use played MIDI keys after custom articulation conversion and retain unknown keys', () => {
  const score=scoreWith([[]],0,true); const track=score.tracks[0];track.percussionArticulations.push(new model.InstrumentArticulation('Snare',0,38));
  const note=new model.Note();note.percussionArticulation=0;track.staves[0].bars[0].voices[0].beats[0].addNote(note); const notes=finish(score);
  const unknown:PlanNote={...notes[0],id:'unknown',key:127}, {container}=render(<InstrumentView score={score} track={0} staff={0} notes={[...notes,unknown]}/>);
  expect(container.querySelector('[data-drum="snare"][data-active="true"]')).toBeInTheDocument(); expect(screen.getByText('Acoustic snare',{selector:'.instrument-note'})).toBeInTheDocument(); expect(screen.getByText('Percussion G9 (127)',{selector:'.instrument-note'})).toBeInTheDocument();
});

it('clears highlights when playback state supplies an empty note set and Auto follows track changes', () => {
  const score=scoreWith();stringNote(score,6,3);const notes=finish(score); const {container,rerender}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);expect(activeMarks(container)).toHaveLength(1);
  rerender(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);expect(activeMarks(container)).toHaveLength(0);expect(screen.getByText('No notes sounding')).toBeInTheDocument();
  const bass=scoreWith([[43,38,33,28]],33);finish(bass);rerender(<InstrumentView score={bass} track={0} staff={0} notes={[]}/>);expect(screen.getByRole('img',{name:'Bass fretboard'})).toBeInTheDocument();
});

it('shows pitches without guessing fret positions when a guitar program has no string tuning', () => {
  const score=scoreWith([[]],25),note=new model.Note();note.octave=5;note.tone=0;score.tracks[0].staves[0].bars[0].voices[0].beats[0].addNote(note);const notes=finish(score);
  const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);expect(container.querySelectorAll('[data-string-row]')).toHaveLength(0);expect(screen.getByText('C4',{selector:'.instrument-note'})).toBeInTheDocument();expect(screen.getByText(/No string tuning/)).toBeInTheDocument();
});

it('renders a guitar body and pickup poles for every string with physical fret spacing', () => {
  const score=scoreWith([[64,59,55,50,45,40,35,30,25]]);finish(score);const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  expect(container.querySelector('[data-instrument-part="body"] path')).toBeInTheDocument();expect(container.querySelectorAll('[data-instrument-part="neck-pickup"] [data-pickup-string]')).toHaveLength(9);
  const frets=[...container.querySelectorAll('[data-fret-boundary]')].map(line=>Number(line.getAttribute('x1')));
  expect(frets[1]-frets[0]).toBeGreaterThan(frets[23]-frets[22]);
});

it('renders acoustic drum shells, heads, cymbals and the kick pedal', () => {
  const score=scoreWith([[]],0,true);finish(score);const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  expect(container.querySelector('[data-drum="snare"] [data-drum-surface="head"]')).toBeInTheDocument();expect(container.querySelector('[data-drum="floor-tom"] [data-drum-surface="shell"]')).toBeInTheDocument();
  expect(container.querySelector('[data-drum="ride"] [data-drum-surface="cymbal"]')).toBeInTheDocument();expect(container.querySelector('[data-drum="kick"] [data-drum-surface="pedal"]')).toBeInTheDocument();
});

it('keeps descriptive SVG titles intact when rendering instrument artwork', () => {
  const score=scoreWith();stringNote(score,6,3);const notes=finish(score),markup=renderToStaticMarkup(<InstrumentView score={score} track={0} staff={0} notes={notes}/>);
  expect(markup).toContain('<title>Guitar fretboard</title>');expect(markup).toContain('<title>G4 · string 6 · fret 3</title>');
});

it.each([[25,guitar],[25,[64,59,55,50,45,40,35,30,25]],[33,[43,38,33,28]],[33,[48,43,38,33,28,23]]])('keeps the neck in physical proportion to the instrument body for program %i', (program,tuning) => {
  const score=scoreWith([tuning as number[]],program as number);finish(score);const {container}=render(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  const neck=container.querySelector('[data-instrument-part="neck"] rect')!,svg=screen.getByRole('img',{name:/fretboard/}),height=Number(svg.getAttribute('viewBox')!.split(' ')[3]);
  expect(Number(neck.getAttribute('height'))).toBeGreaterThan(height*.25);expect(Number(neck.getAttribute('height'))).toBeLessThan(height*.4);
});
