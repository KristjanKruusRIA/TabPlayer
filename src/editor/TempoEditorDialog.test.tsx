// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { TempoEditorDialog } from './TempoEditorDialog';

afterEach(cleanup);

function scoreWithBars(count = 4, tempo = 120): model.Score {
  const score = new model.Score();
  for (let i = 0; i < count; i++) score.addMasterBar(new model.MasterBar());
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, tempo, 2)];
  return score;
}

describe('TempoEditorDialog', () => {
  it('opens on the initial bar, adds a progressive point, and submits replaceTempoAutomations on Apply', async () => {
    const onApply = vi.fn(), onClose = vi.fn();
    const score = scoreWithBars(4, 130);
    const { rerender } = render(<TempoEditorDialog score={score} initialBar={1} onApply={onApply} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Tempo editor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Tempo')).toHaveValue(130);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add point' }));
    fireEvent.change(screen.getByLabelText('Tempo'), { target: { value: '155' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Progressive to next point' }));

    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onApply).toHaveBeenCalledWith({
      type: 'replaceTempoAutomations',
      points: [
        { bar: 0, ratio: 0, bpm: 130, linear: false },
        { bar: 1, ratio: 0, bpm: 155, linear: true },
      ],
    });
    expect(onClose).not.toHaveBeenCalled();

    const updatedScore = scoreWithBars(4, 130);
    updatedScore.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(true, 0, 155, 2)];
    rerender(<TempoEditorDialog score={updatedScore} initialBar={1} onApply={onApply} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove automations' }));
    expect(screen.getByRole('button', { name: 'Remove automations' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onApply).toHaveBeenLastCalledWith({
      type: 'replaceTempoAutomations',
      points: [{ bar: 0, ratio: 0, bpm: 130, linear: false }],
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('refuses invalid out-of-range BPM and keeps OK/Apply disabled', () => {
    render(<TempoEditorDialog score={scoreWithBars(2, 120)} initialBar={0} onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Tempo'), { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/1 and 999/);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
  });
});
