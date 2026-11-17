// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { ExportDialog } from '../export/ExportDialog';
import { PageLayoutPanel } from '../engraving/PageLayoutPanel';
import { defaultEngraving,validateEngravingTracks } from '../engraving/projection';
import { FILE_NAME_TOKENS } from '../export/file-name';
import { catalogs, setLanguagePreference, type SupportedLanguage } from './index';
import { en } from './en';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
afterEach(() => { cleanup(); setLanguagePreference('en'); localStorage.clear(); });
beforeEach(() => { localStorage.clear(); setLanguagePreference('en'); });

function fixture() { const score = new model.Score(); for (let i = 0; i < 3; i++) score.addMasterBar(new model.MasterBar()); const track = new model.Track(); track.name = 'Lead'; score.addTrack(track); return score; }
const layout = { paper: 'A4' as const, orientation: 'portrait' as const, marginMm: 15, scale: 1, profile: 'ScoreTab' as const };
const page = { widthMm: 210, heightMm: 297, marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, scale: 1, profile: 'ScoreTab' as const };
const dialog = () => render(<ExportDialog score={fixture()} layout={layout} page={page} busy={false} currentSpeedAvailable={true} layoutLocked onExport={() => {}} onCancel={() => {}} />);
const languages: SupportedLanguage[] = ['et', 'de'];

describe('the Export dialog and the Page layout panel speak the interface language', () => {
  for (const lang of languages) {
    it(`shows ${lang} texts in the Export dialog`, () => {
      setLanguagePreference(lang);
      dialog();
      const c = catalogs[lang];
      expect(screen.getByLabelText(c['export.format'])).toBeInTheDocument();
      expect(screen.getByRole('button', { name: c['export.submit'] })).toBeInTheDocument();
      expect(screen.queryByText('Export format')).toBeNull();
      fireEvent.change(screen.getByLabelText(c['export.format']), { target: { value: 'pdf' } });
      expect(screen.getByText(c['export.layout_finalized_note'])).toBeInTheDocument();
      expect(screen.getByText(c['export.all_measures'])).toBeInTheDocument();
      expect(screen.getByText(/^\S/, { selector: 'summary' }).textContent).toBe(c['page_layout.summary']);
    });
    it(`shows ${lang} texts in the Page layout panel`, () => {
      setLanguagePreference(lang);
      const c = catalogs[lang];
      render(<PageLayoutPanel value={page} busy={false} onEdit={() => {}} />);
      expect(screen.getByText(c['page_layout.summary'])).toBeInTheDocument();
      expect(screen.getByRole('button', { name: c['page_layout.apply'] })).toBeInTheDocument();
      expect(screen.getByText(c['page_layout.swap_orientation'])).toBeInTheDocument();
      expect(screen.queryByText('Apply page layout')).toBeNull();
    });
  }

  it('words a measure-range error in the interface language', () => {
    setLanguagePreference('et');
    dialog();
    fireEvent.click(screen.getByLabelText(catalogs.et['export.measure_range']));
    fireEvent.change(screen.getByLabelText(catalogs.et['export.first_measure']), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.et['export.submit'] }));
    expect(screen.getByRole('alert')).toHaveTextContent(catalogs.et['export.err_range']);
  });

  it('keeps the English texts the same words as before', () => {
    expect(en['export.format']).toBe('Export format');
    expect(en['export.submit']).toBe('Export');
    expect(en['page_layout.summary']).toBe('Page layout');
    expect(en['page_layout.apply']).toBe('Apply page layout');
    expect(en['export.file_tokens']).toBe(`Tokens: ${FILE_NAME_TOKENS}. Track tokens use the first selected track.`);
  });

  it('gives the tablature refusal a catalogue text in the interface language', () => {
    const score = new model.Score(); score.addMasterBar(new model.MasterBar());
    const track = new model.Track(); const staff = new model.Staff(); staff.isPercussion = true; track.addStaff(staff); const second = new model.Staff(); track.addStaff(second);
    score.addTrack(track);
    const overrides = { ...defaultEngraving(), profiles: [{ trackId: 'a', profile: 'tablature' as const }] };
    expect(() => validateEngravingTracks(score, ['a'], overrides)).toThrow(en['engraving.tablature_refused']);
    setLanguagePreference('de');
    expect(() => validateEngravingTracks(score, ['a'], overrides)).toThrow(catalogs.de['engraving.tablature_refused']);
    expect(catalogs.de['engraving.tablature_refused']).not.toBe(en['engraving.tablature_refused']);
  });

  it('has et and de entries for every new key', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('page_layout.') || /^export\.(format|submit|file_|err_|opt_|gp5_|note_|wav_|measure|all_|first_|last_|paper|orient|margin|print_|staves|one_file|transparent|resolution|png_|svg_|musicxml_|ascii_|midi_|preparing|exporting|progress|include_|tail|normal|metronome|cancel|layout_finalized|track_|staff_|tokens|saves_|pages_|speed|bit|sample|file_type|staves_|loss)/.test(key));
    expect(keys.length).toBeGreaterThan(40);
    for (const lang of languages) for (const key of keys) expect(catalogs[lang][key as keyof typeof en], `${lang} ${key}`).toBeTruthy();
  });
});
