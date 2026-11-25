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
});
