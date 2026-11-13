// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildFamilyFile, collectKit, FAMILIES, fileName, GPIF, main, parseXml, resultsMarkdown, select, writeKit } from '../../scripts/gp8-acceptance-kit.mjs';

// THE-61: the Guitar Pro 8 acceptance kit. Nothing here involves Guitar Pro; the "returned" files are synthetic.
const dir = mkdtempSync(join(tmpdir(), 'gp8-kit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const gpifOf = (path: string) => strFromU8(unzipSync(readFileSync(path))[GPIF]);
const rewrite = (from: string, to: string, edit: (xml: string) => string) => {
  const entries = unzipSync(readFileSync(from));
  entries[GPIF] = strToU8(edit(strFromU8(entries[GPIF])));
  writeFileSync(to, zipSync(entries));
};
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
type Manifest = { families: { id: string; name: string; file: string; midi: { onsets: number[] } }[] };
const manifest = () => JSON.parse(readFileSync(join(dir, 'kit-manifest.json'), 'utf8')) as Manifest;
const family = (result: ReturnType<typeof collectKit>, id: string) => result.families.find((f) => f.id === id)!;
const clean = () => { for (const name of ['results.md', 'results.json']) rmSync(join(dir, name), { force: true }); };

describe('write', () => {
  let written: ReturnType<typeof writeKit>;
  beforeAll(() => { written = writeKit(dir); });

  it('writes one file per family plus the checklist and manifest', () => {
    expect(written.warnings).toEqual([]);
    expect(FAMILIES.length).toBeGreaterThanOrEqual(12);
    FAMILIES.forEach((f, i) => expect(existsSync(join(dir, `${fileName(i, f)}.gp`)), f.id).toBe(true));
    expect(existsSync(join(dir, 'checklist.md'))).toBe(true);
    expect(manifest().families).toHaveLength(FAMILIES.length);
  });

  it('puts the elements each family is about into score.gpif, and labels every bar with family and case', () => {
    FAMILIES.forEach((f, i) => {
      const xml = parseXml(gpifOf(join(dir, `${fileName(i, f)}.gp`)));
      expect(xml.error, f.id).toBeNull();
      const sections = select(xml.root, 'Section>Text').map((n) => n.text.trim());
      expect(sections, f.id).toEqual(f.cases.map((c) => `${f.id}: ${c.name}`));
      for (const selector of f.elements) {
        if (f.control && selector.startsWith('Fermata')) { expect(select(xml.root, selector), `${f.id} ${selector}`).toHaveLength(0); continue; }
        expect(select(xml.root, selector).length, `${f.id} has no ${selector}`).toBeGreaterThan(0);
      }
    });
  });

  it('writes the three fermatas of the fermata family and none in the control', () => {
    const idx = (id: string) => FAMILIES.findIndex((f) => f.id === id);
    const fermata = parseXml(gpifOf(join(dir, `${fileName(idx('fermata'), FAMILIES[idx('fermata')])}.gp`))).root;
    expect(select(fermata, 'Fermata>Type').map((n) => n.text.trim())).toEqual(['Short', 'Medium', 'Long']);
    const control = parseXml(gpifOf(join(dir, `${fileName(idx('fermata-control'), FAMILIES[idx('fermata-control')])}.gp`))).root;
    expect(select(control, 'Fermata')).toHaveLength(0);
  });

  it('is deterministic: writing again gives identical bytes', () => {
    FAMILIES.forEach((f, i) => expect(Buffer.from(buildFamilyFile(f).bytes).equals(readFileSync(join(dir, `${fileName(i, f)}.gp`))), f.id).toBe(true));
  });

  it('generates a checklist from the same data, with the fermata control as its own item', () => {
    const text = readFileSync(join(dir, 'checklist.md'), 'utf8');
    FAMILIES.forEach((f, i) => {
      const name = fileName(i, f);
      expect(text, f.id).toContain(`${name}.saved.gp`);
      expect(text, f.id).toContain(`${name}.mid`);
      f.cases.forEach((c) => expect(text).toContain(`${f.id}: ${c.name}`));
    });
    expect(text).toContain('Fermata positive control');
    expect(text).toContain('add one fermata by hand');
  });
});

describe('collect', () => {
  it('reports identical, dropped, changed and missing files, and MIDI counts and timing', () => {
    writeKit(dir);
    const m = manifest(), at = (id: string) => m.families.find((f) => f.id === id)!;
    const path = (id: string, suffix = '.gp') => join(dir, `${at(id).name}${suffix}`);
    writeFileSync(path('bends', '.saved.gp'), readFileSync(path('bends'))); // identical re-save
    rewrite(path('links'), path('links', '.saved.gp'), (xml) => xml.replace(/<Tie [^>]*\/>/g, '')); // field dropped
    rewrite(path('note-marks'), path('note-marks', '.saved.gp'), (xml) => xml.replace('<Accent>8</Accent>', '<Accent>4</Accent>')); // field changed
    writeFileSync(path('bends', '.mid'), smf(at('bends').midi.onsets)); // MIDI that matches
    writeFileSync(path('links', '.mid'), smf(at('links').midi.onsets.map((q, i) => (i === 2 ? q + 0.5 : q)))); // one note moved
    const result = collectKit(dir);

    const bends = family(result, 'bends');
    expect(bends.saved.status).toBe('ok');
    expect(bends.selectors.length).toBeGreaterThan(0);
    expect(bends.selectors.filter((s) => s.written > 0).every((s) => s.status === 'same')).toBe(true);
    expect(bends.midiCompare?.noteCountMatches).toBe(true);
    expect(bends.midiCompare?.timingMatches).toBe(true);
    expect(bends.midiCompare?.firstTempoBpm).toBe(120);

    const links = family(result, 'links');
    expect(links.selectors.find((s) => s.selector === 'Tie')).toMatchObject({ status: 'absent', returned: 0 });
    expect(links.selectors.find((s) => s.selector === 'Property[Slide]')?.status).toBe('same');
    expect(links.midiCompare?.noteCountMatches).toBe(true);
    expect(links.midiCompare?.timingMatches).toBe(false);
    expect(links.midiCompare?.missingCount).toBe(1);
    expect(links.midiCompare?.extraCount).toBe(1);

    const marks = family(result, 'note-marks');
    expect(marks.selectors.find((s) => s.selector === 'Accent')).toMatchObject({ status: 'changed', written: 3, returned: 3 });
    expect(marks.selectors.find((s) => s.selector === 'Vibrato')?.status).toBe('same');

    const structure = family(result, 'structure');
    expect(structure.saved.status).toBe('missing');
    expect(structure.selectors).toEqual([]);
    expect(structure.midi.status).toBe('missing');

    const text = resultsMarkdown(result);
    expect(text).toContain('ABSENT in the Guitar Pro file');
    expect(text).toContain('CHANGED');
    expect(text).toContain('does not judge whether a difference is a defect');
  });

  it('never throws on bad, oversized or hostile returned files, and says what is wrong with each', () => {
    writeKit(dir);
    const name = (id: string) => manifest().families.find((f) => f.id === id)!.name;
    writeFileSync(join(dir, `${name('structure')}.saved.gp`), strToU8('this is not a zip'));
    writeFileSync(join(dir, `${name('repeats')}.saved.gp`), readFileSync(join(dir, `${name('repeats')}.gp`)).subarray(0, 60)); // truncated zip
    writeFileSync(join(dir, `${name('dynamics')}.saved.gp`), zipSync({ 'other.txt': strToU8('x') }));
    writeFileSync(join(dir, `${name('rhythm')}.saved.gp`), zipSync({ [GPIF]: strToU8('<GPIF><Score></GPIF>') }));
    writeFileSync(join(dir, `${name('harmonics-ornaments')}.saved.gp`), zipSync({ [GPIF]: strToU8(`<GPIF>${'<a>'.repeat(400)}</GPIF>`) }));
    writeFileSync(join(dir, `${name('chord-diagram')}.mid`), strToU8('MThd garbage'));
    writeFileSync(join(dir, `${name('tracks-tuning')}.mid`), new Uint8Array(9 * 1024 * 1024)); // over the 8 MiB limit
    writeFileSync(join(dir, 'stray.mid'), smf([0]));
    let result!: ReturnType<typeof collectKit>;
    expect(() => { result = collectKit(dir); }).not.toThrow();
    expect(family(result, 'structure').saved.status).toBe('unreadable');
    expect(family(result, 'structure').saved.detail).toContain('not a zip');
    expect(family(result, 'repeats').saved.status).toBe('unreadable');
    expect(family(result, 'dynamics').saved.detail).toContain('no Content/score.gpif');
    expect(family(result, 'rhythm').saved.detail).toContain('not readable XML');
    expect(family(result, 'harmonics-ornaments').saved.detail).toContain('Nesting deeper');
    expect(family(result, 'chord-diagram').midi.status).toBe('unreadable');
    expect(family(result, 'tracks-tuning').midi.status).toBe('too-large');
    expect(result.unrecognised).toContain('stray.mid');
    expect(() => resultsMarkdown(result)).not.toThrow();
    for (const f of manifest().families) for (const suffix of ['.saved.gp', '.mid']) rmSync(join(dir, `${f.name}${suffix}`), { force: true });
    rmSync(join(dir, 'stray.mid'), { force: true });
  });

  it('reports a missing or damaged manifest instead of throwing, and a changed original file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gp8-kit-empty-'));
    try {
      expect(collectKit(empty).problems[0]).toContain('kit-manifest.json');
      writeFileSync(join(empty, 'kit-manifest.json'), '{ not json');
      expect(collectKit(empty).problems[0]).toContain('kit-manifest.json');
    } finally { rmSync(empty, { recursive: true, force: true }); }
    writeKit(dir);
    const first = manifest().families[0], file = join(dir, first.file);
    rewrite(file, file, (xml) => xml.replace('<Time>3/4', '<Time>5/4'));
    expect(family(collectKit(dir), first.id).notes.join(' ')).toContain('has changed since it was written');
    writeKit(dir);
  });

  it('writes results.md and results.json from the command line entry point', () => {
    writeKit(dir);
    clean();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(main(['collect', dir])).toBe(0); } finally { log.mockRestore(); }
    expect(existsSync(join(dir, 'results.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).families).toHaveLength(FAMILIES.length);
  });
});
