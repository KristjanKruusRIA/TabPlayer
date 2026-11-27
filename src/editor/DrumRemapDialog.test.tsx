// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { blankProject } from '../project';
import { previewEdit } from '../engine';
import { DrumRemapDialog } from './DrumRemapDialog';

afterEach(cleanup);

function makeDrumScore(): { score: model.Score; trackIndex: number } {
  const built = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
  const score = built.score;
  const trackIndex = score.tracks.findIndex(t => t.isPercussion);
  const beat0 = score.tracks[trackIndex].staves[0].bars[0].voices[0].beats[0];
  beat0.isEmpty = false;
  for (const id of [36, 42]) {
    const note = new model.Note();
    note.percussionArticulation = id;
    beat0.addNote(note);
  }
  return { score, trackIndex };
}

describe('DrumRemapDialog', () => {
  it('lists imported drum pieces, allows per-piece remapping, and submits remapPercussion', async () => {
    const { score, trackIndex } = makeDrumScore();
    const onEdit = vi.fn(), onClose = vi.fn();
    render(<DrumRemapDialog score={score} trackIndex={trackIndex} onEdit={onEdit} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Drum mapping' })).toBeInTheDocument();
    expect(screen.getByText('Kick 2 hit 2', { selector: '.drum-remap-piece-name' })).toBeInTheDocument();
    expect(screen.getByText(/Hi-hat/i, { selector: '.drum-remap-piece-name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    const hiHatSelect = screen.getByLabelText(/Hi-hat.*— Mapped to/i);
    fireEvent.change(hiHatSelect, { target: { value: '46' } });

    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('1 updated (1 notes affected)');

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onEdit).toHaveBeenCalledWith({
      type: 'remapPercussion',
      track: trackIndex,
      map: [[42, 46]],
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('updates only track drumMap when the note-update toggle is off, and remaps notes from the previous mapping when toggled on', async () => {
    const { score, trackIndex } = makeDrumScore();
    // Add a Low Floor Tom (41 -> key 41 in GM; in ezdrummer-3 key 43 -> 41) or High Floor Tom (43: powerkit key 42) to test translation.
    const voice = score.tracks[trackIndex].staves[0].bars[0].voices[0];
    const extra = new model.Note();
    extra.percussionArticulation = 43;
    voice.beats[1].isEmpty = false;
    voice.beats[1].addNote(extra);

    const onEdit = vi.fn(), onClose = vi.fn();
    render(
      <DrumRemapDialog
        score={score}
        trackIndex={trackIndex}
        trackId="base/1"
        mix={{ gain: 1, pan: 0, mute: false, solo: false, drumMap: { preset: 'soundblind-powerkit' } }}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );

    const mapSelect = screen.getByLabelText('MIDI drum map');
    expect(mapSelect).toHaveValue('soundblind-powerkit');
    const toggle = screen.getByLabelText('Update drum notes for the new mapping');
    expect(toggle).not.toBeChecked();

    // Switch to gm with toggle OFF -> only track drumMap changes, notes stay intact.
    fireEvent.change(mapSelect, { target: { value: 'gm' } });
    expect(screen.getByRole('status')).toHaveTextContent('Track drum map will change; drum notes unchanged.');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({
      type: 'setTrackMix',
      trackId: 'base/1',
      mix: { gain: 1, pan: 0, mute: false, solo: false },
    });

    // Now test toggle ON -> emits setTrackMix + remapPercussion translated from soundblind-powerkit -> gm.
    onEdit.mockReset();
    onClose.mockReset();
    cleanup();
    render(
      <DrumRemapDialog
        score={score}
        trackIndex={trackIndex}
        trackId="base/1"
        mix={{ gain: 1, pan: 0, mute: false, solo: false, drumMap: { preset: 'soundblind-powerkit' } }}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText('MIDI drum map'), { target: { value: 'gm' } });
    fireEvent.click(screen.getByLabelText('Update drum notes for the new mapping'));
    expect(screen.getByRole('status')).toHaveTextContent(/Track drum map will change · \d+ updated/);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(onEdit.mock.calls[0][0]).toEqual({
      type: 'setTrackMix',
      trackId: 'base/1',
      mix: { gain: 1, pan: 0, mute: false, solo: false },
    });
    expect(onEdit.mock.calls[1][0]).toMatchObject({
      type: 'remapPercussion',
      track: trackIndex,
    });
    const remapMap = (onEdit.mock.calls[1][0] as { map: [number, number | null][] }).map;
    // In soundblind-powerkit, High Floor Tom (43) outputs key 42 -> under GM, key 42 is Closed Hi-Hat (42).
    expect(remapMap).toContainEqual([43, 42]);

    // Toggling OFF clears the preset note changes while keeping the layout selection.
    cleanup();
    render(
      <DrumRemapDialog
        score={score}
        trackIndex={trackIndex}
        trackId="base/1"
        mix={{ gain: 1, pan: 0, mute: false, solo: false, drumMap: { preset: 'soundblind-powerkit' } }}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Update drum notes for the new mapping'));
    fireEvent.change(screen.getByLabelText('MIDI drum map'), { target: { value: 'gm' } });
    expect(screen.getByRole('status')).toHaveTextContent(/updated/);
    fireEvent.click(screen.getByLabelText('Update drum notes for the new mapping'));
    expect(screen.getByRole('status')).toHaveTextContent('Track drum map will change; drum notes unchanged.');
  });
});
