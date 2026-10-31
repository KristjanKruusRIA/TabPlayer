import { model, type Settings } from '@coderline/alphatab';
import { parsePowerTab, PowerTabError, PTB_LIMITS, type PtbBarline, type PtbDocument, type PtbGuitar, type PtbPosition, type PtbScore, type PtbSystem } from './powertab';

const { Score, Track, Staff, Bar, Voice, Beat, Note, MasterBar, Automation, Section } = model;
const STANDARD: Record<number, number[]> = {
  3: [55, 50, 45], 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 6: [64, 59, 55, 50, 45, 40],
  7: [64, 59, 55, 50, 45, 40, 35], 8: [64, 59, 55, 50, 45, 40, 35, 30],
};
const BEAT_QUARTERS = [2, 3, 1, 1.5, 0.5, 0.75, 0.25, 0.375, 0.125, 0.1875];
const DURATIONS = new Set([1, 2, 4, 8, 16, 32, 64]);

export interface PowerTabImport { score: model.Score; notice: string }

interface Boundaries { starts: PtbBarline[]; ends: { type: number; repeat: number }[] }

function systemBoundaries(system: PtbSystem): Boundaries {
  const bars = [...system.barlines].sort((a, b) => a.position - b.position);
  const starts = [system.startBar, ...bars];
  return { starts, ends: starts.map((_, k) => k + 1 < starts.length ? { type: starts[k + 1].type, repeat: starts[k + 1].repeat } : { type: system.endType, repeat: system.endRepeat }) };
}

function measureIndexFor(starts: PtbBarline[], position: number) {
  let k = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i].position <= position) k = i;
  return k;
}

function tuningFor(guitar: PtbGuitar | undefined, strings: number, note: (message: string) => void, label: string) {
  let tuning = guitar?.tuning.slice();
  if (tuning && tuning.length === strings) {
    if (tuning[0] < tuning[tuning.length - 1]) tuning.reverse();
    return tuning;
  }
  tuning = STANDARD[strings] ?? Array.from({ length: strings }, (_, i) => Math.max(0, 64 - 5 * i));
  note(`${label}: tuning did not match its ${strings} strings, so standard tuning was used.`);
  return tuning;
}

function sanitize(text: string, fallback: string) {
  const clean = text.replace(/[^\x20-\x7e -ÿ]/g, ' ').trim().slice(0, 80);
  return clean || fallback;
}

export function importPowerTab(bytes: Uint8Array, settings: Settings): PowerTabImport {
  const doc = parsePowerTab(bytes);
  try { return convert(doc, settings); }
  catch (error) {
    if (error instanceof PowerTabError) throw error;
    throw new PowerTabError('The Power Tab file could not be converted into a score.', error);
  }
}

function convert(doc: PtbDocument, settings: Settings): PowerTabImport {
  const dropped: Record<string, number> = { ...doc.dropped };
  const notes: string[] = [];
  const bump = (key: string, by = 1) => { if (by > 0) dropped[key] = (dropped[key] ?? 0) + by; };
  const warn = (message: string) => { if (notes.length < 12) notes.push(message); };

  const guitar = doc.guitar;
  if (!guitar.systems.length) throw new PowerTabError('The Power Tab file contains no music.');
  const measureCount = guitar.systems.reduce((sum, s) => sum + 1 + s.barlines.length, 0);
  if (measureCount > PTB_LIMITS.totalMeasures) throw new PowerTabError('The Power Tab file has too many measures.');

  let bass: PtbScore | null = doc.bass;
  if (bass) {
    const hasNotes = bass.systems.some(s => s.staves.some(t => t.voices.some(v => v.some(p => p.notes.length))));
    const bassMeasures = bass.systems.reduce((sum, s) => sum + 1 + s.barlines.length, 0);
    if (!hasNotes) bass = null;
    else if (bassMeasures !== measureCount) {
      bass = null; bump('bass score (measure layout differs from the guitar score)');
    }
  }
  if (doc.bassError) warn(`The bass score could not be read and was skipped: ${doc.bassError}`);

  const score = new Score();
  score.title = sanitize(doc.title, ''); score.artist = sanitize(doc.artist, '');
  score.music = sanitize(doc.composer, ''); score.words = sanitize(doc.lyricist, ''); score.copyright = sanitize(doc.copyright, '');
  if (doc.lyrics) bump('lyrics text');
  if (doc.notes) bump('arranger, transcriber and note fields', doc.notes);

  // Master bars come from the guitar score's layout.
  let time = { n: 4, d: 4, common: false };
  let key = { value: 0, type: 0 };
  const bounds = guitar.systems.map(systemBoundaries);
  const barOffsets: number[] = [];
  let sumNumerators = 0;
  const masters: model.MasterBar[] = [];
  const keys: { value: number; type: number }[] = [];
  guitar.systems.forEach((_, s) => {
    barOffsets.push(masters.length);
    bounds[s].starts.forEach((start, k) => {
      const master = new MasterBar(); score.addMasterBar(master);
      const t = start.timeData;
      if (t & 0x100000) {
        const common = (t & 0x400000) !== 0, cut = (t & 0x800000) !== 0;
        const n = common ? 4 : cut ? 2 : (t >>> 27) + 1, d = common ? 4 : cut ? 2 : 1 << ((t >>> 24) & 7);
        if ([1, 2, 4, 8, 16, 32].includes(d)) time = { n, d, common };
        else bump('unsupported time signatures');
      }
      master.timeSignatureNumerator = time.n; master.timeSignatureDenominator = time.d; master.timeSignatureCommon = time.common;
      const kd = start.keyData;
      if ((kd & 0x10) && !(kd & 0x20)) {
        const a = kd & 0x0f;
        if (a <= 7) key = { value: a, type: (kd & 0x40) ? 1 : 0 };
        else if (a <= 14) key = { value: -(a - 7), type: (kd & 0x40) ? 1 : 0 };
      }
      keys.push({ ...key });
      if (start.type === 3) master.isRepeatStart = true;
      const end = bounds[s].ends[k];
      if (end.type === 4) master.repeatCount = end.repeat >= 2 ? end.repeat : 2;
      if (end.type === 1 || end.type === 5) master.isDoubleBar = true;
      if (end.type === 2) bump('free-time barlines');
      if (start.letter >= 65 && start.letter <= 90) {
        const section = new Section(); section.marker = String.fromCharCode(start.letter); section.text = sanitize(start.description, '');
        master.section = section;
      }
      masters.push(master); sumNumerators += master.timeSignatureNumerator;
    });
  });

  // Tempo: use the first usable marker as the score tempo, then place the rest.
  let baseTempo = 120;
  let firstTempo = true;
  const tempoSources = [...guitar.tempos];
  for (const marker of tempoSources) {
    const type = (marker.data >>> 27) & 3, bpm = marker.data & 0xffff, factor = BEAT_QUARTERS[(marker.data >>> 23) & 0xf];
    if (type > 1 || !factor) { bump('tempo markers (listesso or pace changes)'); continue; }
    const quarter = Math.round(bpm * factor);
    if (quarter < 20 || quarter > 400 || marker.system >= guitar.systems.length) { bump('tempo markers (out of range)'); continue; }
    const s = marker.system, index = barOffsets[s] + measureIndexFor(bounds[s].starts, marker.position);
    const master = masters[index];
    master.tempoAutomations = [Automation.buildTempoAutomation(false, 0, quarter, 2)];
    if (firstTempo && index === 0) { baseTempo = quarter; firstTempo = false; }
  }
  if (!masters[0].tempoAutomations.length) masters[0].tempoAutomations = [Automation.buildTempoAutomation(false, 0, baseTempo, 2)];

  const channels = Array.from({ length: 16 }, (_, i) => i).filter(i => i !== 9);
  let nextChannel = 0;
  const staffCountOf = (g: PtbScore) => Math.max(...g.systems.map(s => s.staves.length), 0);
  const positionsOf = (g: PtbScore) => g.systems.reduce((n, sys) => n + sys.staves.reduce((m, st) => m + st.voices[0].length + st.voices[1].length, 0), 0);
  const trackBudget = Math.min(channels.length, staffCountOf(guitar) + (bass ? staffCountOf(bass) : 0));
  if (trackBudget * measureCount > PTB_LIMITS.scoreBars)
    throw new PowerTabError(`This Power Tab file is too large to import safely (${trackBudget} tracks x ${measureCount} measures; the limit is ${PTB_LIMITS.scoreBars} bars).`);
  if (trackBudget * sumNumerators + positionsOf(guitar) + (bass ? positionsOf(bass) : 0) > PTB_LIMITS.scoreBeats)
    throw new PowerTabError('This Power Tab file has too many beats to import safely.');

  const guitarFor = (group: PtbScore, si: number, label: string) => {
    const ins = group.guitarIns.filter(g => g.staff === si).sort((a, b) => a.system - b.system || a.position - b.position);
    if (ins.length > 1) bump('guitar changes after the first on a staff', ins.length - 1);
    for (const first of ins.slice(0, 1)) {
      const bit = [...Array(16).keys()].find(i => first.data & (1 << i));
      if (bit !== undefined && group.guitars[bit]) return group.guitars[bit];
    }
    if (ins.length && !group.guitars.length) warn(`${label}: guitar assignment refers to a missing guitar.`);
    return group.guitars[si] ?? group.guitars[0];
  };
  const addGroup = (group: PtbScore, label: string, defaultProgram: number, defaultTuningCount: number) => {
    const systems = group.systems;
    const staffCount = staffCountOf(group);
    const built: model.Track[] = [];
    let channel = nextChannel;
    for (let si = 0; si < staffCount; si++) {
      if (channel + 1 > channels.length) { bump('tracks (more than 15 playback channels)'); continue; }
      const ptStaff = systems.map(s => s.staves[si]).find(Boolean);
      const strings = ptStaff?.strings ?? defaultTuningCount;
      const guitarInfo = guitarFor(group, si, `${label} ${si + 1}`);
      const name = sanitize(guitarInfo?.description ?? '', `${label} ${si + 1}`);
      const tuning = tuningFor(guitarInfo, strings, warn, name);
      const track = new Track(); track.name = name; track.shortName = name.slice(0, 12);
      const program = guitarInfo && guitarInfo.preset <= 127 ? guitarInfo.preset : defaultProgram;
      track.playbackInfo.program = program;
      track.playbackInfo.primaryChannel = channels[channel]; track.playbackInfo.secondaryChannel = channels[channel + 1] ?? channels[channel];
      channel += 1;
      const staff = new Staff(); staff.stringTuning.tunings = [...tuning]; staff.showTablature = true; staff.showStandardNotation = true;
      if (guitarInfo && guitarInfo.capo > 0 && guitarInfo.capo <= 24) staff.capo = guitarInfo.capo;
      track.addStaff(staff);
      fillStaff(staff, group, si, strings, ptStaff?.clef === 1);
      built.push(track);
    }
    for (const track of built) score.addTrack(track);
    nextChannel = channel;
  };

  function fillStaff(staff: model.Staff, group: PtbScore, si: number, strings: number, bassClef: boolean) {
    const frets = new Map<number, number>();
    const bars: { voices: model.Voice[] }[] = [];
    let secondVoice = false, measureIndex = 0;
    group.systems.forEach(system => {
      const ptStaff = system.staves[si];
      const { starts } = systemBoundaries(system);
      const spans = starts.map(() => [[], []] as PtbPosition[][]);
      if (ptStaff) {
        ptStaff.voices.forEach((voice, v) => {
          for (const position of [...voice].sort((a, b) => a.position - b.position)) spans[measureIndexFor(starts, position.position)][v].push(position);
        });
      }
      starts.forEach((_, k) => {
        const master = masters[measureIndex++];
        if (!master) throw new PowerTabError('The Power Tab measure layout is inconsistent.');
        const voices = [0, 1].map(v => {
          const voice = new Voice();
          let tuplet: { n: number; d: number } | null = null;
          for (const position of spans[k][v]) addBeat(voice, position, strings, frets, tuplet, t => { tuplet = t; });
          if (v === 0 && !voice.beats.length) for (let i = 0; i < master.timeSignatureNumerator; i++) voice.addBeat(emptyRest(master.timeSignatureDenominator));
          if (v === 1 && voice.beats.length) secondVoice = true;
          return voice;
        });
        bars.push({ voices });
      });
    });
    for (const info of bars) {
      const bar = new Bar();
      bar.clef = bassClef ? model.Clef.F4 : model.Clef.G2;
      const key = keys[staff.bars.length];
      bar.keySignature = key.value as model.KeySignature; bar.keySignatureType = key.type as model.KeySignatureType;
      bar.addVoice(info.voices[0]);
      if (secondVoice) {
        const extra = info.voices[1];
        if (!extra.beats.length) { const carrier = new Beat(); carrier.isEmpty = true; extra.addBeat(carrier); }
        bar.addVoice(extra);
      }
      staff.addBar(bar);
    }
  }

  function emptyRest(duration: number) { const b = new Beat(); b.duration = duration as model.Duration; b.isEmpty = false; return b; }

  function addBeat(voice: model.Voice, p: PtbPosition, strings: number, frets: Map<number, number>, tuplet: { n: number; d: number } | null, setTuplet: (t: { n: number; d: number } | null) => void) {
    const beat = new Beat(); beat.isEmpty = false;
    const type = p.data >>> 24;
    if (DURATIONS.has(type)) beat.duration = type as model.Duration; else { beat.duration = 4 as model.Duration; bump('positions with an unsupported note length (shown as quarter notes)'); }
    beat.dots = p.data & 0x02 ? 2 : p.data & 0x01 ? 1 : 0;
    if (p.data & 0x18000) { beat.graceType = model.GraceType.BeforeBeat; beat.duration = 16 as model.Duration; beat.dots = 0; }
    const group = (p.data >>> 21) & 7;
    if (group) {
      const played = ((p.beaming & 0x78) >> 3) + 1, over = (p.beaming & 0x07) + 1;
      if (group & 1) tuplet = played !== over && played > 1 ? { n: played, d: over } : null;
      if (tuplet) { beat.tupletNumerator = tuplet.n; beat.tupletDenominator = tuplet.d; }
      setTuplet(group & 4 ? null : tuplet);
    } else setTuplet(null);
    const flags = p.data;
    if (flags & 0x60) bump('arpeggios'); if (flags & 0x180) bump('pick strokes'); if (flags & 0xc00) bump('accents');
    if (flags & 0x1000) bump('tremolo picking'); if (flags & 0x4000) bump('tapping');
    if (flags & 0x60000) bump('triplet-feel marks'); if (flags & 0x100000) bump('fermatas');
    for (const symbol of p.symbols) if (symbol) bump('tremolo bars, volume swells and multi-bar rests');
    const isRest = (flags & 0x04) !== 0 || !p.notes.length;
    if (!isRest) {
      for (const n of p.notes) {
        if (n.string >= strings) { bump('notes on strings the staff does not have'); continue; }
        const note = new Note();
        note.string = strings - n.string; note.fret = n.fret;
        const s = note.string, simple = n.simple;
        if (simple & 0x01) {
          if (frets.has(s)) { note.isTieDestination = true; note.fret = frets.get(s)!; } else bump('ties with no earlier note');
        }
        if (simple & 0x02) note.isDead = true;
        if (simple & 0x80) note.isGhost = true;
        if (simple & 0x40) note.harmonicType = model.HarmonicType.Natural;
        if (simple & 0x18) note.isHammerPullOrigin = true;
        if (simple & 0xf00) bump('octave (8va/15ma) marks');
        if (simple & 0x24) bump('tie wrap and hammer/pull markers');
        if (flags & 0x18) note.vibrato = model.VibratoType.Slight;
        if (flags & 0x2000) note.isPalmMute = true;
        if (flags & 0x80000) note.isLetRing = true;
        if (flags & 0x200) note.isStaccato = true;
        for (const symbol of n.symbols) if (symbol) bump('slides, bends, trills and artificial harmonics');
        frets.set(s, note.fret);
        beat.addNote(note);
      }
    }
    voice.addBeat(beat);
  }

  addGroup(guitar, 'Guitar', 25, 6);
  if (bass) {
    try { addGroup(bass, 'Bass', 33, 4); }
    catch (error) {
      if (!(error instanceof PowerTabError) && !(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
      bump('bass score (could not be converted)');
    }
  }
  if (!score.tracks.length) throw new PowerTabError('The Power Tab file contains no playable staves.');
  score.finish(settings);

  const labels = Object.entries(dropped).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${v} ${k}`);
  const parts = [`Imported from Power Tab: ${measureCount} measures, ${score.tracks.length} track${score.tracks.length === 1 ? '' : 's'}.`];
  parts.push(labels.length
    ? `Not imported (dropped): ${labels.join('; ')}.`
    : 'No dropped content was detected, but the importer cannot detect every unsupported Power Tab feature.');
  parts.push('Imported where present: rhythm, pitches, grace notes, ties, hammer-ons/pull-offs, repeats, key and time signatures, tempo, section letters, composer, lyricist and copyright.');
  return { score, notice: [...parts, ...notes].join(' ') };
}
