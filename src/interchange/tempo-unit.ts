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
/** The tempo text of a unit-bearing automation: nine decimals hide the division's rounding noise without moving the sounding tempo. */
const written = (automation: model.Automation) => String(Math.round(displayedBpm(automation) * 1e9) / 1e9);

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
  const start = xml.indexOf('<MasterTrack>'), end = start < 0 ? -1 : xml.indexOf('</MasterTrack>', start);
  if (start < 0 || end < 0) return xml;
  const tag = (block: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1];
  const seen = new Map<number, number>();
  const patched = xml.slice(start, end).replace(/<Automation>[\s\S]*?<\/Automation>/g, block => {
    if (tag(block, 'Type') !== 'Tempo') return block;
    const bar = Number(tag(block, 'Bar')), position = Number(tag(block, 'Position')), ordinal = seen.get(bar) ?? 0;
    seen.set(bar, ordinal + 1);
    const automation = score.masterBars[bar]?.tempoAutomations[ordinal];
    if (!automation || automation.ratioPosition !== position) return block;
    const unit = tempoUnitOf(automation);
    return unit === quarterUnit ? block : block.replace(/<Value>[^<]*<\/Value>/, `<Value>${written(automation)} ${unit}</Value>`);
  });
  return xml.slice(0, start) + patched + xml.slice(end);
}
