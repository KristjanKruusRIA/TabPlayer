// THE-61: the authored Guitar Pro 8 acceptance files. Every file is written by TabPlayer's own exporter (exportGpInterchange), so the
// private additions it makes (fermatas, beam direction, chord diagrams, lyrics, percussion references, channel-strip automations, tempo
// units, stylesheet members, TabPlayerCurves, partial capo) are exactly what a person opens in Guitar Pro 8.
// Not a test file: scripts/gp8-acceptance-kit.mjs runs src/interchange/gp8-acceptance-kit-write.test.ts to call writeKitFiles.
import { model, Settings } from '@coderline/alphatab';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportGpInterchange } from './gp';
import { gpLosses } from './gp-losses';
import { applyHarmonyEdit } from '../harmony/edits';
import { formatChordName } from '../harmony/chords';
import type { HarmonyChord } from '../editor/harmony-types';
import { applyLyricsEdit } from '../editor/lyrics';
import { setPartialCapo } from '../editor/partial-capo';
import { buildTempo } from '../editor/tempo-unit';
import { initializeTimeSignatureSource, setTimeSignatureIntent } from '../editor/time-signature-source';

export const KIT_BPM = 120;
const GUITAR_TUNING = [64, 59, 55, 50, 45, 40];
const DRUM_ARTICULATIONS = [91, 92, 114, 124];

export interface KitContext { score: model.Score; track: model.Track; staff: model.Staff; bar: model.Bar; masterBar: model.MasterBar; beats: model.Beat[]; notes: model.Note[]; index: number }
export interface KitCase { name: string; time?: [number, number]; beats?: number; build: (c: KitContext) => void }
export interface KitTrack { name: string; short?: string; color?: [number, number, number]; tuning?: number[]; volume?: number; balance?: number; program?: number; percussion?: boolean; build?: (t: { track: model.Track; staff: model.Staff }) => void }
export interface KitFamily {
  id: string; title: string; look: string; cases: KitCase[]; tracks?: KitTrack[];
  /** What to compare after Guitar Pro re-saves the file: GPIF selectors (`Tag`, `Parent>Tag`, `Property[name]`), or `@Archive/Member` for a whole archive member. */
  elements: string[];
  midi?: { timing: boolean; why: string };
  control?: boolean;
  /** Elements this file does not contain when written (a control, or a member Guitar Pro may add); the regular test does not require them. */
  expectAbsent?: string[];
  /** Runs once after every bar exists and before the score is finished. */
  post?: (score: model.Score) => void;
  /** What a person should know before looking, shown in the checklist. */
  notes?: string[];
}
export interface KitExpected { notes: number; onsets: number[]; quarters: number }
export interface KitFamilyMeta {
  id: string; title: string; look: string; cases: string[]; tracks: string[]; elements: string[]; control: boolean; expectAbsent: string[];
  midi: { notes: number; onsets: number[]; quarters: number; timing: boolean; why: string | null };
  warnings: string[]; notes: string[];
}
export interface KitFile { index: number; name: string; meta: KitFamilyMeta; bytes: Uint8Array }

const quartersOf = (beat: model.Beat) => {
  let q = (4 / beat.duration) * (beat.dots === 1 ? 1.5 : beat.dots === 2 ? 1.75 : 1);
  if (beat.tupletNumerator > 0 && beat.tupletDenominator > 0) q = (q * beat.tupletDenominator) / beat.tupletNumerator;
  return q;
};
const DURATION_BY_DEN: Record<number, model.Duration> = { 2: model.Duration.Half, 4: model.Duration.Quarter, 8: model.Duration.Eighth, 16: model.Duration.Sixteenth };
const point = (offset: number, value: number) => new model.BendPoint(offset, value);
const round = (x: number) => Math.round(x * 1000) / 1000;
const noteSpec = (index: number, tuning: number[]) => ({ string: Math.max(1, tuning.length - (index % 3)), fret: 2 + (index % 5) });
const chordAt = (score: model.Score, bar: number, beat: number, chord: HarmonyChord) => applyHarmonyEdit(score, { type: 'setHarmonyChord', target: { track: 0, staff: 0, bar, voice: 0, beat }, chord, fillEmptyBeat: false }, bar + 1);
const link = (from: model.Note, to: model.Note, a: Partial<model.Note>, b: Partial<model.Note>) => { Object.assign(from, a); Object.assign(to, b); };
const commonCut = (score: model.Score, intents: boolean[], shown: boolean[]) => {
  initializeTimeSignatureSource(score, null);
  score.masterBars.forEach((master, i) => { master.timeSignatureCommon = shown[i]; setTimeSignatureIntent(master, intents[i]); });
};

export const KIT_FAMILIES: KitFamily[] = [
  {
    id: 'structure', title: 'Bar structure: meter, free time, triplet feel, tempo, key',
    look: 'Time signatures (3/4, 6/8, 2/2), the double bar, free time, the swing feel mark, a tempo change to 90 and key signatures.',
    cases: [
      { name: '3/4', time: [3, 4], build: () => {} },
      { name: '6/8', time: [6, 8], build: () => {} },
      { name: '2/2', time: [2, 2], build: () => {} },
      { name: 'double bar', build: (c) => { c.masterBar.isDoubleBar = true; } },
      { name: 'free time', build: (c) => { c.masterBar.isFreeTime = true; } },
      { name: 'triplet feel 8th', build: (c) => { c.masterBar.tripletFeel = model.TripletFeel.Triplet8th; } },
      { name: 'tempo 90', build: (c) => { c.masterBar.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, 90, 2)); } },
      { name: 'key 3 sharps major', build: (c) => { c.bar.keySignature = 3; c.bar.keySignatureType = model.KeySignatureType.Major; } },
      { name: 'key 2 flats minor', build: (c) => { c.bar.keySignature = -2; c.bar.keySignatureType = model.KeySignatureType.Minor; } },
    ],
    elements: ['MasterBar>Time', 'MasterBar>Key', 'MasterBar>DoubleBar', 'MasterBar>FreeTime', 'MasterBar>TripletFeel', 'MasterBar>Section', 'Automation'],
  },
  {
    id: 'repeats', title: 'Repeats, alternate endings and jumps',
    look: 'Start repeat, end repeat with 3 plays, first and second endings, Segno, Coda and D.S. al Coda marks.',
    midi: { timing: false, why: 'Guitar Pro expands repeats and jumps in a MIDI export, so the length differs from the written bars.' },
    cases: [
      { name: 'repeat start', build: (c) => { c.masterBar.isRepeatStart = true; } },
      { name: 'repeat end x3 with ending 1', build: (c) => { c.masterBar.repeatCount = 3; c.masterBar.alternateEndings = 1; } },
      { name: 'ending 2', build: (c) => { c.masterBar.alternateEndings = 2; } },
      { name: 'segno target', build: (c) => { c.masterBar.addDirection(model.Direction.TargetSegno); } },
      { name: 'coda target', build: (c) => { c.masterBar.addDirection(model.Direction.TargetCoda); } },
      { name: 'D.S. al Coda', build: (c) => { c.masterBar.addDirection(model.Direction.JumpDalSegnoAlCoda); } },
    ],
    elements: ['MasterBar>Repeat', 'MasterBar>AlternateEndings', 'Directions>Target', 'Directions>Jump', 'MasterBar>Section'],
  },
  {
    id: 'fermata', title: 'Fermatas written by TabPlayer (Short, Medium, Long)',
    look: 'A fermata symbol over the first beat of the three labelled bars. Do not add or remove any.',
    midi: { timing: false, why: 'A fermata may lengthen playback; that question belongs to the fermata control (fermata-control) and to scripts/fermata-probe.mjs.' },
    cases: [
      { name: 'Short, Length 0', build: (c) => { c.masterBar.addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Short, length: 0 })); } },
      { name: 'Medium, Length 0', build: (c) => { c.masterBar.addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Medium, length: 0 })); } },
      { name: 'Long, Length 1', build: (c) => { c.masterBar.addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Long, length: 1 })); } },
    ],
    elements: ['Fermata', 'Fermata>Type', 'Fermata>Length', 'Fermata>Offset'],
  },
  {
    id: 'fermata-control', title: 'Fermata positive control: add ONE fermata by hand',
    look: 'This file has no fermata. In Guitar Pro 8 add a single fermata to the first beat of bar 2 by hand, then save and export as described. It shows how Guitar Pro itself writes a fermata and whether its own MIDI export holds the note.',
    midi: { timing: false, why: 'The point of this file is to measure whether a hold appears; collect reports the numbers instead of a verdict.' },
    control: true,
    expectAbsent: ['Fermata', 'Fermata>Type', 'Fermata>Length', 'Fermata>Offset'],
    cases: [{ name: 'plain bar 1', build: () => {} }, { name: 'plain bar 2 (add the fermata here)', build: () => {} }, { name: 'plain bar 3', build: () => {} }, { name: 'plain bar 4', build: () => {} }],
    elements: ['Fermata', 'Fermata>Type', 'Fermata>Length', 'Fermata>Offset'],
  },
  {
    id: 'dynamics', title: 'Dynamics, crescendo, fades, beat text',
    look: 'Dynamic marks pp and ff, a crescendo, a fade in and the words "Solo" over a beat.',
    cases: [
      { name: 'dynamics pp', build: (c) => { c.beats[0].dynamics = model.DynamicValue.PP; } },
      { name: 'dynamics ff', build: (c) => { c.beats[0].dynamics = model.DynamicValue.FF; } },
      { name: 'crescendo', build: (c) => { c.beats[0].crescendo = model.CrescendoType.Crescendo; } },
      { name: 'fade in', build: (c) => { c.beats[0].fade = model.FadeType.FadeIn; } },
      { name: 'beat text "Solo"', build: (c) => { c.beats[0].text = 'Solo'; } },
    ],
    elements: ['Beat>Dynamic', 'Hairpin', 'Fadding', 'FreeText'],
  },
  {
    id: 'bends', title: 'Bends and whammy bar',
    look: 'Bend shapes (bend, bend and release, pre-bend, pre-bend and release) and whammy dive and dip on the first beat of each bar.',
    cases: [
      { name: 'bend up 1 tone', build: (c) => { Object.assign(c.notes[0], { bendType: model.BendType.Bend, bendPoints: [point(0, 0), point(60, 4)] }); } },
      { name: 'bend and release', build: (c) => { Object.assign(c.notes[0], { bendType: model.BendType.BendRelease, bendPoints: [point(0, 0), point(30, 4), point(60, 0)] }); } },
      { name: 'pre-bend', build: (c) => { Object.assign(c.notes[0], { bendType: model.BendType.Prebend, bendPoints: [point(0, 4), point(60, 4)] }); } },
      { name: 'pre-bend and release', build: (c) => { Object.assign(c.notes[0], { bendType: model.BendType.PrebendRelease, bendPoints: [point(0, 4), point(30, 4), point(60, 0)] }); } },
      { name: 'whammy dive', build: (c) => { c.beats[0].whammyBarType = model.WhammyType.Dive; c.beats[0].whammyBarPoints = [point(0, 0), point(60, -4)]; } },
      { name: 'whammy dip', build: (c) => { c.beats[0].whammyBarType = model.WhammyType.Dip; c.beats[0].whammyBarPoints = [point(0, 0), point(30, -4), point(60, 0)]; } },
    ],
    elements: ['Property[Bended]', 'Property[BendOriginValue]', 'Property[BendOriginOffset]', 'Property[BendMiddleValue]', 'Property[BendMiddleOffset1]', 'Property[BendMiddleOffset2]', 'Property[BendDestinationValue]', 'Property[BendDestinationOffset]', 'Whammy'],
  },
  {
    id: 'links', title: 'Ties, hammer-ons and slides',
    look: 'A tie, a hammer-on/pull-off, a shift slide, a legato slide, slides into the note from below and out downward.',
    cases: [
      { name: 'tie', build: (c) => { const [a, b] = c.notes; b.fret = a.fret; b.string = a.string; link(a, b, { tieDestination: b }, { tieOrigin: a, isTieDestination: true }); } },
      { name: 'hammer-on', build: (c) => { const [a, b] = c.notes; b.string = a.string; b.fret = a.fret + 2; link(a, b, { isHammerPullOrigin: true, hammerPullDestination: b }, { hammerPullOrigin: a }); } },
      { name: 'shift slide', build: (c) => { c.notes[0].slideOutType = model.SlideOutType.Shift; } },
      { name: 'legato slide', build: (c) => { c.notes[0].slideOutType = model.SlideOutType.Legato; } },
      { name: 'slide in from below', build: (c) => { c.notes[0].slideInType = model.SlideInType.IntoFromBelow; } },
      { name: 'slide out down', build: (c) => { c.notes[0].slideOutType = model.SlideOutType.OutDown; } },
    ],
    elements: ['Tie', 'Property[HopoOrigin]', 'Property[HopoDestination]', 'Property[Slide]'],
  },
  {
    id: 'note-marks', title: 'Note marks: muting, ghost, dead, accents, vibrato, fingering',
    look: 'Palm mute, let ring, dead note, ghost note, staccato, normal and heavy accent, vibrato, left-hand tap and finger numbers.',
    cases: [
      { name: 'palm mute', build: (c) => { c.notes[0].isPalmMute = true; } },
      { name: 'let ring', build: (c) => { c.notes[0].isLetRing = true; } },
      { name: 'dead note', build: (c) => { c.notes[0].isDead = true; } },
      { name: 'ghost note', build: (c) => { c.notes[0].isGhost = true; } },
      { name: 'staccato', build: (c) => { c.notes[0].isStaccato = true; } },
      { name: 'accent normal', build: (c) => { c.notes[0].accentuated = model.AccentuationType.Normal; } },
      { name: 'accent heavy', build: (c) => { c.notes[0].accentuated = model.AccentuationType.Heavy; } },
      { name: 'note vibrato wide', build: (c) => { c.notes[0].vibrato = model.VibratoType.Wide; } },
      { name: 'left-hand tap', build: (c) => { c.notes[0].isLeftHandTapped = true; } },
      { name: 'fingering', build: (c) => { Object.assign(c.notes[0], { leftHandFinger: model.Fingers.IndexFinger, rightHandFinger: model.Fingers.Thumb }); } },
    ],
    elements: ['Property[PalmMuted]', 'LetRing', 'Property[Muted]', 'AntiAccent', 'Accent', 'Vibrato', 'Property[LeftHandTapped]', 'LeftFingering', 'RightFingering'],
  },
  {
    id: 'harmonics-ornaments', title: 'Harmonics, trill and ornaments',
    look: 'Natural, artificial, pinch, tap, semi and feedback harmonics, a trill and a turn.',
    cases: [
      ...(['Natural', 'Artificial', 'Pinch', 'Tap', 'Semi', 'Feedback'] as const).map((type) => ({ name: `${type.toLowerCase()} harmonic`, build: (c: KitContext) => { Object.assign(c.notes[0], { harmonicType: model.HarmonicType[type], harmonicValue: 12 }); } })),
      { name: 'trill', build: (c) => { Object.assign(c.notes[0], { trillValue: 68, trillSpeed: model.Duration.Sixteenth }); } },
      { name: 'turn ornament', build: (c) => { c.notes[0].ornament = model.NoteOrnament.Turn; } },
    ],
    elements: ['Property[HarmonicType]', 'Property[HarmonicFret]', 'Trill', 'Ornament'],
  },
  {
    id: 'strokes-gestures', title: 'Strokes, tremolo picking and gestures',
    look: 'Brush down, arpeggio up, pick-stroke up/down, tremolo picking with 1 and 3 marks, rasgueado, slap, pop, tap, wah, barre and timer.',
    cases: [
      { name: 'brush down', build: (c) => { c.beats[0].brushType = model.BrushType.BrushDown; c.beats[0].brushDuration = 30; } },
      { name: 'arpeggio up', build: (c) => { c.beats[0].brushType = model.BrushType.ArpeggioUp; c.beats[0].brushDuration = 30; } },
      { name: 'pick stroke up', build: (c) => { c.beats[0].pickStroke = model.PickStroke.Up; } },
      { name: 'pick stroke down', build: (c) => { c.beats[0].pickStroke = model.PickStroke.Down; } },
      { name: 'tremolo picking 1 mark', build: (c) => { c.beats[0].tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 1 }); } },
      { name: 'tremolo picking 3 marks', build: (c) => { c.beats[0].tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 3 }); } },
      { name: 'rasgueado ii', build: (c) => { c.beats[0].rasgueado = model.Rasgueado.Ii; } },
      { name: 'slap', build: (c) => { c.beats[0].slap = true; } },
      { name: 'pop', build: (c) => { c.beats[0].pop = true; } },
      { name: 'tap', build: (c) => { c.beats[0].tap = true; } },
      { name: 'wah open', build: (c) => { c.beats[0].wahPedal = model.WahPedal.Open; } },
      { name: 'barre full at fret 3', build: (c) => { c.beats[0].barreFret = 3; c.beats[0].barreShape = model.BarreShape.Full; } },
      { name: 'timer 45 s', build: (c) => { c.beats[0].showTimer = true; c.beats[0].timer = 45; } },
    ],
    elements: ['Property[Brush]', 'Arpeggio', 'XProperty', 'Property[PickStroke]', 'Tremolo', 'Property[Rasgueado]', 'Property[Slapped]', 'Property[Popped]', 'Property[Tapped]', 'Wah', 'Property[BarreFret]', 'Property[BarreString]', 'Timer'],
  },
  {
    id: 'rhythm', title: 'Rhythm: dots, tuplets, octave mark, beam direction',
    look: 'Dotted eighths, a triplet, a quintuplet, sixteenth notes, an 8va octave mark and a beamed group with its beam direction inverted.',
    cases: [
      { name: 'dotted eighth + sixteenth', beats: 8, build: (c) => { c.beats.forEach((b, i) => { b.duration = i % 2 ? model.Duration.Sixteenth : model.Duration.Eighth; b.dots = i % 2 ? 0 : 1; }); } },
      { name: 'triplet eighths', beats: 3, build: (c) => { c.beats.forEach((b) => { b.duration = model.Duration.Eighth; b.tupletNumerator = 3; b.tupletDenominator = 2; }); } },
      { name: 'quintuplet sixteenths', beats: 5, build: (c) => { c.beats.forEach((b) => { b.duration = model.Duration.Sixteenth; b.tupletNumerator = 5; b.tupletDenominator = 4; }); } },
      { name: 'sixteenths', beats: 16, build: (c) => { c.beats.forEach((b) => { b.duration = model.Duration.Sixteenth; }); } },
      { name: 'octave 8va', build: (c) => { c.beats[0].ottava = model.Ottavia._8va; } },
      { name: 'beam direction inverted', beats: 8, build: (c) => { c.beats.forEach((b) => { b.duration = model.Duration.Eighth; }); c.beats[0].invertBeamDirection = true; } },
    ],
    elements: ['Rhythm', 'Rhythm>NoteValue', 'Rhythm>AugmentationDot', 'Rhythm>PrimaryTuplet', 'Ottavia', 'XProperty'],
  },
  {
    id: 'tracks-tuning', title: 'Tracks, tuning, capo and mixer',
    look: 'Two tracks: "Capo 3" (capo on fret 3, orange) and "Drop D" (low string tuned to D, blue, mixer volume and pan changed, program 30). Check the track names, colours, tunings, capo and mixer values.',
    tracks: [
      { name: 'Capo 3', short: 'Cap', color: [220, 110, 40], build: (t) => { t.staff.capo = 3; } },
      { name: 'Drop D', short: 'DrpD', color: [40, 110, 220], tuning: [64, 59, 55, 50, 45, 38], volume: 12, balance: 4, program: 30 },
    ],
    cases: [{ name: 'plain bar 1', build: () => {} }, { name: 'plain bar 2', build: () => {} }],
    elements: ['Track>Name', 'Track>ShortName', 'Track>Color', 'Property[CapoFret]', 'Property[Tuning]', 'Program', 'ChannelStrip>Parameters'],
  },
  {
    id: 'chord-diagram', title: 'Chord diagrams with theory and fingering data',
    look: 'Three chord diagrams written by TabPlayer: "C/E" built from a theory recipe (bass E), an F barre chord with fingering shown, and a diagram with its name hidden. Look at the name, the fret positions, the barre, the fingers and which of name, diagram and fingering are shown.',
    cases: [{ name: 'C/E theory chord, bass E', build: (c) => {
      const recipe = { root: { step: 0, alteration: 0 }, formula: 'major' as const, alterations: [], omissions: [], bass: { step: 2, alteration: 0 } };
      chordAt(c.score, c.index, 0, { name: formatChordName(recipe), nameMode: 'theory', recipe, firstFret: 0, frets: [0, 1, 0, 2, 3, 0], fingers: [0, 1, 0, 2, 3, 0], barreFrets: [], showName: true, showDiagram: true, showFingering: true });
    } }, { name: 'F barre, fingering shown', build: (c) => {
      chordAt(c.score, c.index, 0, { name: 'F', nameMode: 'manual', recipe: null, firstFret: 1, frets: [1, 1, 2, 3, 3, 1], fingers: [1, 1, 2, 4, 3, 1], barreFrets: [1], showName: true, showDiagram: true, showFingering: true });
    } }, { name: 'Am, name hidden', build: (c) => {
      chordAt(c.score, c.index, 0, { name: 'Am', nameMode: 'manual', recipe: null, firstFret: 0, frets: [0, 1, 2, 2, 0, -1], fingers: [0, 1, 3, 2, 0, 0], barreFrets: [], showName: false, showDiagram: true, showFingering: false });
    } }],
    elements: ['Item', 'Diagram', 'Diagram>Fret', 'Fingering', 'Diagram>Property', 'Chord'],
  },
  {
    id: 'lyrics-verses', title: 'Lyrics with several verses',
    look: 'Three lyric lines written by TabPlayer: verse one and verse two under bars 1 to 2, a third verse starting in bar 3. Look at where each syllable sits and how many verses Guitar Pro shows.',
    cases: [{ name: 'bar 1', build: () => {} }, { name: 'bar 2', build: () => {} }, { name: 'bar 3', build: () => {} }, { name: 'bar 4', build: () => {} }],
    post: (score) => { applyLyricsEdit(score, { type: 'setTrackLyrics', track: 0, visible: true, lines: [{ startBar: 0, text: 'La la la la lo lo lo lo' }, { startBar: 0, text: 'Do re mi fa sol la ti do' }, { startBar: 2, text: 'One two three four five six seven eight' }] }); },
    elements: ['Lyrics>Line', 'Line>Text', 'Line>Offset'],
  },
  {
    id: 'percussion', title: 'Percussion track',
    look: 'A guitar track and a percussion track with four different drum pieces per bar, written through TabPlayer\'s percussion references. Look at the drum staff, the piece names and noteheads.',
    tracks: [{ name: 'Guitar', short: 'Gtr' }, { name: 'Drums', short: 'Drm', percussion: true, program: 0 }],
    cases: [{ name: 'bar 1', build: () => {} }, { name: 'bar 2', build: () => {} }],
    elements: ['Articulations>Articulation', 'Note>InstrumentArticulation', 'Track>Name'],
  },
  {
    id: 'mix-automation', title: 'Volume and pan automation',
    look: 'Volume and pan changes on the first beats of bars 2 and 3, written to the track\'s channel strip. Look at the track\'s mixer automation lane for each bar.',
    cases: [{ name: 'bar 1', build: () => {} },
      { name: 'volume change', build: (c) => { c.beats[0].automations.push(Object.assign(new model.Automation(), { type: model.AutomationType.Volume, value: 12, ratioPosition: 0, isLinear: false })); } },
      { name: 'pan change', build: (c) => { c.beats[0].automations.push(Object.assign(new model.Automation(), { type: model.AutomationType.Balance, value: 4, ratioPosition: 0, isLinear: false })); } }],
    elements: ['ChannelStrip>Automations'],
  },
  {
    id: 'tempo-unit', title: 'Tempo in a non-quarter note',
    look: 'Bar 1 at 120 (quarter), bar 2 at 80 with a dotted quarter as the beat unit, bar 3 at 60 with a half note. Look at the tempo mark and its note symbol.',
    cases: [{ name: 'tempo 120 quarter', build: () => {} },
      { name: 'tempo 80 dotted quarter', build: (c) => { c.masterBar.tempoAutomations.push(buildTempo(false, 0, 80, 3)); } },
      { name: 'tempo 60 half', build: (c) => { c.masterBar.tempoAutomations.push(buildTempo(false, 0, 60, 4)); } }],
    elements: ['Automation'],
  },
  {
    id: 'common-cut-uniform', title: 'Common and cut time shown (every bar the same)',
    look: 'Four bars, all set to show the common-time and cut-time symbols. Guitar Pro keeps one such choice for the whole score. Look at whether the symbols show in every bar.',
    cases: [{ name: '4/4 common', build: () => {} }, { name: '2/2 cut', time: [2, 2], build: () => {} }, { name: '4/4 common', build: () => {} }, { name: '2/2 cut', time: [2, 2], build: () => {} }],
    post: (score) => commonCut(score, [true, true, true, true], [true, true, true, true]),
    elements: ['@Content/BinaryStylesheet', '@Content/Stylesheets/score.gpss', 'MasterBar>Time'],
    expectAbsent: ['@Content/Stylesheets/score.gpss'],
    notes: ['TabPlayer writes the choice into Content/BinaryStylesheet (the legacy stylesheet). Guitar Pro 8 may keep it in Content/Stylesheets/score.gpss instead; collect compares both members and shows where it appears.'],
  },
  {
    id: 'common-cut-mixed', title: 'Common and cut time shown in some bars only',
    look: 'Four bars: bars 1 and 3 set to show the common symbol, bars 2 and 4 set to show numbers. Guitar Pro keeps one choice for the whole score, so TabPlayer\'s export writes the choice most bars make and warns. Look at what Guitar Pro shows in each bar.',
    cases: [{ name: '4/4 symbol', build: () => {} }, { name: '4/4 numbers', build: () => {} }, { name: '4/4 symbol', build: () => {} }, { name: '4/4 numbers', build: () => {} }],
    post: (score) => commonCut(score, [true, false, true, false], [true, false, true, false]),
    elements: ['@Content/BinaryStylesheet', '@Content/Stylesheets/score.gpss', 'MasterBar>Time'],
    expectAbsent: ['@Content/Stylesheets/score.gpss'],
  },
  {
    id: 'curves-private', title: 'Bends, slur and note flags kept only in TabPlayer\'s private property',
    look: 'Written for TabPlayer\'s own `TabPlayerCurves` property: a bend with six points, a quick-style bend, a gradual whammy dive, a slur, a buzz-roll tremolo, a note sounding half its length and a hidden note. Guitar Pro does not read that property, so these are expected to show in a plainer form. Record how Guitar Pro shows each, and whether it keeps the property when it saves.',
    cases: [
      { name: 'bend with six points', build: (c) => { Object.assign(c.notes[0], { bendType: model.BendType.Custom, bendPoints: [point(0, 0), point(10, 2), point(20, 4), point(30, 2), point(45, 4), point(60, 0)] }); } },
      { name: 'quick-style bend', build: (c) => { Object.assign(c.notes[0], { bendType: model.BendType.Bend, bendStyle: model.BendStyle.Fast, bendPoints: [point(0, 0), point(60, 4)] }); } },
      { name: 'gradual whammy dive', build: (c) => { c.beats[0].whammyBarType = model.WhammyType.Dive; c.beats[0].whammyStyle = model.BendStyle.Gradual; c.beats[0].whammyBarPoints = [point(0, 0), point(60, -4)]; } },
      { name: 'slur', build: (c) => { const [a, b] = c.notes; link(a, b, { slurDestination: b }, { slurOrigin: a, isSlurDestination: true }); } },
      { name: 'buzz-roll tremolo', build: (c) => { c.beats[0].tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 2, style: model.TremoloPickingStyle.BuzzRoll }); } },
      { name: 'half-length note and hidden note', build: (c) => { c.notes[0].durationPercent = 0.5; c.notes[1].isVisible = false; } },
    ],
    elements: ['Property[TabPlayerCurves]', 'Property[Bended]', 'Whammy', 'Tremolo'],
    notes: ['Guitar Pro 8 is not expected to read Property[TabPlayerCurves]; the interesting result is whether it keeps the property when it saves, and what it shows instead.'],
  },
  {
    id: 'golpe', title: 'Golpe',
    look: 'A thumb golpe and a finger golpe on the first beat of bars 1 and 2. Look at whether Guitar Pro shows a golpe mark.',
    cases: [{ name: 'golpe thumb', build: (c) => { c.beats[0].golpe = model.GolpeType.Thumb; } }, { name: 'golpe finger', build: (c) => { c.beats[0].golpe = model.GolpeType.Finger; } }],
    elements: ['Golpe'],
  },
  {
    id: 'partial-capo', title: 'Partial capo',
    look: 'One track with a partial capo on fret 2 over strings 1 to 3 (the three highest). Look at the capo display and the fret numbers.',
    tracks: [{ name: 'Partial capo', short: 'PCap', build: (t) => { setPartialCapo(t.staff, { fret: 2, strings: [1, 2, 3] }); } }],
    cases: [{ name: 'plain bar 1', build: () => {} }, { name: 'plain bar 2', build: () => {} }],
    elements: ['Property[PartialCapoFret]', 'Property[PartialCapoStringFlags]'],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
function resetAlphaTabIds() {
  // alphaTab numbers bars, voices, beats and notes from process-wide counters; reset them so a family always gives the same bytes.
  Object.assign(model.Bar as unknown as Record<string, number>, { _globalBarId: 0 });
  Object.assign(model.Beat as unknown as Record<string, number>, { _globalBeatId: 0 });
  Object.assign(model.Note as unknown as Record<string, number>, { globalNoteId: 0 });
  Object.assign(model.Voice as unknown as Record<string, number>, { _globalVoiceId: 0 });
}

export function buildFamilyScore(family: KitFamily): { score: model.Score; settings: Settings; expected: KitExpected } {
  resetAlphaTabIds();
  const settings = new Settings(), score = new model.Score();
  score.title = `GP8 acceptance: ${family.id}`; score.artist = 'TabPlayer acceptance kit';
  const trackDefs: KitTrack[] = family.tracks ?? [{ name: 'Guitar', short: 'Gtr' }];
  const shapes = family.cases.map((c) => { const [num, den] = c.time ?? [4, 4]; return { num, den, count: c.beats ?? num, duration: DURATION_BY_DEN[den] ?? model.Duration.Quarter }; });
  family.cases.forEach((c, i) => {
    const master = new model.MasterBar();
    master.timeSignatureNumerator = shapes[i].num; master.timeSignatureDenominator = shapes[i].den;
    if (i === 0) master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, KIT_BPM, 2)];
    master.section = new model.Section(); master.section.marker = String(i + 1); master.section.text = `${family.id}: ${c.name}`;
    score.addMasterBar(master);
  });
  const expected: KitExpected = { notes: 0, onsets: [], quarters: 0 };
  trackDefs.forEach((def, trackIndex) => {
    const track = new model.Track(), staff = new model.Staff(), tuning = def.percussion ? [] : (def.tuning ?? GUITAR_TUNING);
    track.name = def.name; track.shortName = def.short ?? def.name.slice(0, 4);
    track.playbackInfo.program = def.program ?? 25;
    if (def.volume !== undefined) track.playbackInfo.volume = def.volume;
    if (def.balance !== undefined) track.playbackInfo.balance = def.balance;
    if (def.color) track.color = new model.Color(def.color[0], def.color[1], def.color[2], 255);
    staff.stringTuning.tunings = [...tuning]; staff.showTablature = !def.percussion;
    if (def.percussion) { staff.isPercussion = true; track.playbackInfo.primaryChannel = 9; track.playbackInfo.secondaryChannel = 9; }
    score.addTrack(track); track.addStaff(staff);
    def.build?.({ track, staff });
    let cursor = 0;
    family.cases.forEach((c, i) => {
      const shape = shapes[i], bar = new model.Bar(), voice = new model.Voice();
      staff.addBar(bar); bar.addVoice(voice);
      const beats: model.Beat[] = [], notes: model.Note[] = [];
      for (let b = 0; b < shape.count; b += 1) {
        const beat = new model.Beat(), note = new model.Note();
        beat.duration = shape.duration; beat.isEmpty = false;
        if (def.percussion) { note.string = -1; note.fret = -1; note.percussionArticulation = DRUM_ARTICULATIONS[b % DRUM_ARTICULATIONS.length]; }
        else { const spec = noteSpec(b, tuning); note.string = spec.string; note.fret = spec.fret; }
        beat.addNote(note); voice.addBeat(beat); beats.push(beat); notes.push(note);
      }
      if (trackIndex === 0) c.build({ score, track, staff, bar, masterBar: score.masterBars[i], beats, notes, index: i });
      const length = beats.reduce((sum, beat) => sum + quartersOf(beat), 0), barQuarters = (shape.num * 4) / shape.den;
      let remaining = barQuarters - length;
      for (const [size, duration] of [[1, model.Duration.Quarter], [0.5, model.Duration.Eighth], [0.25, model.Duration.Sixteenth]] as const) {
        while (remaining >= size - 1e-9) { const rest = new model.Beat(); rest.duration = duration; rest.isEmpty = false; voice.addBeat(rest); remaining -= size; }
      }
      if (trackIndex === 0) {
        let at = cursor;
        for (const beat of beats) {
          const sounding = beat.notes.filter((n) => !n.isTieDestination);
          if (sounding.length) { expected.onsets.push(round(at)); expected.notes += sounding.length; }
          at += quartersOf(beat);
        }
        cursor += barQuarters; expected.quarters = cursor;
      }
    });
  });
  family.post?.(score);
  score.finish(settings);
  return { score, settings, expected };
}

export function buildKit(): KitFile[] {
  return KIT_FAMILIES.map((family, index) => {
    const { score, settings, expected } = buildFamilyScore(family);
    const warnings = gpLosses(score);
    const bytes = exportGpInterchange(score, settings);
    const meta: KitFamilyMeta = {
      id: family.id, title: family.title, look: family.look, cases: family.cases.map((c) => c.name), tracks: (family.tracks ?? [{ name: 'Guitar' }]).map((t) => t.name),
      elements: [...new Set(family.elements)], control: !!family.control, expectAbsent: family.expectAbsent ?? [],
      midi: { notes: expected.notes, onsets: expected.onsets, quarters: expected.quarters, timing: family.midi?.timing !== false, why: family.midi?.why ?? null },
      warnings, notes: family.notes ?? [],
    };
    return { index, name: `${String(index + 1).padStart(2, '0')}-${family.id}`, meta, bytes };
  });
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Writes the .gp files and kit-manifest.json. The checklist is written by scripts/gp8-acceptance-kit.mjs from the manifest. */
export function writeKitFiles(dir: string): string[] {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const files = buildKit(), written: string[] = [];
  const manifest = { kit: 'gp8-acceptance', source: 'TabPlayer exportGpInterchange', bpm: KIT_BPM, families: files.map((f) => ({ ...f.meta, index: f.index, name: f.name, file: `${f.name}.gp`, sha256: sha256(f.bytes), bytes: f.bytes.length })) };
  for (const f of files) { const path = join(out, `${f.name}.gp`); writeFileSync(path, f.bytes); written.push(path); }
  const manifestPath = join(out, 'kit-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1)); written.push(manifestPath);
  return written;
}
