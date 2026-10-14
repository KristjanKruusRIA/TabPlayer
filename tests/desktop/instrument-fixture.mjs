import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exporter, importer, midi, model, Settings } from '@coderline/alphatab';
import { rolldown } from 'rolldown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixturePath = resolve(root, '.analysis/desktop-smoke/instrument-view-fixture.gp');
export const metadataPath = resolve(root, '.analysis/desktop-smoke/instrument-view-fixture.json');
const settings = new Settings();
const definitions = [
  { name: 'Guitar9', instrument: 'guitar', program: 25, channel: 0, secondary: 1, preset: 'guitar-9-standard-csharp', tuning: [64, 59, 55, 50, 45, 40, 35, 30, 25],
    chords: [[[9, 0], [8, 1], [1, 0]], [[9, 5], [1, 7]], [[8, 0], [2, 0]], [[9, 12], [1, 12]]] },
  { name: 'Bass6', instrument: 'bass', program: 33, channel: 2, secondary: 3, preset: 'bass-6-standard-b', tuning: [48, 43, 38, 33, 28, 23],
    chords: [[[6, 0], [4, 2], [1, 0]], [[6, 7], [1, 5]], [[2, 0]], [[6, 12], [1, 12]]] },
  { name: 'Drums', instrument: 'drums', program: 0, channel: 9, secondary: 9, tuning: [],
    chords: [[36, 49], [38, 42], [41, 51], [38, 46]] },
  { name: 'Keys', instrument: 'keys', program: 0, channel: 4, secondary: 5, tuning: [],
    chords: [[60, 64, 67], [62, 66, 69], [59, 62, 66], [48, 72]] },
];
const drumNames = { 36: 'Bass drum', 38: 'Acoustic snare', 41: 'Low floor tom', 42: 'Closed hi-hat', 46: 'Open hi-hat', 49: 'Crash cymbal 1', 51: 'Ride cymbal 1' };
const drumKeys = [36, 49, 38, 42, 41, 51, 46];
const drumElements = ['Kick Drum', 'Crash High', 'Snare', 'Charley', 'Floor tom', 'Ride', 'Charley'];
const drumLines = [7, -2, 3, -1, 6, 0, -1];
const pitchName = key => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][key % 12]}${Math.floor(key / 12) - 1}`;
const layouts = [
  [{ duration: model.Duration.Whole, start: 0, end: 3840, chord: true }],
  [{ duration: model.Duration.Quarter, start: 3840, end: 4800 }, { duration: model.Duration.Half, start: 4800, end: 6720, chord: true }, { duration: model.Duration.Quarter, start: 6720, end: 7680 }],
  [{ duration: model.Duration.Half, start: 7680, end: 9600, chord: true }, { duration: model.Duration.Half, start: 9600, end: 11520 }],
  [{ duration: model.Duration.Whole, start: 11520, end: 15360, chord: true }],
];

// Bundle the real TypeScript planner in memory; leave no compiled test artifacts.
async function planner() {
  const bundle = await rolldown({ input: resolve(root, 'src/audio/plan.ts'), external: ['@coderline/alphatab'] });
  try {
    const { output } = await bundle.generate({ format: 'es', paths: { '@coderline/alphatab': import.meta.resolve('@coderline/alphatab') } });
    const entry = output.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(entry, 'The public planner bundle must contain an entry');
    return await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
  } finally { await bundle.close(); }
}

export async function buildInstrumentFixture() {
  const score = new model.Score();
  score.title = 'Authored instrument view fixture'; score.artist = 'TabPlayer desktop verification';
  for (let bar = 0; bar < 4; bar++) {
    const master = new model.MasterBar(); master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4; score.addMasterBar(master);
  }
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 60, 2)];
  const intended = [];
  for (const [trackIndex, definition] of definitions.entries()) {
    const track = new model.Track(); track.name = definition.name; track.shortName = definition.name;
    Object.assign(track.playbackInfo, { program: definition.program, primaryChannel: definition.channel, secondaryChannel: definition.secondary });
    if (definition.instrument === 'drums') track.percussionArticulations = drumKeys.map((key, index) => new model.InstrumentArticulation(drumElements[index], drumLines[index], key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Above, key));
    const staff = new model.Staff(); staff.stringTuning.tunings = [...definition.tuning]; staff.stringTuning.name = definition.preset ?? '';
    staff.isPercussion = definition.instrument === 'drums'; staff.showTablature = definition.tuning.length > 0; staff.showStandardNotation = true;
    track.addStaff(staff); score.addTrack(track);
    for (const [barIndex, layout] of layouts.entries()) {
      // Public IDs keep GP bytes deterministic even after another score was created.
      const bar = new model.Bar(); bar.id = trackIndex * 4 + barIndex; bar.clef = staff.isPercussion ? model.Clef.Neutral : definition.instrument === 'bass' ? model.Clef.F4 : model.Clef.G2; staff.addBar(bar);
      const voice = new model.Voice(); voice.id = bar.id; bar.addVoice(voice);
      for (const [beatIndex, item] of layout.entries()) {
        const beat = new model.Beat(); beat.id = trackIndex * 7 + [0, 1, 4, 6][barIndex] + beatIndex; beat.duration = item.duration; beat.isEmpty = false; voice.addBeat(beat);
        if (!item.chord) continue;
        for (const value of definition.chords[barIndex]) {
          const note = new model.Note(); note.id = intended.length; let key;
          if (definition.tuning.length) { [note.string, note.fret] = value; key = definition.tuning[definition.tuning.length - note.string] + note.fret; }
          else if (staff.isPercussion) { note.percussionArticulation = drumKeys.indexOf(value); key = value; }
          else { note.octave = Math.floor(value / 12); note.tone = value % 12; key = value; }
          beat.addNote(note);
          intended.push({ track: trackIndex, staff: 0, bar: barIndex, voice: 0, beat: beatIndex, noteIndex: beat.notes.length - 1, string: Math.max(0, note.string), fret: definition.tuning.length ? note.fret : null, key, pitch: pitchName(key), drum: definition.instrument === 'drums' ? drumNames[key] : null, percussionArticulation: staff.isPercussion ? note.percussionArticulation : null, startTick: item.start, endTick: item.end });
        }
      }
    }
  }
  score.finish(settings);
  const bytes = new exporter.Gp7Exporter().export(score, settings);
  const reopened = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  assert.equal(reopened.masterBars.length, 4); assert.equal(reopened.tempo, 60);
  for (const [index, definition] of definitions.entries()) {
    const track = reopened.tracks[index], staff = track.staves[0];
    assert.equal(track.name, definition.name); assert.equal(track.playbackInfo.program, definition.program);
    assert.deepEqual(staff.tuning, definition.tuning); assert.equal(staff.isPercussion, definition.instrument === 'drums');
    if (staff.isPercussion) assert.equal(track.playbackInfo.primaryChannel, 9);
  }
  assert.equal(reopened.tracks.length, 4);
  for (const expected of intended) {
    const note = reopened.tracks[expected.track].staves[expected.staff].bars[expected.bar].voices[expected.voice].beats[expected.beat].notes[expected.noteIndex];
    assert.equal(Math.max(0, note.string), expected.string);
    if (expected.percussionArticulation === null) assert.equal(note.realValue, expected.key);
    else assert.equal(reopened.tracks[expected.track].percussionArticulations[note.percussionArticulation].outputMidiNumber, expected.key);
    if (expected.fret !== null) assert.equal(note.fret, expected.fret);
    if (expected.percussionArticulation !== null) assert.equal(note.percussionArticulation, expected.percussionArticulation);
  }
  const { buildPlaybackPlan } = await planner(), plan = buildPlaybackPlan(reopened, 1);
  assert.equal(plan.durationTick, 15360); assert.equal(plan.durationMs, 16000); assert.equal(plan.notes.length, intended.length);
  assert.deepEqual(plan.occurrences.map(o => [o.bar, o.occurrence, o.startTick, o.endTick]), [0, 1, 2, 3].map(bar => [bar, 0, bar * 3840, (bar + 1) * 3840]));
  const metadataNotes = intended.map(expected => {
    const candidates = plan.notes.filter(note => note.source.target.track === expected.track && note.source.target.staff === expected.staff && note.source.target.bar === expected.bar && note.source.target.voice === expected.voice && note.source.target.beat === expected.beat && note.source.string === expected.string && note.key === expected.key);
    assert.equal(candidates.length, 1, `Exact plan source for ${JSON.stringify(expected)}`); const actual = candidates[0];
    assert.equal(actual.startTick, expected.startTick); assert.equal(actual.endTick, expected.endTick); assert.equal(actual.program, definitions[expected.track].program);
    if (definitions[expected.track].instrument === 'drums') assert.equal(actual.channel, 9);
    return { ...expected, id: actual.id, trackId: actual.trackId, source: actual.source, occurrence: actual.occurrence, channel: actual.channel, program: actual.program, velocity: actual.velocity, startMs: actual.startTick / 0.96, endMs: actual.endTick / 0.96 };
  });
  const file = new midi.MidiFile(); new midi.MidiFileGenerator(reopened, settings, new midi.AlphaSynthMidiFileHandler(file)).generate();
  const tuples = notes => notes.map(note => JSON.stringify(note)).sort();
  for (const [type, field] of [[midi.MidiEventType.NoteOn, 'startTick'], [midi.MidiEventType.NoteOff, 'endTick']]) {
    const events = file.tracks.flatMap(track => track.events.filter(event => event.type === type).map(event => [event.track, event.tick, event.noteKey, event.noteVelocity]));
    assert.deepEqual(tuples(plan.notes.map(note => [note.source.target.track, note[field], note.key, note.velocity])), tuples(events));
  }
  const metadata = { authored: true, title: score.title, fixturePath, ppq: 960, bpm: 60, durationTick: plan.durationTick, durationMs: plan.durationMs, sha256: createHash('sha256').update(bytes).digest('hex'), stringNumbering: 'alphaTab: string 1 is the lowest-pitched string', tracks: definitions.map(({ name, instrument, program, channel, preset, tuning }, index) => ({ index, id: plan.tracks[index].id, name, instrument, program, channel, preset: preset ?? null, tuning })), occurrences: plan.occurrences, notes: metadataNotes, sharedSilentWindows: [{ startTick: 3840, endTick: 4800, startMs: 4000, endMs: 5000 }, { startTick: 6720, endTick: 7680, startMs: 7000, endMs: 8000 }, { startTick: 9600, endTick: 11520, startMs: 10000, endMs: 12000 }], verification: { gpRoundtrip: true, literalNotesAndTiming: true, publicMidiOnOffAgreement: true } };
  mkdirSync(dirname(fixturePath), { recursive: true }); writeFileSync(fixturePath, bytes); writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildInstrumentFixture();
  console.log(JSON.stringify({ fixturePath, metadataPath, tracks: result.tracks.map(track => track.name), notes: result.notes.length, durationMs: result.durationMs, sha256: result.sha256, verification: result.verification }, null, 2));
}
