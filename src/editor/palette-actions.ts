import { model } from '@coderline/alphatab';
import type { BeatTarget, EditCommand } from '../project';
import type { MessageKey } from '../i18n/en';
import type { BeatTechniques, NoteTechniques } from '../edit-types';
import type { GesturePatch } from './gestures-types';
import { describeSelection } from '../engine';
import { measureSettingsExact, readMeasureSettings, type MeasureSettings } from './measure-settings';
import { beatPedalRatio, pedalMarks, sustainPedalAt } from './sustain-pedal';
import { tremoloMarks } from './common';
import { nextLinkedNote } from './techniques';

/** Panels the palette can open instead of editing directly. */
export type PaletteOpen = 'measure' | 'chord' | 'scales' | 'lyrics';
/** What one click asks for: one edit, a panel, or nothing (the control is off, or the value is already current). */
export type PaletteResult = { edit: EditCommand } | { open: PaletteOpen } | null;
export interface PaletteItem {
  id: string;
  label: MessageKey;
  /** Shown instead of the translated label, for proper names such as "D.S. al Coda". */
  text?: string;
  glyph: string;
  pressed: boolean;
  enabled: boolean;
  activate: () => PaletteResult;
}
export interface PaletteControl extends PaletteItem {
  /** The control opens this list; each entry is one edit. */
  menu?: PaletteItem[];
  /** The control asks for a line of text; submitting it is one edit. */
  prompt?: { value: string; submit: (text: string) => PaletteResult };
}
export interface PaletteGroup { id: string; label: MessageKey; controls: PaletteControl[] }

const DIRECTIONS: ReadonlyArray<readonly [number, string]> = [
  [0, 'Fine'], [1, 'Segno'], [2, 'Double Segno'], [3, 'Coda'], [4, 'Double Coda'],
  [5, 'D.C.'], [6, 'D.C. al Coda'], [7, 'D.C. al Double Coda'], [8, 'D.C. al Fine'],
  [9, 'D.S.'], [10, 'D.S. al Coda'], [11, 'D.S. al Double Coda'], [12, 'D.S. al Fine'],
  [13, 'D.S.S.'], [14, 'D.S.S. al Coda'], [15, 'D.S.S. al Double Coda'], [16, 'D.S.S. al Fine'],
  [17, 'To Coda'], [18, 'To Double Coda'],
];
const TUPLETS: ReadonlyArray<readonly [number, number]> = [[2, 3], [4, 3], [5, 4], [6, 4], [7, 4], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8]];

const edit = (command: EditCommand | null): PaletteResult => (command ? { edit: command } : null);

function control(id: string, label: MessageKey, glyph: string, pressed: boolean, enabled: boolean, command: () => EditCommand | null): PaletteControl {
  return { id, label, glyph, pressed, enabled, activate: () => (enabled ? edit(command()) : null) };
}
function opener(id: string, label: MessageKey, glyph: string, panel: PaletteOpen, enabled = true): PaletteControl {
  return { id, label, glyph, pressed: false, enabled, activate: () => (enabled ? { open: panel } : null) };
}
/** A list control: highlighted while any entry is, usable while any entry is. */
function menu(id: string, label: MessageKey, glyph: string, items: PaletteItem[]): PaletteControl {
  return { id, label, glyph, pressed: items.some(item => item.pressed && !item.id.endsWith('-none')), enabled: items.some(item => item.enabled), activate: () => null, menu: items };
}

/**
 * Every palette control beyond durations, dots, rest, tie, voices and dynamics, for the cursor position.
 * A control is disabled only when the selection makes it meaningless; each click yields at most one edit.
 */
export function paletteGroups(score: model.Score, target: BeatTarget, string: number, noteIndex: number | null): PaletteGroup[] {
  const { staff, voice, beat, master } = describeSelection(score, target);
  const bar = staff.bars[target.bar];
  const indexed = staff.isPercussion || !staff.tuning.length;
  const stringed = !indexed;
  const note = indexed ? (noteIndex === null ? undefined : beat?.notes[noteIndex]) : beat?.notes.find(n => n.string === string);
  const index = note && beat ? beat.notes.indexOf(note) : -1;
  const hasBeat = Boolean(beat);
  const sounding = Boolean(beat && !beat.isRest && beat.notes.length);
  const stringedBeat = sounding && stringed;
  const pitched = Boolean(note && !staff.isPercussion);
  const stringedNote = Boolean(note && stringed);

  const noteEdit = (patch: NoteTechniques): EditCommand | null =>
    !note ? null : indexed ? { type: 'setNoteTechniquesByIndex', target, noteIndex: index, patch } : { type: 'setNoteTechniques', target, string, patch };
  const gesture = (patch: GesturePatch): EditCommand => ({ type: 'setBeatGestures', target, patch });
  const beatTech = (patch: BeatTechniques): EditCommand => ({ type: 'setBeatTechniques', target, patch });
  const noteEnum = (id: string, label: MessageKey, glyph: string, key: 'accent' | 'slideIn' | 'slideOut' | 'vibrato' | 'ornament', current: number, value: number, enabled: boolean) =>
    control(id, label, glyph, current === value, enabled, () => noteEdit({ [key]: current === value ? 0 : value }));
  const noteFlag = (id: string, label: MessageKey, glyph: string, key: 'leftHandTapped' | 'stringNumber', current: boolean, enabled: boolean) =>
    control(id, label, glyph, current, enabled, () => noteEdit({ [key]: !current }));
  const gestureEnum = (id: string, label: MessageKey, glyph: string, key: 'golpe' | 'rasgueado' | 'fade' | 'vibrato' | 'wahPedal', current: number, value: number, enabled: boolean) =>
    control(id, label, glyph, current === value, enabled, () => gesture({ [key]: current === value ? 0 : value }));
  const gestureFlag = (id: string, label: MessageKey, glyph: string, key: 'tap' | 'slap' | 'pop' | 'deadSlapped' | 'slashed' | 'showTimer', enabled: boolean) => {
    const current = Boolean(beat?.[key]);
    return control(id, label, glyph, current, enabled, () => gesture({ [key]: !current }));
  };

  // ---- Bar ----
  const exact = measureSettingsExact(score, target.bar);
  const settings = (change: Partial<MeasureSettings>): EditCommand => ({ type: 'setMeasureSettings', bar: target.bar, ...readMeasureSettings(score, target.bar), ...change });
  const rule = master.beamingRules?.groups.entries().next().value;
  const masterGestures = (change: { doubleBar?: boolean; tripletFeel?: number }): EditCommand => ({
    type: 'setMasterBarGestures', bar: target.bar, commonTime: master.timeSignatureCommon, doubleBar: change.doubleBar ?? master.isDoubleBar,
    tripletFeel: change.tripletFeel ?? Number(master.tripletFeel), beaming: rule ? { unit: rule[0], groups: [...rule[1]] } : null,
  });
  const feel = Number(master.tripletFeel);
  const feels: ReadonlyArray<readonly [number, MessageKey, string]> = [
    [0, 'palette.feel_none', '♪♪'], [2, 'palette.feel_triplet_8th', '♪♪=♪³'], [1, 'palette.feel_triplet_16th', '𝅘𝅥𝅯𝅘𝅥𝅯=³'],
    [4, 'palette.feel_dotted_8th', '♪.♬'], [3, 'palette.feel_dotted_16th', '𝅘𝅥𝅯.'], [6, 'palette.feel_scottish_8th', '♬♪.'], [5, 'palette.feel_scottish_16th', '𝅘𝅥𝅯𝅘𝅥𝅯.'],
  ];
  const simile = bar.simileMark === model.SimileMark.Simple ? 'single' : bar.simileMark >= model.SimileMark.FirstOfDouble ? 'double' : 'none';
  // A simile repeats the bar (or two bars) before it, so it needs that many earlier bars.
  const simileControl = (kind: 'single' | 'double', label: MessageKey, glyph: string) =>
    control(`simile-${kind}`, label, glyph, simile === kind, simile === kind || target.bar >= (kind === 'single' ? 1 : 2), () => ({ type: 'setSimile', track: target.track, staff: target.staff, bar: target.bar, kind: simile === kind ? 'none' : kind }));
  const endings = readMeasureSettings(score, target.bar).endings;
  const directions = [...(master.directions ?? [])];
  const ottava = beat?.ottava ?? model.Ottavia.Regular;
  const ottavaControl = (id: string, label: MessageKey, glyph: string, value: number) =>
    control(id, label, glyph, ottava === value, hasBeat, () => ({ type: 'setOttava', from: target, to: target, ottava: ottava === value ? model.Ottavia.Regular : value }));
  const barGroup: PaletteGroup = {
    id: 'bar', label: 'palette.group_bar', controls: [
      opener('clef', 'palette.clef', '𝄞', 'measure'),
      opener('key', 'palette.key_signature', '♯♯', 'measure'),
      opener('time-signature', 'toolbar.time_signature', '4/4', 'measure'),
      menu('triplet-feel', 'palette.triplet_feel', '♪=³', feels.map(([value, label, glyph]) =>
        ({ id: value === 0 ? 'feel-none' : `feel-${value}`, label, glyph, pressed: feel === value, enabled: true, activate: () => (feel === value ? null : { edit: masterGestures({ tripletFeel: value }) }) }))),
      control('free-time', 'palette.free_time', '┆', master.isFreeTime, exact, () => settings({ freeTime: !master.isFreeTime })),
      control('double-bar', 'palette.double_bar', '‖', master.isDoubleBar, true, () => masterGestures({ doubleBar: !master.isDoubleBar })),
      simileControl('single', 'palette.simile_single', '𝄎'),
      simileControl('double', 'palette.simile_double', '𝄏'),
      control('repeat-start', 'palette.repeat_start', '𝄆', master.isRepeatStart, exact, () => settings({ repeatStart: !master.isRepeatStart })),
      menu('endings', 'palette.alternate_endings', '⌐1.', Array.from({ length: 8 }, (_, i) => i + 1).map(n => {
        const on = endings.includes(n);
        return { id: `ending-${n}`, label: 'palette.ending_n', text: `${n}.`, glyph: `${n}.`, pressed: on, enabled: exact,
          activate: () => (exact ? { edit: settings({ endings: on ? endings.filter(e => e !== n) : [...endings, n].sort((a, b) => a - b) }) } : null) };
      })),
      control('repeat-end', 'palette.repeat_end', '𝄇', master.repeatCount > 0, exact, () => settings({ repeatCount: master.repeatCount > 0 ? 0 : 2 })),
      menu('directions', 'palette.directions', '𝄌', DIRECTIONS.map(([value, name]) => {
        const on = directions.includes(value);
        return { id: `direction-${value}`, label: 'palette.directions', text: name, glyph: name, pressed: on, enabled: true,
          activate: () => ({ edit: { type: 'setDirections', bar: target.bar, directions: on ? directions.filter(d => d !== value) : [...directions, value].sort((a, b) => a - b) } }) };
      })),
      ottavaControl('8va', 'palette.ottava_8va', '8va', model.Ottavia._8va),
      ottavaControl('8vb', 'palette.ottava_8vb', '8vb', model.Ottavia._8vb),
      ottavaControl('15ma', 'palette.ottava_15ma', '15ma', model.Ottavia._15ma),
      ottavaControl('15mb', 'palette.ottava_15mb', '15mb', model.Ottavia._15mb),
    ],
  };

  // ---- Rhythm and pitch ----
  // alphaTab stores "no tuplet" as -1 or 1; setBeatRhythm takes 1:1.
  const tuplet = beat && beat.tupletNumerator > 1 && beat.tupletDenominator > 1 ? [beat.tupletNumerator, beat.tupletDenominator] : [1, 1];
  const rhythm = (change: { tupletNumerator?: number; tupletDenominator?: number; graceType?: number }): EditCommand | null => beat ? {
    type: 'setBeatRhythm', target, duration: beat.duration, dots: beat.dots, tupletNumerator: change.tupletNumerator ?? tuplet[0],
    tupletDenominator: change.tupletDenominator ?? tuplet[1], graceType: change.graceType ?? beat.graceType,
  } : null;
  const isTuplet = (n: number, d: number) => tuplet[0] === n && tuplet[1] === d;
  // A tuplet that lengthens the beat must still fit the bar; one that shortens it always does.
  const used = voice.beats.reduce((sum, b) => sum + (b.graceType === model.GraceType.None ? b.playbackDuration : 0), 0);
  const free = master.calculateDuration(false) - used;
  const fits = (n: number, d: number) => !beat || master.isFreeTime || beat.graceType !== model.GraceType.None
    || beat.playbackDuration * (tuplet[0] / tuplet[1]) * (d / n) - beat.playbackDuration <= free + 0.5;
  const graceControl = (id: string, label: MessageKey, glyph: string, value: number) => {
    const current = beat?.graceType ?? 0;
    return control(id, label, glyph, current === value, sounding, () => rhythm({ graceType: current === value ? 0 : value }));
  };
  const fermata = beat?.fermata ?? null;
  const spelling = note?.accidentalMode ?? 0;
  const accidental = (id: string, label: MessageKey, glyph: string, value: number) =>
    control(id, label, glyph, pitched && spelling === value, pitched, () =>
      spelling === value && value === 0 ? null : { type: 'setNoteSpelling', target, noteIndex: index, accidentalMode: spelling === value ? 0 : value });
  // The adjacent string by open pitch must be free at this beat and reach the same pitch at fret 0 or above.
  const openPitch = (s: number) => staff.tuning[staff.tuning.length - s];
  const canMove = (direction: 'higher' | 'lower') => {
    if (!note || !stringedNote || !beat) return false;
    const strings = staff.tuning.map((_, i) => i + 1).sort((a, b) => openPitch(a) - openPitch(b) || a - b);
    const destination = strings[strings.indexOf(note.string) + (direction === 'higher' ? 1 : -1)];
    return destination !== undefined && openPitch(destination) !== openPitch(note.string)
      && note.fret + openPitch(note.string) - openPitch(destination) >= 0 && !beat.notes.some(n => n.string === destination);
  };
  const move = (direction: 'higher' | 'lower', label: MessageKey, glyph: string) =>
    control(`string-${direction}`, label, glyph, false, canMove(direction), () => ({ type: 'moveSelectionStrings', selection: { kind: 'notes', notes: [{ target, noteIndex: index }] }, direction }));
  const notesGroup: PaletteGroup = {
    id: 'notes', label: 'palette.group_notes', controls: [
      control('triplet', 'palette.triplet', '³', isTuplet(3, 2), hasBeat && fits(...(isTuplet(3, 2) ? [1, 1] : [3, 2]) as [number, number]), () => rhythm(isTuplet(3, 2) ? { tupletNumerator: 1, tupletDenominator: 1 } : { tupletNumerator: 3, tupletDenominator: 2 })),
      menu('tuplet', 'palette.tuplet', 'n:m', [
        { id: 'tuplet-none', label: 'palette.tuplet_none', glyph: '1:1', pressed: isTuplet(1, 1), enabled: hasBeat && fits(1, 1), activate: () => (hasBeat && fits(1, 1) && !isTuplet(1, 1) ? edit(rhythm({ tupletNumerator: 1, tupletDenominator: 1 })) : null) },
        ...TUPLETS.map(([n, d]) => ({ id: `tuplet-${n}-${d}`, label: 'palette.tuplet' as MessageKey, text: `${n}:${d}`, glyph: `${n}:${d}`, pressed: isTuplet(n, d), enabled: hasBeat && fits(n, d),
          activate: () => (hasBeat && fits(n, d) && !isTuplet(n, d) ? edit(rhythm({ tupletNumerator: n, tupletDenominator: d })) : null) })),
      ]),
      control('fermata', 'palette.fermata', '𝄐', Boolean(fermata), hasBeat && beat?.graceType === model.GraceType.None, () =>
        ({ type: 'setFermata', target, fermata: fermata ? null : { type: model.FermataType.Medium, length: 1 } })),
      graceControl('grace-before', 'palette.grace_before', '𝆔', model.GraceType.BeforeBeat),
      graceControl('grace-on', 'palette.grace_on', '𝆕', model.GraceType.OnBeat),
      accidental('double-flat', 'palette.double_flat', '𝄫', model.NoteAccidentalMode.ForceDoubleFlat),
      accidental('flat', 'palette.flat', '♭', model.NoteAccidentalMode.ForceFlat),
      accidental('natural', 'palette.natural', '♮', model.NoteAccidentalMode.ForceNatural),
      accidental('sharp', 'palette.sharp', '♯', model.NoteAccidentalMode.ForceSharp),
      accidental('double-sharp', 'palette.double_sharp', '𝄪', model.NoteAccidentalMode.ForceDoubleSharp),
      accidental('auto-spelling', 'palette.auto_spelling', '♭♯', model.NoteAccidentalMode.Default),
      move('higher', 'palette.string_higher', '↑s'),
      move('lower', 'palette.string_lower', '↓s'),
    ],
  };

  // Hairpins: a click adds one from the cursor beat to the next attack, ending a dynamic step further; a click on a hairpin clears its whole run.
  const attack = (b: model.Beat | null | undefined) => Boolean(b && !b.isEmpty && !b.isRest && b.graceType === model.GraceType.None && b.notes.length);
  // Walked lazily: the palette re-renders often, and these stop at the first beat that answers.
  function* beatsAfter(from: model.Beat) {
    for (let barIndex = target.bar; barIndex < staff.bars.length; barIndex++) {
      const beats = staff.bars[barIndex].voices[target.voice]?.beats ?? [];
      for (let i = barIndex === target.bar ? from.index + 1 : 0; i < beats.length; i++) yield beats[i];
    }
  }
  function* beatsBefore(from: model.Beat) {
    for (let barIndex = target.bar; barIndex >= 0; barIndex--) {
      const beats = staff.bars[barIndex].voices[target.voice]?.beats ?? [];
      for (let i = barIndex === target.bar ? from.index - 1 : beats.length - 1; i >= 0; i--) yield beats[i];
    }
  }
  const toTarget = (b: model.Beat): BeatTarget => ({ ...target, bar: b.voice.bar.index, beat: b.index });
  const hairpin = (id: string, label: MessageKey, glyph: string, kind: number) => {
    const current = beat?.crescendo ?? 0;
    if (beat && current === kind) {
      let first = beat, last = beat;
      for (const b of beatsBefore(beat)) { if (b.crescendo !== kind) break; first = b; }
      for (const b of beatsAfter(beat)) { if (b.crescendo !== kind) break; last = b; }
      return control(id, label, glyph, true, true, () => ({ type: 'setCrescendo', from: toTarget(first), to: toTarget(last), crescendo: 0, targetDynamics: null }));
    }
    let next: model.Beat | undefined;
    if (beat && attack(beat)) for (const b of beatsAfter(beat)) if (attack(b)) { next = b; break; }
    const end = beat ? beat.dynamics + (kind === model.CrescendoType.Crescendo ? 1 : -1) : -1;
    const enabled = Boolean(next) && end >= 0 && end <= 7;
    return control(id, label, glyph, false, enabled, () => (next ? { type: 'setCrescendo', from: target, to: toTarget(next), crescendo: kind, targetDynamics: end } : null));
  };
  const hairpinGroup: PaletteGroup = {
    id: 'hairpins', label: 'palette.group_hairpins', controls: [
      hairpin('crescendo', 'palette.crescendo', '<', model.CrescendoType.Crescendo),
      hairpin('decrescendo', 'palette.decrescendo', '>', model.CrescendoType.Decrescendo),
    ],
  };

  // ---- Effects ----
  const accent = note?.accentuated ?? 0;
  const slideOut = note?.slideOutType ?? 0, slideIn = note?.slideInType ?? 0;
  const nextOnString = note && stringed ? nextLinkedNote(note) : null;
  const vibrato = note?.vibrato ?? 0;
  const ornament = note?.ornament ?? 0;
  // Presses and releases alternate: a beat can press only where the pedal is up, and release only where it is held.
  const pedalBeat = Boolean(beat && beat.graceType === model.GraceType.None && !staff.isPercussion);
  const pedal = beat && pedalBeat ? sustainPedalAt(beat) : 'none';
  const held = beat && pedalBeat ? (pedalMarks(staff).filter(mark => mark.bar < target.bar || (mark.bar === target.bar && mark.ratio < beatPedalRatio(beat))).at(-1)?.down ?? false) : false;
  const pedalControl = (id: string, label: MessageKey, glyph: string, value: 'down' | 'up') =>
    control(id, label, glyph, pedal === value, pedalBeat && (pedal === value || (pedal === 'none' && held === (value === 'up'))),
      () => ({ type: 'setSustainPedal', target, pedal: pedal === value ? 'none' : value }));
  const harmonic = note?.harmonicType ?? 0;
  const harmonics: ReadonlyArray<readonly [number, MessageKey, string]> = [
    [model.HarmonicType.Artificial, 'palette.harmonic_artificial', 'A.H.'], [model.HarmonicType.Pinch, 'palette.harmonic_pinch', 'P.H.'],
    [model.HarmonicType.Tap, 'palette.harmonic_tap', 'T.H.'], [model.HarmonicType.Semi, 'palette.harmonic_semi', 'S.H.'], [model.HarmonicType.Feedback, 'palette.harmonic_feedback', 'Fdbk.'],
  ];
  const whammy = beat?.whammyBarType ?? 0;
  const whammyPresets: ReadonlyArray<readonly [number, MessageKey, string, Array<{ offset: number; value: number }>]> = [
    [model.WhammyType.Dive, 'palette.whammy_dive', '╲', [{ offset: 0, value: 0 }, { offset: 60, value: -4 }]],
    [model.WhammyType.Dip, 'palette.whammy_dip', '∨', [{ offset: 0, value: 0 }, { offset: 30, value: -4 }, { offset: 60, value: 0 }]],
    [model.WhammyType.Hold, 'palette.whammy_hold', '‾', [{ offset: 0, value: -4 }, { offset: 60, value: -4 }]],
    [model.WhammyType.Predive, 'palette.whammy_predive', '⌐', [{ offset: 0, value: -4 }, { offset: 60, value: 0 }]],
  ];
  const brush = beat?.brushType ?? 0;
  const brushControl = (id: string, label: MessageKey, glyph: string, value: number) =>
    control(id, label, glyph, brush === value, stringedBeat, () => beatTech({ brushType: brush === value ? 0 : value }));
  const pick = beat?.pickStroke ?? 0;
  const pickControl = (id: string, label: MessageKey, glyph: string, value: number) =>
    control(id, label, glyph, pick === value, stringedBeat, () => beatTech({ pickStroke: pick === value ? 0 : value }));
  const chordStrings = beat ? new Set(beat.notes.filter(n => n.isStringed).map(n => n.string)).size : 0;
  const tremoloSpeed = beat ? [8, 16, 32, 64].find(speed => tremoloMarks(beat.duration, speed) !== null) : undefined;
  const effectsGroup: PaletteGroup = {
    id: 'effects', label: 'palette.group_effects', controls: [
      noteEnum('heavy-accent', 'palette.heavy_accent', '^', 'accent', accent, model.AccentuationType.Heavy, Boolean(note)),
      noteEnum('tenuto', 'palette.tenuto', '‒', 'accent', accent, model.AccentuationType.Tenuto, Boolean(note)),
      control('slur', 'palette.slur', '⁀', Boolean(note?.slurDestination || note?.isSlurDestination), Boolean(note && (note.slurDestination || note.slurOrigin || nextSlurNote(note))), () => {
        if (!note) return null;
        if (note.slurDestination) return linkEdit(note, null, 'slur', target, indexed);
        if (note.slurOrigin) return linkEdit(note.slurOrigin, null, 'slur', target, indexed);
        const destination = nextSlurNote(note);
        return destination ? linkEdit(note, destination, 'slur', target, indexed) : null;
      }),
      pedalControl('pedal-down', 'palette.pedal_down', 'Ped.', 'down'),
      pedalControl('pedal-up', 'palette.pedal_up', '✱', 'up'),
      gestureFlag('dead-slap', 'palette.dead_slap', 'X', 'deadSlapped', stringedBeat),
      menu('harmonics', 'palette.harmonics', '◆', [
        { id: 'harmonic-none', label: 'palette.harmonic_none', glyph: '○', pressed: harmonic === 0, enabled: stringedNote, activate: () => (stringedNote && harmonic !== 0 ? edit(noteEdit({ harmonic: null })) : null) },
        ...harmonics.map(([value, label, glyph]) => ({ id: `harmonic-${value}`, label, glyph, pressed: harmonic === value, enabled: stringedNote,
          activate: () => (stringedNote && harmonic !== value ? edit(noteEdit({ harmonic: { type: value, value: 12 } })) : null) })),
      ]),
      menu('whammy', 'palette.whammy', 'w/b', [
        { id: 'whammy-none', label: 'palette.whammy_none', glyph: '—', pressed: whammy === 0, enabled: stringedBeat, activate: () => (stringedBeat && whammy !== 0 ? { edit: beatTech({ whammy: null }) } : null) },
        ...whammyPresets.map(([value, label, glyph, points]) => ({ id: `whammy-${value}`, label, glyph, pressed: whammy === value, enabled: stringedBeat,
          activate: () => (stringedBeat && whammy !== value ? { edit: beatTech({ whammy: { type: value, style: 0, points } }) } : null) })),
      ]),
      noteEnum('wide-vibrato', 'palette.wide_vibrato', '〰', 'vibrato', vibrato, model.VibratoType.Wide, Boolean(note && !staff.isPercussion)),
      gestureEnum('whammy-vibrato', 'palette.whammy_vibrato', 'ʌʌʌ', 'vibrato', beat?.vibrato ?? 0, model.VibratoType.Slight, sounding),
      noteEnum('pick-slide-down', 'palette.pick_slide_down', 'x╲', 'slideOut', slideOut, model.SlideOutType.PickSlideDown, stringedNote),
      noteEnum('pick-slide-up', 'palette.pick_slide_up', 'x╱', 'slideOut', slideOut, model.SlideOutType.PickSlideUp, stringedNote),
      noteEnum('legato-slide', 'palette.legato_slide', '1⁀3', 'slideOut', slideOut, model.SlideOutType.Legato, stringedNote && (slideOut === model.SlideOutType.Legato || Boolean(nextOnString))),
      noteEnum('slide-in-below', 'palette.slide_in_below', '╱3', 'slideIn', slideIn, model.SlideInType.IntoFromBelow, stringedNote),
      noteEnum('slide-in-above', 'palette.slide_in_above', '╲3', 'slideIn', slideIn, model.SlideInType.IntoFromAbove, stringedNote),
      noteEnum('slide-out-down', 'palette.slide_out_down', '3╲', 'slideOut', slideOut, model.SlideOutType.OutDown, stringedNote),
      noteEnum('slide-out-up', 'palette.slide_out_up', '3╱', 'slideOut', slideOut, model.SlideOutType.OutUp, stringedNote),
      noteFlag('left-hand-tap', 'palette.left_hand_tap', 'L.H.', 'leftHandTapped', Boolean(note?.isLeftHandTapped), stringedNote),
      gestureFlag('tap', 'palette.tap', 'tap', 'tap', stringedBeat),
      gestureFlag('slap', 'palette.slap', 'slap', 'slap', stringedBeat),
      gestureFlag('pop', 'palette.pop', 'pop', 'pop', stringedBeat),
      gestureEnum('golpe-thumb', 'palette.golpe_thumb', '✋p', 'golpe', beat?.golpe ?? 0, model.GolpeType.Thumb, stringedBeat),
      gestureEnum('golpe-finger', 'palette.golpe_finger', '✋i', 'golpe', beat?.golpe ?? 0, model.GolpeType.Finger, stringedBeat),
      noteFlag('string-number', 'palette.string_number', note && stringed ? String.fromCodePoint(0x2460 + Math.max(0, Math.min(19, staff.tuning.length - note.string))) : '⑥', 'stringNumber', Boolean(note?.showStringNumber), stringedNote),
      brushControl('brush-up', 'palette.brush_up', '↑', model.BrushType.BrushUp),
      brushControl('brush-down', 'palette.brush_down', '↓', model.BrushType.BrushDown),
      brushControl('arpeggio-up', 'palette.arpeggio_up', '⇡', model.BrushType.ArpeggioUp),
      brushControl('arpeggio-down', 'palette.arpeggio_down', '⇣', model.BrushType.ArpeggioDown),
      gestureEnum('rasgueado', 'palette.rasgueado', 'rasg.', 'rasgueado', beat?.rasgueado ?? 0, model.Rasgueado.Ii, stringedBeat && (chordStrings >= 2 || (beat?.rasgueado ?? 0) !== 0)),
      pickControl('pick-down', 'palette.pick_down', '⊓', model.PickStroke.Down),
      pickControl('pick-up', 'palette.pick_up', 'V', model.PickStroke.Up),
      control('trill', 'palette.trill', 'tr', Boolean(note?.isTrill), Boolean(note && !staff.isPercussion), () =>
        noteEdit({ trill: note?.isTrill ? null : { pitch: Math.min(127, (note?.realValue ?? 60) + 2), speed: 16 } })),
      control('tremolo-picking', 'palette.tremolo_picking', '⫽', Boolean(beat?.isTremolo), Boolean(sounding && (beat?.isTremolo || tremoloSpeed !== undefined)), () =>
        beatTech({ tremolo: beat?.isTremolo ? null : { speed: tremoloSpeed!, style: 0 } })),
      noteEnum('upper-mordent', 'palette.upper_mordent', '∿∿', 'ornament', ornament, model.NoteOrnament.UpperMordent, Boolean(note && !staff.isPercussion)),
      noteEnum('lower-mordent', 'palette.lower_mordent', '∿|∿', 'ornament', ornament, model.NoteOrnament.LowerMordent, Boolean(note && !staff.isPercussion)),
      noteEnum('turn', 'palette.turn', '∞', 'ornament', ornament, model.NoteOrnament.Turn, Boolean(note && !staff.isPercussion)),
      noteEnum('inverted-turn', 'palette.inverted_turn', '∞̸', 'ornament', ornament, model.NoteOrnament.InvertedTurn, Boolean(note && !staff.isPercussion)),
      gestureEnum('fade-in', 'palette.fade_in', '<', 'fade', beat?.fade ?? 0, model.FadeType.FadeIn, sounding),
      gestureEnum('fade-out', 'palette.fade_out', '>', 'fade', beat?.fade ?? 0, model.FadeType.FadeOut, sounding),
      gestureEnum('volume-swell', 'palette.volume_swell', '<>', 'fade', beat?.fade ?? 0, model.FadeType.VolumeSwell, sounding),
      gestureEnum('wah-open', 'palette.wah_open', 'o', 'wahPedal', beat?.wahPedal ?? 0, model.WahPedal.Open, stringedBeat),
      gestureEnum('wah-closed', 'palette.wah_closed', '+', 'wahPedal', beat?.wahPedal ?? 0, model.WahPedal.Closed, stringedBeat),
    ],
  };

  // ---- Chords, text and beaming ----
  const barreFret = beat ? Math.min(...beat.notes.filter(n => n.isStringed && n.fret > 0).map(n => n.fret)) : Infinity;
  const hasBarre = (beat?.barreShape ?? 0) !== 0;
  const beaming = beat?.beamingMode ?? 0;
  const beamControl = (id: string, label: MessageKey, glyph: string, value: number) =>
    control(id, label, glyph, hasBeat && beaming === value, hasBeat, () => (beaming === value ? null : gesture({ beamingMode: value })));
  const stem = !beat ? 'auto' : beat.invertBeamDirection ? (beat.preferredBeamDirection === null ? 'inverted' : 'mixed') : beat.preferredBeamDirection === 0 ? 'up' : beat.preferredBeamDirection === 1 ? 'down' : 'auto';
  const stemControl = (id: string, label: MessageKey, glyph: string, value: 'auto' | 'up' | 'down' | 'inverted') =>
    control(id, label, glyph, hasBeat && stem === value, hasBeat, () => (stem === value ? null : gesture({ stem: value })));
  const textGroup: PaletteGroup = {
    id: 'text', label: 'palette.group_text', controls: [
      opener('chord-diagram', 'palette.chord_diagram', '▦', 'chord', hasBeat),
      opener('scale-diagram', 'palette.scale_diagram', '▤', 'scales'),
      gestureFlag('slash', 'palette.slash_notation', '𝄍', 'slashed', hasBeat),
      control('barre', 'palette.barre', 'B', hasBarre, stringedBeat && (hasBarre || Number.isFinite(barreFret)), () =>
        gesture({ barre: hasBarre ? null : { fret: barreFret, shape: 1 } })),
      gestureFlag('timer', 'palette.timer', '⏱', 'showTimer', hasBeat),
      { id: 'beat-text', label: 'palette.beat_text', glyph: 'TXT', pressed: Boolean(beat?.text), enabled: hasBeat, activate: () => null,
        prompt: { value: beat?.text ?? '', submit: text => (hasBeat && text !== (beat?.text ?? '') ? { edit: { type: 'setBeatText', target, text } } : null) } },
      { id: 'section', label: 'palette.section', glyph: 'A', pressed: Boolean(master.section), enabled: exact, activate: () => null,
        prompt: { value: master.section?.text ?? '', submit: text => (exact && text.trim() !== (master.section?.text ?? '') ? { edit: settings({ section: text.trim() }) } : null) } },
      beamControl('beam-auto', 'palette.beam_auto', '♫ₐ', model.BeatBeamingMode.Auto),
      beamControl('beam-merge', 'palette.beam_merge', '♫', model.BeatBeamingMode.ForceMergeWithNext),
      beamControl('beam-split', 'palette.beam_split', '♪♪', model.BeatBeamingMode.ForceSplitToNext),
      beamControl('beam-split-secondary', 'palette.beam_split_secondary', '♬|', model.BeatBeamingMode.ForceSplitOnSecondaryToNext),
      stemControl('stem-auto', 'palette.stem_auto', '♩ₐ', 'auto'),
      stemControl('stem-up', 'palette.stem_up', '♩↑', 'up'),
      stemControl('stem-down', 'palette.stem_down', '♩↓', 'down'),
      stemControl('stem-inverted', 'palette.stem_inverted', '♩⇅', 'inverted'),
    ],
  };
  return [barGroup, notesGroup, hairpinGroup, effectsGroup, textGroup];
}

/** The next note a slur can reach: the first note of the next sounding beat in the same voice. */
function nextSlurNote(note: model.Note): model.Note | null {
  const staff = note.beat.voice.bar.staff, voice = note.beat.voice.index;
  for (let bar = note.beat.voice.bar.index; bar < staff.bars.length; bar++) {
    const beats = staff.bars[bar].voices[voice]?.beats ?? [];
    for (let i = bar === note.beat.voice.bar.index ? note.beat.index + 1 : 0; i < beats.length; i++) {
      const candidate = beats[i].isRest ? undefined : (note.isStringed ? beats[i].notes.find(n => n.string === note.string) : undefined) ?? beats[i].notes[0];
      if (candidate) return candidate;
    }
  }
  return null;
}

function linkEdit(from: model.Note, to: model.Note | null, kind: 'slur', cursor: BeatTarget, indexed: boolean): EditCommand {
  const at = (n: model.Note): BeatTarget => ({ track: cursor.track, staff: cursor.staff, voice: cursor.voice, bar: n.beat.voice.bar.index, beat: n.beat.index });
  if (indexed || (to && !to.isStringed) || !from.isStringed) {
    return { type: 'setNoteLinkByIndex', from: { target: at(from), noteIndex: from.beat.notes.indexOf(from) }, to: to ? { target: at(to), noteIndex: to.beat.notes.indexOf(to) } : null, kind };
  }
  return { type: 'setNoteLink', from: { target: at(from), string: from.string }, to: to ? { target: at(to), string: to.string } : null, kind };
}
