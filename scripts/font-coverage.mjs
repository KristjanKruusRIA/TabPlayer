// Writes src/engraving/font-coverage.json (inclusive code point ranges per bundled text face) and
// scripts/music-substitutes.json (the reviewed list of glyphs a music font lacks, drawn from Bravura instead).
// Run `node scripts/font-coverage.mjs` after changing a font; the test compares both files with a fresh build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codePoints } from './font-cmap.mjs';
import { neededGlyphs, smuflNameOfSymbol } from '../src/engraving/smufl.ts';

const root = new URL('../', import.meta.url);
const TEXT_FAMILIES = new Set(['Noto Sans', 'Noto Serif', 'Noto Sans Mono']);

export const coveragePath = fileURLToPath(new URL('src/engraving/font-coverage.json', root));
export const substitutesPath = fileURLToPath(new URL('scripts/music-substitutes.json', root));
export const fontsDir = fileURLToPath(new URL('assets/fonts/', root));

export function readSources(dir = fontsDir) {
  return JSON.parse(readFileSync(`${dir}/sources.json`, 'utf8')).fonts;
}

export function toRanges(points) {
  const sorted = [...points].sort((a, b) => a - b);
  const ranges = [];
  for (const point of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && point === last[1] + 1) last[1] = point;
    else ranges.push([point, point]);
  }
  return ranges;
}

export function readCodePoints(file, dir = fontsDir) {
  return codePoints(new Uint8Array(readFileSync(`${dir}/${file}`)));
}

/** Coverage ranges for every bundled text face, keyed by file name. */
export function buildCoverage(dir = fontsDir) {
  const coverage = {};
  for (const font of readSources(dir).filter((entry) => TEXT_FAMILIES.has(entry.family))) {
    coverage[font.filename] = toRanges(readCodePoints(font.filename, dir));
  }
  return coverage;
}

/** `MusicFontSymbol` members as `{smuflName: codePoint}`, read from alphaTab's source text (the package does not export the enum). */
export function symbolCodePoints() {
  const text = readFileSync(fileURLToPath(new URL('node_modules/@coderline/alphatab/dist/alphaTab.core.mjs', root)), 'utf8');
  const start = text.indexOf('var MusicFontSymbol = ');
  const end = text.indexOf('//#endregion', start);
  if (start < 0 || end < 0) throw new Error('MusicFontSymbol enum not found in alphaTab.core.mjs');
  const map = {};
  for (const match of text.slice(start, end).matchAll(/MusicFontSymbol\["(\w+)"\] = (-?\d+)\]/g)) {
    map[smuflNameOfSymbol(match[1])] = Number(match[2]);
  }
  return map;
}

/** For each non-Bravura music font, the needed glyph names it lacks (no code point or no bbox in its metadata). */
export function buildSubstitutes({ bravuraMetadata, dir = fontsDir, symbols = symbolCodePoints() } = {}) {
  const needed = neededGlyphs(bravuraMetadata);
  const result = {};
  for (const font of readSources(dir).filter((entry) => entry.smuflMetadata)) {
    const id = font.family.toLowerCase();
    const points = readCodePoints(font.filename, dir);
    const metadata = JSON.parse(readFileSync(`${dir}/${font.smuflMetadata.filename}`, 'utf8'));
    const boxes = new Set(neededGlyphs(metadata));
    result[id] = needed.filter((name) => !(symbols[name] !== undefined && points.has(symbols[name]) && boxes.has(name)));
  }
  return result;
}

export function format(value) {
  const lines = Object.entries(value).map(([key, item]) => `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { EngravingSettings } = await import('@coderline/alphatab');
  writeFileSync(coveragePath, format(buildCoverage()));
  const substitutes = buildSubstitutes({ bravuraMetadata: EngravingSettings.bravuraMetadata });
  writeFileSync(substitutesPath, format(substitutes));
  for (const [id, names] of Object.entries(substitutes)) console.log(`${id}: ${names.length} substituted glyph names`);
}
