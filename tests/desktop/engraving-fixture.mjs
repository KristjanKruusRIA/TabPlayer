import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { midi, model, Settings } from '@coderline/alphatab';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync } from 'fflate';
import { rolldown } from 'rolldown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixturePath = resolve(root, '.analysis/desktop-smoke/engraving-fixture.gp');
export const metadataPath = resolve(root, '.analysis/desktop-smoke/engraving-fixture.json');
export const reportPath = resolve(root, '.analysis/parity/engraving-fixture-report.md');
const acceptanceSpec = 'docs/superpowers/specs/2026-10-15-gp8-engraving-design.md';
const settings = new Settings();
const tuning = [64, 59, 55, 50, 45, 38];
const rawLyrics = [
  { startBar: 0, text: '[VERSE ONE]\nAmber win-dows hold+the dawn' },
  { startBar: 0, text: 'Qui-et steps  cross the hall' },
  { startBar: 1, text: '[ECHO]\nRise+again be-neath clear skies' },
  { startBar: 2, text: 'Õhtu tuli blue+and silver' },
  { startBar: 10, text: '[CODA]\nHomeward notes re-turn' },
];
const performedBars = [0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const digest = value => createHash('sha256').update(value).digest('hex');
const sorted = values => values.map(value => JSON.stringify(value)).sort();
let apiPromise;
async function fixtureApi() {
  apiPromise ??= (async () => {
    const entry = 'engraving-fixture-entry';
    const modules = [
      ['src/audio/plan.ts', 'buildPlaybackPlan'],
      ['src/interchange/gp.ts', 'exportGpInterchange,loadInterchangeScore'],
      ['src/editor/lyrics.ts', 'applyLyricsEdit,getTrackLyrics'],
      ['src/editor/links.ts', 'captureNoteLinks'],
    ];
    const bundle = await rolldown({ input: entry, external: ['@coderline/alphatab', 'fflate'], plugins: [{ name: entry, resolveId: id => id === entry ? id : null, load: id => id === entry ? modules.map(([path, names]) => `export {${names}} from ${JSON.stringify(resolve(root, path).replaceAll('\\', '/'))};`).join('\n') : null }] });
    try {
      const { output } = await bundle.generate({ format: 'es', paths: Object.fromEntries(['@coderline/alphatab', 'fflate'].map(name => [name, import.meta.resolve(name)])) });
      return await import(`data:text/javascript;base64,${Buffer.from(output.find(item => item.type === 'chunk' && item.isEntry).code).toString('base64')}`);
    } finally { await bundle.close(); }
  })();
  return apiPromise;
}

function author() {
  const score = new model.Score();
  score.title = 'Amber Windows — engraving study'; score.subTitle = 'Original desktop acceptance fixture'; score.artist = 'TabPlayer verification';
  score.defaultSystemsLayout = 2; score.systemsLayout = [2, 2, 4, 2, 2];
  score.stylesheet.globalDisplayTuning = true; score.stylesheet.globalDisplayChordDiagramsOnTop = true; score.stylesheet.globalDisplayChordDiagramsInScore = true;
  score.stylesheet.multiTrackMultiBarRest = false;
  for (let index = 0; index < 12; index++) {
    const master = new model.MasterBar(); master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4;
    if ([0, 2, 8, 10].includes(index)) master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, { 0: 90, 2: 120, 8: 72, 10: 100 }[index], 2)];
    if (index === 0) master.isRepeatStart = true; if (index === 1) master.repeatCount = 2;
    score.addMasterBar(master);
  }
  const counters = { bar: 0, voice: 0, beat: 0, note: 0 }, authoredNotes = [];
  function staff(track, kind, bass = false) {
    const result = new model.Staff(); result.stringTuning.tunings = kind === 'guitar' ? [...tuning] : []; result.stringTuning.name = kind === 'guitar' ? 'Drop D' : '';
    result.capo = kind === 'guitar' ? 2 : 0; result.showStandardNotation = true; result.showTablature = kind === 'guitar'; result.isPercussion = kind === 'drums'; track.addStaff(result);
    for (let index = 0; index < 12; index++) {
      const bar = new model.Bar(); bar.id = counters.bar++; bar.clef = kind === 'drums' ? model.Clef.Neutral : bass ? model.Clef.F4 : model.Clef.G2; result.addBar(bar);
      for (let voice = 0; voice < 2; voice++) { const value = new model.Voice(); value.id = counters.voice++; bar.addVoice(value); }
    }
    return result;
  }
  function track(name, program, channel, secondary) {
    const value = new model.Track(); value.name = name; value.shortName = name === 'Guitar6' ? 'Gtr.' : name === 'Grand Piano' ? 'Pno.' : 'Dr.';
    Object.assign(value.playbackInfo, { program, primaryChannel: channel, secondaryChannel: secondary }); value.defaultSystemsLayout = 2; value.systemsLayout = [...score.systemsLayout]; score.addTrack(value); return value;
  }
  const guitar = staff(track('Guitar6', 25, 0, 1), 'guitar'), piano = track('Grand Piano', 0, 2, 3), upper = staff(piano, 'piano'), lower = staff(piano, 'piano', true), drums = staff(track('Drums', 0, 9, 9), 'drums');
  const chord = new model.Chord(); Object.assign(chord, { name: 'F#m(add9)', firstFret: 1, strings: [0, 0, 0, 2, 2, 2], showDiagram: true, showName: true, showFingering: true }); guitar.addChord('sunrise', chord);
  const close = new model.Chord(); Object.assign(close, { name: 'F#m', firstFret: 1, strings: [0, 0, 0, 2, 2, 2], showDiagram: true, showName: true }); guitar.addChord('home', close);
  function beat(target, bar, duration, values = [], voiceIndex = 0, options = {}) {
    const voice = target.bars[bar].voices[voiceIndex], result = new model.Beat(); result.id = counters.beat++; result.duration = duration; result.isEmpty = false; result.dynamics = model.DynamicValue.MF;
    Object.assign(result, options); voice.addBeat(result);
    for (const value of values) {
      const note = new model.Note(); note.id = counters.note++; note.dynamics = result.dynamics;
      if (target === guitar) { [note.string, note.fret] = value; note.leftHandFinger = Math.min(4, Math.max(1, note.fret)); }
      else if (target === drums) note.percussionArticulation = value;
      else { note.octave = Math.floor(value / 12); note.tone = value % 12; }
      result.addNote(note);
      authoredNotes.push({ authoredId: note.id, target: { track: target.track.index, staff: target.index, bar, voice: voiceIndex, beat: result.index }, noteIndex: result.notes.length - 1, string: Math.max(0, note.string), key: target === drums ? value : target === guitar ? tuning[tuning.length - note.string] + note.fret + 2 : value });
    }
    return result;
  }
  const Q = model.Duration.Quarter, H = model.Duration.Half, W = model.Duration.Whole, E = model.Duration.Eighth;
  const firstChord = beat(guitar, 0, Q, [[6, 0], [5, 0], [4, 0]], 0, { chordId: 'sunrise', dynamics: model.DynamicValue.F });
  const bent = beat(guitar, 0, Q, [[6, 3]]).notes[0], tied = beat(guitar, 0, Q, [[6, 3]]).notes[0];
  bent.addBendPoint(new model.BendPoint(0, 0)); bent.addBendPoint(new model.BendPoint(60, 4));
  tied.addBendPoint(new model.BendPoint(0, 4)); tied.addBendPoint(new model.BendPoint(60, 4)); tied.isTieDestination = true; tied.isContinuedBend = true; bent.tieDestination = tied; tied.tieOrigin = bent;
  beat(guitar, 0, Q, [[5, 3], [3, 2]]); beat(guitar, 0, H, [[1, 2]], 1); beat(guitar, 0, H, [[2, 2]], 1);
  for (const fret of [0, 2, 3, 5, 7, 5, 3, 2]) beat(guitar, 1, E, [[6, fret]]);
  beat(guitar, 1, W, [[1, 2], [2, 0]], 1);
  beat(guitar, 2, Q); const grace = beat(guitar, 2, E, [[5, 0]], 0, { graceType: model.GraceType.BeforeBeat });
  beat(guitar, 2, Q, [[5, 2]]); beat(guitar, 2, H, [[4, 2], [3, 2]]);
  const phrase = [2, 5, 3, 0].map(fret => beat(guitar, 3, Q, [[6, fret]])); phrase[0].isLegatoOrigin = true; phrase[1].isLegatoOrigin = true;
  for (let index = 0; index < 4; index++) beat(guitar, 10, Q, [[6, [0, 2, 5, 3][index]], [3, 2]], 0, { dynamics: model.DynamicValue.F });
  beat(guitar, 11, W, [[6, 0], [5, 0], [4, 0], [1, 2]], 0, { chordId: 'home' });
  beat(upper, 0, Q, [73, 76, 80]); beat(upper, 0, Q); beat(upper, 0, H, [66, 69, 73]); beat(upper, 0, W, [61], 1, { dynamics: model.DynamicValue.P });
  for (const keys of [[66, 69, 73], [64, 68, 71]]) beat(upper, 1, H, keys);
  const pianoPhrase = [71, 73, 76, 75].map(key => beat(upper, 2, Q, [key])); pianoPhrase[0].isLegatoOrigin = true; pianoPhrase[1].isLegatoOrigin = true;
  for (const key of [66, 68, 69, 71, 73, 75, 76, 78]) beat(upper, 3, E, [key]);
  for (const bar of [8, 9]) { beat(upper, bar, Q, [bar === 8 ? 64 : 66]); beat(upper, bar, Q); beat(upper, bar, Q, [71, 75]); beat(upper, bar, Q, [69, 73]); }
  beat(upper, 10, H, [66, 69, 73]); beat(upper, 10, H, [68, 71, 75]); beat(upper, 11, W, [61, 66, 69, 73]);
  for (const bar of [0, 1, 3]) { beat(lower, bar, H, [42, 49]); beat(lower, bar, H, [40, 47]); }
  for (const bar of [2, 8, 9, 10, 11]) beat(lower, bar, W, bar === 9 ? [40, 52] : [42, 54]);
  for (const bar of [0, 3, 8, 9]) { beat(drums, bar, H, [36, bar === 0 ? 49 : 51]); beat(drums, bar, Q, [38, 42]); beat(drums, bar, Q, [36, 42]); }
  for (const [bar, hits] of [[1, [[36, 42], [38, 42], [36, 42], [38, 46]]], [2, [[36, 42], [38, 42], [45, 42], [38, 49]]]]) for (const keys of hits) beat(drums, bar, Q, keys);
  for (const keys of [[36, 42], [38], [45], [47], [50], [49], [38], [36, 49]]) beat(drums, 10, E, keys);
  beat(drums, 11, W, [36, 49]);
  for (const target of [guitar, upper, lower, drums]) for (const bar of target.bars) for (const voice of bar.voices) if (!voice.beats.length) beat(target, bar.index, W, [], voice.index, { isEmpty: voice.index > 0 });
  score.rebuildRepeatGroups(); score.finish(settings);
  return { score, authoredNotes, targets: { bend: bent.id, tie: tied.id, graceBeat: grace.id, phraseBeat: phrase[0].id, chordBeat: firstChord.id } };
}

// Decode exported SMF bytes independently of alphaTab event objects.
function midiNotes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let cursor = 0;
  const text = count => String.fromCharCode(...bytes.slice(cursor, cursor += count));
  const u32 = () => { const value = view.getUint32(cursor); cursor += 4; return value; }, u16 = () => { const value = view.getUint16(cursor); cursor += 2; return value; };
  const variable = () => { let result = 0, value; do { value = bytes[cursor++]; result = result * 128 + (value & 127); } while (value & 128); return result; };
  assert.equal(text(4), 'MThd'); assert.equal(u32(), 6); u16(); const count = u16(); assert.equal(u16(), 960); const events = [];
  for (let track = 0; track < count; track++) {
    assert.equal(text(4), 'MTrk'); const end = cursor + 4 + u32(); let tick = 0, running = 0;
    while (cursor < end) {
      tick += variable(); let status = bytes[cursor++]; if (status < 128) { cursor--; status = running; } else if (status < 240) running = status;
      if (status === 255) { cursor++; const length = variable(); cursor += length; continue; }
      if (status === 240 || status === 247) { const length = variable(); cursor += length; continue; }
      const command = status & 240, key = bytes[cursor++], value = command === 192 || command === 208 ? null : bytes[cursor++];
      if (command === 144 || command === 128) events.push([command === 144 && value > 0 ? 'noteOn' : 'noteOff', tick, status & 15, key, value]);
    }
    assert.equal(cursor, end);
  }
  return events;
}

export async function buildEngravingFixture() {
  const api = await fixtureApi(), dom = new JSDOM(''), previous = ['DOMParser', 'XMLSerializer'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name] of previous) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
  try {
    const { score, authoredNotes, targets } = author(); api.applyLyricsEdit(score, { type: 'setTrackLyrics', track: 0, visible: true, lines: rawLyrics });
    const snapshot = () => JSON.stringify({ score: model.JsonConverter.scoreToJson(score), lyrics: api.getTrackLyrics(score, 0), links: api.captureNoteLinks(score) }), before = snapshot();
    // Fix only public ZIP timestamps; GPIF and all standard GP entries are adapter output.
    const bytes = zipSync(unzipSync(api.exportGpInterchange(score, settings)), { mtime: new Date(2000, 0, 1) });
    assert.equal(snapshot(), before, 'Export preserves the authored source model/lyrics/links');
    const importedBytesHash = digest(bytes), reopened = api.loadInterchangeScore(bytes, settings), importedSnapshot = model.JsonConverter.scoreToJson(reopened);
    assert.deepEqual(reopened.tracks.map(track => [track.name, track.staves.length]), [['Guitar6', 1], ['Grand Piano', 2], ['Drums', 1]]);
    assert.deepEqual(reopened.tracks[0].staves[0].tuning, tuning); assert.equal(reopened.tracks[0].staves[0].capo, 2); assert.equal(reopened.tracks[2].playbackInfo.primaryChannel, 9);
    assert.deepEqual(api.getTrackLyrics(reopened, 0), { source: 'raw', visible: true, lines: rawLyrics });
    assert.deepEqual(reopened.systemsLayout, [2, 2, 4, 2, 2]);
    const noteAt = target => reopened.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice].beats[target.beat].notes;
    for (const expected of authoredNotes) {
      const note = noteAt(expected.target)[expected.noteIndex]; assert.ok(note, `Retained source note ${expected.authoredId}`);
      if (!note.isPercussion) assert.equal(note.realValue, expected.key); assert.equal(Math.max(0, note.string), expected.string);
    }
    const guitar = reopened.tracks[0].staves[0];
    assert.ok(guitar.bars[0].voices[0].beats[1].notes[0].bendPoints.length); assert.ok(guitar.bars[0].voices[0].beats[2].notes[0].tieOrigin);
    assert.ok(guitar.bars[3].voices[0].beats[0].isLegatoOrigin); assert.ok(guitar.bars[3].voices[0].beats[2].isLegatoDestination);
    assert.equal(guitar.bars[2].voices[0].beats[1].graceType, model.GraceType.BeforeBeat); assert.equal(guitar.chords.size, 2);
    for (const track of reopened.tracks) for (const staff of track.staves) for (const bar of staff.bars.slice(4, 8)) assert.ok(bar.isRestOnly || bar.isEmpty);
    const plan = api.buildPlaybackPlan(reopened, 1);
    assert.deepEqual(plan.occurrences.map(value => value.bar), performedBars); assert.equal(plan.durationTick, 53760); assert.ok(Math.abs(plan.durationMs - 34133.333333333336) < .001);
    assert.deepEqual(plan.occurrences.map(value => value.startTick), performedBars.map((_, index) => index * 3840));
    assert.deepEqual(plan.notes.filter(note => note.source.target.track === 0 && note.source.target.bar === 0 && note.source.target.voice === 0 && note.source.target.beat === 0).map(note => [note.startTick, note.endTick, note.key]), [[0, 960, 66], [0, 960, 61], [0, 960, 57], [7680, 8640, 66], [7680, 8640, 61], [7680, 8640, 57]]);
    const file = new midi.MidiFile(); new midi.MidiFileGenerator(reopened, settings, new midi.AlphaSynthMidiFileHandler(file, true)).generate(); const midiBytes = file.toBinary();
    const expectedMidi = plan.midi.filter(event => event.type === 'noteOn' || event.type === 'noteOff').map(event => [event.type, event.tick, event.channel, event.key, event.velocity]);
    assert.deepEqual(sorted(midiNotes(midiBytes)), sorted(expectedMidi));
    const authoredMidi = new midi.MidiFile(); new midi.MidiFileGenerator(score, settings, new midi.AlphaSynthMidiFileHandler(authoredMidi, true)).generate();
    assert.deepEqual(sorted(midiNotes(authoredMidi.toBinary())), sorted(midiNotes(midiBytes)), 'GP interchange retains the authored note-on/off stream');
    assert.equal(model.JsonConverter.scoreToJson(reopened), importedSnapshot, 'Plan/MIDI generation preserves the imported source'); assert.equal(digest(bytes), importedBytesHash); assert.equal(snapshot(), before);
    const metadata = { authored: true, acceptanceSpec, fixturePath, sourceSha256: digest(bytes), authoredModelSha256: digest(before), midiSha256: digest(midiBytes), title: score.title, ppq: 960, durationTick: plan.durationTick, durationMs: plan.durationMs, tracks: plan.tracks.map((track, index) => ({ ...track, index, name: reopened.tracks[index].name, staves: reopened.tracks[index].staves.map(staff => ({ index: staff.index, tuning: staff.tuning, capo: staff.capo, percussion: staff.isPercussion })) })), sourceTargets: authoredNotes, targets, rawLyrics, systemsLayout: [2, 2, 4, 2, 2], allTrackRestBars: [4, 5, 6, 7], guitarOnlyEmptyBars: [8, 9], tempos: plan.tempos, occurrences: plan.occurrences, notes: plan.notes, expectedMidiNotes: expectedMidi, verification: { publicGpRoundtrip: true, authoredAndReimportedSmfAgreement: true, independentSmfNoteAgreement: true, literalChordAndPerformedTiming: true, sourceUnchanged: true, rawFiveLineLyricsRetained: true, bendTieSlurGraceRetained: true }, visualAcceptance: 'Pending native screenshots and per-page vector PDF inspection by root; model/MIDI checks do not establish engraving fidelity.' };
    mkdirSync(dirname(fixturePath), { recursive: true }); writeFileSync(fixturePath, bytes); writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, `# Authored engraving fixture\n\nBound to the Acceptance section of ${acceptanceSpec}. Entirely original public alphaTab model data; no private scores or copied assets.\n\n- Source: ${fixturePath}\n- Metadata: ${metadataPath}\n- Source SHA-256: ${metadata.sourceSha256}\n- Authored model SHA-256: ${metadata.authoredModelSha256}\n- 12 authored / 14 performed 4/4 bars; ${plan.notes.length} playback attacks; 53,760 ticks / ${plan.durationMs.toFixed(6)} ms.\n- Guitar6: Drop D, capo2, chords, fingering, two voices, continued bend/tie, retained beat-legato phrase slur, before-beat grace, five exact raw lyric lines. Piano: grand staff, two upper voices, independent bass staff. Drums: real percussion channel9 with standard GM output.\n- Layout: systems2/2/4/2/2; all-track rest bars4–7 are multirest candidates; guitar-only empty bars8–9 test hiding. Repeated bars0–1 play twice; tempos90/120/72/100.\n- Verified: GP roundtrip, literal source pitches and first-chord/timeline timing, independently decoded SMF note-on/off agreement, raw lyrics/effects, source model/links/bytes unchanged. Fixed public IDs and ZIP timestamps make regeneration deterministic.\n\nNative apply/undo/redo/save/restart, bounds/selection changes, screenshots, and every vector PDF page still require root validation. No model-only claim of engraving fidelity or GP8/physical printing parity.\n`);
    return metadata;
  } finally {
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    dom.window.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildEngravingFixture(), firstGp = digest(readFileSync(fixturePath)), firstMetadata = digest(readFileSync(metadataPath)), repeated = await buildEngravingFixture();
  assert.equal(digest(readFileSync(fixturePath)), firstGp, 'Repeated GP bytes'); assert.equal(digest(readFileSync(metadataPath)), firstMetadata, 'Repeated metadata'); assert.equal(result.sourceSha256, repeated.sourceSha256);
  console.log(`Engraving fixture PASS: 3tracks/4staves/12sourcebars/14performedbars/${result.notes.length}notes; GP+SMF+source+determinism verified; ${fixturePath}`);
}
