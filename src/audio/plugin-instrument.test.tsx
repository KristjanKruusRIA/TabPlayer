// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PluginSlot, TrackSound } from '../edit-types';
import { PluginSlotPanel } from './PluginSlotPanel';
import { PluginNotices } from './PluginNotices';
import { SoundPanel } from './SoundPanel';
import { PluginPanel } from './PluginPanel';
import { SoundRig } from '../rig/SoundRig';
import { localizePluginError, noticeMessageKey, statusLabelKey, type PluginLibraryEntry, type PluginStatus } from './plugin-host';
import { soundPreset } from './sound-model';
import { forgetSessionSoundLibrary, forgetSoundClipboard } from './sound-library';
import { getMessage, setLanguagePreference } from '../i18n';

const mockCalls: Array<[string, any]> = [];
let library: PluginLibraryEntry[] = [];
let chosen: Record<string, PluginSlot> = {};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: any) => {
    mockCalls.push([command, args]);
    if (command === 'plugin_library_list') return library;
    if (command === 'plugin_status') return [];
    if (command === 'plugin_choose') return { slot: chosen[args.classId], assetToken: 'token' };
    return [];
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const effectEntry: PluginLibraryEntry = {
  classId: 'A'.repeat(32), name: 'Super Amp', vendor: 'Audio Corp', version: '1', bundle: 'C:\\P\\Amp.vst3', moduleLen: 1, moduleModified: 2,
};
const instrumentEntry: PluginLibraryEntry = {
  classId: 'B'.repeat(32), name: 'Big Drums', vendor: 'Kit Co', version: '1', bundle: 'C:\\P\\Drums.vst3', moduleLen: 1, moduleModified: 2, kind: 'instrument',
};
const effectSlot: PluginSlot = {
  format: 'vst3', classId: effectEntry.classId, name: 'Super Amp', vendor: 'Audio Corp', active: true, inputDb: 0, outputDb: 0, state: 's'.repeat(64),
};
const instrumentSlot: PluginSlot = { ...effectSlot, classId: instrumentEntry.classId, name: 'Big Drums', vendor: 'Kit Co', kind: 'instrument' };

beforeEach(() => {
  mockCalls.length = 0;
  library = [effectEntry, instrumentEntry];
  chosen = { [effectEntry.classId]: effectSlot, [instrumentEntry.classId]: instrumentSlot };
  forgetSoundClipboard();
  setLanguagePreference('en');
});
afterEach(() => { cleanup(); forgetSessionSoundLibrary(); forgetSoundClipboard(); localStorage.clear(); });

const optionNames = (select: HTMLElement) => Array.from(select.querySelectorAll('option')).map(option => option.textContent);

describe('the plug-in select', () => {
  it('shows an instruments group and an effects group on a drum track', async () => {
    render(<PluginSlotPanel trackId="drums" percussion onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    const select = screen.getByLabelText('VST3 plug-in');
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map(group => group.label)).toEqual(['Instruments', 'Effects']);
    expect(optionNames(groups[0])).toEqual(['Big Drums (Kit Co)']);
    expect(optionNames(groups[1])).toEqual(['Super Amp (Audio Corp)']);
  });

  it('lists effects only on any other track', async () => {
    render(<PluginSlotPanel trackId="guitar" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Super Amp/ })).toBeInTheDocument());
    const select = screen.getByLabelText('VST3 plug-in');
    expect(select.querySelectorAll('optgroup')).toHaveLength(0);
    expect(optionNames(select)).toEqual(['Built-in tone', 'Super Amp (Audio Corp)']);
  });

  it('choosing an instrument writes one slot with its kind and tells the native side it is a drum track', async () => {
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="drums" documentId="doc" percussion onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('VST3 plug-in'), { target: { value: instrumentEntry.classId } });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(instrumentSlot, 'token');
    expect(mockCalls.find(([command]) => command === 'plugin_choose')![1]).toEqual({
      documentId: 'doc', trackId: 'drums', classId: instrumentEntry.classId, percussion: true,
    });
  });

  it('choosing the current instrument records nothing', async () => {
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="drums" percussion slot={instrumentSlot} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('VST3 plug-in'), { target: { value: instrumentSlot.classId } });
    expect(onChange).not.toHaveBeenCalled();
    expect(mockCalls.some(([command]) => command === 'plugin_choose')).toBe(false);
  });

  it('a busy select keeps focus, is not disabled and refuses the keys that would change it', async () => {
    const { rerender } = render(<PluginSlotPanel trackId="drums" percussion slot={instrumentSlot} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    const select = screen.getByLabelText('VST3 plug-in');
    select.focus();
    rerender(<PluginSlotPanel trackId="drums" percussion slot={instrumentSlot} onChange={vi.fn()} busy />);
    expect(document.activeElement).toBe(select);
    expect(select).not.toBeDisabled();
    expect(select).toHaveAttribute('aria-disabled', 'true');
    expect(fireEvent.keyDown(select, { key: 'ArrowDown' })).toBe(false);
  });
});

describe('the trims of an instrument slot', () => {
  it('hides the input trim, shows the output trim, and keeps the stored input trim through an output edit', async () => {
    const stored = { ...instrumentSlot, inputDb: 3 };
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="drums" percussion slot={stored} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    expect(screen.queryByLabelText('Input trim')).toBeNull();
    const output = screen.getByLabelText('Output trim');
    fireEvent.change(output, { target: { value: '-2' } });
    fireEvent.blur(output);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ ...stored, outputDb: -2 });
    expect(onChange.mock.calls[0][0].inputDb).toBe(3);
  });

  it('still shows both trims for an effect', async () => {
    render(<PluginSlotPanel trackId="drums" percussion slot={effectSlot} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Super Amp/ })).toBeInTheDocument());
    expect(screen.getByLabelText('Input trim')).toBeInTheDocument();
    expect(screen.getByLabelText('Output trim')).toBeInTheDocument();
  });

  it('opens the plug-in editor for an instrument as for an effect', async () => {
    render(<PluginSlotPanel trackId="drums" documentId="doc" percussion slot={instrumentSlot} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit plug-in' }));
    await waitFor(() => expect(mockCalls.some(([command]) => command === 'plugin_editor_open')).toBe(true));
  });
});

describe('the library list', () => {
  it('labels each entry as an instrument or an effect', async () => {
    render(<PluginSlotPanel trackId="drums" percussion onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('effect')).toBeInTheDocument();
    expect(within(rows[1]).getByText('instrument')).toBeInTheDocument();
  });

  it('says a refused bundle holds no effect or instrument, in each language', () => {
    for (const language of ['en', 'et', 'de'] as const) {
      const t = (key: any, params?: any) => getMessage(language, key, params);
      expect(localizePluginError('This file holds no effect or instrument.', t)).toBe(getMessage(language, 'plugin.error.no_effects'));
      expect(localizePluginError('An instrument plug-in can only be used on a drum track.', t)).toBe(
        getMessage(language, 'plugin.error.instrument_needs_drums'),
      );
    }
    expect(getMessage('en', 'plugin.error.no_effects')).toBe('This file holds no effect or instrument.');
  });
});

const statuses: PluginStatus[] = [
  'needsConsent', 'missing', 'unreadable', 'unsupportedFormat', 'unsupportedPlatform', 'unsupportedLayout', 'tooMuchLatency', 'tooMany',
  'crashed', 'hung', 'underrun', 'nonFinite', 'rejectedState', 'stateTooLarge', 'hostMissing',
];

describe('the status notices of an instrument slot', () => {
  it('end by saying the built-in kit plays, for every status and every language', () => {
    for (const language of ['en', 'et', 'de'] as const) {
      for (const status of statuses) {
        const effect = getMessage(language, noticeMessageKey(status), { name: 'X' });
        const instrument = getMessage(language, noticeMessageKey(status, true), { name: 'X' });
        expect(instrument).not.toBe(effect);
        expect(instrument).toContain('X');
        expect(instrument).not.toMatch(/built-in tone|sisseehitatud toon|integrierte Ton/);
      }
    }
    expect(getMessage('en', noticeMessageKey('missing', true), { name: 'Big Drums' })).toBe(
      'The plug-in "Big Drums" is not installed on this computer, so the built-in kit plays instead. The document is unchanged.',
    );
  });

  it('says an instrument on a track that is not a drum track plays only its own sound, in every language', () => {
    const wanted = {
      en: `The plug-in "X" is an instrument and can only play a drum track, so this track's own sound plays instead. The document is unchanged.`,
      et: 'Plugin "X" on instrument ja saab mängida ainult trummirada, seega kõlab selle rea enda heli. Dokumenti ei muudeta.',
      de: 'Das Plugin „X“ ist ein Instrument und kann nur eine Schlagzeugspur spielen, daher wird stattdessen der eigene Klang dieser Spur wiedergegeben. Das Dokument bleibt unverändert.',
    } as const;
    for (const language of ['en', 'et', 'de'] as const) {
      for (const instrument of [true, false]) {
        expect(getMessage(language, noticeMessageKey('instrumentNeedsDrums', instrument), { name: 'X' })).toBe(wanted[language]);
      }
      expect(getMessage(language, statusLabelKey('instrumentNeedsDrums'))).not.toBe(getMessage(language, statusLabelKey('unreadable')));
    }
    expect(getMessage('en', statusLabelKey('instrumentNeedsDrums'))).toBe('Needs a drum track');
  });

  it('shows the kit text in the slot panel for an instrument and the tone text for an effect', async () => {
    const { rerender } = render(<PluginSlotPanel trackId="drums" percussion slot={instrumentSlot} status="crashed" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    expect(screen.getByText(/crashed, so the built-in kit plays instead/)).toBeInTheDocument();
    rerender(<PluginSlotPanel trackId="drums" percussion slot={effectSlot} status="crashed" onChange={vi.fn()} />);
    expect(screen.getByText(/crashed, so the built-in tone plays instead/)).toBeInTheDocument();
  });

  it('shows the kit text in the document notices for the tracks whose slot is an instrument', () => {
    render(
      <PluginNotices
        statuses={[
          { trackId: 'd', classId: instrumentSlot.classId, name: 'Big Drums', vendor: '', status: 'missing' },
          { trackId: 'g', classId: effectSlot.classId, name: 'Super Amp', vendor: '', status: 'missing' },
        ]}
        trackNames={{ d: 'Drums', g: 'Guitar' }}
        instrumentTracks={['d']}
      />,
    );
    expect(screen.getByText(/Drums: .*"Big Drums" is not installed.*built-in kit plays instead/)).toBeInTheDocument();
    expect(screen.getByText(/Guitar: .*"Super Amp" is not installed.*built-in tone plays instead/)).toBeInTheDocument();
  });
});

describe('the banners and the kit note', () => {
  const drums = (plugin: PluginSlot): TrackSound => ({ ...soundPreset('lead'), plugin });
  const rig = (sound: TrackSound) =>
    render(<SoundRig trackId="drums" sound={sound} tracks={[{ id: 'drums', name: 'Drums', program: 0, percussion: true }]} onTrack={() => {}} onEdit={() => {}} />);

  it('says an effect replaces Drive, Amp and Cabinet, and an instrument plays the track with the kit as the stand-in', () => {
    rig(drums(effectSlot));
    expect(screen.getByText('Drive, Amp and Cabinet are replaced by the plug-in.')).toBeInTheDocument();
    expect(screen.queryByText(/The built-in kit plays when the plug-in is unavailable/)).toBeNull();
    cleanup();
    rig(drums(instrumentSlot));
    expect(screen.queryByText(/replaced by the plug-in/)).toBeNull();
    expect(document.querySelector('.rig-chain-item[data-replaced]')).toBeNull();
    expect(screen.getByText('This plug-in plays this track. The built-in kit plays when the plug-in is unavailable.')).toBeInTheDocument();
  });

  it('marks no pedal Replaced in the sound panel for an instrument', () => {
    render(<SoundPanel trackId="drums" sound={drums(instrumentSlot)} onEdit={vi.fn()} percussion />);
    expect(Array.from(document.querySelectorAll('.sound-block>summary')).some(summary => /Replaced/.test(summary.textContent ?? ''))).toBe(false);
    cleanup();
    render(<SoundPanel trackId="drums" sound={drums(effectSlot)} onEdit={vi.fn()} percussion />);
    expect(Array.from(document.querySelectorAll('.sound-block>summary')).some(summary => /Replaced/.test(summary.textContent ?? ''))).toBe(true);
  });

  it('puts the kit note in the drum kit picker only when the slot is an instrument', () => {
    const note = 'The kit and its mix apply to the built-in kit, which plays only when the plug-in is unavailable.';
    render(<SoundPanel trackId="drums" sound={drums(effectSlot)} onEdit={vi.fn()} percussion />);
    expect(screen.queryByText(note)).toBeNull();
    cleanup();
    render(<SoundPanel trackId="drums" sound={drums(instrumentSlot)} onEdit={vi.fn()} percussion />);
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('offers instruments in the Plug-in dialog of a drum track only', async () => {
    render(<PluginPanel trackId="drums" sound={soundPreset('lead')} onEdit={vi.fn()} percussion />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Drums/ })).toBeInTheDocument());
    cleanup();
    render(<PluginPanel trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /Super Amp/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Big Drums/ })).toBeNull();
  });
});
