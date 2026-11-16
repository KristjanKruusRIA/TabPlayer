// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { TrackSettingsPanel } from './TrackSettingsPanel';
import type { EditCommand } from '../edit-types';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })) }));
afterEach(cleanup);

const standard = [64, 59, 55, 50, 45, 40];
const saved = () => ({ tuning: standard, capo: 0, transposition: 0, displayTransposition: 0, clef: 0, showTab: true, showNotation: true, tuningName: 'Standard E' });
const lastEdit = (onEdit: ReturnType<typeof vi.fn>) => onEdit.mock.calls.at(-1)![0];
/** Two tracks, so the selection can move from one to the other. */
const twoTracks = () => previewEdit(blankProject(), { type: 'addTrack', name: 'Bass', tuning: [43, 38, 33, 28], program: 33 }).score;
/** One track with two staves; the second is tuned a tone down. */
const twoStaves = () => previewEdit(blankProject(), { type: 'addStaff', track: 0, settings: { ...saved(), tuning: [62, 57, 53, 48, 43, 38], tuningName: 'Down a tone' } }).score;
const edit = () => screen.getByRole('button', { name: /^Edit tuning/ });
const dialog = () => screen.getByRole('dialog', { name: 'Tuning' });
const notes = () => within(dialog()).getByLabelText('Notes, high to low') as HTMLInputElement;
const inDialog = (name: string | RegExp) => within(dialog()).getByRole('button', { name });
const panel = (score: ReturnType<typeof twoTracks>, selected: number, onEdit: (command: EditCommand) => unknown, extra: Partial<Parameters<typeof TrackSettingsPanel>[0]> = {}) =>
  <TrackSettingsPanel score={score} selected={selected} busy={false} onEdit={onEdit} {...extra} />;

it('a track name typed for one track is recorded for that track when the selection moves first and the blur arrives after, and only once', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  fireEvent.change(screen.getByLabelText('Track name'), { target: { value: 'Lead' } });
  // The score selects on mouse down, before the field loses focus: the panel is drawn for the other track first.
  view.rerender(panel(score, 1, onEdit));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackInfo', track: 0, name: 'Lead', shortName: score.tracks[0].shortName, program: score.tracks[0].playbackInfo.program });
  fireEvent.blur(screen.getByLabelText('Track name'));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Track name')).toHaveValue('Bass');
});

it('a name left by a blur before the selection moves is recorded once, for the track it was typed for', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const field = screen.getByLabelText('Track name');
  fireEvent.change(field, { target: { value: 'Lead' } });
  fireEvent.blur(field);
  view.rerender(panel(score, 1, onEdit));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setTrackInfo', track: 0, name: 'Lead' });
});

it('a name typed for a track that moved in the list is recorded for that track by identity, not by its old position', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const first = trackIdentity(score.tracks[0]);
  fireEvent.change(screen.getByLabelText('Track name'), { target: { value: 'Lead' } });
  const moved = previewEdit(blankProject(), { type: 'addTrack', name: 'Bass', tuning: [43, 38, 33, 28], program: 33 });
  const swapped = previewEdit(moved.project, { type: 'moveTrack', track: 0, to: 1 }).score;
  expect(trackIdentity(swapped.tracks[1])).toBe(first);
  view.rerender(panel(swapped, 0, onEdit));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setTrackInfo', track: 1, name: 'Lead' });
});

it('a transposition typed for one track goes to that track and its staff when the selection moves before the field is left, never to the other track', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  fireEvent.change(screen.getByLabelText('Sounding transposition'), { target: { value: '-12' } });
  view.rerender(panel(score, 1, onEdit));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toEqual({ type: 'setStaffSettings', track: 0, staff: 0, settings: expect.objectContaining({ transposition: -12 }) });
  fireEvent.blur(screen.getByLabelText('Sounding transposition'));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Sounding transposition')).toHaveValue(0);
});

it('a transposition typed on one staff stays on that staff when the cursor moves to the other staff of the track', () => {
  const score = twoStaves(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit, { staff: 0 }));
  fireEvent.change(screen.getByLabelText('Display transposition'), { target: { value: '7' } });
  view.rerender(panel(score, 0, onEdit, { staff: 1 }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toEqual({ type: 'setStaffSettings', track: 0, staff: 0, settings: expect.objectContaining({ displayTransposition: 7 }) });
});

it('a number is compared as a number: 0.0 or " 0" over a transposition of 0 records nothing', () => {
  const onEdit = vi.fn();
  render(panel(twoTracks(), 0, onEdit));
  const field = screen.getByLabelText('Sounding transposition');
  fireEvent.change(field, { target: { value: '0.0' } });fireEvent.blur(field);
  fireEvent.change(field, { target: { value: ' 0' } });fireEvent.blur(field);
  expect(onEdit).not.toHaveBeenCalled();
  expect(field).toHaveValue(0);
});

it('a draft left while an edit is in flight is applied once that edit ends, as one edit to its own track', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const field = screen.getByLabelText('Track name');
  field.focus();
  fireEvent.change(field, { target: { value: 'Lead' } });
  view.rerender(panel(score, 0, onEdit, { busy: true }));
  // The fieldset refuses a blur while busy, so nothing is recorded and the draft stays on screen.
  field.blur();
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Track name')).toHaveValue('Lead');
  view.rerender(panel(score, 0, onEdit, { busy: false }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setTrackInfo', track: 0, name: 'Lead' });
});

it('a draft still being typed in when the edit ends is left alone until the field is left', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const field = screen.getByLabelText('Track name');
  field.focus();
  fireEvent.change(field, { target: { value: 'Lead' } });
  view.rerender(panel(score, 0, onEdit, { busy: true }));
  view.rerender(panel(score, 0, onEdit, { busy: false }));
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.blur(field);
  expect(onEdit).toHaveBeenCalledTimes(1);
});

it('a track with several staves has a staff selector that moves the cursor to the chosen staff; a track with one staff has none', () => {
  const onEdit = vi.fn(), onSelectStaff = vi.fn();
  const view = render(panel(twoStaves(), 0, onEdit, { onSelectStaff }));
  const select = screen.getByRole('combobox', { name: 'Staff' });
  expect(select).toHaveValue('0');expect(select.querySelectorAll('option')).toHaveLength(2);
  fireEvent.change(select, { target: { value: '1' } });
  expect(onSelectStaff).toHaveBeenCalledWith(1);expect(onEdit).not.toHaveBeenCalled();
  view.rerender(panel(twoTracks(), 0, onEdit, { onSelectStaff }));
  expect(screen.queryByRole('combobox', { name: 'Staff' })).toBeNull();
});

it('the tuning row and dialog of a track with several staves act on the selected staff, with the settings edit the old Staff tuning field recorded', () => {
  const onEdit = vi.fn();
  render(panel(twoStaves(), 0, onEdit, { staff: 1 }));
  expect(edit()).toHaveTextContent('D4 A3 F3 C3 G2 D2');
  fireEvent.click(edit());
  expect(notes().value).toBe('D4 A3 F3 C3 G2 D2');
  fireEvent.change(notes(), { target: { value: 'D4 A3 F3 C3 G2 C2' } });fireEvent.click(inDialog('Keep pitch'));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toEqual({ type: 'setStaffSettings', track: 0, staff: 1, settings: expect.objectContaining({ tuning: [62, 57, 53, 48, 43, 36], tuningName: '', keepPitch: true }) });
  fireEvent.click(edit());fireEvent.change(notes(), { target: { value: 'D4 A3 F3 C3 G2 B1' } });fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(2);
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setStaffSettings', track: 0, staff: 1, settings: { tuning: [62, 57, 53, 48, 43, 35] } });
  expect(lastEdit(onEdit).settings).not.toHaveProperty('keepPitch');
});

it('choosing the staff\'s own tuning in a track with several staves records nothing, and the first staff is tuned the same way', () => {
  const onEdit = vi.fn();
  const view = render(panel(twoStaves(), 0, onEdit, { staff: 1 }));
  fireEvent.click(edit());fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).not.toHaveBeenCalled();
  view.rerender(panel(twoStaves(), 0, onEdit, { staff: 0 }));
  expect(edit()).toHaveTextContent('E4 B3 G3 D3 A2 E2');
  fireEvent.click(edit());fireEvent.change(notes(), { target: { value: 'E4 B3 G3 D3 A2 D2' } });fireEvent.click(inDialog('Keep fingering'));
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setStaffSettings', track: 0, staff: 0, settings: { tuning: [64, 59, 55, 50, 45, 38] } });
});

it('a capo and a retune of the selected staff are one edit in a track with several staves', () => {
  const onEdit = vi.fn();
  render(panel(twoStaves(), 0, onEdit, { staff: 1 }));
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'), { target: { value: '2' } });fireEvent.change(notes(), { target: { value: 'D4 A3 F3 C3 G2 C2' } });fireEvent.click(inDialog('Keep pitch'));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toEqual({ type: 'setStaffSettings', track: 0, staff: 1, settings: expect.objectContaining({ capo: 2, tuning: [62, 57, 53, 48, 43, 36], keepPitch: true }) });
});

it('Enter in the Capo field only settles the field; a partial capo typed but not settled is not dropped when the dialog is applied from a button', () => {
  const onEdit = vi.fn();
  render(panel(twoTracks(), 0, onEdit));
  fireEvent.click(edit());
  const capo = within(dialog()).getByLabelText('Capo');
  fireEvent.change(capo, { target: { value: '2' } });
  expect(fireEvent.keyDown(capo, { key: 'Enter' })).toBe(false);
  expect(onEdit).not.toHaveBeenCalled();expect(dialog()).toBeInTheDocument();
  fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastEdit(onEdit)).toMatchObject({ type: 'setStaffSettings', settings: { capo: 2 } });
});

it('a partial capo fret typed and not settled is settled, not dropped, when the dialog is applied from another control', () => {
  const onEdit = vi.fn();
  render(panel(twoTracks(), 0, onEdit));
  fireEvent.click(edit());
  // The string is chosen first (which waits for a fret); the fret is then typed and the dialog applied without leaving the field.
  fireEvent.click(within(dialog()).getByRole('checkbox', { name: /^String 1 / }));
  fireEvent.change(within(dialog()).getByLabelText('Partial capo fret'), { target: { value: '5' } });
  fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setStaffSettings', track: 0, staff: 0, settings: { partialCapo: { fret: 5, strings: [1] } } });
});

it('browsing the MIDI instrument and the clef with the arrow keys records one edit each, when the select is left, not one per key', () => {
  const onEdit = vi.fn();
  render(panel(twoTracks(), 0, onEdit));
  const browse = (select: HTMLElement, key: string, value: string) => { fireEvent.keyDown(select, { key });fireEvent.change(select, { target: { value } });fireEvent.keyUp(select, { key }); };
  const program = screen.getByLabelText('Track MIDI instrument') as HTMLSelectElement, saved = Number(program.value);
  browse(program, 'ArrowDown', String(saved + 1));browse(program, 'ArrowDown', String(saved + 2));browse(program, 'ArrowDown', String(saved + 3));
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.blur(program);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastEdit(onEdit)).toMatchObject({ type: 'setTrackInfo', track: 0, program: saved + 3 });
  const clef = screen.getByLabelText('Staff clef') as HTMLSelectElement, options = Array.from(clef.options).map(option => option.value), at = options.indexOf(clef.value);
  browse(clef, 'ArrowUp', options[at - 1]);browse(clef, 'ArrowUp', options[at - 2]);
  expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.blur(clef);
  expect(onEdit).toHaveBeenCalledTimes(2);expect(lastEdit(onEdit)).toMatchObject({ type: 'setStaffSettings', settings: { clef: Number(options[at - 2]) } });
});

it('a draft typed for one track is dropped, not recorded later, when an edit is in flight as the selection moves to another track', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const field = screen.getByLabelText('Track name');
  field.focus();
  fireEvent.change(field, { target: { value: 'Lead' } });
  // The selection moves while an edit is in flight: the draft cannot be recorded now, and is never recorded later.
  view.rerender(panel(score, 1, onEdit, { busy: true }));
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Track name')).toHaveValue('Bass');
  view.rerender(panel(score, 1, onEdit, { busy: false }));
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Track name')).toHaveValue('Bass');
});

it('a refused commit (the edit comes back false) puts the saved name back on screen', () => {
  const score = twoTracks(), onEdit = vi.fn(() => false);
  render(panel(score, 0, onEdit));
  const field = screen.getByLabelText('Track name');
  fireEvent.change(field, { target: { value: 'Lead' } });fireEvent.blur(field);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Track name')).toHaveValue(score.tracks[0].name);
});

it('a locked score refuses the commit and the field shows the document\'s name again', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const field = screen.getByLabelText('Track name');
  fireEvent.change(field, { target: { value: 'Lead' } });
  view.rerender(panel(score, 0, onEdit, { locked: true }));
  fireEvent.blur(field);
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Track name')).toHaveValue(twoTracks().tracks[0].name);
});

it('a draft typed on a staff is dropped when that staff was removed or an earlier staff was removed so its index names another staff', () => {
  const base = previewEdit(blankProject(), { type: 'addStaff', track: 0, settings: saved() }), three = previewEdit(base.project, { type: 'addStaff', track: 0, settings: saved() });
  const onEdit = vi.fn(), view = render(panel(three.score, 0, onEdit, { staff: 2 }));
  fireEvent.change(screen.getByLabelText('Display transposition'), { target: { value: '7' } });
  // The last staff is removed: index 2 no longer exists, so the draft goes nowhere (it does not land on the new last staff).
  const two = previewEdit(three.project, { type: 'removeStaff', track: 0, staff: 2 }).score;
  view.rerender(panel(two, 0, onEdit, { staff: 1 }));
  expect(onEdit).not.toHaveBeenCalled();
  cleanup();
  const again = render(panel(three.score, 0, onEdit, { staff: 2 }));
  fireEvent.change(screen.getByLabelText('Display transposition'), { target: { value: '7' } });
  // The first staff is removed: index 2 is gone and the staff count changed, so the index is not trusted.
  const rest = previewEdit(three.project, { type: 'removeStaff', track: 0, staff: 0 }).score;
  again.rerender(panel(rest, 0, onEdit, { staff: 1 }));
  expect(onEdit).not.toHaveBeenCalled();
});

it('a browsed choice that was left while an edit was in flight is dropped, so a track with the same stored value does not show or take it', () => {
  const score = twoTracks();
  const sameProgram = (previewEdit(blankProject(), { type: 'addTrack', name: 'Bass', tuning: [43, 38, 33, 28], program: score.tracks[0].playbackInfo.program }).score);
  const onEdit = vi.fn(), view = render(panel(sameProgram, 0, onEdit));
  const program = () => screen.getByLabelText('Track MIDI instrument') as HTMLSelectElement;
  const stored = program().value;
  program().focus();
  fireEvent.keyDown(program(), { key: 'ArrowDown' });fireEvent.change(program(), { target: { value: String(Number(stored) + 1) } });fireEvent.keyUp(program(), { key: 'ArrowDown' });
  expect(program()).toHaveValue(String(Number(stored) + 1));
  // An edit is in flight and the select is left (the fieldset refuses that blur); then the other track, with the same stored value, is selected.
  view.rerender(panel(sameProgram, 0, onEdit, { busy: true }));
  program().blur();
  view.rerender(panel(sameProgram, 1, onEdit, { busy: true }));
  view.rerender(panel(sameProgram, 1, onEdit, { busy: false }));
  expect(program()).toHaveValue(stored);
  fireEvent.blur(program());
  expect(onEdit).not.toHaveBeenCalled();
});

it('a browsed choice is dropped when the selection moves to another track, and recorded once for its own track when the select is left', () => {
  const score = twoTracks(), onEdit = vi.fn(), view = render(panel(score, 0, onEdit));
  const program = () => screen.getByLabelText('Track MIDI instrument') as HTMLSelectElement;
  const stored = Number(program().value);
  fireEvent.keyDown(program(), { key: 'ArrowDown' });fireEvent.change(program(), { target: { value: String(stored + 1) } });fireEvent.keyUp(program(), { key: 'ArrowDown' });
  view.rerender(panel(score, 1, onEdit));
  fireEvent.blur(program());
  expect(onEdit).not.toHaveBeenCalled();
  expect(program()).toHaveValue(String(score.tracks[1].playbackInfo.program));
  view.rerender(panel(score, 0, onEdit));
  fireEvent.keyDown(program(), { key: 'ArrowDown' });fireEvent.change(program(), { target: { value: String(stored + 1) } });fireEvent.keyUp(program(), { key: 'ArrowDown' });
  fireEvent.blur(program());
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastEdit(onEdit)).toMatchObject({ type: 'setTrackInfo', track: 0, program: stored + 1 });
});

it('a field that is unmounted with a draft records nothing', () => {
  const onEdit = vi.fn(), view = render(panel(twoTracks(), 0, onEdit));
  fireEvent.change(screen.getByLabelText('Track name'), { target: { value: 'Lead' } });
  view.unmount();
  expect(onEdit).not.toHaveBeenCalled();
});

it('changing the string count of a track with several staves says so before it is applied; a single-staff track has no such line', () => {
  const onEdit = vi.fn(), view = render(panel(twoStaves(), 0, onEdit, { staff: 1 }));
  fireEvent.click(edit());fireEvent.change(notes(), { target: { value: 'D4 A3 F3 C3 G2 D2 A1' } });
  expect(within(dialog()).getByText(/applies to every staff of the track/)).toBeInTheDocument();
  fireEvent.click(inDialog('Cancel'));
  view.rerender(panel(twoTracks(), 0, onEdit));
  fireEvent.click(edit());fireEvent.change(notes(), { target: { value: 'G2 D2 A1 E1 B0' } });
  expect(within(dialog()).queryByText(/applies to every staff of the track/)).toBeNull();
});
