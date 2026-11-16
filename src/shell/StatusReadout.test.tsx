// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { StatusReadout } from './StatusReadout';
import { music, target } from '../editor/fixtures';
import { setLanguagePreference } from '../i18n';

afterEach(() => { cleanup(); setLanguagePreference('en'); localStorage.clear(); });
const shown = (props: Partial<Parameters<typeof StatusReadout>[0]> = {}) => {
  const score = props.score ?? music();
  return render(<StatusReadout score={score} target={target} string={6} noteIndex={null} selection={null} indexed={false} {...props} />);
};

it('says where the cursor is: the track, bar, beat, string and voice, then the fret and pitch of the note under it', () => {
  shown();
  expect(screen.getByText('Guitar')).toBeInTheDocument();
  expect(screen.getByText('Bar 1 · Beat 1 · String 6 · Voice 1')).toBeInTheDocument();
  expect(screen.getByTestId('status-value')).toHaveTextContent('Fret 3 · G4');
  expect(screen.getByTestId('status-meta')).toHaveTextContent(/^4\/4 · \d+ BPM$/);
});

it('shows the techniques of the note, the chord, a rest and an empty string', () => {
  const score = music(), beat = score.tracks[0].staves[0].bars[0].voices[0].beats[0], note = beat.notes[0];
  note.isPalmMute = true;note.bendType = 1;note.isGhost = true;
  const view = shown({ score });
  expect(screen.getByLabelText('Techniques')).toHaveTextContent('Bend, PM, Ghost');
  beat.notes = [];beat.duration = 8;beat.dots = 1;
  view.rerender(<StatusReadout score={score} target={target} string={6} noteIndex={null} selection={null} indexed={false} />);
  expect(screen.getByTestId('status-value')).toHaveTextContent('Rest · 1/8.');
  const other = new model.Note();other.string = 5;other.fret = 0;beat.addNote(other);
  view.rerender(<StatusReadout score={score} target={target} string={6} noteIndex={null} selection={null} indexed={false} />);
  expect(screen.getByTestId('status-value')).toHaveTextContent('No note on this string');
});

it('shows a selected range and a note selection, and the indexed note position of a percussion staff', () => {
  const view = shown({ selection: { kind: 'bars', tracks: [0], firstBar: 0, lastBar: 1 } });
  expect(screen.getByTestId('status-value')).toHaveTextContent('Fret 3 · G4 · Selection · bars 1–2');
  view.rerender(<StatusReadout score={music()} target={target} string={6} noteIndex={null} indexed={false} selection={{ kind: 'notes', notes: [{ target, noteIndex: 0 }] } as never} />);
  expect(screen.getByTestId('status-value')).toHaveTextContent('Fret 3 · G4 · Selection · 1 note');
  const score = music();score.tracks[0].staves[0].isPercussion = true;
  view.rerender(<StatusReadout score={score} target={target} string={6} noteIndex={0} selection={null} indexed />);
  expect(screen.getByText('Bar 1 · Beat 1 · Note 1 · Voice 1')).toBeInTheDocument();expect(screen.getByTestId('status-value')).toHaveTextContent('Note selected');
});

it('names the staff when the track has more than one', () => {
  const score = music();
  score.tracks[0].addStaff(new model.Staff());
  shown({ score });
  expect(screen.getByText('Guitar · Staff 1')).toBeInTheDocument();
});

it('reads in Estonian and German with the catalogue words', () => {
  setLanguagePreference('et');
  const view = shown();
  expect(screen.getByText('Takt 1 · Löök 1 · Keel 6 · Hääl 1')).toBeInTheDocument();expect(screen.getByTestId('status-value')).toHaveTextContent('Krihv 3 · G4');
  setLanguagePreference('de');
  view.unmount();shown();
  expect(screen.getByText('Takt 1 · Schlag 1 · Saite 6 · Stimme 1')).toBeInTheDocument();expect(screen.getByTestId('status-value')).toHaveTextContent('Bund 3 · G4');
});
