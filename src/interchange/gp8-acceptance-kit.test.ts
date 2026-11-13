// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildKit, KIT_FAMILIES, writeKitFiles, type KitFile } from './gp8-acceptance-families';
import { checklistText, collectKit, GPIF, main, parseXml, resultsMarkdown, select, type ManifestFamily } from '../../scripts/gp8-acceptance-kit.mjs';

// THE-61: the Guitar Pro 8 acceptance kit. The files come from TabPlayer's exporter; nothing here involves Guitar Pro, and the
// "returned" files below are synthetic. The opt-in writer test (gp8-acceptance-kit-write.test.ts) is skipped unless GP8_KIT_OUT is set.
const gpifOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)[GPIF]);
const varlen = (n: number) => { const out = [n & 127]; for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 127) | 128); return out; };
/** A one-track SMF with a note at each given quarter-note onset, 480 ticks per quarter, tempo 120. */
function smf(onsets: number[], tempoUs = 500000) {
  const body: number[] = [0, 255, 81, 3, (tempoUs >> 16) & 255, (tempoUs >> 8) & 255, tempoUs & 255];
  let last = 0;
  for (const q of onsets) {
    const on = Math.round(q * 480);
    body.push(...varlen(on - last), 0x90, 60, 80, ...varlen(120), 0x80, 60, 0);
    last = on + 120;
  }
  body.push(0, 255, 47, 0);
  const n = body.length;
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0, 0x4d, 0x54, 0x72, 0x6b, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...body]);
}

describe('the builder (in memory)', () => {
  let kit: KitFile[];
  beforeAll(() => { kit = buildKit(); });

  it('has the original families and the ones TabPlayer\'s exporter adds', () => {
    const ids = kit.map((f) => f.meta.id);
    for (const id of ['structure', 'repeats', 'fermata', 'fermata-control', 'dynamics', 'bends', 'links', 'note-marks', 'harmonics-ornaments', 'strokes-gestures', 'rhythm', 'tracks-tuning', 'chord-diagram',
      'lyrics-verses', 'percussion', 'mix-automation', 'tempo-unit', 'common-cut-uniform', 'common-cut-mixed', 'curves-private', 'golpe', 'partial-capo']) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes with TabPlayer\'s exporter: its private additions are in score.gpif', () => {
    const gpif = (id: string) => gpifOf(kit.find((f) => f.meta.id === id)!.bytes);
    expect(gpif('curves-private')).toContain('name="TabPlayerCurves"');
    expect(gpif('fermata')).toContain('<Fermatas>');
    expect(gpif('partial-capo')).toContain('<Bitset>111000</Bitset>');
    expect(gpif('tempo-unit')).toContain('<Value>80 3</Value>');
    expect(gpif('mix-automation')).toContain('<Type>DSPParam_12</Type>');
    expect(gpif('golpe')).toContain('<Golpe>Thumb</Golpe>');
  });

  it('puts every element a family names into the file, and labels every bar with family and case', () => {
    for (const f of kit) {
      const entries = unzipSync(f.bytes), xml = parseXml(strFromU8(entries[GPIF]));
      expect(xml.error, f.meta.id).toBeNull();
      expect(select(xml.root, 'Section>Text').map((n) => n.text.trim()), f.meta.id).toEqual(f.meta.cases.map((c) => `${f.meta.id}: ${c}`));
      expect(f.meta.elements.length, `${f.meta.id} names no elements`).toBeGreaterThan(0);
      for (const element of f.meta.elements) {
        const absent = f.meta.expectAbsent.includes(element);
        const found = element.startsWith('@') ? element.slice(1) in entries : select(xml.root, element).length > 0;
        expect(found, `${f.meta.id} ${element}`).toBe(!absent);
      }
    }
  });

  it('writes the three fermatas through the app writer and none in the control', () => {
    const fermata = parseXml(gpifOf(kit.find((f) => f.meta.id === 'fermata')!.bytes)).root;
    expect(select(fermata, 'Fermata>Type').map((n) => n.text.trim())).toEqual(['Short', 'Medium', 'Long']);
    expect(select(parseXml(gpifOf(kit.find((f) => f.meta.id === 'fermata-control')!.bytes)).root, 'Fermata')).toHaveLength(0);
  });

  it('writes three chord diagrams, three lyric verses, a drum staff and two tracks with their own tuning', () => {
    const root = (id: string) => parseXml(gpifOf(kit.find((f) => f.meta.id === id)!.bytes)).root;
    expect(select(root('chord-diagram'), 'Item').map((n) => n.attrs.name)).toContain('C/E');
    expect(select(root('chord-diagram'), 'Item').length).toBeGreaterThanOrEqual(3);
    expect(select(root('lyrics-verses'), 'Lyrics>Line').length).toBeGreaterThanOrEqual(3);
    expect(select(root('percussion'), 'Track>Name').map((n) => n.text.trim())).toEqual(['Guitar', 'Drums']);
    expect(select(root('tracks-tuning'), 'Property[Tuning]').map((n) => select(n, 'Pitches')[0].text.trim())).toEqual(['40 45 50 55 59 64', '38 45 50 55 59 64']);
  });

  it('shows the common/cut stylesheet flag and records the export warning for the mixed case', () => {
    const style = (id: string) => Buffer.from(unzipSync(kit.find((f) => f.meta.id === id)!.bytes)['Content/BinaryStylesheet']).toString('latin1').match(/drawTimeSignatureC\u0000(.)/)![1].charCodeAt(0);
    expect(style('common-cut-uniform')).toBe(1);
    expect(style('common-cut-mixed')).toBe(0);
    const mixed = kit.find((f) => f.meta.id === 'common-cut-mixed')!.meta;
    expect(mixed.warnings.join(' ')).toMatch(/common\/cut symbol will show numbers/);
    expect(kit.find((f) => f.meta.id === 'common-cut-uniform')!.meta.warnings.join(' ')).not.toMatch(/common\/cut symbol/);
  });

  it('is deterministic: building again gives identical bytes', () => {
    const again = buildKit();
    again.forEach((f, i) => expect(Buffer.from(f.bytes).equals(Buffer.from(kit[i].bytes)), f.meta.id).toBe(true));
  });

  it('builds a checklist from the manifest that names files, bars, warnings and the elements compared', () => {
    const text = checklistText(kit.map((f) => ({ ...f.meta, name: f.name })));
    for (const f of kit) {
      expect(text, f.meta.id).toContain(`${f.name}.saved.gp`);
      expect(text, f.meta.id).toContain(`${f.name}.mid`);
      f.meta.cases.forEach((c) => expect(text).toContain(`${f.meta.id}: ${c}`));
      for (const w of f.meta.warnings) expect(text).toContain(w);
      for (const e of f.meta.elements) expect(text).toContain(e.startsWith('@') ? e.slice(1) : e);
    }
    expect(text).toContain('After Guitar Pro saves it');
    expect(text).toContain('Fermata positive control');
    expect(text).toContain('add one fermata by hand');
  });
});

describe('collect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp8-kit-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  type Manifest = { families: ManifestFamily[] };
  const manifest = () => JSON.parse(readFileSync(join(dir, 'kit-manifest.json'), 'utf8')) as Manifest;
  const fresh = () => { for (const name of ['results.md', 'results.json']) rmSync(join(dir, name), { force: true }); writeKitFiles(dir); };
  const at = (id: string) => manifest().families.find((f) => f.id === id)!;
  const path = (id: string, suffix = '.gp') => join(dir, `${at(id).name}${suffix}`);
  const rewrite = (from: string, to: string, edit: (xml: string) => string) => {
    const entries = unzipSync(readFileSync(from));
    entries[GPIF] = strToU8(edit(strFromU8(entries[GPIF])));
    writeFileSync(to, zipSync(entries));
  };
  const family = (result: ReturnType<typeof collectKit>, id: string) => result.families.find((f) => f.id === id)!;

  it('reports identical, dropped, changed and missing files, archive members, and MIDI counts and timing', () => {
    fresh();
    writeFileSync(path('bends', '.saved.gp'), readFileSync(path('bends'))); // identical re-save
    rewrite(path('links'), path('links', '.saved.gp'), (xml) => xml.replace(/<Tie [^>]*\/>/g, '')); // field dropped
    rewrite(path('note-marks'), path('note-marks', '.saved.gp'), (xml) => xml.replace('<Accent>8</Accent>', '<Accent>4</Accent>')); // field changed
    // archive member: the stylesheet flag flips, and Guitar Pro adds score.gpss
    const entries = unzipSync(readFileSync(path('common-cut-uniform')));
    const sheet = Buffer.from(entries['Content/BinaryStylesheet']); sheet[sheet.length - 1] = 0; // the flag is the last byte of its entry
    entries['Content/BinaryStylesheet'] = new Uint8Array(sheet); entries['Content/Stylesheets/score.gpss'] = Uint8Array.of(0x08, 1);
    writeFileSync(path('common-cut-uniform', '.saved.gp'), zipSync(entries));
    writeFileSync(path('bends', '.mid'), smf(at('bends').midi.onsets)); // MIDI that matches
    writeFileSync(path('links', '.mid'), smf(at('links').midi.onsets.map((q, i) => (i === 2 ? q + 0.5 : q)))); // one note moved
    const result = collectKit(dir);

    const bends = family(result, 'bends');
    expect(bends.saved.status).toBe('ok');
    expect(bends.selectors.filter((s) => s.written > 0).every((s) => s.status === 'same')).toBe(true);
    expect(bends.midiCompare?.noteCountMatches).toBe(true);
    expect(bends.midiCompare?.timingMatches).toBe(true);
    expect(bends.midiCompare?.firstTempoBpm).toBe(120);

    const links = family(result, 'links');
    expect(links.selectors.find((s) => s.selector === 'Tie')).toMatchObject({ status: 'absent', returned: 0 });
    expect(links.selectors.find((s) => s.selector === 'Property[Slide]')?.status).toBe('same');
    expect(links.midiCompare).toMatchObject({ noteCountMatches: true, timingMatches: false, missingCount: 1, extraCount: 1 });

    const marks = family(result, 'note-marks');
    expect(marks.selectors.find((s) => s.selector === 'Accent')).toMatchObject({ status: 'changed', written: 3, returned: 3 });

    const style = family(result, 'common-cut-uniform');
    expect(style.selectors.find((s) => s.selector === '@Content/BinaryStylesheet')?.status).toBe('changed');
    expect(style.selectors.find((s) => s.selector === '@Content/Stylesheets/score.gpss')).toMatchObject({ status: 'added', written: 0, returned: 1 });
    expect(style.selectors.find((s) => s.selector === 'MasterBar>Time')?.status).toBe('same');

    const structure = family(result, 'structure');
    expect(structure.saved.status).toBe('missing');
    expect(structure.selectors).toEqual([]);

    const text = resultsMarkdown(result);
    expect(text).toContain('ABSENT in the Guitar Pro file');
    expect(text).toContain('CHANGED');
    expect(text).toContain('does not judge whether a difference is a defect');
  });

  it('compares the private TabPlayer property: absent when Guitar Pro drops it', () => {
    fresh();
    rewrite(path('curves-private'), path('curves-private', '.saved.gp'), (xml) => xml.replace(/<Property name="TabPlayerCurves">[\s\S]*?<\/Items><\/Property>/, ''));
    const row = family(collectKit(dir), 'curves-private').selectors.find((s) => s.selector === 'Property[TabPlayerCurves]');
    expect(row).toMatchObject({ status: 'absent', written: 1, returned: 0 });
  });

  it('never throws on bad, oversized or hostile returned files, and says what is wrong with each', () => {
    fresh();
    writeFileSync(path('structure', '.saved.gp'), strToU8('this is not a zip'));
    writeFileSync(path('repeats', '.saved.gp'), readFileSync(path('repeats')).subarray(0, 60)); // truncated zip
    writeFileSync(path('dynamics', '.saved.gp'), zipSync({ 'other.txt': strToU8('x') }));
    writeFileSync(path('rhythm', '.saved.gp'), zipSync({ [GPIF]: strToU8('<GPIF><Score></GPIF>') }));
    writeFileSync(path('harmonics-ornaments', '.saved.gp'), zipSync({ [GPIF]: strToU8(`<GPIF>${'<a>'.repeat(400)}</GPIF>`) }));
    writeFileSync(path('chord-diagram', '.mid'), strToU8('MThd garbage'));
    writeFileSync(path('tracks-tuning', '.mid'), new Uint8Array(9 * 1024 * 1024)); // over the 8 MiB limit
    writeFileSync(join(dir, 'stray.mid'), smf([0]));
    let result!: ReturnType<typeof collectKit>;
    expect(() => { result = collectKit(dir); }).not.toThrow();
    expect(family(result, 'structure').saved.detail).toContain('not a zip');
    expect(family(result, 'repeats').saved.status).toBe('unreadable');
    expect(family(result, 'dynamics').saved.detail).toContain('no Content/score.gpif');
    expect(family(result, 'rhythm').saved.detail).toContain('not readable XML');
    expect(family(result, 'harmonics-ornaments').saved.detail).toContain('Nesting deeper');
    expect(family(result, 'chord-diagram').midi.status).toBe('unreadable');
    expect(family(result, 'tracks-tuning').midi.status).toBe('too-large');
    expect(result.unrecognised).toContain('stray.mid');
    expect(() => resultsMarkdown(result)).not.toThrow();
    rmSync(join(dir, 'stray.mid'), { force: true });
  });

  it('reports a missing or damaged manifest instead of throwing, and a changed original file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gp8-kit-empty-'));
    try {
      expect(collectKit(empty).problems[0]).toContain('kit-manifest.json');
      writeFileSync(join(empty, 'kit-manifest.json'), '{ not json');
      expect(collectKit(empty).problems[0]).toContain('kit-manifest.json');
    } finally { rmSync(empty, { recursive: true, force: true }); }
    fresh();
    const first = manifest().families[0];
    rewrite(join(dir, first.file), join(dir, first.file), (xml) => xml.replace('<Time>3/4', '<Time>5/4'));
    expect(family(collectKit(dir), first.id).notes.join(' ')).toContain('has changed since it was written');
  });

  it('writes results.md and results.json from the command line entry point', () => {
    fresh();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(main(['collect', dir])).toBe(0); } finally { log.mockRestore(); }
    expect(existsSync(join(dir, 'results.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).families).toHaveLength(KIT_FAMILIES.length);
  });
});
