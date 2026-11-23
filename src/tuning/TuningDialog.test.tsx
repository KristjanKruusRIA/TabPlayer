// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { buildDocument } from '../engine';
import { blankProject } from '../project';
import { TuningDialog } from './TuningDialog';

afterEach(cleanup);

it('opens on Bass and the track string count for a custom 5-string Drop F#0 bass track', () => {
  const dropFsharp5 = [40, 35, 30, 25, 18];
  const project = {
    ...blankProject(),
    edits: [
      {
        type: 'addTrack' as const,
        name: 'ShinzBass',
        tuning: dropFsharp5,
        program: 33,
      },
    ],
  };
  const built = buildDocument(project);
  const bassStaff = built.score.tracks[1].staves[0];

  render(
    <TuningDialog
      mode="track"
      pitches={dropFsharp5}
      name=""
      staff={bassStaff}
      defaultInstrument="bass"
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByLabelText('Instrument')).toHaveValue('bass');
  expect(screen.getByLabelText('Number of strings')).toHaveValue('5');
});
