#!/usr/bin/env node
// THE-61 Guitar Pro 8 acceptance kit.
//   node scripts/gp8-acceptance-kit.mjs write [dir]     writes small authored .gp files, checklist.md and kit-manifest.json (default .analysis/gp8-acceptance/)
//   node scripts/gp8-acceptance-kit.mjs collect [dir]   reads what came back from Guitar Pro 8 (re-saved .gp, exported .mid) and writes results.md and results.json
// Nothing here has been opened in Guitar Pro 8. The files are written with alphaTab's public Guitar Pro 7/8 writer, not with TabPlayer's
// own exporter: that exporter is TypeScript with extensionless imports and a plain Node script cannot load it (the same limit as
// scripts/fermata-probe.mjs, whose helpers this script reuses). So TabPlayer-only additions (TabPlayerCurves, partial capo, harmony
// carriers) are NOT exercised here. Fermatas are patched into score.gpif by hand, exactly as the fermata probe does.
// `collect` compares the GPIF XML of the file written with the XML of the file Guitar Pro saved, for the named elements only, and
// reads the exported MIDI with the probe's Standard MIDI File reader. It never throws on a returned file: every problem is reported.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exporter, model, Settings } from '@coderline/alphatab';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { fermataXml, GUITAR_TUNING, MAX_MIDI_BYTES, parseSmf, stringAndFret, tempoMap, tickToSeconds } from './fermata-probe.mjs';

export const DEFAULT_DIR = '.analysis/gp8-acceptance';
export const MAX_GP_BYTES = 64 * 1024 * 1024;
export const MAX_GPIF_BYTES = 48 * 1024 * 1024;
export const MAX_XML_NODES = 2_000_000;
export const MAX_XML_DEPTH = 256;
export const GPIF = 'Content/score.gpif';
export const BPM = 120;

// ---------------------------------------------------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------------------------------------------------
/** Enum member by name; throws with the member list if alphaTab no longer has it, so the kit never writes `undefined`. */
const E = (enumObject, enumName, name) => {
  const value = enumObject?.[name];
  if (typeof value !== 'number') throw new Error(`alphaTab model.${enumName}.${name} does not exist. Members: ${Object.keys(enumObject ?? {}).filter((k) => Number.isNaN(Number(k))).join(', ')}`);
  return value;
};
const M = (enumName, name) => E(model[enumName], enumName, name);
const point = (offset, value) => new model.BendPoint(offset, value);

const DURATION_VALUE = { 2: 'Half', 4: 'Quarter', 8: 'Eighth', 16: 'Sixteenth' };
/** Quarter notes a beat lasts, from its duration, dots and tuplet ratio. */
export function beatQuarters(beat) {
  const base = 4 / beat.duration;
  let q = base * (beat.dots === 1 ? 1.5 : beat.dots === 2 ? 1.75 : 1);
  if (beat.tupletNumerator > 0 && beat.tupletDenominator > 0) q = (q * beat.tupletDenominator) / beat.tupletNumerator;
  return q;
}

/** A bar's default beats: one note per beat, quarters in x/4, eighths in x/8, halves in x/2. */
function shapeOf(testCase) {
  const [num, den] = testCase.time ?? [4, 4];
  return { num, den, count: testCase.beats ?? num, duration: M('Duration', DURATION_VALUE[den] ?? 'Quarter') };
}
const noteFor = (index, tuning) => {
  const strings = tuning.length;
  const string = Math.max(1, strings - (index % 3));
  return { string, fret: 2 + (index % 5) };
};

/** Family definitions. `cases` is one bar each, in order. `build(c)` receives {score, track, staff, bar, masterBar, beats, notes, index};
 *  `elements` are the GPIF elements the family is about (selectors, see `select`). `midi.timing` false means collect does not judge timing. */
const link = (from, to, flags) => { Object.assign(from, flags.from ?? {}); Object.assign(to, flags.to ?? {}); };
export const FAMILIES = [
  {
    id: 'structure', title: 'Bar structure: meter, free time, triplet feel, tempo, key',
    look: 'Time signatures (3/4, 6/8, cut time), the double bar, free time, the swing feel mark, a tempo change to 90 and key signatures. Common time and cut time are look-only: collect does not compare them, because the symbol is not an element of score.gpif.',
    cases: [
      { name: '3/4', time: [3, 4], build: () => {} },
      { name: '6/8', time: [6, 8], build: () => {} },
      { name: 'common time', build: (c) => { c.masterBar.timeSignatureCommon = true; } },
      { name: 'cut time 2/2', time: [2, 2], build: (c) => { c.masterBar.timeSignatureCommon = true; } },
      { name: 'double bar', build: (c) => { c.masterBar.isDoubleBar = true; } },
      { name: 'free time', build: (c) => { c.masterBar.isFreeTime = true; } },
      { name: 'triplet feel 8th', build: (c) => { c.masterBar.tripletFeel = M('TripletFeel', 'Triplet8th'); } },
      { name: 'tempo 90', build: (c) => { c.masterBar.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, 90, 2)); } },
      { name: 'key 3 sharps major', build: (c) => { c.bar.keySignature = 3; c.bar.keySignatureType = M('KeySignatureType', 'Major'); } },
      { name: 'key 2 flats minor', build: (c) => { c.bar.keySignature = -2; c.bar.keySignatureType = M('KeySignatureType', 'Minor'); } },
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
      { name: 'segno target', build: (c) => { c.masterBar.addDirection(M('Direction', 'TargetSegno')); } },
      { name: 'coda target', build: (c) => { c.masterBar.addDirection(M('Direction', 'TargetCoda')); } },
      { name: 'D.S. al Coda', build: (c) => { c.masterBar.addDirection(M('Direction', 'JumpDalSegnoAlCoda')); } },
    ],
    elements: ['MasterBar>Repeat', 'MasterBar>AlternateEndings', 'Directions>Target', 'Directions>Jump', 'MasterBar>Section'],
  },
  {
    id: 'fermata', title: 'Fermatas written by the kit (Short, Medium, Long)',
    look: 'A fermata symbol over the first beat of the three labelled bars. Do not add or remove any.',
    midi: { timing: false, why: 'A fermata may lengthen playback; that question belongs to the fermata control (file fermata-control) and to scripts/fermata-probe.mjs.' },
    cases: [
      { name: 'Short, Length 0', fermata: { type: 'Short', length: 0 }, build: () => {} },
      { name: 'Medium, Length 0', fermata: { type: 'Medium', length: 0 }, build: () => {} },
      { name: 'Long, Length 1', fermata: { type: 'Long', length: 1 }, build: () => {} },
    ],
    elements: ['Fermata', 'Fermata>Type', 'Fermata>Length', 'Fermata>Offset'],
  },
  {
    id: 'fermata-control', title: 'Fermata positive control: add ONE fermata by hand',
    look: 'This file has no fermata. In Guitar Pro 8 add a single fermata to the first beat of bar 2 by hand, then save and export as described. It shows how Guitar Pro itself writes a fermata and whether its own MIDI export holds the note.',
    midi: { timing: false, why: 'The point of this file is to measure whether a hold appears; collect reports the numbers instead of a verdict.' },
    control: true,
    cases: [
      { name: 'plain bar 1', build: () => {} },
      { name: 'plain bar 2 (add the fermata here)', build: () => {} },
      { name: 'plain bar 3', build: () => {} },
      { name: 'plain bar 4', build: () => {} },
    ],
    elements: ['Fermata', 'Fermata>Type', 'Fermata>Length', 'Fermata>Offset'],
  },
  {
    id: 'dynamics', title: 'Dynamics, crescendo, fades, beat text and lyrics',
    look: 'Dynamic marks pp and ff, a crescendo, a fade in, the words "Solo" over a beat and a lyric syllable under each beat of the last bar.',
    cases: [
      { name: 'dynamics pp', build: (c) => { c.beats[0].dynamics = M('DynamicValue', 'PP'); } },
      { name: 'dynamics ff', build: (c) => { c.beats[0].dynamics = M('DynamicValue', 'FF'); } },
      { name: 'crescendo', build: (c) => { c.beats[0].crescendo = M('CrescendoType', 'Crescendo'); } },
      { name: 'fade in', build: (c) => { c.beats[0].fade = M('FadeType', 'FadeIn'); } },
      { name: 'beat text "Solo"', build: (c) => { c.beats[0].text = 'Solo'; } },
      { name: 'lyrics', build: (c) => { ['La', 'la', 'laa', 'la'].forEach((t, i) => { c.beats[i].lyrics = [t]; }); } },
    ],
    elements: ['Beat>Dynamic', 'Hairpin', 'Fadding', 'FreeText', 'Lyrics>Line'],
  },
  {
    id: 'bends', title: 'Bends and whammy bar',
    look: 'Bend shapes (bend, bend and release, pre-bend, pre-bend and release) and whammy dive and dip on the first beat of each bar.',
    cases: [
      { name: 'bend up 1 tone', build: (c) => { Object.assign(c.notes[0], { bendType: M('BendType', 'Bend'), bendPoints: [point(0, 0), point(60, 4)] }); } },
      { name: 'bend and release', build: (c) => { Object.assign(c.notes[0], { bendType: M('BendType', 'BendRelease'), bendPoints: [point(0, 0), point(30, 4), point(60, 0)] }); } },
      { name: 'pre-bend', build: (c) => { Object.assign(c.notes[0], { bendType: M('BendType', 'Prebend'), bendPoints: [point(0, 4), point(60, 4)] }); } },
      { name: 'pre-bend and release', build: (c) => { Object.assign(c.notes[0], { bendType: M('BendType', 'PrebendRelease'), bendPoints: [point(0, 4), point(30, 4), point(60, 0)] }); } },
      { name: 'whammy dive', build: (c) => { c.beats[0].whammyBarType = M('WhammyType', 'Dive'); c.beats[0].whammyBarPoints = [point(0, 0), point(60, -4)]; } },
      { name: 'whammy dip', build: (c) => { c.beats[0].whammyBarType = M('WhammyType', 'Dip'); c.beats[0].whammyBarPoints = [point(0, 0), point(30, -4), point(60, 0)]; } },
    ],
    elements: ['Property[Bended]', 'Property[BendOriginValue]', 'Property[BendOriginOffset]', 'Property[BendMiddleValue]', 'Property[BendMiddleOffset1]', 'Property[BendMiddleOffset2]', 'Property[BendDestinationValue]', 'Property[BendDestinationOffset]', 'Whammy'],
  },
  {
    id: 'links', title: 'Ties, hammer-ons and slides',
    look: 'A tie, a hammer-on/pull-off, a shift slide, a legato slide, slides into the note from below and out downward.',
    cases: [
      { name: 'tie', build: (c) => { const [a, b] = c.notes; b.fret = a.fret; b.string = a.string; link(a, b, { from: { tieDestination: b }, to: { tieOrigin: a, isTieDestination: true } }); } },
      { name: 'hammer-on', build: (c) => { const [a, b] = c.notes; b.string = a.string; b.fret = a.fret + 2; link(a, b, { from: { isHammerPullOrigin: true, hammerPullDestination: b }, to: { hammerPullOrigin: a } }); } },
      { name: 'shift slide', build: (c) => { c.notes[0].slideOutType = M('SlideOutType', 'Shift'); } },
      { name: 'legato slide', build: (c) => { c.notes[0].slideOutType = M('SlideOutType', 'Legato'); } },
      { name: 'slide in from below', build: (c) => { c.notes[0].slideInType = M('SlideInType', 'IntoFromBelow'); } },
      { name: 'slide out down', build: (c) => { c.notes[0].slideOutType = M('SlideOutType', 'OutDown'); } },
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
      { name: 'accent normal', build: (c) => { c.notes[0].accentuated = M('AccentuationType', 'Normal'); } },
      { name: 'accent heavy', build: (c) => { c.notes[0].accentuated = M('AccentuationType', 'Heavy'); } },
      { name: 'note vibrato wide', build: (c) => { c.notes[0].vibrato = M('VibratoType', 'Wide'); } },
      { name: 'left-hand tap', build: (c) => { c.notes[0].isLeftHandTapped = true; } },
      { name: 'fingering', build: (c) => { Object.assign(c.notes[0], { leftHandFinger: M('Fingers', 'IndexFinger'), rightHandFinger: M('Fingers', 'Thumb') }); } },
    ],
    elements: ['Property[PalmMuted]', 'LetRing', 'Property[Muted]', 'AntiAccent', 'Accent', 'Vibrato', 'Property[LeftHandTapped]', 'LeftFingering', 'RightFingering'],
  },
  {
    id: 'harmonics-ornaments', title: 'Harmonics, trill and ornaments',
    look: 'Natural, artificial, pinch, tap, semi and feedback harmonics, a trill and a turn.',
    cases: [
      { name: 'natural harmonic 12', build: (c) => { Object.assign(c.notes[0], { harmonicType: M('HarmonicType', 'Natural'), harmonicValue: 12 }); } },
      { name: 'artificial harmonic', build: (c) => { Object.assign(c.notes[0], { harmonicType: M('HarmonicType', 'Artificial'), harmonicValue: 12 }); } },
      { name: 'pinch harmonic', build: (c) => { Object.assign(c.notes[0], { harmonicType: M('HarmonicType', 'Pinch'), harmonicValue: 12 }); } },
      { name: 'tap harmonic', build: (c) => { Object.assign(c.notes[0], { harmonicType: M('HarmonicType', 'Tap'), harmonicValue: 12 }); } },
      { name: 'semi harmonic', build: (c) => { Object.assign(c.notes[0], { harmonicType: M('HarmonicType', 'Semi'), harmonicValue: 12 }); } },
      { name: 'feedback harmonic', build: (c) => { Object.assign(c.notes[0], { harmonicType: M('HarmonicType', 'Feedback'), harmonicValue: 12 }); } },
      { name: 'trill', build: (c) => { Object.assign(c.notes[0], { trillValue: 68, trillSpeed: M('Duration', 'Sixteenth') }); } },
      { name: 'turn ornament', build: (c) => { c.notes[0].ornament = M('NoteOrnament', 'Turn'); } },
    ],
    elements: ['Property[HarmonicType]', 'Property[HarmonicFret]', 'Trill', 'Ornament'],
  },
  {
    id: 'strokes-gestures', title: 'Strokes, tremolo picking and gestures',
    look: 'Brush up/down, pick-stroke up/down, tremolo picking with 1 and 3 marks, rasgueado, slap, pop, tap, wah, barre and timer.',
    cases: [
      { name: 'brush down', build: (c) => { c.beats[0].brushType = M('BrushType', 'BrushDown'); c.beats[0].brushDuration = 30; } },
      { name: 'arpeggio up', build: (c) => { c.beats[0].brushType = M('BrushType', 'ArpeggioUp'); c.beats[0].brushDuration = 30; } },
      { name: 'pick stroke up', build: (c) => { c.beats[0].pickStroke = M('PickStroke', 'Up'); } },
      { name: 'pick stroke down', build: (c) => { c.beats[0].pickStroke = M('PickStroke', 'Down'); } },
      { name: 'tremolo picking 1 mark', build: (c) => { c.beats[0].tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 1 }); } },
      { name: 'tremolo picking 3 marks', build: (c) => { c.beats[0].tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 3 }); } },
      { name: 'rasgueado ii', build: (c) => { c.beats[0].rasgueado = M('Rasgueado', 'Ii'); } },
      { name: 'slap', build: (c) => { c.beats[0].slap = true; } },
      { name: 'pop', build: (c) => { c.beats[0].pop = true; } },
      { name: 'tap', build: (c) => { c.beats[0].tap = true; } },
      { name: 'wah open', build: (c) => { c.beats[0].wahPedal = M('WahPedal', 'Open'); } },
      { name: 'barre full at fret 3', build: (c) => { c.beats[0].barreFret = 3; c.beats[0].barreShape = M('BarreShape', 'Full'); } },
      { name: 'timer 45 s', build: (c) => { c.beats[0].showTimer = true; c.beats[0].timer = 45; } },
    ],
    elements: ['Property[Brush]', 'Arpeggio', 'XProperty', 'Property[PickStroke]', 'Tremolo', 'Property[Rasgueado]', 'Property[Slapped]', 'Property[Popped]', 'Property[Tapped]', 'Wah', 'Property[BarreFret]', 'Property[BarreString]', 'Timer'],
  },
  {
    id: 'rhythm', title: 'Rhythm: dots, tuplets, octave marks',
    look: 'Dotted eighths, a triplet, a quintuplet, sixteenth notes and an 8va octave mark.',
    cases: [
      { name: 'dotted eighth + sixteenth', beats: 8, build: (c) => { c.beats.forEach((b, i) => { b.duration = M('Duration', i % 2 ? 'Sixteenth' : 'Eighth'); b.dots = i % 2 ? 0 : 1; }) } },
      { name: 'triplet eighths', beats: 3, build: (c) => { c.beats.forEach((b) => { b.duration = M('Duration', 'Eighth'); b.tupletNumerator = 3; b.tupletDenominator = 2; }); } },
      { name: 'quintuplet sixteenths', beats: 5, build: (c) => { c.beats.forEach((b) => { b.duration = M('Duration', 'Sixteenth'); b.tupletNumerator = 5; b.tupletDenominator = 4; }); } },
      { name: 'sixteenths', beats: 16, build: (c) => { c.beats.forEach((b) => { b.duration = M('Duration', 'Sixteenth'); }); } },
      { name: 'octave 8va', build: (c) => { c.beats[0].ottava = M('Ottavia', '_8va'); } },
    ],
    elements: ['Rhythm', 'Rhythm>NoteValue', 'Rhythm>AugmentationDot', 'Rhythm>PrimaryTuplet', 'Ottavia'],
  },
  {
    id: 'tracks-tuning', title: 'Tracks, tuning, capo and staff display',
    look: 'Two tracks: "Capo 3" (capo on fret 3, orange) and "Drop D" (low string tuned to D, blue, mixer volume and pan changed, program 30). Check the track names, colours, tunings, capo and mixer values.',
    tracks: [
      { name: 'Capo 3', short: 'Cap', color: [220, 110, 40], build: (t) => { t.staff.capo = 3; } },
      { name: 'Drop D', short: 'DrpD', color: [40, 110, 220], tuning: [64, 59, 55, 50, 45, 38], volume: 12, balance: 4, program: 30, build: () => {} },
    ],
    cases: [{ name: 'plain bar 1', build: () => {} }, { name: 'plain bar 2', build: () => {} }],
    elements: ['Track>Name', 'Track>ShortName', 'Track>Color', 'Property[CapoFret]', 'Property[Tuning]', 'Program', 'ChannelStrip>Parameters'],
  },
  {
    id: 'chord-diagram', title: 'Chord diagram',
    look: 'A C major chord diagram named "C" over the first beat of bar 1.',
    cases: [{ name: 'chord C', build: (c) => {
      const chord = Object.assign(new model.Chord(), { name: 'C', firstFret: 1, strings: [0, 1, 0, 2, 3, -1], barreFrets: [], showName: true, showDiagram: true, showFingering: false });
      chord.staff = c.staff; c.staff.addChord('c1', chord); c.beats[0].chordId = 'c1';
    } }],
    elements: ['Item', 'Diagram', 'Chord'],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Building the files
// ---------------------------------------------------------------------------------------------------------------------
function buildScore(family) {
  // alphaTab numbers bars, voices, beats and notes from process-wide counters; reset them so the same family always gives the same bytes.
  model.Bar._globalBarId = 0; model.Beat._globalBeatId = 0; model.Note.globalNoteId = 0; model.Voice._globalVoiceId = 0;
  const settings = new Settings(), score = new model.Score();
  score.title = `GP8 acceptance: ${family.id}`; score.artist = 'TabPlayer acceptance kit';
  const trackDefs = family.tracks ?? [{ name: 'Guitar', short: 'Gtr', build: () => {} }];
  const shapes = family.cases.map(shapeOf);
  family.cases.forEach((testCase, i) => {
    const master = new model.MasterBar();
    master.timeSignatureNumerator = shapes[i].num; master.timeSignatureDenominator = shapes[i].den;
    if (i === 0) master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, BPM, 2)];
    master.section = new model.Section(); master.section.marker = String(i + 1); master.section.text = `${family.id}: ${testCase.name}`;
    score.addMasterBar(master);
  });
  const expected = { notes: 0, onsets: [], quarters: 0 };
  trackDefs.forEach((def, trackIndex) => {
    const track = new model.Track(), staff = new model.Staff(), tuning = def.tuning ?? GUITAR_TUNING;
    track.name = def.name; track.shortName = def.short ?? def.name.slice(0, 4);
    track.playbackInfo.program = def.program ?? 25;
    if (def.volume !== undefined) track.playbackInfo.volume = def.volume;
    if (def.balance !== undefined) track.playbackInfo.balance = def.balance;
    if (def.color) track.color = new model.Color(def.color[0], def.color[1], def.color[2], 255);
    staff.stringTuning.tunings = [...tuning]; staff.showTablature = true;
    score.addTrack(track); track.addStaff(staff);
    def.build?.({ track, staff });
    let cursor = 0;
    family.cases.forEach((testCase, i) => {
      const shape = shapes[i], bar = new model.Bar(), voice = new model.Voice();
      staff.addBar(bar); bar.addVoice(voice);
      const beats = [], notes = [];
      for (let b = 0; b < shape.count; b += 1) {
        const beat = new model.Beat(); beat.duration = shape.duration; beat.isEmpty = false;
        const spec = noteFor(b, tuning), note = new model.Note();
        note.string = spec.string; note.fret = spec.fret; beat.addNote(note);
        voice.addBeat(beat); beats.push(beat); notes.push(note);
      }
      const context = { score, track, staff, bar, masterBar: score.masterBars[i], beats, notes, index: i };
      if (trackIndex === 0 || family.tracks) testCase.build(context);
      // A case may drop beats (c.beats.length = n); remove the excess from the voice too.
      while (voice.beats.length > beats.length) voice.beats.pop();
      // Fill the bar with rests where a tuplet or short case leaves it under-full.
      const length = beats.reduce((sum, beat) => sum + beatQuarters(beat), 0), barQuarters = (shape.num * 4) / shape.den;
      const rest = barQuarters - length;
      if (rest > 1e-9) {
        let remaining = rest; const fills = [];
        while (remaining >= 1 - 1e-9) { const r = new model.Beat(); r.duration = M('Duration', 'Quarter'); r.isEmpty = false; fills.push(r); remaining -= 1; }
        while (remaining >= 0.5 - 1e-9) { const r = new model.Beat(); r.duration = M('Duration', 'Eighth'); r.isEmpty = false; fills.push(r); remaining -= 0.5; }
        while (remaining >= 0.25 - 1e-9) { const r = new model.Beat(); r.duration = M('Duration', 'Sixteenth'); r.isEmpty = false; fills.push(r); remaining -= 0.25; }
        for (const r of fills) { voice.addBeat(r); }
      }
      if (trackIndex === 0) {
        let at = cursor;
        for (const beat of beats) {
          const sounding = beat.notes.filter((n) => !n.isTieDestination);
          if (sounding.length) { expected.onsets.push(round(at)); expected.notes += sounding.length; }
          at += beatQuarters(beat);
        }
        cursor += barQuarters; expected.quarters = cursor;
      }
    });
  });
  score.finish(settings);
  return { score, settings, expected };
}
const round = (x) => Math.round(x * 1000) / 1000;

/** Bytes of one authored file. Fermata cases are patched into score.gpif as the fermata probe does. */
export function buildFamilyFile(family) {
  const { score, settings, expected } = buildScore(family);
  const entries = unzipSync(new exporter.Gp7Exporter().export(score, settings));
  const fermataCases = family.cases.map((c) => c.fermata ?? null);
  if (fermataCases.some(Boolean)) {
    const parts = strFromU8(entries[GPIF]).replace(/<Fermatas>[\s\S]*?<\/Fermatas>/g, '').split('</MasterBar>');
    if (parts.length !== family.cases.length + 1) throw new Error(`Expected ${family.cases.length} master bars in the written GPIF of ${family.id}, found ${parts.length - 1}.`);
    entries[GPIF] = strToU8(parts.map((part, i) => (i < family.cases.length && fermataCases[i] ? part + fermataXml({ type: fermataCases[i].type, length: fermataCases[i].length, beat: 0 }) : part)).join('</MasterBar>'));
  }
  return { bytes: zipSync(entries, { mtime: new Date(Date.UTC(2020, 0, 1)) }), expected };
}

export const fileName = (index, family) => `${String(index + 1).padStart(2, '0')}-${family.id}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------------------------------------------------
export function checklistText(entries) {
  const out = [
    '# Guitar Pro 8 acceptance checklist (THE-61)', '',
    'Nothing in this kit has been opened in Guitar Pro 8. You need an activated Guitar Pro 8. Do not edit the `.gp` files this kit wrote; open each, look, then save and export under the new names below, in this same folder.', '',
    'Before you start: in Guitar Pro 8, switch off any count-in, metronome click or extra repeats for MIDI export, and write down the export options you chose (the Guitar Pro version, build and the option names). Take the settings once and keep them the same for every file.', '',
    'For every file:', '',
    '1. Open it. Note any warning on opening (say which file and the exact text).',
    '2. Look at the things named for that file. Write down anything missing or different from what is named. The bar labels (section names) say which case each bar is.',
    '3. File, Save as, type Guitar Pro 7/8 (`.gp`), the name shown as "save as", in this folder.',
    '4. File, Export, MIDI, the name shown as "export as", in this folder. Use the default MIDI options.',
    '5. Close the file without saving again.', '',
    'Then run `node scripts/gp8-acceptance-kit.mjs collect <this folder>` and read `results.md`.', '',
    '| # | File to open | What to look at | Save as (.gp) | Export as (MIDI) |', '|---|---|---|---|---|',
  ];
  entries.forEach(({ family, name }) => out.push(`| ${name.slice(0, 2)} | \`${name}.gp\` | ${family.look.replace(/\|/g, '/')} | \`${name}.saved.gp\` | \`${name}.mid\` |`));
  out.push('');
  entries.forEach(({ family, name }) => {
    out.push(`## ${name.slice(0, 2)} ${family.title}`, '', `File \`${name}.gp\`. ${family.look}`, '', 'Bars, in order (each is labelled in the file by its section name):', '');
    family.cases.forEach((c, i) => out.push(`${i + 1}. ${family.id}: ${c.name}`));
    if (family.tracks) out.push('', 'Tracks: ' + family.tracks.map((t) => t.name).join(', ') + '.');
    out.push('', `Save as \`${name}.saved.gp\`; export MIDI as \`${name}.mid\`.`, '');
    if (family.control) {
      out.push('### Fermata positive control (do these exact steps)', '',
        '1. Open `' + name + '.gp`. It has four plain bars and no fermata.',
        '2. Select the first beat of bar 2 and add one fermata by hand with Guitar Pro 8\'s own fermata tool. Write down which type and length you chose (the defaults are fine; say so).',
        '3. Do not change anything else. Save as `' + name + '.saved.gp`.',
        '4. Export MIDI with the default options as `' + name + '.mid`.',
        '5. If the MIDI export dialog offers an option that changes tempo, repeat or fermata handling, export once more with the other setting as `' + name + '-alt.mid` and write down which option it was.',
        '', 'This answers three open questions from `docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md`: how Guitar Pro itself writes a fermata, whether its MIDI export holds the note, and by how much. The earlier probe had no fermata placed by Guitar Pro itself.', '');
    }
  });
  out.push('## When something looks wrong', '', 'Write what you saw and in which bar, even if it seems small. A file Guitar Pro refuses to open is a result: note the exact message and skip that file\'s save and export.', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------------------------------------------------
export function writeKit(dir) {
  const out = resolve(dir ?? DEFAULT_DIR);
  mkdirSync(out, { recursive: true });
  const files = [], manifest = { kit: 'gp8-acceptance', bpm: BPM, ppqNote: 'Expected MIDI onsets are in quarter notes from the start.', families: [] };
  const entries = [];
  const warnings = [];
  FAMILIES.forEach((family, index) => {
    const name = fileName(index, family), { bytes, expected } = buildFamilyFile(family);
    const path = join(out, `${name}.gp`);
    if (existsSync(path) && sha256(readFileSync(path)) !== sha256(bytes) && (existsSync(join(out, `${name}.saved.gp`)) || existsSync(join(out, `${name}.mid`)))) {
      warnings.push(`${name}.gp already existed with different bytes and has returned files beside it; the new file replaces it, so those returned files no longer match.`);
    }
    writeFileSync(path, bytes); files.push(path);
    entries.push({ family, name });
    manifest.families.push({
      id: family.id, index, name, title: family.title, file: `${name}.gp`, sha256: sha256(bytes), bytes: bytes.length,
      cases: family.cases.map((c) => c.name), tracks: family.tracks?.map((t) => t.name) ?? ['Guitar'],
      elements: [...new Set(family.elements)], control: !!family.control,
      midi: { notes: expected.notes, onsets: expected.onsets, quarters: expected.quarters, timing: family.midi?.timing !== false, why: family.midi?.why ?? null },
    });
  });
  const checklist = join(out, 'checklist.md');
  writeFileSync(checklist, checklistText(entries)); files.push(checklist);
  const manifestPath = join(out, 'kit-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1)); files.push(manifestPath);
  return { out, files, warnings };
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
    try { entries = unzipSync(bytes, { filter: (file) => file.name === GPIF && file.originalSize <= MAX_GPIF_BYTES }); }
    catch (error) { return { status: 'unreadable', detail: `zip could not be read: ${error?.message ?? error}` }; }
    const gpif = entries[GPIF];
    if (!gpif) return { status: 'unreadable', detail: `no ${GPIF} inside the archive, or it is larger than ${MAX_GPIF_BYTES} bytes` };
    const xml = parseXml(strFromU8(gpif));
    if (xml.error) return { status: 'unreadable', detail: `score.gpif is not readable XML: ${xml.error}`, xml };
    return { status: 'ok', detail: '', xml, bytes: bytes.length };
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
        try { record.selectors.push(compareSelector(selector, original.xml.root, saved.xml.root)); }
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
    const { out, files, warnings } = writeKit(dir);
    console.log(`Wrote ${FAMILIES.length} Guitar Pro files, checklist.md and kit-manifest.json to ${out}`);
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
