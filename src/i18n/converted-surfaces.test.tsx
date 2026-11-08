// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { InterpretationPanel } from '../audio/InterpretationPanel';
import { CabinetResponse } from '../audio/CabinetResponse';
import { SelectionPlaybackControls } from '../audio/SelectionPlaybackControls';
import { OpenPasswordDialog, ProtectionDialog, UnlockEditingDialog } from '../protection/PasswordDialogs';
import { ViewDefaultsPanel } from '../workspace/ViewDefaultsPanel';
import { standardViewDefaults } from '../workspace/view-defaults';
import { MidiImportDialog } from '../workspace/MidiImportDialog';
import { AsciiTabImportDialog } from '../workspace/AsciiTabImportDialog';
import { DocumentTabs } from '../workspace/DocumentTabs';
import { BarWidthsPanel } from '../engraving/BarWidthsPanel';
import { withBarScale } from '../engraving/bar-widths';
import { defaultEngraving } from '../engraving/projection';
import { setLanguagePreference, type SupportedLanguage } from './index';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));

afterEach(() => { cleanup(); setLanguagePreference('en'); localStorage.clear(); });
beforeEach(() => { localStorage.clear(); setLanguagePreference('en'); });

/**
 * Guard for components whose English was moved into the catalogs. It fails when a NEW hard-coded English string
 * appears, which the `fixed` denylist in surfaces.test.tsx cannot: every piece of visible or announced text a surface
 * renders in English must differ when the language is Estonian or German, unless it is listed below.
 */

/** Text that is legitimately the same as the English: file text from the test, and real cognates. Keep this short; each entry needs a reason. */
const allowed: Record<'all' | SupportedLanguage, ReadonlySet<string>> = {
  all: new Set(['Moonlight.tabplayer', 'Untitled']),   // a file name and a tab title the test supplies: user data, not UI text
  en: new Set(),
  et: new Set(['ASCII tab']),                      // the Estonian catalog keeps this format name as it is
  de: new Set(['Interpretation', 'Normal']),      // the German words are spelled the same
};
/** Strings with no letters (numbers, symbols, units alone) cannot be English or Estonian. */
const hasWords = (text: string) => /\p{L}{2,}/u.test(text.replace(/\b(?:BPM|MIDI|dB|Hz|ms|WAV|%)\b/g, ''));

/** Every label, title and text a person or a screen reader is offered, one entry per leaf of text. */
function texts(root: HTMLElement): Set<string> {
  const found = new Set<string>();
  const add = (text: string | null | undefined) => { const value = (text ?? '').replace(/\s+/g, ' ').trim(); if (value) found.add(value); };
  root.querySelectorAll('details').forEach(details => { details.open = true; });
  root.querySelectorAll('*').forEach(element => {
    for (const attr of ['aria-label', 'title', 'placeholder']) add(element.getAttribute(attr));
    for (const node of Array.from(element.childNodes)) if (node.nodeType === Node.TEXT_NODE) add(node.textContent);
  });
  return found;
}

const noop = () => {};
const tab = (id: string, title: string, dirty: boolean) => ({ id, title, path: null, dirty });
const protection = { edit: 'none', open: false } as const;
const occurrences = [
  { bar: 0, occurrence: 0, startTick: 0, endTick: 3840, startMs: 0, endMs: 2000, meterNumerator: 4, meterDenominator: 4 },
  { bar: 1, occurrence: 0, startTick: 3840, endTick: 7680, startMs: 2000, endMs: 4000, meterNumerator: 4, meterDenominator: 4 },
];
const choices = { cursor: [{ generation: 1, occurrenceIndex: 0, startTick: 0 }, { generation: 1, occurrenceIndex: 1, startTick: 3840 }],
  passage: [{ generation: 1, startOccurrence: 0, endOccurrence: 1, startTick: 0, endTick: 7680 }, { generation: 1, startOccurrence: 1, endOccurrence: 1, startTick: 3840, endTick: 7680 }] };

const surfaces: Array<{ title: string; mount: () => ReturnType<typeof render> }> = [
  { title: 'InterpretationPanel', mount: () => render(<InterpretationPanel trackId="t" mix={{ gain: .5, pan: 0, mute: false, solo: false }} stringed onEdit={noop} />) },
  { title: 'CabinetResponse', mount: () => render(<CabinetResponse ir={{ id: 'a'.repeat(32), name: 'Mesa', gainDb: 0 } as never} model="british crunch" label={text => text} onChange={noop} />) },
  { title: 'SelectionPlaybackControls', mount: () => render(<SelectionPlaybackControls cursorChoices={choices.cursor} passageChoices={choices.passage} occurrences={occurrences} cursorChoice={null} passageChoice={null} disabled={false}
    onCursorChoice={noop} onPassageChoice={noop} onPlayCursor={noop} onPlaySelection={noop} onLoopSelection={noop} />) },
  { title: 'OpenPasswordDialog', mount: () => render(<OpenPasswordDialog fileName="Moonlight.tabplayer" onTry={async () => {}} onCancel={noop} />) },
  { title: 'UnlockEditingDialog', mount: () => render(<UnlockEditingDialog onTry={async () => {}} onClose={noop} />) },
  { title: 'ProtectionDialog', mount: () => render(<ProtectionDialog protection={protection} dirty={false} onRequest={async () => {}} onClose={noop} />) },
  { title: 'ViewDefaultsPanel', mount: () => render(<ViewDefaultsPanel current={{ zoom: 150, trackView: { kind: 'all' }, scoreDisplay: { layout: 'verticalPage', zoomMode: 'fitWidth' } }} load={() => standardViewDefaults} onSave={() => true} />) },
  { title: 'MidiImportDialog', mount: () => render(<MidiImportDialog busy={false} onImport={async () => true} onClose={noop} />) },
  { title: 'AsciiTabImportDialog', mount: () => render(<AsciiTabImportDialog busy={false} onImport={async () => true} onClose={noop} />) },
  { title: 'DocumentTabs', mount: () => render(<DocumentTabs tabs={[tab('a', 'Untitled', true), tab('b', 'Untitled', false)]} activeId="a" disabled={false} onActivate={noop} onClose={noop} />) },
  { title: 'BarWidthsPanel', mount: () => render(<BarWidthsPanel value={withBarScale(defaultEngraving(), 1, 1.5)} design={false} onDesign={noop} busy={false} honoured onEdit={noop} />) },
];

describe('converted surfaces show no unchanged English', () => {
  for (const surface of surfaces) {
    describe(surface.title, () => {
      it('renders English text in English mode, so the checks below are not vacuous', () => {
        expect([...texts(surface.mount().baseElement)].filter(hasWords).length).toBeGreaterThan(2);
      });
      for (const lang of ['et', 'de'] as const satisfies readonly SupportedLanguage[]) {
        it(`renders every English text differently in ${lang}`, () => {
          const english = texts(surface.mount().baseElement); cleanup();
          setLanguagePreference(lang);
          const local = texts(surface.mount().baseElement);
          const unchanged = [...english].filter(text => hasWords(text) && !allowed.all.has(text) && !allowed[lang].has(text) && local.has(text));
          expect(unchanged, `${lang} ${surface.title} still renders English text`).toEqual([]);
        });
      }
    });
  }
});
