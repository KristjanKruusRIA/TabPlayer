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
  'src/help/HelpDialog.tsx',
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
  'src/editor/command-palette.ts',
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

/** A template literal, with its `${...}` parts. */
const template = /`((?:[^`\\]|\\.)*)`/g;

export function scanSource(file: string, source: string): Hit[] {
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
    // `Promise<void>(...)` is a generic, not a tag: its `<` follows an identifier character.
    const opening = source.lastIndexOf('<', match.index!);
    if (opening > 0 && /[A-Za-z0-9_]/.test(source[opening - 1])) continue;
    report(match.index!, match[1], 'JSX text');
  }
  // Any quoted capitalised phrase of two or more words, or ending in an ellipsis, that is not an import path.
  for (const match of source.matchAll(quoted)) {
    if (match[1] === '`') continue;
    const text = match[2];
    if (!/^[A-Z][a-z]+(?:[ ,.'’:&/-]+[A-Za-z0-9…()]+)+[.…]?$|^[A-Z][a-z]+…$/.test(text) || !/[a-z]{2,} [A-Za-z]|…$/.test(text)) continue;
    report(match.index!, text, 'string literal');
  }
  // English built in a template literal: `Measure ${n}, occurrence ${m}` reads as `Measure X, occurrence X`.
  for (const match of source.matchAll(template)) {
    const text = match[1].replace(/\$\{[^}]*\}/g, 'X');
    if (!/^[A-Z][a-z]+(?:[ ,.'’:&/-]+[A-Za-z0-9…()]+)+[.…]?$/.test(text) || !/[a-z]{2,} [A-Za-z]|…$/.test(text)) continue;
    report(match.index!, text, 'template literal');
  }
  for (const match of source.matchAll(errorMessage)) {
    // A message built from a variable (`${...}` only) or from a catalog call is fine.
    if (/^\$\{[^}]*\}$/.test(match[2]) || !/[A-Za-z]{3,}/.test(match[2])) continue;
    report(match.index!, match[2], 'Error message');
  }
  return hits;
}

/** Errors only a programmer sees: an impossible state, a failed assertion, a rejected bridge call that the UI replaces with its own text. */
const programmerErrors: ReadonlyArray<[string, RegExp, string]> = [
  ['src/audio/practice.ts', /^Invalid /, 'shape checks of a settings object the panel builds itself; never shown'],
  ['src/audio/practice.ts', /must be|is unavailable/, 'the English source text of PracticeError, which PracticePanel shows through practice.error_<code>'],
];

describe('no hard-coded English in the swept files', () => {
  for (const file of sweepFiles) {
    it(`${file} shows no English text that bypasses t(...)`, () => {
      const hits = scanSource(file, readFileSync(resolve(process.cwd(), file), 'utf8')).filter(hit => !programmerErrors.some(([name, pattern]) => name === hit.file && pattern.test(hit.text)));
      expect(hits.map(hit => `${hit.file}:${hit.line} ${hit.where}: ${hit.text}`)).toEqual([]);
    });
  }

  it('catches a leftover string, so the scan is not vacuous', () => {
    const probe = (text: string) => scanSource('probe.tsx', text).map(hit => `${hit.where}:${hit.text}`);
    expect(probe('<button title="Remove the track">x</button>')).toEqual(['attribute:Remove the track', 'string literal:Remove the track']);
    expect(probe('<p>Nothing to show here.</p>')).toEqual(['JSX text:Nothing to show here.']);
    expect(probe("<span title={dirty?'Unsaved changes':t('x')}/>")).toEqual(['attribute expression:Unsaved changes', 'string literal:Unsaved changes']);
    expect(probe('const name = (bar: number) => `Measure ${bar + 1}, occurrence ${bar}`;')).toEqual(['template literal:Measure X, occurrence X']);
    expect(probe('<b aria-label={`Bar ${n}, position ${r.toFixed(2)}`}/>')).toEqual(['template literal:Bar X, position X']);
    expect(probe('<i className={`backing-waveform-grid ${line.kind}`} id={`${list}-${current.id}`}/>')).toEqual([]);
    expect(probe("<p>{t('x')}</p>")).toEqual([]);
  });
});

/** The English source constants that other code and tests still use must not drift from the catalog. */
describe('English sources match the catalog', () => {
  it('keeps the shared texts equal to their en entries', async () => {
    const { en } = await import('./en');
    const { FINALIZED_MESSAGE, EDIT_LOCKED_MESSAGE } = await import('../project');
    const { TRUNCATED_NOTE, batchKinds } = await import('../batch/convert');
    const { notationPresets } = await import('../engraving/notation-presets');
    expect(en['project.finalized']).toBe(FINALIZED_MESSAGE);
    expect(en['project.edit_locked']).toBe(EDIT_LOCKED_MESSAGE);
    expect(en['batch.truncated_note']).toBe(TRUNCATED_NOTE);
    for (const kind of batchKinds) expect(en[`batch.kind_${kind.id}` as const], kind.id).toBe(kind.label);
    for (const preset of notationPresets) {
      expect(en[preset.nameKey], preset.id).toBe(preset.name);
      expect(en[preset.descriptionKey], preset.id).toBe(preset.description);
    }
  });
});
