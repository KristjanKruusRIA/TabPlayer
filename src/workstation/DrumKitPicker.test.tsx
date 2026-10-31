// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { previewEdit, trackIdentity } from '../engine';
import { defaultEffects } from '../document-settings';
import type { TrackSound } from '../edit-types';
import { blankProject } from '../project';
import { TrackSettingsPanel } from './TrackSettingsPanel';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })) }));
afterEach(cleanup);

function drumScore() {
  const score = previewEdit(blankProject(), { type: 'setRest', target: { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 } }).score;
  score.tracks[0].staves[0].isPercussion = true; score.tracks[0].name = 'Drums';
  return score;
}
const gm = (extra: object = {}): TrackSound => ({ voiceId: null, presetId: 'gm', effects: defaultEffects(), ...extra });
it('a drum track offers only the kits the sound bank carries, and one choice is one setTrackSound edit', () => {
  const score = drumScore(), id = trackIdentity(score.tracks[0]), onEdit = vi.fn(); render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit} />);
  const kit = screen.getByLabelText('Drum kit'); expect(Array.from(kit.querySelectorAll('option')).map(o => o.textContent)).toEqual(['Standard', 'Room', 'Jazz', 'Brush']);
  expect(kit).toHaveValue('0');
  fireEvent.change(kit, { target: { value: '0' } }); expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(kit, { target: { value: '32' } }); expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackSound', trackId: id, sound: { ...gm(), drumKit: 32 } });
  expect(screen.getByText(/same sound, so they differ on the page only/)).toBeInTheDocument();
});
it('choosing Standard clears the stored kit, keeps the rest of the sound, and choosing the stored kit records nothing', () => {
  const score = drumScore(), id = trackIdentity(score.tracks[0]), onEdit = vi.fn(), sound = gm({ drumKit: 8, locked: true });
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit} sound={sound} />);
  const kit = screen.getByLabelText('Drum kit'); expect(kit).toHaveValue('8'); expect(screen.getByText(/Room changes/)).toBeInTheDocument();
  fireEvent.change(kit, { target: { value: '8' } }); expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(kit, { target: { value: '0' } }); expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackSound', trackId: id, sound: gm({ locked: true }) });
  expect('drumKit' in (onEdit.mock.calls[0][0] as { sound: object }).sound).toBe(false);
});
it('the kit select keeps focus while busy and refuses the change', () => {
  const score = drumScore(), onEdit = vi.fn(), view = render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit} />);
  screen.getByLabelText('Drum kit').focus(); view.rerender(<TrackSettingsPanel score={score} selected={0} busy onEdit={onEdit} />);
  const busy = screen.getByLabelText('Drum kit'); expect(busy).not.toBeDisabled(); expect(busy).toHaveAttribute('aria-disabled', 'true'); expect(busy).toHaveFocus();
  fireEvent.change(busy, { target: { value: '40' } }); expect(onEdit).not.toHaveBeenCalled();
});
it('a drum track has no MIDI instrument list, and a pitched track has no drum kit control', () => {
  render(<TrackSettingsPanel score={drumScore()} selected={0} busy={false} onEdit={vi.fn()} />); expect(screen.queryByLabelText('Track MIDI instrument')).toBeNull();
  cleanup();
  const score = previewEdit(blankProject(), { type: 'setRest', target: { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 } }).score;
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={vi.fn()} />); expect(screen.queryByLabelText('Drum kit')).toBeNull(); expect(screen.getByLabelText('Track MIDI instrument')).toBeInTheDocument();
});
