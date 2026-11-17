// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { model } from '@coderline/alphatab';
import './plugin-test-support';
import { catalogs, setLanguagePreference } from '../i18n';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { drumPieces, instrumentHits, percussionInstruments } from '../instruments/drum-kit';
import { DrumMapPanel } from './DrumMapPanel';
import { drumMapFiles, exportedName } from './drum-map-file';
import { brandWords, namesBrand } from './drum-map-brands.test.helper';
import { drumMapPresets } from './drum-map';
import maps from './drum-maps.json';

vi.mock('./drum-map-file', async importOriginal => ({ ...(await importOriginal<object>()), drumMapFiles: { import: vi.fn(), export: vi.fn() } }));

afterEach(() => { cleanup(); setLanguagePreference('en'); vi.mocked(drumMapFiles.export).mockReset(); });

const languages = ['en', 'et', 'de'] as const;
const text = (language: (typeof languages)[number], key: string) => (catalogs[language] as Record<string, string | undefined>)[key];

describe('drum map sound names', () => {
  it('has a name in every language for every sound of the catalogue and of the map', () => {
    const ids = new Set([...standardPercussionCatalog.map(entry => entry.id), ...maps.sounds.map(([id]) => id)]);
    for (const language of languages) {
      const missing = [...ids].filter(id => !text(language, `drum_sound.${id}`));
      expect(missing, language).toEqual([]);
    }
  });

  it('has a name in every language for every piece that owns a sound', () => {
    const blank = new model.Track(), standard = new Set(maps.sounds.map(([id]) => id));
    const owners = [...drumPieces, ...percussionInstruments].filter(item => instrumentHits(blank, item).some(hit => standard.has(hit.id)));
    for (const language of languages) expect(owners.filter(item => !text(language, `drum_piece.${item.id}`)).map(item => item.id), language).toEqual([]);
  });

  it('keeps the English names exactly as the kit gave them', () => {
    const blank = new model.Track();
    for (const item of [...drumPieces, ...percussionInstruments]) {
      const hits = instrumentHits(blank, item).filter(hit => maps.sounds.some(([id]) => id === hit.id));
      if (!hits.length) continue;
      expect(text('en', `drum_piece.${item.id}`)).toBe(item.label);
    }
  });

  it('keeps the English hit names exactly as the kit gives them, for all 94 sounds', () => {
    const blank = new model.Track(), seen = new Map<number, string>();
    for (const item of [...drumPieces, ...percussionInstruments]) for (const hit of instrumentHits(blank, item)) if (!seen.has(hit.id)) seen.set(hit.id, hit.name);
    expect(maps.sounds).toHaveLength(94);
    for (const [id] of maps.sounds) expect(text('en', `drum_sound.${id}`), `sound ${id}`).toBe(seen.get(id) ?? standardPercussionCatalog.find(entry => entry.id === id)?.label);
  });

  it('has the source paragraph of every layout that names no product in every language, English as the data has it, and none for one that does', () => {
    const english = Object.entries(catalogs.en).filter(([key]) => key.startsWith('drum_map.source_text_'));
    let translated = 0;
    for (const preset of drumMapPresets().filter(entry => entry.source && entry.id !== 'gm')) {
      const found = english.find(([, value]) => value === preset.source);
      if (namesBrand(preset.source!).length) { expect(found, preset.id).toBeUndefined(); continue; }
      expect(found, preset.id).toBeDefined();
      translated++;
      for (const language of ['et', 'de'] as const) expect(text(language, found![0]), `${language} ${preset.id}`).toBeTruthy();
    }
    expect(translated).toBeGreaterThan(0);
    expect(english.length).toBe(translated);
  });

  it('names no product, maker or outside source in any catalogue text, in any language', () => {
    expect(brandWords().length).toBeGreaterThan(5);
    for (const language of languages) {
      const found = Object.entries(catalogs[language]).filter(([key, value]) => typeof value === 'string' && key !== 'drum_map.disclaimer' && namesBrand(value).length > 0);
      expect(found.map(([key, value]) => `${key}: ${namesBrand(value as string)}`), language).toEqual([]);
    }
  });

  it('uses the Estonian and German terms the rest of the app already uses for the same instruments', () => {
    const own = (value: string | undefined) => value?.replace(/\s*\([^)]*\)/, '');
    const pairs: [string, string][] = [['kick', 'kick_hit'], ['kick-2', 'kick_hit_2'], ['snare', 'snare_hit'], ['electric-snare', 'electric_snare'], ['hand-clap', 'hand_clap'], ['floor-tom', 'low_floor_tom_hit'], ['high-floor-tom', 'high_floor_tom_hit'], ['high-tom', 'high_tom_hit']];
    for (const language of ['et', 'de'] as const) for (const [piece, percussion] of pairs) expect(text(language, `drum_piece.${piece}`), `${language} ${piece}`).toBe(own(text(language, `percussion.${percussion}`)));
    expect(text('et', 'drum_piece.snare')).toBe('Väike trumm');
    expect(text('et', 'drum_piece.kick')).toBe('Suur trumm');
    expect(text('et', 'drum_piece.floor-tom')).toBe('Madal püsttomm');
    for (const id of ['high-tom', 'hi-mid-tom', 'low-mid-tom', 'low-tom', 'floor-tom', 'high-floor-tom']) expect(text('et', `drum_piece.${id}`), id).toMatch(/tomm$/);
    for (const language of ['et', 'de'] as const) for (const [key, value] of Object.entries(catalogs[language])) if (key.startsWith('drum_piece.') || key.startsWith('drum_sound.')) expect(value, `${language} ${key}`).not.toMatch(/Haruldrum|põrandatom|Bassitrumm|Floortom/);
    expect(text('de', 'drum_piece.cowbell')).toBe('Kuhglocke');
    expect(text('et', 'drum_piece.cowbell')).toBe(text('et', 'practice.metronome_sound.cowbell'));
  });

  it('shows the names and a translatable source paragraph in Estonian and German', () => {
    const cases = [['et', 'Väike trumm', 'Klahvinumbrid'], ['de', 'Snare', 'Tastennummern']] as const;
    for (const [language, snare, source] of cases) {
      setLanguagePreference(language);
      const { container } = render(<DrumMapPanel trackId="base/1" mix={{ gain: 1, pan: 0, mute: false, solo: false, drumMap: { preset: 'ggd-invasion' } }} used={[38, 91, 42]} onEdit={vi.fn()} />);
      const names = [...container.querySelectorAll('.drum-map-sound > span:first-child')].map(node => node.textContent);
      expect(names[0], language).toContain(snare);
      expect(names.join(' '), language).not.toMatch(/rim shot|hit|closed/);
      cleanup();
      const plain = render(<DrumMapPanel trackId="base/1" mix={{ gain: 1, pan: 0, mute: false, solo: false, drumMap: { preset: 'ezdrummer-3' } }} used={[38]} onEdit={vi.fn()} />);
      expect(plain.container.querySelector('.drum-map-source p')?.textContent, language).toContain(source);
      cleanup();
    }
  });

  it('writes no translated name into an exported file or a recorded edit: the same calls under Estonian as under English', async () => {
    const run = async (language: 'en' | 'et') => {
      setLanguagePreference(language);
      vi.mocked(drumMapFiles.export).mockReset().mockResolvedValue(true);
      const onEdit = vi.fn(async (_command: unknown) => undefined);
      const user = userEvent.setup();
      const map = { preset: 'ezdrummer-3', keys: [[91, 41]] as [number, number | null][] };
      const { container } = render(<DrumMapPanel trackId="base/1" mix={{ gain: 1, pan: 0, mute: false, solo: false, drumMap: map }} used={[38, 91, 42]} onEdit={onEdit} />);
      await user.click(screen.getAllByRole('button').find(button => /Export|Ekspordi|Exportieren/.test(button.textContent ?? ''))!);
      await waitFor(() => expect(drumMapFiles.export).toHaveBeenCalledTimes(1));
      const field = container.querySelector('li input') as HTMLInputElement;
      fireEvent.change(field, { target: { value: '45' } });
      fireEvent.blur(field);
      await waitFor(() => expect(onEdit).toHaveBeenCalled());
      const bytes = JSON.stringify([vi.mocked(drumMapFiles.export).mock.calls, onEdit.mock.calls]);
      cleanup();
      return bytes;
    };
    const english = await run('en'), estonian = await run('et');
    expect(english).toContain('"ezdrummer-3"');
    expect(estonian).toBe(english);
    expect(estonian).not.toMatch(/Väike|löök|Haruldrum|Schlag/);
  });

  it('does not put a sound name into the name an export suggests', () => {
    setLanguagePreference('et');
    expect(exportedName('ezdrummer-3', 'Test kit')).toBe('Test kit');
    expect(exportedName('gm', undefined)).toBe('General MIDI');
  });
});
