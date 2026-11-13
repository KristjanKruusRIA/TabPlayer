#!/usr/bin/env node
// THE-61 Guitar Pro 8 acceptance kit.
//   node scripts/gp8-acceptance-kit.mjs write [dir]     writes the authored .gp files, kit-manifest.json and checklist.md (default .analysis/gp8-acceptance/)
//   node scripts/gp8-acceptance-kit.mjs collect [dir]   reads what came back from Guitar Pro 8 (re-saved .gp, exported .mid) and writes results.md and results.json
// Nothing here has been opened in Guitar Pro 8. The .gp files come from TabPlayer's own exporter (exportGpInterchange), so they carry its
// private additions. That exporter is TypeScript with extensionless imports, which plain Node cannot load, so `write` runs
// `vitest run src/interchange/gp8-acceptance-kit-write.test.ts` with GP8_KIT_OUT set; the builder is src/interchange/gp8-acceptance-families.ts.
// `collect` stays here: it compares the GPIF XML (and named archive members) of the file written with the file Guitar Pro saved, for the
// named elements only, and reads the exported MIDI with the fermata probe's Standard MIDI File reader. It never throws on a returned file.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { MAX_MIDI_BYTES, parseSmf, tempoMap, tickToSeconds } from './fermata-probe.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WRITE_TEST = 'src/interchange/gp8-acceptance-kit-write.test.ts';
export const MAX_MEMBER_BYTES = 2 * 1024 * 1024;
export const DEFAULT_DIR = '.analysis/gp8-acceptance';
export const MAX_GP_BYTES = 64 * 1024 * 1024;
export const MAX_GPIF_BYTES = 48 * 1024 * 1024;
export const MAX_XML_NODES = 2_000_000;
export const MAX_XML_DEPTH = 256;
export const GPIF = 'Content/score.gpif';
export const BPM = 120;

const round = (x) => Math.round(x * 1000) / 1000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------------------------------------------------
const memberOf = (element) => (element.startsWith('@') ? element.slice(1) : null);
const describeElement = (element) => (memberOf(element) ? `archive member \`${memberOf(element)}\` (compared byte for byte)` : `\`${element}\``);
/** The checklist, from the manifest's families. */
export function checklistText(families) {
  const out = [
    '# Guitar Pro 8 acceptance checklist (THE-61)', '',
    'Nothing in this kit has been opened in Guitar Pro 8. You need an activated Guitar Pro 8. The `.gp` files were written by TabPlayer\'s own exporter. Do not edit them; open each, look, then save and export under the new names below, in this same folder.', '',
    'Before you start: in Guitar Pro 8, switch off any count-in, metronome click or extra repeats for MIDI export, and write down the export options you chose (the Guitar Pro version, build and the option names). Use the same options for every file.', '',
    'For every file:', '',
    '1. Open it. Note any warning on opening (say which file and the exact text).',
    '2. Look at the things named for that file. Write down anything missing or different from what is named. The bar labels (section names) say which case each bar is.',
    '3. File, Save as, type Guitar Pro 7/8 (`.gp`), the name shown as "save as", in this folder.',
    '4. File, Export, MIDI, the name shown as "export as", in this folder. Use the default MIDI options.',
    '5. Close the file without saving again.', '',
    'Then run `node scripts/gp8-acceptance-kit.mjs collect <this folder>` and read `results.md`. For each file it compares the elements listed under "After Guitar Pro saves it" below, and nothing else.', '',
    '| # | File to open | What to look at | Save as (.gp) | Export as (MIDI) |', '|---|---|---|---|---|',
  ];
  families.forEach((f) => out.push(`| ${f.name.slice(0, 2)} | \`${f.name}.gp\` | ${f.look.replace(/\|/g, '/')} | \`${f.name}.saved.gp\` | \`${f.name}.mid\` |`));
  out.push('');
  families.forEach((f) => {
    out.push(`## ${f.name.slice(0, 2)} ${f.title}`, '', `File \`${f.name}.gp\`. ${f.look}`, '', 'Bars, in order (each is labelled in the file by its section name):', '');
    f.cases.forEach((c, i) => out.push(`${i + 1}. ${f.id}: ${c}`));
    if (f.tracks?.length > 1 || (f.tracks?.length === 1 && f.tracks[0] !== 'Guitar')) out.push('', `Tracks: ${f.tracks.join(', ')}.`);
    out.push('', `Save as \`${f.name}.saved.gp\`; export MIDI as \`${f.name}.mid\`.`, '');
    if (f.warnings?.length) {
      out.push('TabPlayer\'s own export warning for this score (the text the app shows before writing a Guitar Pro 7/8 file):', '', ...f.warnings.map((w) => `> ${w}`), '');
    }
    for (const note of f.notes ?? []) out.push(`Note: ${note}`, '');
    out.push('After Guitar Pro saves it, `collect` compares these standard GPIF elements between the file TabPlayer wrote and the file Guitar Pro saved:', '', ...(f.elements ?? []).map((e) => `- ${describeElement(e)}${(f.expectAbsent ?? []).includes(e) ? ' (not in the written file; shows where Guitar Pro puts it)' : ''}`), '');
    if (f.control) {
      out.push('### Fermata positive control (do these exact steps)', '',
        `1. Open \`${f.name}.gp\`. It has four plain bars and no fermata.`,
        '2. Select the first beat of bar 2 and add one fermata by hand with Guitar Pro 8\'s own fermata tool. Write down which type and length you chose (the defaults are fine; say so).',
        `3. Do not change anything else. Save as \`${f.name}.saved.gp\`.`,
        `4. Export MIDI with the default options as \`${f.name}.mid\`.`,
        `5. If the MIDI export dialog offers an option that changes tempo, repeat or fermata handling, export once more with the other setting as \`${f.name}-alt.mid\` and write down which option it was.`,
        '', 'This answers three open questions from `docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md`: how Guitar Pro itself writes a fermata, whether its MIDI export holds the note, and by how much. The earlier probe had no fermata placed by Guitar Pro itself.', '');
    }
  });
  out.push('## When something looks wrong', '', 'Write what you saw and in which bar, even if it seems small. A file Guitar Pro refuses to open is a result: note the exact message and skip that file\'s save and export.', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// write: the builder runs under Vitest (it needs TabPlayer's TypeScript exporter)
// ---------------------------------------------------------------------------------------------------------------------
/** Runs the opt-in Vitest file that writes the .gp files and manifest, then writes the checklist. Returns { out, files, warnings, log }. */
export function writeKit(dir) {
  const out = resolve(dir ?? DEFAULT_DIR);
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) throw new Error(`Vitest is not installed at ${vitest}; run npm ci.`);
  const before = new Map();
  for (const name of existsSync(out) ? readdirSync(out) : []) if (/\.gp$/.test(name) && !/\.saved\.gp$/.test(name)) before.set(name, sha256(readFileSync(join(out, name))));
  const run = spawnSync(process.execPath, [vitest, 'run', WRITE_TEST], { cwd: ROOT, env: { ...process.env, GP8_KIT_OUT: out }, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`The builder failed (exit ${run.status}).\n${run.stdout}\n${run.stderr}`);
  const manifest = JSON.parse(readFileSync(join(out, 'kit-manifest.json'), 'utf8'));
  const warnings = [];
  for (const f of manifest.families) {
    const old = before.get(f.file);
    if (old && old !== f.sha256 && (existsSync(join(out, `${f.name}.saved.gp`)) || existsSync(join(out, `${f.name}.mid`)))) warnings.push(`${f.file} was replaced with different bytes and has returned files beside it; those no longer match.`);
  }
  const checklist = join(out, 'checklist.md');
  writeFileSync(checklist, checklistText(manifest.families));
  const files = [...manifest.families.map((f) => join(out, f.file)), join(out, 'kit-manifest.json'), checklist];
  return { out, files, warnings, families: manifest.families };
}

// ---------------------------------------------------------------------------------------------------------------------
// A tolerant XML reader. Never throws; returns { root, error }.
// ---------------------------------------------------------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
  if (e[0] === '#') { const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; }
  return ENTITIES[e] ?? m;
});
export function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '', parent: null };
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
  const attrToken = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let at = 0, nodes = 0, current = root, depth = 0, m;
  if (typeof text !== 'string') return { root, error: 'not text' };
  while (at < text.length) {
    token.lastIndex = at; m = token.exec(text);
    if (!m) return { root, error: `Unreadable markup at character ${at}.` };
    at = token.lastIndex;
    if (m[1] !== undefined) current.text += m[1];
    else if (m[2] !== undefined) { if (current.tag !== m[2]) return { root, error: `Closing tag </${m[2]}> does not match <${current.tag}> near character ${at}.` }; current = current.parent; depth -= 1; }
    else if (m[3] !== undefined) {
      nodes += 1; if (nodes > MAX_XML_NODES) return { root, error: `More than ${MAX_XML_NODES} elements; stopped.` };
      const attrs = {}; let a; attrToken.lastIndex = 0;
      while ((a = attrToken.exec(m[4] ?? ''))) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const node = { tag: m[3], attrs, children: [], text: '', parent: current };
      current.children.push(node);
      if (m[5] !== '/') { current = node; depth += 1; if (depth > MAX_XML_DEPTH) return { root, error: `Nesting deeper than ${MAX_XML_DEPTH}; stopped.` }; }
    } else if (m[6] !== undefined) current.text += decode(m[6]);
  }
  if (current !== root) return { root, error: `Element <${current.tag}> is never closed.` };
  return { root, error: null };
}
function* walk(node) { for (const child of node.children) { yield child; yield* walk(child); } }

/** Selector: `Tag`, `Tag[attr=value]`, or `Parent>Tag` (direct parent), each optionally with one attribute test. */
export function parseSelector(selector) {
  const m = /^(?:([A-Za-z0-9_]+)>)?([A-Za-z0-9_]+)(?:\[(?:([A-Za-z0-9_]+)=)?([^\]=]*)\])?$/.exec(selector);
  if (!m) throw new Error(`Bad selector "${selector}".`);
  // `Tag[value]` is shorthand for `Tag[name=value]`, which is how GPIF names its Property elements.
  return { parent: m[1] ?? null, tag: m[2], attr: m[4] === undefined ? null : (m[3] ?? 'name'), value: m[4] ?? null };
}
export function select(root, selector) {
  const s = typeof selector === 'string' ? parseSelector(selector) : selector, out = [];
  for (const node of walk(root)) {
    if (node.tag !== s.tag) continue;
    if (s.parent && node.parent?.tag !== s.parent) continue;
    if (s.attr && node.attrs[s.attr] !== s.value) continue;
    out.push(node);
  }
  return out;
}
/** Stable text of an element, ignoring `id` attributes (Guitar Pro renumbers ids) and whitespace between elements. */
export function canonical(node, budget = { left: 4000 }) {
  const attrs = Object.entries(node.attrs).filter(([k]) => k !== 'id').sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ` ${k}="${v}"`).join('');
  const inner = node.children.length ? node.children.map((c) => canonical(c, budget)).join('') : node.text.trim();
  const text = `<${node.tag}${attrs}>${inner}</${node.tag}>`;
  budget.left -= text.length;
  return budget.left < 0 ? `${text.slice(0, 200)}…` : text;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading returned files (all bounded, none throw)
// ---------------------------------------------------------------------------------------------------------------------
/** Result: { status: 'ok'|'missing'|'too-large'|'unreadable', detail, xml?: {root,error}, bytes? } */
export function readGpFile(path) {
  try {
    if (!existsSync(path)) return { status: 'missing', detail: 'file not found' };
    const st = statSync(path);
    if (!st.isFile()) return { status: 'unreadable', detail: 'not a regular file' };
    if (st.size > MAX_GP_BYTES) return { status: 'too-large', detail: `${st.size} bytes is over the ${MAX_GP_BYTES} byte limit` };
    const bytes = readFileSync(path);
    if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { status: 'unreadable', detail: 'not a zip archive (no PK header). A .gpx file is a different container and is not read by this kit; save as .gp.' };
    let entries;
    try { entries = unzipSync(bytes, { filter: (file) => (file.name === GPIF && file.originalSize <= MAX_GPIF_BYTES) || (/^Content\/(Stylesheets\/|BinaryStylesheet$)/.test(file.name) && file.originalSize <= MAX_MEMBER_BYTES) }); }
    catch (error) { return { status: 'unreadable', detail: `zip could not be read: ${error?.message ?? error}` }; }
    const gpif = entries[GPIF];
    if (!gpif) return { status: 'unreadable', detail: `no ${GPIF} inside the archive, or it is larger than ${MAX_GPIF_BYTES} bytes` };
    const xml = parseXml(strFromU8(gpif));
    if (xml.error) return { status: 'unreadable', detail: `score.gpif is not readable XML: ${xml.error}`, xml };
    return { status: 'ok', detail: '', xml, bytes: bytes.length, members: entries };
  } catch (error) { return { status: 'unreadable', detail: `unexpected error: ${error?.message ?? error}` }; }
}
export function readMidiFile(path) {
  try {
    if (!existsSync(path)) return { status: 'missing', detail: 'file not found' };
    const st = statSync(path);
    if (!st.isFile()) return { status: 'unreadable', detail: 'not a regular file' };
    if (st.size > MAX_MIDI_BYTES) return { status: 'too-large', detail: `${st.size} bytes is over the ${MAX_MIDI_BYTES} byte limit` };
    const smf = parseSmf(readFileSync(path));
    if (!smf.ok) return { status: 'unreadable', detail: smf.warnings.join(' ') || 'no tracks', smf };
    return { status: 'ok', detail: smf.warnings.join(' '), smf };
  } catch (error) { return { status: 'unreadable', detail: `unexpected error: ${error?.message ?? error}` }; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------------------------------
/** Byte comparison of one archive member (the stylesheets), for selectors written `@Content/...`. */
export function compareMember(selector, writtenMembers, returnedMembers) {
  const name = selector.slice(1), w = writtenMembers?.[name], r = returnedMembers?.[name];
  const hex = (b) => Buffer.from(b).toString('hex');
  if (!w && !r) return { selector, written: 0, returned: 0, status: 'none', detail: 'no such member in either file' };
  if (w && !r) return { selector, written: 1, returned: 0, status: 'absent', detail: `written ${w.length} bytes` };
  if (!w) return { selector, written: 0, returned: 1, status: 'added', detail: `Guitar Pro added ${r.length} bytes` };
  if (hex(w) === hex(r)) return { selector, written: 1, returned: 1, status: 'same', detail: '' };
  let at = 0; while (at < w.length && at < r.length && w[at] === r[at]) at += 1;
  return { selector, written: 1, returned: 1, status: 'changed', detail: `${w.length} bytes written, ${r.length} returned; first difference at byte ${at}` };
}
const counts = (list) => { const m = new Map(); for (const x of list) m.set(x, (m.get(x) ?? 0) + 1); return m; };
/** Compares the canonical text of the elements a selector finds in the written and the returned file. Describes only what it compared. */
export function compareSelector(selector, writtenRoot, returnedRoot) {
  const w = select(writtenRoot, selector).map((n) => canonical(n)), r = select(returnedRoot, selector).map((n) => canonical(n));
  if (!w.length && !r.length) return { selector, written: 0, returned: 0, status: 'none', detail: 'no such element in either file' };
  if (w.length && !r.length) return { selector, written: w.length, returned: 0, status: 'absent', detail: `written: ${w[0].slice(0, 160)}` };
  if (!w.length) return { selector, written: 0, returned: r.length, status: 'added', detail: `Guitar Pro added: ${r[0].slice(0, 160)}` };
  const cw = counts(w), cr = counts(r);
  const onlyW = [...cw].filter(([k, n]) => (cr.get(k) ?? 0) < n).map(([k]) => k), onlyR = [...cr].filter(([k, n]) => (cw.get(k) ?? 0) < n).map(([k]) => k);
  if (!onlyW.length && !onlyR.length) return { selector, written: w.length, returned: r.length, status: 'same', detail: '' };
  return { selector, written: w.length, returned: r.length, status: 'changed', detail: `written ${onlyW[0]?.slice(0, 120) ?? '(nothing different)'} / returned ${onlyR[0]?.slice(0, 120) ?? '(nothing different)'}` };
}
const TICK_TOLERANCE_QUARTERS = 0.02;
/** Note count and onset timing of an exported MIDI against the manifest. */
export function compareMidi(smf, expected, nominalBpm = BPM) {
  const ppq = smf.ppq, notes = smf.notes;
  const onsets = [...new Set(notes.map((n) => round(n.on / ppq)))].sort((a, b) => a - b);
  const want = expected.onsets;
  const near = (list, x) => list.some((y) => Math.abs(y - x) <= TICK_TOLERANCE_QUARTERS);
  const missing = want.filter((x) => !near(onsets, x)), extra = onsets.filter((x) => !near(want, x));
  const ends = notes.map((n) => (n.off ?? n.on)), last = ends.length ? Math.max(...ends) / ppq : 0;
  const map = tempoMap(smf.tempos, ppq);
  const endSeconds = ends.length ? tickToSeconds(map, ppq, Math.max(...ends)) : 0;
  const keys = [...new Set(notes.map((n) => n.key))];
  const result = {
    ppq, tracks: smf.tracks, observedNotes: notes.length, expectedNotes: expected.notes, noteCountMatches: notes.length === expected.notes,
    observedOnsets: onsets.length, expectedOnsets: want.length, missingOnsets: missing.slice(0, 8), extraOnsets: extra.slice(0, 8), missingCount: missing.length, extraCount: extra.length,
    endQuarters: round(last), expectedQuarters: expected.quarters, endSeconds: round(endSeconds), nominalSeconds: round((expected.quarters * 60) / nominalBpm),
    tempoEvents: smf.tempos.length, firstTempoBpm: smf.tempos.length ? round(60e6 / smf.tempos[0].usPerQuarter) : null,
    distinctKeys: keys.length, allKeysZero: keys.length === 1 && keys[0] === 0,
  };
  result.timingMatches = !missing.length && !extra.length;
  return result;
}

function describeFermataControl(returnedRoot, smf) {
  const fermatas = select(returnedRoot, 'Fermata').map((n) => canonical(n));
  const out = { fermatasInReturnedFile: fermatas.length, fermataXml: fermatas.slice(0, 4) };
  if (smf) {
    const map = tempoMap(smf.tempos, smf.ppq);
    const notes = smf.notes;
    const expectedSeconds = (4 * 4 * 60) / BPM, ends = notes.map((n) => n.off ?? n.on);
    out.endSeconds = ends.length ? round(tickToSeconds(map, smf.ppq, Math.max(...ends))) : null;
    out.nominalSeconds = expectedSeconds;
    out.addedSeconds = out.endSeconds === null ? null : round(out.endSeconds - expectedSeconds);
    out.tempoEvents = smf.tempos.length;
    out.tempoValues = [...new Set(smf.tempos.map((t) => round(60e6 / t.usPerQuarter)))];
    // Per bar: first note-on in each of the 4 bars, as seconds late against the nominal grid.
    const barStarts = [0, 1, 2, 3].map((b) => { const first = notes.filter((n) => n.on >= b * 4 * smf.ppq - 2).sort((a, c) => a.on - c.on)[0]; return first ? round(tickToSeconds(map, smf.ppq, first.on) - (b * 4 * 60) / BPM) : null; });
    out.barStartShiftSeconds = barStarts;
    out.note = 'Compare against the probe in docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md. A non-zero addedSeconds, tempo events beyond the first, or a growing barStartShiftSeconds would show a hold; zeros show none. This is one fermata of one type and length.';
  }
  return out;
}

/** Reads the kit folder. Returns the results object; never throws. */
export function collectKit(dir) {
  const out = resolve(dir ?? DEFAULT_DIR);
  const result = { dir: out, problems: [], families: [], unrecognised: [] };
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(out, 'kit-manifest.json'), 'utf8')); }
  catch (error) { result.problems.push(`kit-manifest.json could not be read (${error?.message ?? error}). Run \`write\` first, in this folder.`); return result; }
  if (!Array.isArray(manifest?.families)) { result.problems.push('kit-manifest.json has no families list.'); return result; }
  const known = new Set();
  for (const fam of manifest.families) {
    const record = { id: fam.id, name: fam.name, title: fam.title, original: null, saved: null, midi: null, selectors: [], midiCompare: null, control: null, notes: [] };
    result.families.push(record);
    const base = fam.name;
    for (const suffix of ['.gp', '.saved.gp', '.mid', '-alt.mid']) known.add(base + suffix);
    const original = readGpFile(join(out, fam.file));
    record.original = { status: original.status, detail: original.detail };
    if (original.status === 'ok') {
      try { if (sha256(readFileSync(join(out, fam.file))) !== fam.sha256) record.notes.push('The file written by the kit has changed since it was written (its SHA-256 differs from kit-manifest.json). The comparison uses the file as it is now.'); } catch { /* reported above */ }
    }
    const saved = readGpFile(join(out, `${base}.saved.gp`));
    record.saved = { status: saved.status, detail: saved.detail };
    if (original.status === 'ok' && saved.status === 'ok') {
      for (const selector of fam.elements ?? []) {
        try { record.selectors.push(selector.startsWith('@') ? compareMember(selector, original.members, saved.members) : compareSelector(selector, original.xml.root, saved.xml.root)); }
        catch (error) { record.selectors.push({ selector, written: 0, returned: 0, status: 'error', detail: String(error?.message ?? error) }); }
      }
    }
    const midi = readMidiFile(join(out, `${base}.mid`));
    record.midi = { status: midi.status, detail: midi.detail };
    if (midi.status === 'ok') {
      try {
        record.midiCompare = compareMidi(midi.smf, fam.midi);
        if (fam.midi?.timing === false) record.midiCompare.timingNote = `Timing not judged: ${fam.midi.why}`;
        if (fam.control) record.control = describeFermataControl(saved.status === 'ok' ? saved.xml.root : { children: [] }, midi.smf);
      } catch (error) { record.midi = { status: 'unreadable', detail: `comparison failed: ${error?.message ?? error}` }; }
    } else if (fam.control && saved.status === 'ok') record.control = describeFermataControl(saved.xml.root, null);
    const alt = readMidiFile(join(out, `${base}-alt.mid`));
    if (alt.status === 'ok') record.notes.push(`${base}-alt.mid is present (${alt.smf.notes.length} notes). It is not compared; read it with scripts/fermata-probe.mjs if it is for a fermata.`);
  }
  try {
    for (const name of readdirSync(out)) if (/\.(gp|gpx|mid|midi)$/i.test(name) && !known.has(name)) result.unrecognised.push(name);
  } catch { /* folder listing failed; nothing to report */ }
  return result;
}

export function resultsMarkdown(result) {
  const out = ['# Guitar Pro 8 acceptance results (generated)', '',
    'Generated by `node scripts/gp8-acceptance-kit.mjs collect`. It compares the XML of `score.gpif` in the file the kit wrote with the file Guitar Pro 8 saved, for the listed elements only, and the exported MIDI with what the kit wrote. It does not judge whether a difference is a defect, does not look at how anything sounds or looks, and says nothing about elements it was not given. Read it with the notes you took in Guitar Pro.', ''];
  for (const p of result.problems) out.push(`**Problem:** ${p}`, '');
  const label = { same: 'same', absent: 'ABSENT in the Guitar Pro file', changed: 'CHANGED', added: 'added by Guitar Pro', none: 'not in either file', error: 'ERROR' };
  for (const fam of result.families) {
    out.push(`## ${fam.name}: ${fam.title}`, '',
      `Written file: ${fam.original.status}${fam.original.detail ? ` (${fam.original.detail})` : ''}. Saved by Guitar Pro (\`${fam.name}.saved.gp\`): ${fam.saved.status}${fam.saved.detail ? ` (${fam.saved.detail})` : ''}. MIDI (\`${fam.name}.mid\`): ${fam.midi.status}${fam.midi.detail ? ` (${fam.midi.detail})` : ''}.`, '');
    for (const note of fam.notes) out.push(`- ${note}`);
    if (fam.notes.length) out.push('');
    if (fam.selectors.length) {
      out.push('| element | in written | in saved | result | detail |', '|---|---|---|---|---|');
      for (const s of fam.selectors) out.push(`| \`${s.selector}\` | ${s.written} | ${s.returned} | ${label[s.status] ?? s.status} | ${String(s.detail).replace(/\|/g, '/').replace(/\r?\n/g, ' ')} |`);
      out.push('');
    }
    if (fam.midiCompare) {
      const m = fam.midiCompare;
      out.push(`MIDI: ${m.observedNotes} notes observed, ${m.expectedNotes} expected (${m.noteCountMatches ? 'same count' : 'different count'}); ${m.tracks} track(s), ${m.ppq} ticks per quarter, first tempo ${m.firstTempoBpm} BPM, ${m.tempoEvents} tempo event(s).`);
      out.push(`Onsets: ${m.observedOnsets} distinct observed, ${m.expectedOnsets} expected; ${m.missingCount} expected onset(s) not found${m.missingCount ? ` (quarters ${m.missingOnsets.join(', ')}${m.missingCount > m.missingOnsets.length ? ', ...' : ''})` : ''}; ${m.extraCount} extra${m.extraCount ? ` (quarters ${m.extraOnsets.join(', ')}${m.extraCount > m.extraOnsets.length ? ', ...' : ''})` : ''}. Last note ends at ${m.endQuarters} quarters (the written bars are ${m.expectedQuarters}; trailing rests make the last note end earlier), ${m.endSeconds} s (nominal for the written bars ${m.nominalSeconds} s).`);
      out.push(m.timingNote ? m.timingNote : `Timing ${m.timingMatches ? 'matches the written bars' : 'differs from the written bars'} within ${TICK_TOLERANCE_QUARTERS} quarter. Trills, tremolo picking, brushes and grace notes can legitimately add or move note starts.`);
      if (m.allKeysZero) out.push('Every note is at MIDI key 0, as in the earlier probe export; pitch cannot be compared.');
      out.push('');
    }
    if (fam.control) {
      out.push('Fermata control:', '```json', JSON.stringify(fam.control, null, 1), '```', '');
    }
  }
  if (result.unrecognised.length) out.push('## Files in the folder that the kit does not recognise', '', ...result.unrecognised.map((n) => `- ${n}`), '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------
export function main(argv) {
  const [command, dir] = argv;
  if (command === 'write') {
    let made;
    try { made = writeKit(dir); } catch (error) { console.error(`error: ${error.message}`); return 1; }
    const { out, files, warnings, families } = made;
    console.log(`Wrote ${families.length} Guitar Pro files from TabPlayer's exporter, checklist.md and kit-manifest.json to ${out}`);
    for (const f of files) console.log(`  ${f}`);
    for (const w of warnings) console.log(`warning: ${w}`);
    console.log('Next: follow checklist.md in an activated Guitar Pro 8, then run `collect`.');
    return 0;
  }
  if (command === 'collect') {
    const result = collectKit(dir);
    const out = resolve(dir ?? DEFAULT_DIR);
    try {
      writeFileSync(join(out, 'results.md'), resultsMarkdown(result)); writeFileSync(join(out, 'results.json'), JSON.stringify(result, null, 1));
    } catch (error) { console.error(`Could not write results: ${error?.message ?? error}`); return 1; }
    for (const p of result.problems) console.log(`problem: ${p}`);
    for (const fam of result.families) {
      const tally = { same: 0, absent: 0, changed: 0, added: 0, none: 0, error: 0 };
      for (const s of fam.selectors) tally[s.status] = (tally[s.status] ?? 0) + 1;
      console.log(`${fam.name}: saved ${fam.saved.status}, midi ${fam.midi.status}${fam.selectors.length ? `; elements same ${tally.same}, absent ${tally.absent}, changed ${tally.changed}, added ${tally.added}, not present ${tally.none}` : ''}`);
    }
    console.log(`Wrote ${join(out, 'results.md')} and results.json`);
    return result.problems.length ? 1 : 0;
  }
  console.error('Usage: node scripts/gp8-acceptance-kit.mjs write [dir] | collect [dir]');
  return 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = main(process.argv.slice(2));
