// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { InstrumentView } from './InstrumentView';
import { LiveInstrumentView } from './LiveInstrumentView';
import { readInstrumentViewPreferences } from './view-preferences';

afterEach(() => { cleanup(); localStorage.clear(); });
/** One guitar beat holding E2 (string 1 fret 0) and C4 (string 5 fret 1). */
function music() {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff(); track.name = 'Guitar'; track.playbackInfo.program = 25;
  staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(); beat.duration = model.Duration.Quarter;
  for (const [string, fret] of [[1, 0], [5, 1]]) { const note = new model.Note(); note.string = string; note.fret = fret; beat.addNote(note); }
  voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  return { score, notes: buildPlaybackPlan(score, 1).notes };
}
const view = (score: model.Score, notes: ReturnType<typeof music>['notes']) => <InstrumentView score={score} track={0} staff={0} notes={notes} />;

it('keeps handedness with the user preferences, one stored record, and reads it back in a new view', () => {
  const { score, notes } = music(); render(view(score, notes));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Left-handed' }));
  expect(readInstrumentViewPreferences().leftHanded).toBe(true);
  expect(localStorage.getItem('tabplayer.instrument.leftHanded')).toBeNull();
  cleanup(); render(view(score, notes));
  expect(screen.getByRole('checkbox', { name: 'Left-handed' })).toBeChecked();
});

it('offers note names, applies them to the keys and the list of notes, and remembers the choice', () => {
  const { score, notes } = music(), { container } = render(view(score, notes));
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'keys' } });
  const names = screen.getByRole('combobox', { name: 'Note names' });
  expect([...(names as HTMLSelectElement).options].map(option => option.text)).toEqual(['With octave', 'Letters only']);
  expect(container.querySelector('g[data-key="60"] text')).toHaveTextContent('C4');
  expect(screen.getByRole('group', { name: 'Sounding notes' })).toBeInTheDocument();
  fireEvent.change(names, { target: { value: 'letter' } });
  expect(container.querySelector('g[data-key="60"] text')).toHaveTextContent(/^C$/);
  expect(container.querySelector('g[data-key="40"] text')).toHaveTextContent(/^E$/);
  expect(readInstrumentViewPreferences().noteNames).toBe('letter');
  cleanup(); const again = render(view(score, notes));
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'keys' } });
  expect(screen.getByRole('combobox', { name: 'Note names' })).toHaveValue('letter');
  expect(again.container.querySelector('g[data-key="60"] text')).toHaveTextContent(/^C$/);
});

it('remembers the neck and the size across views, while the mode itself follows the track again', () => {
  const { score, notes } = music(); render(view(score, notes));
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'bass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Expand instrument view' }));
  expect(readInstrumentViewPreferences()).toMatchObject({ neck: 'bass', expanded: true });
  cleanup(); const again = render(view(score, notes));
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('auto');
  expect(again.container.querySelector('.instrument-view')).toHaveAttribute('data-size', 'expanded');
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'both' } });
  expect(screen.getByRole('img', { name: 'Bass fretboard' })).toBeInTheDocument();
});

it('remembers what the live view shows and whether clicking edits', () => {
  const { score } = music(), ready = { ready: true, error: null }, idle = { tick: null, counting: false, loop: null, range: null };
  const player = { subscribe: () => () => {}, getState: () => ready, activeNotes: () => [], scheduledNotes: () => ({ ...idle, notes: [], beats: [] }) };
  const live = () => <LiveInstrumentView score={score} track={0} staff={0} player={player as never} onEdit={() => {}} />;
  render(live());
  fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'bar' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Click to edit notes' }));
  expect(readInstrumentViewPreferences()).toMatchObject({ focus: 'bar', clickToEdit: true });
  cleanup(); render(live());
  expect(screen.getByRole('checkbox', { name: 'Click to edit notes' })).toBeChecked();
});

it('still works when storage refuses every write', () => {
  const { score, notes } = music(), refuse = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new Error('full'); };
  try {
    render(view(score, notes));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Left-handed' }));
    expect(screen.getByRole('checkbox', { name: 'Left-handed' })).toBeChecked();
  } finally { Storage.prototype.setItem = refuse; }
});

it('can be locked to the keyboard for its own panel, with no mode or handedness choice but the same note names', () => {
  const { score, notes } = music(), { container } = render(<LiveInstrumentView score={score} track={0} staff={0} panel="keyboard" player={null} />);
  expect(screen.getByRole('region', { name: 'Keyboard panel' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Keyboard' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Instrument view mode')).toBeNull(); expect(screen.queryByRole('checkbox', { name: 'Left-handed' })).toBeNull(); expect(container.querySelector('.instrument-fretboard')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Note names' })).toBeInTheDocument();
  cleanup();
  render(<InstrumentView score={score} track={0} staff={0} notes={notes} lockedMode="keys" />);
  expect(screen.getByRole('heading')).toHaveTextContent('Guitar · Keys'); expect(screen.queryByLabelText('Instrument view mode')).toBeNull();
});

it('an open view follows the native settings once they arrive, with no choice of its own recorded', async () => {
  const { score, notes } = music(), { act } = await import('@testing-library/react');
  const { setNativeSettingsBridge, resetInstrumentViewPreferencesSync, syncInstrumentViewPreferencesFromNative } = await import('./view-preferences');
  resetInstrumentViewPreferencesSync();
  setNativeSettingsBridge({ read: async () => ({ instrumentView: { leftHanded: true, noteNames: 'letter', neck: null, expanded: true, focus: 'bar' } }), put: async () => ({}) });
  try {
    render(<LiveInstrumentView score={score} track={0} staff={0} player={null} />);
    expect(screen.getByRole('checkbox', { name: 'Left-handed' })).not.toBeChecked();
    await act(async () => { await syncInstrumentViewPreferencesFromNative(); });
    expect(screen.getByRole('checkbox', { name: 'Left-handed' })).toBeChecked();
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('bar');
    expect(notes.length).toBeGreaterThan(0);
  } finally { setNativeSettingsBridge(null); resetInstrumentViewPreferencesSync(); }
});

it('says once, quietly, when the options could not be saved, and when the settings belong to a newer build', async () => {
  const { score } = music(), { act } = await import('@testing-library/react');
  const { setNativeSettingsBridge, resetInstrumentViewPreferencesSync, syncInstrumentViewPreferencesFromNative } = await import('./view-preferences');
  resetInstrumentViewPreferencesSync();
  setNativeSettingsBridge({ read: async () => ({ instrumentView: null }), put: async () => { throw new Error('disk full'); } });
  try {
    render(<LiveInstrumentView score={score} track={0} staff={0} player={null} />);
    await act(async () => { await syncInstrumentViewPreferencesFromNative(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Left-handed' })); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('could not be saved');
    expect(screen.getByRole('checkbox', { name: 'Left-handed' })).toBeChecked();
  } finally { setNativeSettingsBridge(null); resetInstrumentViewPreferencesSync(); }
});
