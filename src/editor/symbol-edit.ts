import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import type { MessageKey } from '../i18n';
import { getHarmonyChord } from '../harmony/chord-source';
import { measureSettingsExact, readMeasureSettings } from './measure-settings';

/**
 * Direct symbol editing: the title, a tempo mark, a chord name or a clef, picked on the rendered score. Every builder here
 * returns an existing edit (setScoreInfo, setMeasureSettings, setHarmonyChord, setBarNotation), so one gesture is one undoable
 * edit and replays like the inspector's. Choosing the value a symbol already has builds nothing.
 */
export type SymbolRef =
  | { kind: 'title' }
  /** `index` counts the measure's tempo automations in order, hidden ones included, as setMeasureSettings does. */
  | { kind: 'tempo'; bar: number; index: number }
  | { kind: 'chord'; target: BeatTarget }
  | { kind: 'clef'; track: number; staff: number; bar: number };

export type SymbolProblem = { key: MessageKey; params?: Record<string, string | number> };
/** `unchanged` is a successful no-op: nothing is recorded. */
export type SymbolBuild = { command: EditCommand } | { unchanged: true } | { error: SymbolProblem };

export const clefChoices = [
  { value: model.Clef.G2, label: 'symbol.clef_treble' },
  { value: model.Clef.F4, label: 'symbol.clef_bass' },
  { value: model.Clef.C3, label: 'symbol.clef_alto' },
  { value: model.Clef.C4, label: 'symbol.clef_tenor' },
  { value: model.Clef.Neutral, label: 'symbol.clef_neutral' },
] as const satisfies readonly { value: number; label: MessageKey }[];

export const MAX_CHORD_NAME = 64;
const stale: SymbolBuild = { error: { key: 'symbol.stale' } };

/** Same bounds as the command palette's tempo command. */
export function parseTempo(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= 999 ? value : null;
}

const barOf = (score: model.Score, ref: Extract<SymbolRef, { kind: 'clef' }>) => score.tracks[ref.track]?.staves[ref.staff]?.bars[ref.bar];
const beatOf = (score: model.Score, target: BeatTarget) => score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];

/** The text the editor starts with; empty when the symbol no longer exists. */
export function symbolText(score: model.Score, ref: SymbolRef): string {
  if (ref.kind === 'title') return score.title;
  if (ref.kind === 'tempo') return String(score.masterBars[ref.bar]?.tempoAutomations[ref.index]?.value ?? '');
  if (ref.kind === 'chord') { const chord = beatOf(score, ref.target)?.chord; return chord ? chord.name : ''; }
  return '';
}

/** The tempo setScoreInfo must be given so that it leaves the tempo as it is: what the first measure's opening mark says. */
const initialTempo = (score: model.Score) => score.masterBars[0]?.tempoAutomations.find(automation => automation.ratioPosition === 0)?.value ?? score.tempo;

/**
 * setScoreInfo rebuilds the opening tempo mark as a plain, visible, unlabelled one. A score whose opening mark is anything else
 * (labelled, gradual, hidden, or only in the middle of the measure) would lose that, so renaming it here is refused.
 */
const openingTempoSurvives = (score: model.Score) => {
  const opening = score.masterBars[0]?.tempoAutomations.find(automation => automation.ratioPosition === 0);
  return !!opening && opening.isVisible && !opening.text && !opening.isLinear;
};

export function titleEdit(score: model.Score, text: string): SymbolBuild {
  const title = text.trim();
  if (title === score.title || title === score.title.trim()) return { unchanged: true };
  if (!openingTempoSurvives(score)) return { error: { key: 'symbol.title_inexact' } };
  return { command: { type: 'setScoreInfo', title, artist: score.artist, tempo: initialTempo(score) } };
}

/** setMeasureSettings rebuilds every mark of the measure as a visible one on a beat, so a hidden one would come back. */
const rewritable = (score: model.Score, bar: number) => measureSettingsExact(score, bar) && (score.masterBars[bar]?.tempoAutomations.every(automation => automation.isVisible) ?? false);
const isInitialTempo = (ref: Extract<SymbolRef, { kind: 'tempo' }>, automation: model.Automation) => ref.bar === 0 && automation.ratioPosition === 0;

export function tempoEdit(score: model.Score, ref: Extract<SymbolRef, { kind: 'tempo' }>, text: string): SymbolBuild {
  const value = parseTempo(text);
  if (value === null) return { error: { key: 'symbol.tempo_invalid' } };
  const automation = score.masterBars[ref.bar]?.tempoAutomations[ref.index];
  if (!automation) return stale;
  if (automation.value === value) return { unchanged: true };
  // The initial tempo has its own edit; a label or a gradual change would not survive it, so those go through the measure rewrite.
  if (isInitialTempo(ref, automation) && automation.isVisible && !automation.text && !automation.isLinear) return { command: { type: 'setScoreInfo', title: score.title, artist: score.artist, tempo: value } };
  if (!rewritable(score, ref.bar)) return { error: { key: 'symbol.tempo_inexact', params: { bar: ref.bar + 1 } } };
  const settings = readMeasureSettings(score, ref.bar);
  return { command: { type: 'setMeasureSettings', bar: ref.bar, ...settings, tempos: settings.tempos.map((point, index) => (index === ref.index ? { ...point, bpm: value } : point)) } };
}

/** The initial tempo cannot be removed; any other mark can, when the measure can be rewritten as it is. */
export function canRemoveTempo(score: model.Score, ref: Extract<SymbolRef, { kind: 'tempo' }>): boolean {
  const automation = score.masterBars[ref.bar]?.tempoAutomations[ref.index];
  return !!automation && !isInitialTempo(ref, automation) && rewritable(score, ref.bar);
}

export function removeTempoEdit(score: model.Score, ref: Extract<SymbolRef, { kind: 'tempo' }>): SymbolBuild {
  const automation = score.masterBars[ref.bar]?.tempoAutomations[ref.index];
  if (!automation) return stale;
  if (isInitialTempo(ref, automation)) return { error: { key: 'symbol.tempo_initial' } };
  if (!rewritable(score, ref.bar)) return { error: { key: 'symbol.tempo_inexact', params: { bar: ref.bar + 1 } } };
  const settings = readMeasureSettings(score, ref.bar);
  return { command: { type: 'setMeasureSettings', bar: ref.bar, ...settings, tempos: settings.tempos.filter((_, index) => index !== ref.index) } };
}

export function chordNameEdit(score: model.Score, ref: Extract<SymbolRef, { kind: 'chord' }>, text: string): SymbolBuild {
  const name = text.trim();
  if (!name) return { error: { key: 'symbol.chord_empty' } };
  if ([...name].length > MAX_CHORD_NAME) return { error: { key: 'symbol.chord_long', params: { max: MAX_CHORD_NAME } } };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f￾￿]/.test(name)) return { error: { key: 'symbol.chord_chars' } };
  const beat = beatOf(score, ref.target), chord = beat?.chord;
  if (!beat || !chord) return stale;
  const current = getHarmonyChord(chord);
  if (current.name === name || current.name.trim() === name) return { unchanged: true };
  // A chord that carries only a name (some imports) has no diagram for this staff; setHarmonyChord needs one position per string.
  if (current.frets.length !== beat.voice.bar.staff.tuning.length) return { error: { key: 'symbol.chord_shape' } };
  // A typed name is the chord's own name, so a formula behind the old one no longer describes it.
  return { command: { type: 'setHarmonyChord', target: ref.target, chord: { ...current, name, nameMode: 'manual', recipe: null }, fillEmptyBeat: false } };
}

export function removeChordEdit(score: model.Score, ref: Extract<SymbolRef, { kind: 'chord' }>): SymbolBuild {
  if (!beatOf(score, ref.target)?.chord) return stale;
  return { command: { type: 'setHarmonyChord', target: ref.target, chord: null, fillEmptyBeat: false } };
}

export function clefEdit(score: model.Score, ref: Extract<SymbolRef, { kind: 'clef' }>, clef: number): SymbolBuild {
  const bar = barOf(score, ref);
  if (!bar) return stale;
  if (bar.clef === clef) return { unchanged: true };
  return { command: { type: 'setBarNotation', track: ref.track, staff: ref.staff, bar: ref.bar, keySignature: bar.keySignature, keyMode: bar.keySignatureType, clef } };
}

/** The clef of the bar a clef symbol belongs to, or null when the bar is gone. */
export function currentClef(score: model.Score, ref: Extract<SymbolRef, { kind: 'clef' }>): number | null {
  return barOf(score, ref)?.clef ?? null;
}

export type SymbolAction = 'editTitle' | 'editTempo' | 'removeTempo' | 'editChord' | 'openChordEditor' | 'removeChord' | 'chooseClef';
export interface SymbolMenuItem { action: SymbolAction; label: MessageKey; params?: Record<string, string | number>; /** The action opens another view rather than recording an edit. */ opens: boolean }

/**
 * The actions that fit one clicked symbol, in menu order. `place` names where the symbol is (measure or chord) in the labels,
 * for the keyboard menu that lists several symbols at once.
 */
export function symbolMenu(score: model.Score, ref: SymbolRef, place = false): SymbolMenuItem[] {
  if (ref.kind === 'title') return [{ action: 'editTitle', label: 'symbol.edit_title', opens: true }];
  if (ref.kind === 'tempo') {
    const where = { bar: ref.bar + 1, value: symbolText(score, ref) };
    const items: SymbolMenuItem[] = [place ? { action: 'editTempo', label: 'symbol.edit_tempo_at', params: where, opens: true } : { action: 'editTempo', label: 'symbol.edit_tempo', opens: true }];
    if (canRemoveTempo(score, ref)) items.push(place ? { action: 'removeTempo', label: 'symbol.remove_tempo_at', params: where, opens: false } : { action: 'removeTempo', label: 'symbol.remove_tempo', opens: false });
    return items;
  }
  if (ref.kind === 'chord') return [
    place ? { action: 'editChord', label: 'symbol.edit_chord_name_at', params: { name: symbolText(score, ref) }, opens: true } : { action: 'editChord', label: 'symbol.edit_chord_name', opens: true },
    { action: 'openChordEditor', label: 'symbol.open_chord_editor', opens: false },
    { action: 'removeChord', label: 'symbol.remove_chord', opens: false },
  ];
  return [place ? { action: 'chooseClef', label: 'symbol.change_clef_at', params: { bar: ref.bar + 1 }, opens: true } : { action: 'chooseClef', label: 'symbol.change_clef', opens: true }];
}

/**
 * The symbols a keyboard user can reach from the edit target, which has no pointer position: the title, the tempo marks of its
 * measure (the initial tempo when that measure has none), its beat's chord name, and the clef of its staff.
 */
export function targetSymbols(score: model.Score, target: BeatTarget, tracks: readonly number[]): SymbolRef[] {
  const refs: SymbolRef[] = [{ kind: 'title' }];
  const automations = score.masterBars[target.bar]?.tempoAutomations ?? [];
  const shown = automations.flatMap((automation, index) => (automation.isVisible ? [index] : [])), initial = score.masterBars[0]?.tempoAutomations.findIndex(automation => automation.isVisible && automation.ratioPosition === 0) ?? -1;
  if (shown.length) for (const index of shown) refs.push({ kind: 'tempo', bar: target.bar, index });
  else if (initial >= 0) refs.push({ kind: 'tempo', bar: 0, index: initial });
  if (tracks.includes(target.track) && beatOf(score, target)?.chord) refs.push({ kind: 'chord', target });
  const staff = score.tracks[target.track]?.staves[target.staff];
  if (tracks.includes(target.track) && staff?.showStandardNotation && staff.bars[target.bar]) refs.push({ kind: 'clef', track: target.track, staff: target.staff, bar: target.bar });
  return refs;
}
