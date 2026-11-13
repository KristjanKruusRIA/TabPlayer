import { describe, expect, it } from 'vitest';
import { en } from './en';
import { et } from './et';
import { de } from './de';
import {
  buildRows, countFlags, csvField, edgeDifference, groupByArea, loadCatalog, parseCsv, placeholders, planApply, rowsToCsv, rowsToMarkdown, COLUMNS,
} from '../../scripts/i18n-review-table.mjs';

const english = en as Record<string, string>;
const catalogs: Record<string, Record<string, string>> = { et, de };

// Placeholder mismatches that exist in the real catalogs today. Empty means there are none; a new one fails the test below.
const KNOWN_PLACEHOLDER_MISMATCHES: Record<string, string[]> = { et: [], de: [] };

describe('translation review table on the real catalogs', () => {
  for (const lang of ['et', 'de']) {
    const rows = buildRows(lang, english, catalogs[lang]);
    it(`${lang}: every English key appears exactly once`, () => {
      expect(rows.map((r) => r.key)).toEqual(Object.keys(english));
      expect(new Set(rows.map((r) => r.key)).size).toBe(Object.keys(english).length);
      expect([...groupByArea(rows).values()].reduce((n, g) => n + g.length, 0)).toBe(rows.length);
      const csv = parseCsv(rowsToCsv(rows));
      expect(csv[0]).toEqual(COLUMNS);
      expect(csv.length - 1).toBe(Object.keys(english).length);
      expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(Object.keys(english).length);
      expect(rowsToMarkdown(lang, rows)).toContain('Nothing here has been reviewed');
    });
    it(`${lang}: placeholder mismatches are only the known ones`, () => {
      const found = rows.filter((r) => r.flags.includes('placeholders')).map((r) => r.key);
      expect(found).toEqual(KNOWN_PLACEHOLDER_MISMATCHES[lang]);
    });
    it(`${lang}: nothing is missing or empty`, () => {
      expect(countFlags(rows).missing).toBe(0);
    });
  }
  it('loads the catalogs the way the command line does', async () => {
    const loaded = await loadCatalog('et');
    expect(Object.keys(loaded.catalog)).toEqual(Object.keys(et));
  });
});

describe('flag logic on small inputs', () => {
  const flagsOf = (e: Record<string, string>, t: Record<string, string>, key = 'a.x') => buildRows('et', e, t, []).find((r) => r.key === key)!.flags;
  it('flags identical text', () => expect(flagsOf({ 'a.x': 'MIDI' }, { 'a.x': 'MIDI' })).toContain('identical'));
  it('flags a missing or blank translation', () => {
    expect(flagsOf({ 'a.x': 'Save' }, {})).toEqual(['missing']);
    expect(flagsOf({ 'a.x': 'Save' }, { 'a.x': '  ' })).toEqual(['missing']);
  });
  it('flags a changed placeholder set', () => {
    expect(placeholders('{b} and {a} and {a}')).toEqual(['a', 'b']);
    expect(flagsOf({ 'a.x': 'Bar {n}' }, { 'a.x': 'Takt {m}' })).toContain('placeholders');
    expect(flagsOf({ 'a.x': 'Bar {n}' }, { 'a.x': 'Takt {n}' })).not.toContain('placeholders');
  });
  it('flags differing whitespace and end punctuation', () => {
    expect(edgeDifference('Open…', 'Ava...')).not.toBe('');
    expect(flagsOf({ 'a.x': 'Open.' }, { 'a.x': 'Ava' })).toContain('edges');
    expect(flagsOf({ 'a.x': 'Open' }, { 'a.x': ' Ava' })).toContain('edges');
    expect(flagsOf({ 'a.x': 'Open.' }, { 'a.x': 'Ava.' })).not.toContain('edges');
  });
  it('flags one English text translated two ways and names the other key', () => {
    const rows = buildRows('et', { 'a.x': 'Tie', 'b.y': 'Tie', 'c.z': 'Tie' }, { 'a.x': 'Side', 'b.y': 'Bogen', 'c.z': 'Side' }, []);
    expect(rows[0].flags).toContain('inconsistent');
    expect(rows[0].details.join(' ')).toContain('b.y');
    expect(rows[0].details.join(' ')).not.toContain('c.z');
    expect(buildRows('et', { 'a.x': 'Tie', 'b.y': 'Tie' }, { 'a.x': 'Side', 'b.y': 'Side' }, []).every((r) => !r.flags.includes('inconsistent'))).toBe(true);
  });
  it('flags terms from the notes by language', () => {
    const terms = [{ id: 't', lang: 'et', side: 'translation' as const, kind: 'forbidden' as const, match: 'bad', note: 'n', source: 's' }];
    expect(buildRows('et', { 'a.x': 'x' }, { 'a.x': 'a BAD word' }, terms)[0].flags).toEqual(['forbidden-term:t']);
    expect(buildRows('de', { 'a.x': 'x' }, { 'a.x': 'a bad word' }, terms)[0].flags).toEqual([]);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and newlines and reads them back', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('l1\nl2')).toBe('"l1\nl2"');
    const rows = buildRows('et', { 'a.x': 'A, "B"\nC' }, { 'a.x': 'Ä, "Ö"\r\nÜ' }, []);
    const text = rowsToCsv(rows);
    expect(text.startsWith('﻿')).toBe(true);
    expect(parseCsv(text)[1].slice(0, 3)).toEqual(['a.x', 'A, "B"\nC', 'Ä, "Ö"\r\nÜ']);
  });
  it('rejects an unterminated quote', () => expect(() => parseCsv('a,"b')).toThrow());
});

describe('--apply planning', () => {
  const e = { 'a.x': 'Bar {n}', 'a.y': 'Save' }, t = { 'a.x': 'Takt {n}', 'a.y': 'Salvesta' };
  const csv = (corrections: Record<string, string>) => parseCsv(rowsToCsv(buildRows('et', e, t, []))).map((row, i) => {
    if (i && corrections[row[0]] !== undefined) row[row.length - 1] = corrections[row[0]];
    return row;
  });
  it('plans a valid correction and writes nothing', () => {
    const plan = planApply('et', csv({ 'a.y': 'Salvesta fail' }), e, t);
    expect(plan.changes).toEqual([{ row: 3, key: 'a.y', line: null, from: 'Salvesta', to: 'Salvesta fail' }]);
  });
  it('refuses a correction that drops a placeholder, and a stale row', () => {
    expect(planApply('et', csv({ 'a.x': 'Takt' }), e, t).refused[0].reason).toContain('placeholders');
    expect(planApply('et', csv({ 'a.y': 'x' }), e, { ...t, 'a.y': 'Muu' }).refused[0].reason).toContain('current translation');
  });
});
