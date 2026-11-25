// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import './plugin-test-support';
import type { ChannelMix, EditCommand } from '../edit-types';
import { setLanguagePreference } from '../i18n';
import { DrumMapPanel } from './DrumMapPanel';

// The layouts here are the ones the build ships: their names are compatibility labels (owner's decision of 2026-11-17, THE-219), not
// endorsements, and the panel says so.
afterEach(() => { cleanup(); setLanguagePreference('en'); });

const base: ChannelMix = { gain: 1, pan: 0, mute: false, solo: false };
function Harness({ initial = base, used = [38, 91, 42, 46, 56], onEdit }: { initial?: ChannelMix; used?: number[]; onEdit: (edit: EditCommand) => void }) {
  const [mix, setMix] = useState(initial);
  return <DrumMapPanel trackId="base/1" mix={mix} used={used} onEdit={edit => { onEdit(edit); if (edit.type === 'setTrackMix') setMix(edit.mix); }} />;
}
const keyField = (sound: string) => screen.getByLabelText(new RegExp(`^Key for ${sound}( \\(|$)`)) as HTMLInputElement;

describe('the library layouts in the panel', () => {
  it('lists each under the other layouts as not yet checked, in the order the build gives them', () => {
    render(<Harness onEdit={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'Drum map' });
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      'General MIDI (built-in kit keys)',
      'Toontrack EZdrummer 3 — not yet checked',
      'Toontrack Superior Drummer 3 — not yet checked',
      'GetGood Drums Modern & Massive — not yet checked',
      'GetGood Drums Invasion — not yet checked',
      'GetGood Drums One Kit Wonder: Architects — not yet checked',
      'GetGood Drums One Kit Wonder: Brutal (GM) — not yet checked',
    ]);
    expect(select.querySelector('optgroup')).toHaveAttribute('label', 'Other layouts');
  });

  it('chooses one as one edit holding only the layout, and says what its numbers rest on', () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Drum map' }), { target: { value: 'ggd-modern-and-massive' } });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect((onEdit.mock.calls[0][0] as { mix: ChannelMix }).mix.drumMap).toEqual({ preset: 'ggd-modern-and-massive' });
    expect(screen.getByText(/If a sound plays wrong/)).toHaveTextContent('These key numbers come from third-party notes and have not been checked against the library. If a sound plays wrong, change its key under Keys.');
    // What the layout's own data says about its numbers stays one disclosure away.
    expect(screen.getByText(/have not been checked against the library itself\./).closest('details')).toHaveClass('drum-map-source');
    expect(keyField('Snare hit')).toHaveValue('26');
    expect(keyField('Snare rim shot')).toHaveValue('26');
    expect(screen.getByRole('status')).not.toHaveTextContent('changed');
  });

  it('shows a sound the library does not have as no sound, and one with other keys on record as buttons to try', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ ...base, drumMap: { preset: 'ezdrummer-3' } }} onEdit={onEdit} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 sound in this track has no key in this map.');
    const open = screen.getByRole('group', { name: 'Keys to try for Hi-hat open' });
    expect(within(open).getAllByRole('button').map(button => button.textContent)).toEqual(['24', '25', '26']);
    await user.click(within(open).getByRole('button', { name: 'Use key 24 for Hi-hat open' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect((onEdit.mock.calls[0][0] as { mix: ChannelMix }).mix.drumMap).toEqual({ preset: 'ezdrummer-3', keys: [[46, 24]] });
  });

  it('says in the footer that the names only say which layout is followed, in every language', () => {
    for (const [language, text] of [
      ['en', 'Layout names only say which layout a map follows. TabPlayer is not affiliated with these products or their makers.'],
      ['de', 'Die Namen der Belegungen geben nur an, welcher Belegung eine Zuordnung folgt. TabPlayer steht in keiner Verbindung zu diesen Produkten oder ihren Herstellern.'],
      ['et', 'Paigutuste nimed näitavad ainult, millist paigutust kaart järgib. TabPlayer ei ole nende toodete ega nende tootjatega seotud.'],
    ] as const) {
      setLanguagePreference(language);
      render(<Harness onEdit={vi.fn()} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      cleanup();
    }
  });
});
