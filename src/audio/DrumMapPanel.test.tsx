// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { model } from '@coderline/alphatab';
import './plugin-test-support';
import type { ChannelMix, EditCommand, PluginSlot } from '../edit-types';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { copyTrackSettings, defaultMix, defaultDocumentSettings } from '../document-settings';
import { setLanguagePreference } from '../i18n';
import { DrumMapPanel } from './DrumMapPanel';
import { MidiOutPanel } from './MidiOutPanel';
import { InterpretationPanel } from './InterpretationPanel';
import { SoundPanel } from './SoundPanel';
import { soundPreset } from './sound-model';
import { usedDrumSounds } from './drum-map';
import { drumMapFiles, type ImportedDrumMap } from './drum-map-file';
import type { MidiOutBridge } from './midi-out';

// Two layouts besides General MIDI, as a later slice's data will bring them: one not yet checked, with a changed key, a silent key and
// candidate keys for a row, and one checked on a date. Nothing in the app names them.
vi.mock('./drum-maps.json', async importOriginal => {
  const real = (await importOriginal<{ default: { sounds: unknown; presets: unknown[] } }>()).default;
  const data = {
    ...real,
    presets: [
      ...real.presets,
      { id: 'test-kit', name: 'Test kit', state: 'unverified', source: 'Notes from the maker of the test kit.', rows: [[91, 40], [42, null]], candidates: [[91, [40, 41]]] },
      { id: 'checked-kit', name: 'Checked kit', state: 'verified', source: 'Source.', checked: '2026-11-01' },
    ],
  };
  return { default: data, ...data };
});

// The two file commands are the native side's; here they answer what a test says.
vi.mock('./drum-map-file', async importOriginal => ({ ...(await importOriginal<object>()), drumMapFiles: { import: vi.fn(), export: vi.fn() } }));

afterEach(() => { cleanup(); setLanguagePreference('en'); vi.mocked(drumMapFiles.import).mockReset(); vi.mocked(drumMapFiles.export).mockReset(); });

const base: ChannelMix = { gain: 0.7, pan: -0.2, mute: false, solo: false };
const mixEdit = (edit: EditCommand | undefined) => (edit as Extract<EditCommand, { type: 'setTrackMix' }>).mix;
/** Keeps the mix the way the app does: an edit that is accepted becomes the mix the panel is given. */
function Harness({ initial = base, used = [38, 91, 42], busy = false, onEdit }: { initial?: ChannelMix; used?: number[]; busy?: boolean; onEdit: (edit: EditCommand) => void }) {
  const [mix, setMix] = useState(initial);
  return <DrumMapPanel trackId="base/1" mix={mix} used={used} busy={busy} onEdit={edit => { onEdit(edit); if (edit.type === 'setTrackMix') setMix(edit.mix); }} />;
}
const keyField = (sound: string) => screen.getByLabelText(new RegExp(`^Key for ${sound}( \\(|$)`)) as HTMLInputElement;
const type = (field: HTMLInputElement, text: string) => { fireEvent.change(field, { target: { value: text } }); fireEvent.blur(field); };
const rowCount = () => document.querySelectorAll('.drum-map-table li').length;

describe('editing keys', () => {
  it('records one edit per key, drops a key that equals the layout, and records nothing for the key already there', () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);
    expect(keyField('Snare rim shot')).toHaveValue('38');
    type(keyField('Snare rim shot'), '38');
    expect(onEdit).not.toHaveBeenCalled();
    type(keyField('Snare rim shot'), '40');
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(mixEdit(onEdit.mock.calls[0][0])).toEqual({ ...base, drumMap: { preset: 'gm', keys: [[91, 40]] } });
    expect(onEdit.mock.calls[0][0]).toMatchObject({ type: 'setTrackMix', trackId: 'base/1' });
    type(keyField('Snare rim shot'), '40');
    expect(onEdit).toHaveBeenCalledTimes(1);
    type(keyField('Snare rim shot'), '38');
    expect(onEdit).toHaveBeenCalledTimes(2);
    // General MIDI with no changed rows is no map at all, and the rest of the mix is as it was.
    expect(mixEdit(onEdit.mock.calls[1][0])).toEqual(base);
    expect('drumMap' in mixEdit(onEdit.mock.calls[1][0])).toBe(false);
  });

  it('shows an empty key as no sound without calling it an error, and keeps the others of the map', () => {
    const onEdit = vi.fn();
    render(<Harness initial={{ ...base, drumMap: { preset: 'gm', keys: [[91, 40]] } }} onEdit={onEdit} />);
    type(keyField('Hi-hat closed'), '');
    expect(mixEdit(onEdit.mock.calls[0][0]).drumMap).toEqual({ preset: 'gm', keys: [[42, null], [91, 40]] });
    expect(screen.getByText('No sound')).toBeInTheDocument();
    expect(screen.getByText('No sound')).toHaveClass('muted');
    expect(screen.queryByRole('alert')).toBeNull();
    // The sound is named to assistive technology, with the row's state.
    expect(screen.getByLabelText(/^Key for Hi-hat closed \(changed, no sound\)$/)).toHaveValue('');
  });

  it('leaves a typed value that is no key alone and puts the key back', () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);
    for (const bad of ['abc', '128', '-1', '3.5', '1e1']) {
      type(keyField('Snare rim shot'), bad);
      expect(keyField('Snare rim shot')).toHaveValue('38');
    }
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('marks a changed row in words, resets it in one edit and keeps focus in the row', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ ...base, drumMap: { preset: 'gm', keys: [[91, 40]] } }} onEdit={onEdit} />);
    const row = keyField('Snare rim shot').closest('li')!;
    expect(within(row).getByText('Changed')).toBeInTheDocument();
    expect(keyField('Snare rim shot')).toHaveAccessibleName('Key for Snare rim shot (changed)');
    await user.click(within(row).getByRole('button', { name: 'Reset Snare rim shot to the layout' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(mixEdit(onEdit.mock.calls[0][0])).toEqual(base);
    expect(document.activeElement).toBe(keyField('Snare rim shot'));
    expect(within(keyField('Snare rim shot').closest('li')!).queryByText('Changed')).toBeNull();
  });

  it('resets everything in one edit, and records nothing when there is nothing to reset', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ ...base, drumMap: { preset: 'gm', keys: [[91, 40], [42, null]] } }} onEdit={onEdit} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 keys changed.');
    await user.click(screen.getByRole('button', { name: 'Reset all to preset' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(mixEdit(onEdit.mock.calls[0][0])).toEqual(base);
    const again = screen.getByRole('button', { name: 'Reset all to preset' });
    expect(again).toHaveAttribute('aria-disabled', 'true');
    expect(again).not.toBeDisabled();
    await user.click(again);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel and the focus in place across a commit with Enter, and adds no layout of its own when a row changes', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onEdit={onEdit} />);
    const field = keyField('Snare rim shot'), cells = field.closest('li')!.children.length;
    await user.click(field);
    await user.clear(field);
    await user.type(field, '41{Enter}');
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(keyField('Snare rim shot')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field).toHaveValue('41');
    expect(field.closest('li')!.children.length).toBe(cells);
  });

  it('reads the keys in visual order with Tab', async () => {
    const user = userEvent.setup();
    render(<Harness used={[38, 91, 37, 42]} onEdit={vi.fn()} />);
    keyField('Snare hit').focus();
    const visited: string[] = [];
    for (let step = 0; step < 4; step++) { await user.tab(); visited.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''); }
    expect(visited).toEqual(['Key for Snare side stick', 'Key for Snare rim shot', 'Hi-hat', 'Key for Hi-hat closed']);
  });
});

describe('the layout', () => {
  it('offers General MIDI and any other layout the data carries, and says an unchecked one is not yet checked', () => {
    render(<Harness initial={{ ...base, drumMap: { preset: 'test-kit' } }} onEdit={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'Drum map' });
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual(['General MIDI (built-in kit keys)', 'Test kit — not yet checked', 'Checked kit']);
    expect(select.querySelector('optgroup')).toHaveAttribute('label', 'Other layouts');
    expect(select).toHaveValue('test-kit');
    expect(screen.getByText('Notes from the maker of the test kit. Not yet checked.')).toBeInTheDocument();
    // Its own rows come from the layout, so the track has changed nothing.
    expect(keyField('Snare rim shot')).toHaveValue('40');
    expect(screen.getByRole('status')).not.toHaveTextContent('changed');
  });

  it('says when a layout was checked', () => {
    render(<Harness initial={{ ...base, drumMap: { preset: 'checked-kit' } }} onEdit={vi.fn()} />);
    expect(screen.getByText('Source. Checked on 2026-11-01.')).toBeInTheDocument();
  });

  it('shows the candidate keys of a row as buttons that set the key', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ ...base, drumMap: { preset: 'test-kit' } }} onEdit={onEdit} />);
    const group = screen.getByRole('group', { name: 'Keys to try for Snare rim shot' });
    expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['40', '41']);
    expect(within(group).getByRole('button', { name: 'Use key 40 for Snare rim shot' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(group).getByRole('button', { name: 'Use key 41 for Snare rim shot' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(mixEdit(onEdit.mock.calls[0][0]).drumMap).toEqual({ preset: 'test-kit', keys: [[91, 41]] });
    await user.click(screen.getByRole('button', { name: 'Use key 41 for Snare rim shot' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('changes the layout in one edit that clears the changed rows, and says Undo brings them back', async () => {
    const onEdit = vi.fn();
    render(<Harness initial={{ ...base, drumMap: { preset: 'test-kit', keys: [[38, 41]] } }} onEdit={onEdit} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 key changed.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Drum map' }), { target: { value: 'gm' } });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(mixEdit(onEdit.mock.calls[0][0])).toEqual(base);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('The changed keys were cleared. Undo brings them back.');
    });
    {
      fireEvent.change(screen.getByRole('combobox', { name: 'Drum map' }), { target: { value: 'gm' } });
      expect(onEdit).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByRole('combobox', { name: 'Drum map' }), { target: { value: 'checked-kit' } });
      expect(mixEdit(onEdit.mock.calls[1][0]).drumMap).toEqual({ preset: 'checked-kit' });
    }
  });

  it('plays an unknown layout as General MIDI plus the track\'s rows, and says so', () => {
    const onEdit = vi.fn();
    render(<Harness initial={{ ...base, drumMap: { preset: 'mystery-kit', keys: [[91, 40]] } }} onEdit={onEdit} />);
    const select = screen.getByRole('combobox', { name: 'Drum map' });
    expect(select).toHaveValue('mystery-kit');
    expect(within(select).getByRole('option', { name: 'mystery-kit (unknown layout)' })).toBeInTheDocument();
    expect(screen.getByText(/not known to this version of the app\. General MIDI keys are used, with the changes made to this track\./)).toBeInTheDocument();
    expect(keyField('Snare hit')).toHaveValue('38');
    expect(keyField('Snare rim shot')).toHaveValue('40');
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to preset' }));
    expect(mixEdit(onEdit.mock.calls[0][0]).drumMap).toEqual({ preset: 'mystery-kit' });
  });

  it('says which sounds of the track have no key, and how many keys were changed', () => {
    const { rerender } = render(<DrumMapPanel trackId="t" mix={{ ...base, drumMap: { preset: 'test-kit' } }} used={[38, 91, 42]} onEdit={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 sound in this track has no key in this map.');
    rerender(<DrumMapPanel trackId="t" mix={{ ...base, drumMap: { preset: 'test-kit', keys: [[38, null], [46, null]] } }} used={[38, 91, 42, 46, 51]} onEdit={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 keys changed. 3 sounds in this track have no key in this map.');
    rerender(<DrumMapPanel trackId="t" mix={base} used={[38]} onEdit={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});

describe('which sounds are listed', () => {
  it('lists exactly the sounds the track uses, by name, with the counts', async () => {
    const user = userEvent.setup();
    render(<DrumMapPanel trackId="t" mix={base} used={[38, 91, 42, 60]} onEdit={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'In this track (4)' })).toBeChecked();
    expect(rowCount()).toBe(4);
    expect(screen.getAllByLabelText(/^Key for /).map(field => field.getAttribute('aria-label'))).toEqual(['Key for Snare hit', 'Key for Snare rim shot', 'Key for Hi-hat closed', 'Key for Bongo high hit'].map(name => name));
    await user.click(screen.getByRole('radio', { name: 'All sounds (94)' }));
    expect(rowCount()).toBe(94);
    expect(document.querySelector('.drum-map-group')).not.toBeNull();
    // Every sound belongs to a piece, so no group of leftovers appears.
    expect(screen.queryByText('Other sounds')).toBeNull();
  });

  it('opens the groups of the drum kit and folds the other percussion, and says when the track plays nothing', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DrumMapPanel trackId="t" mix={base} used={[38, 60]} onEdit={vi.fn()} />);
    expect(screen.getByText('Snare').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Bongo high').closest('details')).not.toHaveAttribute('open');
    rerender(<DrumMapPanel trackId="t" mix={base} used={[]} onEdit={vi.fn()} />);
    expect(screen.getByText('This track has no drum notes yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'All sounds (94)' }));
    expect(screen.queryByText('This track has no drum notes yet.')).toBeNull();
  });

  it('heads the note column with the octave the app uses, middle C being 60', () => {
    render(<DrumMapPanel trackId="t" mix={{ ...base, drumMap: { preset: 'gm', keys: [[91, 60]] } }} used={[91]} onEdit={vi.fn()} />);
    expect(screen.getByText('Note (C4 = 60)')).toBeInTheDocument();
    expect(keyField('Snare rim shot').closest('li')).toHaveTextContent('C4');
  });

  it('says quietly when a sound has the key of its piece\'s plain hit', () => {
    const { rerender } = render(<DrumMapPanel trackId="t" mix={base} used={[38, 91]} onEdit={vi.fn()} />);
    expect(keyField('Snare rim shot').closest('li')).toHaveTextContent('Same key as Snare hit');
    expect(keyField('Snare hit').closest('li')).not.toHaveTextContent('Same key');
    rerender(<DrumMapPanel trackId="t" mix={{ ...base, drumMap: { preset: 'gm', keys: [[91, 40]] } }} used={[38, 91]} onEdit={vi.fn()} />);
    expect(keyField('Snare rim shot').closest('li')).not.toHaveTextContent('Same key');
  });

  it('closes the key editor with Escape and returns to its summary', async () => {
    const user = userEvent.setup();
    render(<DrumMapPanel trackId="t" mix={base} used={[38]} onEdit={vi.fn()} />);
    const details = screen.getByText('Keys').closest('details')!;
    await user.click(screen.getByText('Keys'));
    expect(details.open).toBe(true);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    await user.click(keyField('Snare hit'));
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', outer);
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });
});

describe('while an edit is in flight', () => {
  it('refuses changes without disabling anything that can hold focus', () => {
    const onEdit = vi.fn();
    const { rerender } = render(<Harness onEdit={onEdit} />);
    const field = keyField('Snare rim shot');
    field.focus();
    rerender(<Harness onEdit={onEdit} busy />);
    expect(document.activeElement).toBe(field);
    expect(document.querySelectorAll('fieldset[disabled],input[disabled],select[disabled],button[disabled]')).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Drum map' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByRole('combobox', { name: 'Drum map' }), { target: { value: 'test-kit' } });
    fireEvent.click(screen.getByRole('radio', { name: 'All sounds (94)' }));
    expect(screen.getByRole('radio', { name: 'In this track (3)' })).toBeChecked();
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('where the panel shows', () => {
  const slot: PluginSlot = { format: 'vst3', classId: 'B'.repeat(32), name: 'Big Drums', vendor: 'Kit Co', active: true, inputDb: 0, outputDb: 0, state: 's'.repeat(64), kind: 'instrument' };
  const effect: PluginSlot = { ...slot, kind: undefined };
  delete (effect as { kind?: string }).kind;
  const sound = (plugin?: PluginSlot) => ({ ...soundPreset('gm'), ...(plugin ? { plugin } : {}) });

  it('follows an instrument in a drum track\'s plug-in slot, and edits the mix through the same edit', () => {
    const onEdit = vi.fn();
    const { rerender } = render(<SoundPanel trackId="base/1" sound={sound(slot)} percussion mix={base} usedDrumSounds={[38, 91]} onEdit={onEdit} />);
    expect(screen.getByRole('combobox', { name: 'Drum map' })).toBeInTheDocument();
    type(keyField('Snare rim shot'), '40');
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toEqual({ type: 'setTrackMix', trackId: 'base/1', mix: { ...base, drumMap: { preset: 'gm', keys: [[91, 40]] } } });
    for (const [plugin, percussion] of [[undefined, true], [effect, true], [slot, false]] as const) {
      rerender(<SoundPanel trackId="base/1" sound={sound(plugin)} percussion={percussion} mix={base} usedDrumSounds={[38]} onEdit={onEdit} />);
      expect(screen.queryByRole('combobox', { name: 'Drum map' })).toBeNull();
    }
  });

  const bridge = (): MidiOutBridge => ({ ports: vi.fn(async () => [{ id: '1', name: 'USB MIDI' }]), setDelay: vi.fn(async () => {}), status: vi.fn(async () => ({ ports: [], sent: 0, dropped: 0, late: 0, maxLateMs: 0 })), testLog: vi.fn(async () => []) });

  it('follows a chosen MIDI port on a drum track', async () => {
    const onEdit = vi.fn();
    const { rerender } = render(<MidiOutPanel trackId="base/1" mix={{ ...base, midiPort: 'USB MIDI' }} percussion usedDrumSounds={[38, 91]} onEdit={onEdit} bridge={bridge()} />);
    await screen.findByRole('option', { name: 'USB MIDI' });
    expect(screen.getByRole('combobox', { name: 'Drum map' })).toBeInTheDocument();
    type(keyField('Snare rim shot'), '40');
    expect(onEdit.mock.calls[0][0].mix).toEqual({ ...base, midiPort: 'USB MIDI', drumMap: { preset: 'gm', keys: [[91, 40]] } });
    rerender(<MidiOutPanel trackId="base/1" mix={base} percussion usedDrumSounds={[38]} onEdit={onEdit} bridge={bridge()} />);
    expect(screen.queryByRole('combobox', { name: 'Drum map' })).toBeNull();
    rerender(<MidiOutPanel trackId="base/1" mix={{ ...base, midiPort: 'USB MIDI' }} usedDrumSounds={[38]} onEdit={onEdit} bridge={bridge()} />);
    expect(screen.queryByRole('combobox', { name: 'Drum map' })).toBeNull();
  });
});

describe('every other mix edit keeps the drum map', () => {
  const mapped: ChannelMix = { ...base, drumMap: { preset: 'gm', keys: [[91, 40]] } };

  it('keeps it when the MIDI port is chosen or cleared', async () => {
    const onEdit = vi.fn();
    const bridge: MidiOutBridge = { ports: vi.fn(async () => [{ id: '1', name: 'USB MIDI' }]), setDelay: vi.fn(async () => {}), status: vi.fn(async () => ({ ports: [], sent: 0, dropped: 0, late: 0, maxLateMs: 0 })), testLog: vi.fn(async () => []) };
    const { rerender } = render(<MidiOutPanel trackId="base/1" mix={mapped} percussion onEdit={onEdit} bridge={bridge} />);
    await screen.findByRole('option', { name: 'USB MIDI' });
    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'USB MIDI' } });
    expect(onEdit.mock.calls[0][0].mix).toEqual({ ...mapped, midiPort: 'USB MIDI' });
    rerender(<MidiOutPanel trackId="base/1" mix={{ ...mapped, midiPort: 'USB MIDI' }} percussion onEdit={onEdit} bridge={bridge} />);
    fireEvent.change(screen.getByLabelText('Output'), { target: { value: '' } });
    expect(onEdit.mock.calls[1][0].mix).toEqual(mapped);
  });

  it('keeps it when an interpretation is chosen', () => {
    const onEdit = vi.fn();
    render(<InterpretationPanel trackId="base/1" mix={mapped} stringed onEdit={onEdit} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Playing style' }), { target: { value: 'fingers' } });
    expect(onEdit.mock.calls[0][0].mix).toEqual({ ...mapped, interpretation: { style: 'fingers' } });
  });

  it('keeps it through a duplicated track, which copies the source mix as it is', () => {
    const settings = defaultDocumentSettings();
    settings.mixes.source = structuredClone(mapped);
    copyTrackSettings(settings, 'source', 'copy');
    expect(settings.mixes.copy.drumMap).toEqual(mapped.drumMap);
    const added = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
    const id = trackIdentity(added.score.tracks[1]);
    const withMap = previewEdit(added.project, { type: 'setTrackMix', trackId: id, mix: mapped });
    const duplicated = previewEdit(withMap.project, { type: 'duplicateTrack', track: 1 });
    const copy = trackIdentity(duplicated.score.tracks[2]);
    expect(copy).not.toBe(id);
    expect(duplicated.settings.mixes[copy].drumMap).toEqual(mapped.drumMap);
    expect(buildDocument(duplicated.project).settings.mixes[copy].drumMap).toEqual(mapped.drumMap);
  });

  it('keeps a map through a default mix being the base of an edit', () => {
    expect(defaultMix()).not.toHaveProperty('drumMap');
  });
});

describe('usedDrumSounds', () => {
  it('reads the standard sounds of the notes: standard articulations, the standard sound a track\'s own table copies, and plain hits by key', () => {
    let state = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
    const at = (beat: number) => ({ track: 1, staff: 0, bar: 0, voice: 0, beat });
    for (const articulation of [38, 91, 42]) state = previewEdit(state.project, { type: 'addPercussionNote', target: at(0), articulation }, state);
    expect(usedDrumSounds(state.score.tracks[1])).toEqual([38, 42, 91]);
    // A track's own articulation that copies no standard one is a plain hit by the key it sounds.
    const own = new model.Track();
    own.percussionArticulations = [new model.InstrumentArticulation('Mystery', 3, 42, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Outside, 0)];
    const staff = new model.Staff(), bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(), note = new model.Note();
    staff.isPercussion = true; note.percussionArticulation = 0; beat.addNote(note); voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar); own.addStaff(staff);
    expect(note.isPercussion).toBe(true);
    expect(usedDrumSounds(own)).toEqual([42]);
    expect(usedDrumSounds(new model.Track())).toEqual([]);
  });
});

describe('drum map files', () => {
  const importButton = () => screen.getByRole('button', { name: 'Import…' });
  const exportButton = () => screen.getByRole('button', { name: 'Export…' });
  const file = (over: Partial<ImportedDrumMap> = {}): ImportedDrumMap => ({ name: 'Kit', base: null, keys: [[38, 41], [42, null]], ...over });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('imports a file as one edit that keeps the rest of the mix, and keeps focus on the button', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    vi.mocked(drumMapFiles.import).mockResolvedValue(file());
    render(<Harness onEdit={onEdit} />);
    await user.click(importButton());
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(onEdit.mock.calls[0][0]).toMatchObject({ type: 'setTrackMix', trackId: 'base/1' });
    expect(mixEdit(onEdit.mock.calls[0][0])).toEqual({ ...base, drumMap: { preset: 'gm', keys: [[38, 41], [42, null]] } });
    expect(document.activeElement).toBe(importButton());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('2 keys changed.');
  });

  it('stores the base layout and only the rows that differ from it, and General MIDI when the base is unknown here', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    vi.mocked(drumMapFiles.import).mockResolvedValueOnce(file({ base: 'test-kit', keys: [[91, 41], [42, null], [38, 38]] }));
    render(<Harness onEdit={onEdit} />);
    await user.click(importButton());
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(mixEdit(onEdit.mock.calls[0][0]).drumMap).toEqual({ preset: 'test-kit', keys: [[91, 41]] });
    vi.mocked(drumMapFiles.import).mockResolvedValueOnce(file({ base: 'nonesuch', keys: [[38, 41]] }));
    await user.click(importButton());
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(2));
    expect(mixEdit(onEdit.mock.calls[1][0]).drumMap).toEqual({ preset: 'gm', keys: [[38, 41]] });
  });

  it('records nothing for a file that says what the track already plays', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    vi.mocked(drumMapFiles.import).mockResolvedValue(file({ base: 'test-kit', keys: [[91, 40], [42, null], [38, 41]] }));
    render(<Harness initial={{ ...base, drumMap: { preset: 'test-kit', keys: [[38, 41]] } }} onEdit={onEdit} />);
    await user.click(importButton());
    await waitFor(() => expect(drumMapFiles.import).toHaveBeenCalledTimes(1));
    await settle();
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing when the dialog is cancelled, for an import and an export alike', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    vi.mocked(drumMapFiles.import).mockResolvedValue(null);
    vi.mocked(drumMapFiles.export).mockResolvedValue(false);
    render(<Harness onEdit={onEdit} />);
    await user.click(importButton());
    await settle();
    await user.click(exportButton());
    await waitFor(() => expect(drumMapFiles.export).toHaveBeenCalledTimes(1));
    await settle();
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(exportButton());
  });

  it('shows a refused file in words, keeps the map, and clears the message with the next edit', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    vi.mocked(drumMapFiles.import).mockRejectedValue('newer_version');
    render(<Harness onEdit={onEdit} />);
    await user.click(importButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The drum map was not imported: This drum map was made by a newer TabPlayer. Update TabPlayer to use it.');
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(importButton());
    type(keyField('Snare rim shot'), '40');
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(drumMapFiles.import).mockRejectedValue('unreadable: Access is denied.');
    await user.click(importButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The file could not be read. Access is denied.');
  });

  it('shows the refusal in the chosen language', async () => {
    const user = userEvent.setup();
    setLanguagePreference('de');
    vi.mocked(drumMapFiles.import).mockRejectedValue('too_large');
    render(<Harness onEdit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Importieren…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Zuordnung wurde nicht importiert: Die Datei ist größer als 16 KiB');
    cleanup();
    setLanguagePreference('et');
    render(<Harness onEdit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Impordi…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Trummikaarti ei imporditud: Fail on suurem kui 16 KiB');
  });

  it("exports the map the track has, under the layout's name, and shows a failed write", async () => {
    const user = userEvent.setup();
    vi.mocked(drumMapFiles.export).mockResolvedValueOnce(true);
    const map = { preset: 'test-kit', keys: [[38, 41]] as [number, number | null][] };
    render(<Harness initial={{ ...base, drumMap: map }} onEdit={vi.fn()} />);
    await user.click(exportButton());
    await waitFor(() => expect(drumMapFiles.export).toHaveBeenCalledWith(map, 'Test kit'));
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(drumMapFiles.export).mockRejectedValueOnce('unreadable: The disk is full.');
    await user.click(exportButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The drum map was not exported: The file could not be read. The disk is full.');
    cleanup();
    render(<Harness onEdit={vi.fn()} />);
    await user.click(exportButton());
    await waitFor(() => expect(drumMapFiles.export).toHaveBeenLastCalledWith(undefined, 'General MIDI'));
  });

  it('asks for one file at a time and applies it to the mix as it is when the dialog closes', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    let answer: (value: ImportedDrumMap) => void = () => undefined;
    vi.mocked(drumMapFiles.import).mockReturnValue(new Promise<ImportedDrumMap | null>(resolve => { answer = resolve; }));
    render(<Harness onEdit={onEdit} />);
    await user.click(importButton());
    await user.click(importButton());
    expect(drumMapFiles.import).toHaveBeenCalledTimes(1);
    // An edit made while the dialog is open is not lost to a stale mix: the import lands on top of it.
    type(keyField('Hi-hat closed'), '');
    expect(onEdit).toHaveBeenCalledTimes(1);
    answer(file({ keys: [[38, 41]] }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(2));
    expect(mixEdit(onEdit.mock.calls[1][0]).drumMap).toEqual({ preset: 'gm', keys: [[38, 41]] });
  });

  it('refuses both buttons while an edit is in flight, without disabling them', async () => {
    const user = userEvent.setup();
    render(<Harness onEdit={vi.fn()} busy />);
    for (const button of [importButton(), exportButton()]) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
      await user.click(button);
    }
    expect(drumMapFiles.import).not.toHaveBeenCalled();
    expect(drumMapFiles.export).not.toHaveBeenCalled();
  });
});
