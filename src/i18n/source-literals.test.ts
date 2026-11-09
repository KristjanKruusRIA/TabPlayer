import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source scan for hard-coded English in every file the i18n sweeps cover (docs/validation/2026-11-08-i18n-sweep-3.md,
 * plus App.tsx, the batch convert dialog and the leftovers of sweep 4). Unlike the `fixed` list in surfaces.test.tsx,
 * which only notices an old string returning, this fails on any NEW English text a person can see or hear in these files:
 * JSX text, `title`, `aria-label`, `placeholder`, `label`, `alt` attributes, ternaries inside those attributes, and
 * the message of a thrown or stored `Error`. User-visible words must come from `t(...)`.
 *
 * Add a file here when a sweep converts it. Allow-list an entry only with a reason: file formats, key names printed on
 * keycaps, product and unit names, and errors a programmer sees but a person never does.
 */
export const sweepFiles = [
  'src/App.tsx',
  'src/Transport.tsx',
  'src/audio/BackingPanel.tsx',
  'src/audio/BackingProcessingControls.tsx',
  'src/audio/BackingWaveform.tsx',
  'src/audio/CabinetNotices.tsx',
  'src/audio/CabinetResponse.tsx',
  'src/audio/InterpretationPanel.tsx',
  'src/audio/PracticePanel.tsx',
  'src/audio/SelectionPlaybackControls.tsx',
  'src/audio/cabinet-ir.ts',
  'src/audio/practice.ts',
  'src/batch/BatchConvertDialog.tsx',
  'src/editor/BarGesturePanel.tsx',
  'src/editor/CommandPalette.tsx',
  'src/editor/SectionsPanel.tsx',
  'src/engraving/BarWidthsPanel.tsx',
  'src/engraving/EngravingPanel.tsx',
  'src/engraving/StylePresetsPanel.tsx',
  'src/engraving/TrackDisplayControls.tsx',
  'src/protection/PasswordDialogs.tsx',
  'src/workspace/AsciiTabImportDialog.tsx',
  'src/workspace/DocumentTabs.tsx',
  'src/workspace/MidiImportDialog.tsx',
  'src/workspace/ViewDefaultsPanel.tsx',
] as const;

/** Text that is allowed to stay as written, each with its reason. Matched against the whole literal. */
const allowed: ReadonlyArray<[RegExp, string]> = [
  [/^TabPlayer$/, 'the product name'],
  [/^Not converted$/, 'a BatchStatus data value, shown through batch.status_* keys'],
  [/^(?:Promise|Record|Array|Set|Map|Partial|Readonly|ReadonlyArray)$/, 'a TypeScript generic that the JSX-text pattern mistakes for text'],
  [/^(?:Ctrl|Cmd|Shift|Alt|Backspace|Home|End|Delete|Insert|Tab|N|[A-Z0-9])(?:[\s/+,]|Ctrl|Cmd|Shift|Alt|Home|End|Delete|Insert|Backspace|Tab|[A-Z0-9]|Left|Right|Up|Down|\/)*$/, 'key chords made of key names and modifiers, as printed on keycaps'],
];

interface Hit { file: string; line: number; text: string; where: string }

const attribute = /\b(?:title|aria-label|aria-description|aria-valuetext|placeholder|label|alt)=(?:"([^"{}]*)"|\{([^}]*)\})/g;
const jsxText = />\s*([A-Z][A-Za-z]*(?:[ ,.'’:&/+-]+[A-Za-z0-9…()]+)*[.…:]?)\s*</g;
const errorMessage = /\bnew Error\(\s*(['"`])((?:(?!\1).)*)\1/g;
const quoted = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
/** An English sentence or phrase: a capital letter then lower-case words, as opposed to an id, a CSS class or a key. */
const phrase = /^[A-Z][a-z]+(?:[ ,.'’:&/-]+[A-Za-z0-9…()]+)+[.…]?$|^[A-Z][a-z]{3,}[.…]?$/;

function scan(file: string): Hit[] {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const lines = source.split('\n');
  const hits: Hit[] = [];
  const at = (index: number) => source.slice(0, index).split('\n').length;
  const report = (index: number, text: string, where: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || allowed.some(([pattern]) => pattern.test(clean))) return;
    hits.push({ file, line: at(index), text: clean, where });
  };
  for (const match of source.matchAll(attribute)) {
    if (match[1] !== undefined) { if (/[A-Za-z]{2,}/.test(match[1])) report(match.index!, match[1], 'attribute'); continue; }
    // A ternary or template inside an attribute: look at its string literals.
    for (const text of match[2].matchAll(quoted)) if (phrase.test(text[2])) report(match.index!, text[2], 'attribute expression');
  }
  for (const match of source.matchAll(jsxText)) {
    const before = source.slice(Math.max(0, match.index! - 1), match.index!);
    if (/[A-Za-z0-9_)\]]$/.test(before) && /<[A-Za-z]+(?:\s[^<>]*)?$/.test(source.slice(Math.max(0, match.index! - 120), match.index! + 1)) === false) continue;
    report(match.index!, match[1], 'JSX text');
  }
  // Any quoted capitalised phrase of two or more words, or ending in an ellipsis, that is not an import path.
  for (const match of source.matchAll(quoted)) {
    const text = match[2];
    if (!/^[A-Z][a-z]+(?:[ ,.'’:&/-]+[A-Za-z0-9…()]+)+[.…]?$|^[A-Z][a-z]+…$/.test(text) || !/[a-z]{2,} [A-Za-z]|…$/.test(text)) continue;
    report(match.index!, text, 'string literal');
  }
  for (const match of source.matchAll(errorMessage)) {
    // A message built from a variable (`${...}` only) or from a catalog call is fine.
    if (/^\$\{[^}]*\}$/.test(match[2]) || !/[A-Za-z]{3,}/.test(match[2])) continue;
    report(match.index!, match[2], 'Error message');
  }
  void lines;
  return hits;
}

/** Errors only a programmer sees: an impossible state, a failed assertion, a rejected bridge call that the UI replaces with its own text. */
const programmerErrors: ReadonlyArray<[string, RegExp, string]> = [
  ['src/audio/practice.ts', /./, 'validators of a settings object the panel already constrains; the messages reach only a log or a test, never a control'],
];

describe('no hard-coded English in the swept files', () => {
  for (const file of sweepFiles) {
    it(`${file} shows no English text that bypasses t(...)`, () => {
      const hits = scan(file).filter(hit => !programmerErrors.some(([name, pattern]) => name === hit.file && pattern.test(hit.text)));
      expect(hits.map(hit => `${hit.file}:${hit.line} ${hit.where}: ${hit.text}`)).toEqual([]);
    });
  }

  it('catches a leftover string, so the scan is not vacuous', () => {
    const probe = (text: string) => {
      const found: string[] = [];
      for (const [pattern, where] of [[attribute, 'attribute'], [jsxText, 'JSX text']] as const) {
        for (const match of text.matchAll(pattern)) found.push(`${where}:${match[1] ?? match[2]}`);
      }
      return found;
    };
    expect(probe('<button title="Remove the track">x</button>')).toEqual(['attribute:Remove the track']);
    expect(probe('<p>Nothing to show here.</p>')).toEqual(['JSX text:Nothing to show here.']);
    expect(probe("<span title={dirty?'Unsaved changes':t('x')}/>")).toEqual(["attribute:dirty?'Unsaved changes':t('x')"]);
    expect(probe("<p>{t('x')}</p>")).toEqual([]);
  });
});
