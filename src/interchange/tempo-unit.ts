import type { model } from '@coderline/alphatab';
import { isTempoUnit, quarterUnit, setTempoUnit, tempoUnitOf, unitQuarters, displayedBpm } from '../editor/tempo-unit';

/**
 * A GP tempo automation is `<Value>120 3</Value>`: a tempo and the note it counts, coded 1 eighth, 2 quarter,
 * 3 dotted quarter, 4 half, 5 dotted half. alphaTab multiplies the pair into quarter notes per minute when it reads
 * and always writes the quarter code, so the unit is read and written here. alphaTab keeps a bar's tempo
 * automations in file order and writes them in model order, so the nth tempo of a bar in the file is the nth
 * tempo automation of that bar in the model; two at one position are told apart by that order.
 */
const tolerance = 1e-6;
/** The tempo text of a unit-bearing automation, unrounded so that reading it back plays the tempo that was written. */
const written = (automation: model.Automation) => String(displayedBpm(automation));

/** Gives each tempo automation the unit its GPIF value names. A value that disagrees with what alphaTab read is left as it is. */
export function readGpifTempoUnits(score: model.Score, doc: Document): void {
  const seen = new Map<number, number>();
  for (const node of doc.querySelectorAll('GPIF > MasterTrack > Automations > Automation')) {
    const field = (name: string) => node.querySelector(`:scope > ${name}`)?.textContent?.trim() ?? '';
    if (field('Type') !== 'Tempo') continue;
    const bar = Number(field('Bar')), ordinal = seen.get(bar) ?? 0;
    seen.set(bar, ordinal + 1);
    const parts = field('Value').split(/\s+/), position = Number(field('Position')), value = Number(parts[0]), unit = Number(parts[1]);
    if (parts.length !== 2 || !isTempoUnit(unit) || unit === quarterUnit || !Number.isInteger(bar) || !Number.isFinite(position) || !Number.isFinite(value) || value <= 0) continue;
    const automation = score.masterBars[bar]?.tempoAutomations[ordinal];
    if (automation && automation.ratioPosition === position && Math.abs(automation.value - value * unitQuarters[unit]) <= tolerance * Math.max(1, automation.value)) setTempoUnit(automation, unit);
  }
}

/**
 * Rewrites the tempo values of generated GPIF text to the unit each automation is written in. alphaTab's writer
 * emits every `<Automation>` of the master track as a plain `<Automation>...</Automation>` element, so the text is
 * patched in place, which also keeps the exporter's projection of the original file valid.
 */
export function writeGpifTempoUnits(score: model.Score, xml: string): string {
  // Score text (title, notices) is CDATA and may hold anything, tags included; blank it out of every search and
  // patch the original at the same offsets.
  const masked = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, text => ' '.repeat(text.length));
  const start = masked.indexOf('<MasterTrack>'), end = start < 0 ? -1 : masked.indexOf('</MasterTrack>', start);
  if (start < 0 || end < 0) return xml;
  const tag = (block: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1];
  const seen = new Map<number, number>();
  let out = '', at = start;
  for (const match of masked.slice(start, end).matchAll(/<Automation>[\s\S]*?<\/Automation>/g)) {
    const from = start + match.index, to = from + match[0].length, block = xml.slice(from, to);
    if (tag(block, 'Type') !== 'Tempo') continue;
    const bar = Number(tag(block, 'Bar')), position = Number(tag(block, 'Position')), ordinal = seen.get(bar) ?? 0;
    seen.set(bar, ordinal + 1);
    const automation = score.masterBars[bar]?.tempoAutomations[ordinal];
    if (!automation || automation.ratioPosition !== position || tempoUnitOf(automation) === quarterUnit) continue;
    out += xml.slice(at, from) + block.replace(/<Value>[^<]*<\/Value>/, `<Value>${written(automation)} ${tempoUnitOf(automation)}</Value>`);
    at = to;
  }
  return xml.slice(0, start) + out + xml.slice(at);
}
