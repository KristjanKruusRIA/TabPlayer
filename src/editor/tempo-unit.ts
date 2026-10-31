import { model, type Settings } from '@coderline/alphatab';
import type { MessageKey } from '../i18n/en';

/**
 * The note a tempo counts in. The codes are the ones a GP file's tempo automation uses (`<Value>120 3</Value>`), and
 * the same ones alphaTab's `buildTempoAutomation` takes: 1 an eighth, 2 a quarter, 3 a dotted quarter, 4 a half and
 * 5 a dotted half. A tempo with no unit counts quarter notes, as every tempo did before units existed.
 */
export type TempoUnit = 1 | 2 | 3 | 4 | 5;
export const quarterUnit: TempoUnit = 2;
export const tempoUnits: readonly TempoUnit[] = [1, 2, 3, 4, 5];
/** How many quarter notes one beat of the unit lasts. */
export const unitQuarters: Readonly<Record<TempoUnit, number>> = { 1: 0.5, 2: 1, 3: 1.5, 4: 2, 5: 3 };
/** The name of each unit in the user interface, as an i18n key. */
export const tempoUnitKeys: Readonly<Record<TempoUnit, MessageKey>> = {
  1: 'editor.tempo_unit_eighth', 2: 'editor.tempo_unit_quarter', 3: 'editor.tempo_unit_dotted_quarter', 4: 'editor.tempo_unit_half', 5: 'editor.tempo_unit_dotted_half',
};
/** Whether `value` is one of the unit codes. */
export const isTempoUnit = (value: unknown): value is TempoUnit => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;

// A quarter-note tempo is the only form the score stores or plays. The unit rides along on the automation object as
// an own property (so the copies the editor makes of an automation keep it) and on its JSON object, and only when
// it is not the quarter note, so a score that never used units is bit-for-bit what it was.
const unitKey = 'tabplayerTempoUnit';
type Carrier = model.Automation & { [unitKey]?: TempoUnit };
/** The unit a tempo automation counts in. */
export const tempoUnitOf = (automation: model.Automation): TempoUnit => {
  const unit = (automation as Carrier)[unitKey];
  return isTempoUnit(unit) ? unit : quarterUnit;
};
/** Sets an automation's unit; a quarter clears it. The caller has validated it. */
export function setTempoUnit(automation: model.Automation, unit: TempoUnit): void {
  if (unit === quarterUnit) delete (automation as Carrier)[unitKey];
  else (automation as Carrier)[unitKey] = unit;
}
/** The tempo as the user writes it: beats of the automation's own unit per minute. */
export const displayedBpm = (automation: model.Automation): number => {
  const unit = tempoUnitOf(automation);
  return unit === quarterUnit ? automation.value : automation.value / unitQuarters[unit];
};
/** A tempo rounded for showing (three decimals); the stored value is never rounded. */
export const shownBpm = (bpm: number): number => { const rounded = Math.round(bpm * 1000) / 1000; return rounded === 0 && bpm !== 0 ? bpm : rounded; };
/** A tempo automation for `bpm` beats of `unit` per minute. Its `value` is the quarter-note tempo that plays. */
export function buildTempo(linear: boolean, ratio: number, bpm: number, unit: TempoUnit = quarterUnit, visible = true): model.Automation {
  const automation = model.Automation.buildTempoAutomation(linear, ratio, bpm, unit, visible);
  setTempoUnit(automation, unit);
  return automation;
}

const field = (source: unknown, key: string): unknown => source instanceof Map ? source.get(key) : source !== null && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
const list = (source: unknown, key: string): unknown[] => { const value = field(source, key); return Array.isArray(value) ? value : []; };
const extensionKey = 'tabplayertempounit';
const hooks = Symbol.for('tabplayer.tempoUnit.hooks');
/** Whether any automation of the score has a unit other than the quarter. */
export const scoreUsesTempoUnits = (score: model.Score): boolean => score.masterBars.some(bar => bar.tempoAutomations.some(automation => tempoUnitOf(automation) !== quarterUnit));

/**
 * alphaTab has nowhere to keep a tempo's unit, and every clone of a score goes through its score-to-JSON conversion,
 * so the unit rides along on the automation's own JSON object as an extra field, written only for a non-quarter one.
 * Both hooks are installed once, when this module loads.
 */
function install(): void {
  const prototype = model.Score.prototype as unknown as Record<symbol, unknown>;
  if (prototype[hooks]) return;
  prototype[hooks] = true;
  const converter = model.JsonConverter as unknown as {
    scoreToJsObject(score: model.Score): unknown; jsObjectToScore(value: unknown, settings?: Settings): model.Score;
  };
  const toObject = converter.scoreToJsObject.bind(converter), toScore = converter.jsObjectToScore.bind(converter);
  converter.scoreToJsObject = score => {
    const result = toObject(score);
    score.masterBars.forEach((bar, b) => bar.tempoAutomations.forEach((automation, a) => {
      const unit = tempoUnitOf(automation);
      if (unit === quarterUnit) return;
      const wire = field(list(result, 'masterbars')[b], 'tempoautomations') as unknown[] | undefined;
      const node = wire?.[a];
      if (node instanceof Map) node.set(extensionKey, unit);
      else if (node && typeof node === 'object') (node as Record<string, unknown>)[extensionKey] = unit;
    }));
    return result;
  };
  converter.jsObjectToScore = (value, settings) => {
    const score = toScore(value, settings);
    score.masterBars.forEach((bar, b) => {
      const wire = field(list(value, 'masterbars')[b], 'tempoautomations');
      bar.tempoAutomations.forEach((automation, a) => {
        const unit = Array.isArray(wire) ? field(wire[a], extensionKey) : undefined;
        if (isTempoUnit(unit)) setTempoUnit(automation, unit);
      });
    });
    return score;
  };
}
install();
