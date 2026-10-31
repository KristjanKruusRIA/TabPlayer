// Builds an alphaTab Score from a parsed TablEdit document (experimental; see the validation note for what is guessed).
import { model, type Settings } from '@coderline/alphatab';
import { parseTablEdit, TablEditError, type TefDocument, type TefEvent, type TefInstrument } from './tabledit';
import { ImportReport } from './import-support';

const { Score, Track, Staff, Bar, Voice, Beat, Note, MasterBar, Automation } = model;

const MAX_BARS = 3000;
const MAX_BEATS = 30000;
const MAX_REPEAT_COUNT = 16;
/** Beats and notes the audio engine may be asked to play, counting every pass through a repeat. */
const MAX_PLAYED_EVENTS = 120000;
/** Internal time unit: one 64th of a whole note is 12 units, so dots and 3:2 tuplets stay integers. */
const U = 12;

export interface TablEditImport { score: model.Score; notice: string }

interface Length { type: number; dots: number; triplet: boolean; ok: boolean }

/** Duration codes 0..18 cycle plain, dotted, triplet over the base types; 19, 22, 25 and 28 are double dotted. */
function decodeLength(code: number): Length {
  if (code <= 18) {
    const m = code % 3;
    return { type: m === 0 ? code / 3 : m === 1 ? (code + 2) / 3 : (code - 2) / 3, dots: m === 1 ? 1 : 0, triplet: m === 2, ok: true };
  }
  if (code === 19 || code === 22 || code === 25 || code === 28) return { type: (code - 19) / 3 + 1, dots: 2, triplet: false, ok: true };
  return { type: 2, dots: 0, triplet: false, ok: false };
}

function unitsOf(l: Length) {
  const base = 64 >> l.type;
  return l.triplet ? base * 8 : base * (l.dots === 0 ? 12 : l.dots === 1 ? 18 : 21);
}

const REST_SIZES: [number, number, number][] = [[64, 1, 0], [48, 2, 1], [32, 2, 0], [24, 4, 1], [16, 4, 0], [12, 8, 1], [8, 8, 0], [6, 16, 1], [4, 16, 0], [3, 32, 1], [2, 32, 0], [1, 64, 0]];

function sanitize(text: string, fallback: string) {
  const clean = text.replace(/[^\x20-\x7e -ÿ]/g, ' ').trim().slice(0, 80);
  return clean || fallback;
}

function tooLarge(detail = '') { return new TablEditError(`This TablEdit file is too large to import safely${detail}.`); }

export function importTablEdit(bytes: Uint8Array, settings: Settings): TablEditImport {
  const doc = parseTablEdit(bytes);
  try { return convert(doc, settings); }
  catch (error) {
    if (error instanceof TablEditError) throw error;
    throw new TablEditError('The TablEdit file could not be converted into a score.', error);
  }
}

interface Slot { notes: TefEvent[]; rest: TefEvent | null }

function convert(doc: TefDocument, settings: Settings): TablEditImport {
  const report: ImportReport = doc.report;
  const measureCount = doc.measures.length;

  // Measures: nominal lengths come from the time signatures.
  const sizes: number[] = [], starts: number[] = [];
  let time = { n: 4, d: 4 }, key = 0, total = 0;
  const score = new Score();
  score.title = sanitize(doc.title, ''); score.subTitle = sanitize(doc.subtitle, ''); score.copyright = sanitize(doc.copyright, '');
  const keys: number[] = [];
  doc.measures.forEach(m => {
    if ([1, 2, 4, 8, 16, 32].includes(m.denominator) && m.numerator >= 1 && m.numerator <= 32) time = { n: m.numerator, d: m.denominator };
    else report.bump('unsupported time signatures');
    if (m.key >= -7 && m.key <= 7) key = m.key; else report.bump('key signatures out of range');
    const master = new MasterBar();
    master.timeSignatureNumerator = time.n; master.timeSignatureDenominator = time.d; master.isAnacrusis = m.pickup;
    score.addMasterBar(master);
    sizes.push(64 * time.n / time.d); starts.push(total); total += 64 * time.n / time.d; keys.push(key);
  });
  const masters = score.masterBars;
  const tempo = doc.tempo >= 20 && doc.tempo <= 400 ? doc.tempo : 120;
  if (tempo !== doc.tempo) report.warn(`The tempo (${doc.tempo}) is out of range, so 120 was used.`);
  masters[0].tempoAutomations = [Automation.buildTempoAutomation(false, 0, tempo, 2)];


  // Group events by instrument and voice, keyed by position.
  const perInstrument = doc.instruments.map(() => [new Map<number, Slot>(), new Map<number, Slot>()]);
  const inRange = (e: TefEvent) => e.position < total;
  for (const e of doc.events) {
    if (!inRange(e)) { report.bump('events after the last measure'); continue; }
    const index = doc.instruments.findIndex(i => e.string >= i.firstString && e.string < i.firstString + i.strings);
    if (index < 0) { report.bump('events on strings the file does not define'); continue; }
    const slots = perInstrument[index][e.voice];
    const slot = slots.get(e.position) ?? { notes: [], rest: null };
    slots.set(e.position, slot);
    if (e.kind === 'rest') slot.rest = slot.rest ?? e; else slot.notes.push(e);
  }
  const used = doc.instruments.map((_, i) => perInstrument[i][0].size + perInstrument[i][1].size > 0);
  const trackCount = used.filter(Boolean).length;
  if (!trackCount) throw new TablEditError('The TablEdit file contains no notes.');
  report.bump('instruments with no notes', used.length - trackCount);
  if (Math.min(trackCount, 15) * measureCount > MAX_BARS) throw tooLarge(` (${trackCount} instruments x ${measureCount} measures)`);

  // Playback cost of one pass through each measure: its events plus the rests every track needs.
  const weights = starts.map(() => 2 * Math.min(trackCount, 15));
  for (const slots of perInstrument.flat()) for (const position of slots.keys()) weights[measureAt(starts, position)] += 2;
  applyReadingList(doc, masters, report, weights);
  score.rebuildRepeatGroups();

  const channels = Array.from({ length: 16 }, (_, i) => i).filter(i => i !== 9);
  let nextChannel = 0, beatBudget = 0;
  doc.instruments.forEach((ins, index) => {
    if (!used[index]) return;
    if (nextChannel >= channels.length) { report.bump('instruments (more than 15 playback channels)'); return; }
    const name = sanitize(ins.name, `Instrument ${index + 1}`);
    const track = new Track(); track.name = name; track.shortName = name.slice(0, 12);
    track.playbackInfo.program = ins.midi <= 127 ? ins.midi : 25;
    track.playbackInfo.primaryChannel = channels[nextChannel]; track.playbackInfo.secondaryChannel = channels[nextChannel + 1] ?? channels[nextChannel];
    nextChannel++;
    const staff = new Staff(); staff.stringTuning.tunings = [...ins.tuning]; staff.showTablature = true; staff.showStandardNotation = true;
    // The capo is not applied: it is not known whether the stored tuning already includes it, and applying both would raise every pitch twice.
    if (ins.capo > 0) report.bump('capo settings (pitches use the stored tuning)');
    track.addStaff(staff);
    const [first, second] = perInstrument[index];
    const buckets = [first, second].map(slots => bucketByMeasure(slots, starts, sizes));
    const bassClef = ins.tuning[0] < 52;
    const frets = [new Map<number, number>(), new Map<number, number>()];
    const bars: model.Voice[][] = [];
    let secondVoice = false;
    for (let m = 0; m < measureCount; m++) {
      const pickup = doc.measures[m].pickup;
      const voices = [first, second].map((_, v) => {
        const voice = new Voice();
        const items = buckets[v][m];
        buildVoice(voice, items, starts[m], sizes[m], pickup, v === 0, ins, frets[v], report, () => {
          if (++beatBudget > MAX_BEATS) throw tooLarge(' (too many beats)');
        });
        if (v === 1 && voice.beats.length) secondVoice = true;
        return voice;
      });
      bars.push(voices);
    }
    bars.forEach((voices, m) => {
      const bar = new Bar();
      bar.clef = bassClef ? model.Clef.F4 : model.Clef.G2;
      bar.keySignature = keys[m] as model.KeySignature; bar.keySignatureType = 0 as model.KeySignatureType;
      bar.addVoice(voices[0]);
      if (secondVoice) {
        const extra = voices[1];
        if (!extra.beats.length) { const carrier = new Beat(); carrier.isEmpty = true; extra.addBeat(carrier); }
        bar.addVoice(extra);
      }
      staff.addBar(bar);
    });
    score.addTrack(track);
  });
  if (!score.tracks.length) throw new TablEditError('The TablEdit file contains no playable instruments.');
  score.finish(settings);

  const labels = report.labels();
  const parts = [`Imported from TablEdit (experimental import, tested only on synthetic files): ${measureCount} measures, ${score.tracks.length} track${score.tracks.length === 1 ? '' : 's'}.`];
  parts.push(labels.length
    ? `Not imported (dropped): ${labels.join('; ')}.`
    : 'No dropped content was detected, but the importer cannot detect every unsupported TablEdit feature.');
  parts.push('Imported where present: notes, rests, rhythm (including dots and triplets), ties, grace notes, two voices, tuning, repeats, key and time signatures, tempo and title.');
  return { score, notice: [...parts, ...report.warningText()].join(' ') };
}

/**
 * The reading list is read as the order in which measure ranges are played. Only runs of one identical range in order become
 * repeats; jumps, endings and anything overlapping an earlier repeat are reported as dropped. Repeats never nest, and their total cost is capped, so
 * the audio engine's expansion stays bounded.
 */
function applyReadingList(doc: TefDocument, masters: model.MasterBar[], report: ImportReport, weights: number[]) {
  const count = masters.length;
  let expected = 1, lastRepeatEnd = 0, played = weights.reduce((a, b) => a + b, 0);
  const list = doc.readingList;
  for (let i = 0; i < list.length;) {
    const [a, b] = list[i];
    let run = 1;
    while (i + run < list.length && list[i + run][0] === a && list[i + run][1] === b) run++;
    i += run;
    if (a < 1 || b < a || b > count) { report.bump('reading-list entries out of range'); continue; }
    const inOrder = a === expected;
    expected = b + 1;
    if (!inOrder) { report.bump('reading-list jumps and endings'); continue; }
    if (run < 2) continue;
    if (a <= lastRepeatEnd) { report.bump('repeats overlapping an earlier repeat'); continue; }
    const times = Math.min(run, MAX_REPEAT_COUNT);
    if (times < run) report.bump(`repeat counts above ${MAX_REPEAT_COUNT} (reduced)`);
    const extra = weights.slice(a - 1, b).reduce((x, y) => x + y, 0) * (times - 1);
    if (played + extra > MAX_PLAYED_EVENTS) { report.bump('repeats beyond the playback size limit'); continue; }
    played += extra; lastRepeatEnd = b;
    masters[a - 1].isRepeatStart = true; masters[b - 1].repeatCount = times;
  }
}

function measureAt(starts: number[], position: number) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= position) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Sorted slots per measure, found by binary search so the cost is linear in the number of events. */
function bucketByMeasure(slots: Map<number, Slot>, starts: number[], sizes: number[]) {
  const out: [number, Slot][][] = starts.map(() => []);
  for (const entry of slots.entries()) {
    const lo = measureAt(starts, entry[0]);
    if (entry[0] >= starts[lo] && entry[0] < starts[lo] + sizes[lo]) out[lo].push(entry);
  }
  for (const list of out) list.sort((a, b) => a[0] - b[0]);
  return out;
}

function addRests(voice: model.Voice, units: number, tick: () => void) {
  let left = Math.floor(units / U);
  for (const [size, duration, dots] of REST_SIZES) {
    while (left >= size) { const b = new Beat(); b.duration = duration as model.Duration; b.dots = dots; b.isEmpty = false; voice.addBeat(b); tick(); left -= size; }
  }
}

function buildVoice(
  voice: model.Voice, items: [number, Slot][], start: number, size: number, pickup: boolean, primary: boolean,
  ins: TefInstrument, frets: Map<number, number>, report: ImportReport, tick: () => void,
) {
  const capacity = size * U;
  let cursor = pickup && items.length ? (items[0][0] - start) * U : 0;
  let open = 0; // beats in the current triplet group
  for (const [position, slot] of items) {
    const offset = (position - start) * U;
    if (!open && offset > cursor) { addRests(voice, offset - cursor, tick); cursor = offset; }
    else if (!open && offset < cursor) report.bump('notes shifted later because an earlier note overlaps them');
    const lead = slot.notes[0] ?? slot.rest;
    if (!lead) continue;
    const length = decodeLength(lead.code);
    if (!length.ok) report.bump('unsupported note lengths (shown as quarter notes)');
    const units = unitsOf(length);
    if (cursor + units > capacity) { report.bump('notes or rests that overflow their measure', Math.max(1, slot.notes.length)); continue; }
    const beat = new Beat(); beat.isEmpty = false;
    beat.duration = (1 << length.type) as model.Duration; beat.dots = length.dots;
    if (length.triplet) { beat.tupletNumerator = 3; beat.tupletDenominator = 2; open = open >= 2 ? 0 : open + 1; } else open = 0;
    const seen = new Set<number>();
    for (const e of slot.notes) {
      const local = e.string - ins.firstString;
      if (seen.has(local)) { report.bump('duplicate notes on one string'); continue; }
      seen.add(local);
      if (e.code !== lead.code) report.bump('chord notes with a different length from their chord');
      const note = new Note();
      // String 1 is the top tab line and the highest tuning entry; alphaTab numbers strings from the lowest.
      note.string = ins.strings - local; note.fret = e.fret;
      if (e.tie) {
        if (frets.has(note.string)) { note.isTieDestination = true; note.fret = frets.get(note.string)!; } else report.bump('ties with no earlier note');
      }
      frets.set(note.string, note.fret);
      beat.addNote(note);
    }
    const graceSource = slot.notes.find(e => e.grace);
    if (graceSource?.grace && beat.notes.length) {
      const grace = new Beat(); grace.isEmpty = false; grace.graceType = model.GraceType.BeforeBeat; grace.duration = 16 as model.Duration;
      const note = new Note(); note.string = ins.strings - (graceSource.string - ins.firstString); note.fret = graceSource.grace.fret;
      grace.addNote(note); voice.addBeat(grace); tick();
    }
    voice.addBeat(beat); tick();
    cursor += units;
  }
  if (!pickup && cursor < capacity && (primary || voice.beats.length)) addRests(voice, capacity - cursor, tick);
  if (primary && !voice.beats.length) addRests(voice, capacity, tick);
}
