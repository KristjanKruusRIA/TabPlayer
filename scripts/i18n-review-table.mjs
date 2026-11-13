#!/usr/bin/env node
// THE-76 translation review kit.
//   node scripts/i18n-review-table.mjs [--lang et|de] [--out <dir>]   writes review-<lang>.csv and review-<lang>.md (default .analysis/i18n-review/)
//   node scripts/i18n-review-table.mjs --apply <csv> [--lang et|de]   prints the replacements a filled-in CSV would make; writes nothing
// The catalogs are TypeScript object literals (src/i18n/en.ts, et.ts, de.ts). This script imports them with Node's built-in type
// stripping (Node 22.18 or newer; CI uses 24), so the values are the real ones, not a text guess. It stops with an error if a
// catalog cannot be imported, if a key line in the source is not in the imported object (duplicate or unusual syntax), or if a
// value is not a string.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LANGUAGES = ['et', 'de'];
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = '.analysis/i18n-review';
export const MAX_CSV_BYTES = 16 * 1024 * 1024;
export const COLUMNS = ['key', 'English', 'current translation', 'placeholders in English', 'placeholders in translation', 'flags', 'details', 'correction'];

/** Terms that earlier validation notes ask a reviewer to check, or that they record as chosen or forbidden.
 *  kind: 'check' = the note asks for a native speaker's judgement; 'chosen' = the note records this wording as the decision, confirm it;
 *  'forbidden' = the note says this must not appear (a hit is a regression).
 *  side: which text is searched: 'translation', 'english', or 'key'. `match` is a case-insensitive substring or a RegExp. */
export const REVIEW_TERMS = [
  { id: 'et-note-values', lang: 'et', side: 'english', kind: 'check', match: /\b(whole|half|quarter|eighth|sixteenth|thirty-second|sixty-fourth)\b/i,
    note: 'Estonian note values should be checked by a native speaker.', source: '2026-10-31-gp8-localization.md, Limits' },
  { id: 'de-unfinalize', lang: 'de', side: 'translation', kind: 'check', match: 'Fertigstellung aufheben',
    note: 'German "Fertigstellung aufheben" should be checked by a native speaker.', source: '2026-10-31-gp8-localization.md, Limits' },
  { id: 'de-strg', lang: 'de', side: 'translation', kind: 'check', match: 'Strg',
    note: 'German shortcut labels use "Strg" for Ctrl; Shift and Cmd are left as they are.', source: '2026-10-31-gp8-localization.md, Limits' },
  { id: 'de-ctrl', lang: 'de', side: 'translation', kind: 'forbidden', match: 'Ctrl',
    note: 'No "Ctrl" in German text (pinned by a test).', source: '2026-10-31-gp8-localization.md, Evidence' },
  { id: 'et-flazolett', lang: 'et', side: 'translation', kind: 'chosen', match: 'Flazolett',
    note: 'Chosen Estonian term for harmonic.', source: '2026-10-31-gp8-localization-complete.md, Review' },
  { id: 'et-32nds', lang: 'et', side: 'translation', kind: 'chosen', match: 'Kolmekümnekahend',
    note: 'Chosen Estonian term for thirty-second notes (Kolmekümnekahendikud).', source: '2026-10-31-gp8-localization-complete.md, Review' },
  { id: 'et-keep', lang: 'et', side: 'translation', kind: 'chosen', match: 'Jäta alles',
    note: 'Chosen Estonian term for Keep.', source: '2026-10-31-gp8-localization-complete.md, Review' },
  ...['medikaator', 'flazool', 'Balkeni', 'fermat', 'kolmekümnekahjandik', 'puhver'].map((word) => ({
    id: `et-forbidden-${word}`, lang: 'et', side: 'translation', kind: 'forbidden', match: new RegExp(`${word}(?!a)`, 'i'),
    note: `Review pattern the notes forbid in Estonian text: "${word}".`, source: '2026-10-31-gp8-localization-complete.md, Review' })),
  { id: 'de-haltebogen', lang: 'de', side: 'translation', kind: 'chosen', match: 'Haltebogen',
    note: 'Chosen German term for a tie.', source: '2026-10-31-gp8-localization-complete.md, Review' },
  { id: 'de-bindung', lang: 'de', side: 'translation', kind: 'forbidden', match: 'Bindung',
    note: 'German tie is "Haltebogen", never "Bindung".', source: '2026-10-31-gp8-localization-complete.md, Review' },
  { id: 'de-tapping', lang: 'de', side: 'translation', kind: 'chosen', match: 'Tapping mit der linken Hand',
    note: 'Chosen German wording.', source: '2026-10-31-gp8-localization-complete.md, Review' },
  { id: 'de-bogenziel', lang: 'de', side: 'translation', kind: 'chosen', match: 'Explizites Bogenziel',
    note: 'Chosen German wording.', source: '2026-10-31-gp8-localization-complete.md, Review' },
  { id: 'palette-words', lang: '*', side: 'key', kind: 'check', match: /^palette\.(command|hint|aliases|error)_/,
    note: 'Command palette titles, hints, errors and native search alias words. The notes say the alias words are a first choice and may miss forms a speaker expects.', source: '2026-11-13-the-203-command-palette-i18n.md, Limits' },
  { id: 'et-krihv', lang: 'et', side: 'translation', kind: 'chosen', match: 'krihv',
    note: 'Estonian fret is "krihv", not "astmetraat".', source: '2026-11-13-the-203-command-palette-i18n.md, Terms' },
  { id: 'et-astmetraat', lang: 'et', side: 'translation', kind: 'check', match: 'astmetraat',
    note: 'The palette note chose "krihv" for fret over "astmetraat", but other catalog text still uses "astmetraat"; the reviewer should pick one term.', source: '2026-11-13-the-203-command-palette-i18n.md, Terms' },
  { id: 'de-beat', lang: 'de', side: 'translation', kind: 'check', match: /\bBeat\b/,
    note: '"Beat einfügen" and "Beat löschen" match the editor buttons and were kept.', source: '2026-11-13-the-203-command-palette-i18n.md, Terms' },
];

// ---------------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------------
function keyLinesIn(source) {
  const keys = [];
  source.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s{2}(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/.exec(line);
    if (m) keys.push({ key: (m[1] ?? m[2]).replace(/\\(.)/g, '$1'), line: i + 1 });
  });
  return keys;
}

/** Imports src/i18n/<lang>.ts and checks it against the key lines found in the file. Throws with a clear message on any doubt. */
export async function loadCatalog(lang, root = ROOT) {
  const file = join(root, 'src', 'i18n', `${lang}.ts`);
  let mod;
  try { mod = await import(pathToFileURL(file).href); }
  catch (error) { throw new Error(`Cannot import ${file}. This script needs Node 22.18 or newer (type stripping). ${error.message}`); }
  const catalog = mod[lang];
  if (!catalog || typeof catalog !== 'object') throw new Error(`${file} does not export an object named "${lang}".`);
  const lines = keyLinesIn(readFileSync(file, 'utf8'));
  const keys = Object.keys(catalog);
  for (const key of keys) if (typeof catalog[key] !== 'string') throw new Error(`${file}: value of "${key}" is ${typeof catalog[key]}, not a string.`);
  const seen = new Set();
  for (const { key, line } of lines) {
    if (seen.has(key)) throw new Error(`${file}:${line}: duplicate key "${key}".`);
    seen.add(key);
    if (!(key in catalog)) throw new Error(`${file}:${line}: key "${key}" is in the source but not in the imported object.`);
  }
  if (seen.size !== keys.length) {
    const missing = keys.filter((key) => !seen.has(key)).slice(0, 5);
    throw new Error(`${file}: the object has ${keys.length} keys but ${seen.size} key lines were found; for example "${missing.join('", "')}" is not on a line of its own.`);
  }
  return { catalog, lines: new Map(lines.map((l) => [l.key, l.line])), file };
}

// ---------------------------------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------------------------------
/** Sorted, unique {name} tokens in a message. */
export function placeholders(text) {
  return [...new Set([...String(text ?? '').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The run of whitespace, punctuation and symbols at each end of a message. */
export function edges(text) {
  const s = String(text ?? '');
  return { lead: /^[\s\p{P}\p{S}]*/u.exec(s)[0], trail: /[\s\p{P}\p{S}]*$/u.exec(s)[0] };
}
/** Describes how the ends differ, or '' when they match. */
export function edgeDifference(english, translation) {
  const a = edges(english), b = edges(translation), show = (s) => JSON.stringify(s);
  const parts = [];
  if (a.lead !== b.lead) parts.push(`start ${show(a.lead)} -> ${show(b.lead)}`);
  if (a.trail !== b.trail) parts.push(`end ${show(a.trail)} -> ${show(b.trail)}`);
  return parts.join('; ');
}

function termHits(lang, key, english, translation, terms) {
  const hits = [];
  for (const term of terms) {
    if (term.lang !== '*' && term.lang !== lang) continue;
    const subject = term.side === 'key' ? key : term.side === 'english' ? english : translation;
    const found = term.match instanceof RegExp ? term.match.test(subject) : subject.toLowerCase().includes(term.match.toLowerCase());
    if (found) hits.push(term);
  }
  return hits;
}

/** One row per English key, in English catalog order. `terms` is injectable for tests. */
export function buildRows(lang, english, translated, terms = REVIEW_TERMS) {
  const has = (key) => Object.prototype.hasOwnProperty.call(translated, key);
  const byEnglishText = new Map();
  for (const key of Object.keys(english)) {
    const text = english[key];
    if (!byEnglishText.has(text)) byEnglishText.set(text, []);
    byEnglishText.get(text).push(key);
  }
  return Object.keys(english).map((key) => {
    const en = english[key];
    const present = has(key);
    const tr = present ? translated[key] : '';
    const flags = [], details = [];
    const phEn = placeholders(en), phTr = placeholders(tr);
    if (!present || tr.trim() === '') flags.push('missing');
    else {
      if (tr === en) flags.push('identical');
      if (!sameList(phEn, phTr)) {
        flags.push('placeholders');
        const lost = phEn.filter((p) => !phTr.includes(p)), added = phTr.filter((p) => !phEn.includes(p));
        details.push(`placeholders: missing ${lost.map((p) => `{${p}}`).join(' ') || 'none'}; extra ${added.map((p) => `{${p}}`).join(' ') || 'none'}`);
      }
      const edge = edgeDifference(en, tr);
      if (edge) { flags.push('edges'); details.push(`edges: ${edge}`); }
      const different = (byEnglishText.get(en) ?? []).filter((other) => other !== key && has(other) && translated[other].trim() !== '' && translated[other] !== tr);
      if (different.length) {
        flags.push('inconsistent');
        details.push(`same English text translated differently in: ${different.map((other) => `${other} = ${JSON.stringify(translated[other])}`).join('; ')}`);
      }
    }
    for (const term of termHits(lang, key, en, tr, terms)) {
      flags.push(`${term.kind === 'forbidden' ? 'forbidden-term' : 'term'}:${term.id}`);
      details.push(`${term.kind}: ${term.note} (${term.source})`);
    }
    return { key, english: en, translation: tr, phEnglish: phEn, phTranslation: phTr, flags, details };
  });
}

/** Counts rows per flag family. A term flag counts under 'term' or 'forbidden-term' however many terms hit. */
export function countFlags(rows) {
  const counts = { rows: rows.length, flagged: 0, missing: 0, identical: 0, placeholders: 0, edges: 0, inconsistent: 0, term: 0, 'forbidden-term': 0 };
  for (const row of rows) {
    if (row.flags.length) counts.flagged += 1;
    for (const family of new Set(row.flags.map((flag) => flag.split(':')[0]))) if (family in counts) counts[family] += 1;
  }
  return counts;
}

/** Area is the key prefix before the first dot; a key without a dot is its own area. */
export const areaOf = (key) => (key.includes('.') ? key.slice(0, key.indexOf('.')) : key);
export function groupByArea(rows) {
  const groups = new Map();
  for (const row of rows) {
    const area = areaOf(row.key);
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(row);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------------
/** RFC 4180: fields with a comma, quote, CR or LF are quoted and inner quotes doubled; rows end with CRLF. */
export function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (fields) => fields.map(csvField).join(',');
/** UTF-8 with a byte order mark so Excel reads it as UTF-8. Rows are grouped by area. */
export function rowsToCsv(rows) {
  const lines = [csvLine(COLUMNS)];
  for (const list of groupByArea(rows).values()) {
    for (const row of list) lines.push(csvLine([row.key, row.english, row.translation, row.phEnglish.join(' '), row.phTranslation.join(' '), row.flags.join(' '), row.details.join(' | '), '']));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
const mdCell = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').replace(/`/g, '\\`') || ' ';
const LANGUAGE_NAME = { et: 'Estonian', de: 'German' };
export function rowsToMarkdown(lang, rows) {
  const counts = countFlags(rows);
  const out = [
    `# ${LANGUAGE_NAME[lang] ?? lang} translation review`, '',
    `${counts.rows} messages, ${counts.flagged} with at least one flag. Nothing here has been reviewed by a native speaker.`, '',
    'Write corrections in the CSV (the last column), not here. This file is for reading. Keep every {name} token exactly as it is.', '',
    `Flags: missing ${counts.missing}, identical ${counts.identical}, placeholders ${counts.placeholders}, edges ${counts.edges}, inconsistent ${counts.inconsistent}, term ${counts.term}, forbidden-term ${counts['forbidden-term']}.`, '',
  ];
  for (const [area, list] of groupByArea(rows)) {
    out.push(`## ${area} (${list.length})`, '', '| key | English | current translation | placeholders (English) | placeholders (translation) | flags | correction |', '|---|---|---|---|---|---|---|');
    for (const row of list) out.push(`| ${mdCell(row.key)} | ${mdCell(row.english)} | ${mdCell(row.translation)} | ${mdCell(row.phEnglish.join(' '))} | ${mdCell(row.phTranslation.join(' '))} | ${mdCell(row.flags.join(' '))} |   |`);
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a filled-in CSV and planning the replacements
// ---------------------------------------------------------------------------------------------------------------------
/** RFC 4180 reader. Strips a BOM, accepts CRLF or LF, and throws on an unterminated quote. */
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = '', i = 0, quoted = false, started = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i += 1; continue; }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { quoted = true; started = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; started = true; i += 1; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      i += 1;
      if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false; continue;
    }
    field += c; started = true; i += 1;
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field (a quote was opened and never closed).');
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Plans replacements. Pure: takes parsed rows and the live catalogs. Returns { changes, refused, unchanged }. */
export function planApply(lang, csvRows, english, translated, lineOf = new Map()) {
  const header = csvRows[0] ?? [];
  const at = (name) => header.indexOf(name);
  const iKey = at('key'), iCur = at('current translation'), iEn = at('English'), iCorr = at('correction');
  if ([iKey, iCur, iEn, iCorr].some((i) => i < 0)) throw new Error(`The CSV header must have the columns key, English, current translation and correction. Found: ${header.join(', ')}`);
  const changes = [], refused = [], seen = new Set();
  let unchanged = 0;
  csvRows.slice(1).forEach((cells, n) => {
    const rowNo = n + 2;
    const key = cells[iKey] ?? '', correction = cells[iCorr] ?? '';
    if (key === '') { if (cells.some((c) => c !== '')) refused.push({ row: rowNo, key, reason: 'row has no key' }); return; }
    if (correction.trim() === '') return;
    const refuse = (reason) => refused.push({ row: rowNo, key, reason });
    if (seen.has(key)) return refuse('key appears twice in the CSV');
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(english, key)) return refuse('key is not in the English catalog');
    if (!Object.prototype.hasOwnProperty.call(translated, key)) return refuse(`key is not in the ${lang} catalog`);
    if ((cells[iEn] ?? '') !== english[key]) return refuse('the English text in the CSV is not the current English text (the catalog changed after this CSV was exported)');
    if ((cells[iCur] ?? '') !== translated[key]) return refuse('the current translation in the CSV is not the current catalog text (the catalog changed after this CSV was exported)');
    const want = placeholders(english[key]), got = placeholders(correction);
    if (!sameList(want, got)) return refuse(`placeholders do not match English: expected ${want.map((p) => `{${p}}`).join(' ') || 'none'}, correction has ${got.map((p) => `{${p}}`).join(' ') || 'none'}`);
    if (correction === translated[key]) { unchanged += 1; return; }
    changes.push({ row: rowNo, key, line: lineOf.get(key) ?? null, from: translated[key], to: correction });
  });
  return { changes, refused, unchanged };
}
export function describePlan(lang, plan) {
  const out = [];
  for (const c of plan.changes) out.push(`src/i18n/${lang}.ts${c.line ? `:${c.line}` : ''}  ${c.key}`, `  - ${JSON.stringify(c.from)}`, `  + ${JSON.stringify(c.to)}`);
  for (const r of plan.refused) out.push(`REFUSED CSV row ${r.row} ${r.key ? `(${r.key}) ` : ''}: ${r.reason}`);
  out.push(`${plan.changes.length} replacement(s) would be made, ${plan.refused.length} row(s) refused, ${plan.unchanged} correction(s) equal to the current text. Nothing was written.`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { langs: [...LANGUAGES], langGiven: false, out: DEFAULT_OUT, apply: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lang') { const v = argv[++i]; if (!LANGUAGES.includes(v)) throw new Error(`--lang must be one of ${LANGUAGES.join(', ')}.`); args.langs = [v]; args.langGiven = true; }
    else if (a === '--out') { args.out = argv[++i]; if (!args.out) throw new Error('--out needs a folder.'); }
    else if (a === '--apply') { args.apply = argv[++i]; if (!args.apply) throw new Error('--apply needs a CSV path.'); }
    else throw new Error(`Unknown argument ${a}. Usage: node scripts/i18n-review-table.mjs [--lang et|de] [--out <dir>] | --apply <csv> [--lang et|de]`);
  }
  return args;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const en = await loadCatalog('en');
  if (args.apply) {
    const file = resolve(args.apply);
    if (!existsSync(file)) throw new Error(`${file} does not exist.`);
    if (statSync(file).size > MAX_CSV_BYTES) throw new Error(`${file} is over ${MAX_CSV_BYTES} bytes; not read.`);
    const guess = /review-(et|de)\b/.exec(basename(file))?.[1];
    const lang = args.langGiven ? args.langs[0] : guess;
    if (!lang) throw new Error('Cannot tell the language from the file name; pass --lang et or --lang de.');
    if (args.langGiven && guess && guess !== lang) throw new Error(`The file name says ${guess} but --lang says ${lang}.`);
    const tr = await loadCatalog(lang);
    const plan = planApply(lang, parseCsv(readFileSync(file, 'utf8')), en.catalog, tr.catalog, tr.lines);
    console.log(describePlan(lang, plan).join('\n'));
    return plan.refused.length ? 2 : 0;
  }
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  for (const lang of args.langs) {
    const tr = await loadCatalog(lang);
    const extra = Object.keys(tr.catalog).filter((key) => !(key in en.catalog));
    const rows = buildRows(lang, en.catalog, tr.catalog);
    const csv = join(out, `review-${lang}.csv`), md = join(out, `review-${lang}.md`);
    writeFileSync(csv, rowsToCsv(rows), 'utf8');
    writeFileSync(md, rowsToMarkdown(lang, rows), 'utf8');
    const c = countFlags(rows);
    console.log(`${lang}: ${c.rows} keys, ${c.flagged} flagged; missing ${c.missing}, identical ${c.identical}, placeholders ${c.placeholders}, edges ${c.edges}, inconsistent ${c.inconsistent}, term ${c.term}, forbidden-term ${c['forbidden-term']}${extra.length ? `; ${extra.length} key(s) not in English: ${extra.slice(0, 5).join(', ')}` : ''}`);
    console.log(`  ${csv}\n  ${md}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`error: ${error.message}`); process.exitCode = 1; });
}
