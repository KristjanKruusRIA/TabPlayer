// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DiTranscriber, TranscribedDiNote } from '../audio/di-transcribe';
import type { EditCommand } from '../edit-types';
import { buildDocument } from '../engine';
import type { ImportTracksCommand } from '../interchange/import-tracks';
import { loadInterchangeScore } from '../interchange/gp';
import { DiImportDialog } from './DiImportDialog';
import { Settings } from '@coderline/alphatab';

afterEach(cleanup);

const makeSampleNotes = (): TranscribedDiNote[] => [
  {
    startSec: 0.2,
    endSec: 0.4,
    pitch: 36,
    onsetConfidence: 0.9,
    frameConfidence: 0.85,
    velocity: 100,
    palmMuteScore: 0.85,
    bendSemitones: 0,
  },
  {
    startSec: 0.62857,
    endSec: 0.82,
    pitch: 43,
    onsetConfidence: 0.82,
    frameConfidence: 0.80,
    velocity: 95,
    palmMuteScore: 0.78,
    bendSemitones: 0,
  },
  {
    startSec: 1.057,
    endSec: 1.48,
    pitch: 48,
    onsetConfidence: 0.88,
    frameConfidence: 0.84,
    velocity: 102,
    palmMuteScore: 0.10,
    bendSemitones: 0,
  },
];

const makeTranscriber = (notes: TranscribedDiNote[] = makeSampleNotes()): DiTranscriber & {
  pickAndAnalyze: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} => ({
  pickAndAnalyze: vi.fn(async () => ({
    analysisId: 'di-1',
    fileName: 'chugs.wav',
    durationSec: 4.5,
    sampleRate: 48_000,
    channels: 1,
    estimatedBpm: 140,
    estimatedOffsetSec: 0.2,
  })),
  decode: vi.fn(async () => notes),
  clear: vi.fn(async () => {}),
});

const status = () => screen.getByRole('status');

const scoreFixture = () => {
  const project = {
    format: 'TabPlayer' as const,
    schemaVersion: 3 as const,
    engineVersion: '1.8.4' as const,
    base: {
      kind: 'blank' as const,
      title: 'Existing Song',
      artist: '',
      tempo: 140,
      tuning: [62, 57, 53, 48, 43, 36], // Drop C
      measureCount: 4,
    },
    assets: {},
    baselineEdits: [],
    edits: [{ type: 'addPercussionTrack', name: 'Drumkit', program: 0 }] as EditCommand[],
  };
  return buildDocument(project);
};

describe('DiImportDialog', () => {
  it('analyzes DI audio offline, re-decodes on sensitivity/tuning changes, exports GP, and clears cache on unmount', async () => {
    const transcriber = makeTranscriber();
    const onImport = vi.fn(async (_name: string, _bytes: Uint8Array) => true);
    const onClose = vi.fn();

    const { unmount } = render(
      <DiImportDialog busy={false} transcriber={transcriber} onImport={onImport} onClose={onClose} />,
    );

    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(status()).toHaveTextContent('Nothing to import yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio file…' }));
    await waitFor(() => expect(transcriber.decode).toHaveBeenCalledTimes(1));
    expect(screen.getByText('chugs.wav (4.5 s, 48 kHz)')).toBeInTheDocument();
    expect(screen.getByLabelText('Score tempo (BPM)')).toHaveValue(140);
    await waitFor(() =>
      expect(status()).toHaveTextContent('2 notes (1 palm-muted), 1 measure at 140 BPM.'),
    );
    expect(
      screen.getByText('1 detected note exceeded the chosen tuning or fret range and was skipped.'),
    ).toBeInTheDocument();

    // Changing to Drop C triggers decode with C2 (36) minPitch and E4/D4+24 (62+24=86) maxPitch.
    fireEvent.change(screen.getByLabelText('Guitar / bass tuning'), {
      target: { value: 'guitar-6-drop-c' },
    });
    await waitFor(() => expect(transcriber.decode).toHaveBeenCalledTimes(2));
    expect(transcriber.decode).toHaveBeenLastCalledWith('di-1', {
      onsetThreshold: 0.45,
      frameThreshold: 0.28,
      minNoteMs: 55,
      minPitch: 36,
      maxPitch: 86,
      suppressOvertones: true,
    });
    await waitFor(() =>
      expect(status()).toHaveTextContent('3 notes (2 palm-muted), 1 measure at 140 BPM.'),
    );

    // Switch sensitivity to Sensitive.
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Detection sensitivity' })).getByRole('radio', {
        name: 'Sensitive',
      }),
    );
    await waitFor(() => expect(transcriber.decode).toHaveBeenCalledTimes(3));
    expect(transcriber.decode.mock.calls[2][1]).toMatchObject({
      onsetThreshold: 0.35,
      frameThreshold: 0.20,
      minNoteMs: 42,
    });

    // Align first note to bar 1 sets offset to -200 ms.
    fireEvent.click(screen.getByRole('button', { name: 'Align first note to bar 1' }));
    expect(screen.getByLabelText('Audio offset (ms)')).toHaveValue(-200);

    // Submit imports a valid GP file and closes the dialog.
    await waitFor(() => expect(submit).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(submit);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toBe('chugs.gp');
    const score = loadInterchangeScore(onImport.mock.calls[0][1], new Settings());
    expect(score.tracks[0].staves[0].tuning).toEqual([62, 57, 53, 48, 43, 36]);
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(transcriber.clear).toHaveBeenCalledTimes(1);
  });

  it('supports Escape closing fine-tune disclosure without closing dialog and Destination Replace track workflow', async () => {
    const built = scoreFixture();
    const transcriber = makeTranscriber();
    const onImportIntoScore = vi.fn(async (_cmd: ImportTracksCommand) => true);
    const onClose = vi.fn();

    render(
      <DiImportDialog
        busy={false}
        currentScore={built.score}
        selectedTrack={1} // Drumkit selected initially
        transcriber={transcriber}
        onImport={async () => true}
        onImportIntoScore={onImportIntoScore}
        onClose={onClose}
      />,
    );

    const fineTune = document.querySelector<HTMLDetailsElement>('details.di-finetune')!;
    const summary = fineTune.querySelector('summary')!;
    fineTune.open = true;
    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(fineTune.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio file…' }));
    await waitFor(() => expect(status()).toHaveTextContent('2 notes (1 palm-muted)'));

    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Destination' })).getByRole('radio', {
        name: 'Replace track',
      }),
    );

    // Smart default switches away from percussion Drumkit (1) to Guitar (0) and locks to target Drop C tuning.
    const trackSelect = screen.getByLabelText('Target track');
    expect(trackSelect).toHaveValue('0');
    expect(screen.getByLabelText('Guitar / bass tuning')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/Target track tuning:.*\(6 strings\)/)).toBeInTheDocument();
    await waitFor(() => expect(status()).toHaveTextContent('3 notes (2 palm-muted)'));

    // Selecting Drumkit refuses replace and disables Import.
    fireEvent.change(trackSelect, { target: { value: '1' } });
    expect(status()).toHaveTextContent('Choose a pitched guitar or bass target track');
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit).toHaveAttribute('aria-disabled', 'true');

    // Selecting Track 0 allows Replace track submission with targetTrack: 0.
    fireEvent.change(trackSelect, { target: { value: '0' } });
    await waitFor(() => expect(submit).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(submit);
    await waitFor(() => expect(onImportIntoScore).toHaveBeenCalledTimes(1));
    expect(onImportIntoScore.mock.calls[0][0]).toMatchObject({
      type: 'importTracks',
      targetTrack: 0,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces translated backend analysis errors safely', async () => {
    const transcriber = makeTranscriber();
    transcriber.pickAndAnalyze.mockRejectedValueOnce(new Error('decode_failed: invalid WAV chunk'));

    render(
      <DiImportDialog
        busy={false}
        transcriber={transcriber}
        onImport={async () => true}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio file…' }));
    await waitFor(() =>
      expect(status()).toHaveTextContent('The audio file could not be decoded: invalid WAV chunk'),
    );
  });
});
