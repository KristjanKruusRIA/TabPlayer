// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import { TrackSettingsPanel } from './TrackSettingsPanel';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })) }));
afterEach(cleanup);

// A percussion track's program is always 0 (alphaTab resets it), so a 128-entry list could only mislead; the kit is chosen in the Sound task.
it('a drum track has no MIDI instrument list, and a pitched track keeps its 128', () => {
  const score = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 }).score;
  const drums = score.tracks.findIndex(track => track.isPercussion);
  const view = render(<TrackSettingsPanel score={score} selected={drums} busy={false} onEdit={vi.fn()} />);
  expect(screen.queryByLabelText('Track MIDI instrument')).toBeNull();
  view.rerender(<TrackSettingsPanel score={score} selected={score.tracks.findIndex(track => !track.isPercussion)} busy={false} onEdit={vi.fn()} />);
  expect(screen.getByLabelText('Track MIDI instrument').querySelectorAll('option')).toHaveLength(128);
});
