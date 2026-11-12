#!/usr/bin/env node
// THE-60 fermata probe.
//   node scripts/fermata-probe.mjs write [dir]     writes two Guitar Pro files and README.txt (default .analysis/fermata-probe/)
//   node scripts/fermata-probe.mjs analyse [dir]   reads the .mid files Guitar Pro 8 exported from them and prints what the numbers show
// The probe exists because nobody knows what the stored fermata Length means or how Guitar Pro plays a fermata
// (docs/superpowers/specs/2026-10-15-gp8-notation-design.md, "Fermata authority and bounded first delivery").
// The analyser has its own Standard MIDI File reader and does not use alphaTab.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exporter, model, Settings } from '@coderline/alphatab';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export const PPQ = 960;
export const TEMPOS = [120, 60];
export const MAX_MIDI_BYTES = 8 * 1024 * 1024;
const DEFAULT_DIR = '.analysis/fermata-probe';
const GPIF = 'Content/score.gpif';

// Beat positions are 0-based quarter-note indexes inside a 4/4 bar. Shapes: quarter = four quarters; rest = beat 3 is a rest;
// half = quarter, quarter, half; eighth = quarter, quarter, eighth, eighth, quarter.
export const CASES = [
  { id: 'short-0', type: 'Short', length: 0, beat: 2, shape: 'quarter', label: 'Short, Length 0, beat 3' },
  { id: 'medium-0', type: 'Medium', length: 0, beat: 2, shape: 'quarter', label: 'Medium, Length 0, beat 3' },
  { id: 'long-0', type: 'Long', length: 0, beat: 2, shape: 'quarter', label: 'Long, Length 0, beat 3' },
  { id: 'medium-0.5', type: 'Medium', length: 0.5, beat: 2, shape: 'quarter', label: 'Medium, Length 0.5, beat 3' },
  { id: 'medium-1', type: 'Medium', length: 1, beat: 2, shape: 'quarter', label: 'Medium, Length 1, beat 3' },
  { id: 'medium-2', type: 'Medium', length: 2, beat: 2, shape: 'quarter', label: 'Medium, Length 2, beat 3' },
  { id: 'short-2', type: 'Short', length: 2, beat: 2, shape: 'quarter', label: 'Short, Length 2, beat 3' },
  { id: 'long-2', type: 'Long', length: 2, beat: 2, shape: 'quarter', label: 'Long, Length 2, beat 3' },
  { id: 'rest', type: 'Medium', length: 0, beat: 2, shape: 'rest', label: 'Medium, Length 0, on a rest at beat 3' },
  { id: 'last-beat', type: 'Medium', length: 0, beat: 3, shape: 'quarter', label: 'Medium, Length 0, last beat (beat 4)' },
  { id: 'mid-bar', type: 'Medium', length: 0, beat: 1, shape: 'quarter', label: 'Medium, Length 0, mid-bar (beat 2)' },
  { id: 'half-note', type: 'Medium', length: 0, beat: 2, shape: 'half', label: 'Medium, Length 0, on a half note at beat 3' },
  { id: 'eighth-note', type: 'Medium', length: 0, beat: 2, shape: 'eighth', label: 'Medium, Length 0, on an eighth note at beat 3' },
];
const T1_KEYS = [72, 74, 76, 77];
const T2_KEYS = [48, 50, 52, 53];
const T2_WHOLE = 36;
const SHAPES = {
  quarter: () => T1_KEYS.map((key, i) => ({ start: i, dur: 1, key })),
  rest: () => [{ start: 0, dur: 1, key: 72 }, { start: 1, dur: 1, key: 74 }, { start: 3, dur: 1, key: 77 }],
  half: () => [{ start: 0, dur: 1, key: 72 }, { start: 1, dur: 1, key: 74 }, { start: 2, dur: 2, key: 76 }],
  eighth: () => [{ start: 0, dur: 1, key: 72 }, { start: 1, dur: 1, key: 74 }, { start: 2, dur: 0.5, key: 76 }, { start: 2.5, dur: 0.5, key: 77 }, { start: 3, dur: 1, key: 79 }],
};

/** Bar-by-bar layout: bar 0 is a control, then each case bar is followed by a control bar. Track 1 (keys 60+) carries the
 *  fermata; track 2 (keys under 60) sustains a whole note (key 36) across the case bar and plays quarters in control bars. */
export function probePlan() {
  const bars = [];
  const add = (probeCase) => {
    const index = bars.length;
    bars.push({
      index, case: probeCase,
      t1: SHAPES[probeCase?.shape ?? 'quarter'](),
      t2: probeCase ? [{ start: 0, dur: 4, key: T2_WHOLE }] : T2_KEYS.map((key, i) => ({ start: i, dur: 1, key })),
    });
  };
  add(null);
  for (const probeCase of CASES) { add(probeCase); add(null); }
  return bars;
}
const barName = (bar) => (bar.case ? `${bar.case.id}: ${bar.case.label}` : bar.index === 0 ? 'control (lead-in)' : 'control');

const DURATIONS = new Map([[4, model.Duration.Whole], [2, model.Duration.Half], [1, model.Duration.Quarter], [0.5, model.Duration.Eighth]]);
function fillRests(notes) {
  const out = [];
  let cursor = 0;
  for (const note of notes) {
    for (; cursor < note.start; cursor += 1) out.push({ start: cursor, dur: 1, key: null });
    out.push(note);
    cursor = note.start + note.dur;
  }
  for (; cursor < 4; cursor += 1) out.push({ start: cursor, dur: 1, key: null });
  return out;
}
function buildScore(bpm, settings) {
  const plan = probePlan(), score = new model.Score();
  score.title = `Fermata probe ${bpm} BPM`;
  for (const bar of plan) {
    const master = new model.MasterBar();
    if (bar.index === 0) master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, bpm, 2)];
    master.section = new model.Section();
    master.section.marker = String(bar.index + 1);
    master.section.text = `Bar ${bar.index + 1} ${barName(bar)}`;
    score.addMasterBar(master);
  }
  [['Fermata track', 'notes1'], ['Sustain track', 'notes2']].forEach(([name, field]) => {
    const track = new model.Track(), staff = new model.Staff();
    track.name = name; track.shortName = name.slice(0, 4);
    staff.stringTuning.tunings = []; staff.showTablature = false;
    score.addTrack(track); track.addStaff(staff);
    const first = field === 'notes1' ? 't1' : 't2';
    for (const bar of plan) {
      const staffBar = new model.Bar(), voice = new model.Voice();
      staff.addBar(staffBar); staffBar.addVoice(voice);
      fillRests(bar[first]).forEach((entry, i) => {
        const beat = new model.Beat();
        beat.duration = DURATIONS.get(entry.dur); beat.isEmpty = false;
        voice.addBeat(beat);
        if (entry.key !== null) {
          const note = new model.Note();
          note.octave = Math.floor(entry.key / 12); note.tone = entry.key % 12;
          beat.addNote(note);
        }
        if (first === 't1' && i === 0 && bar.case) beat.text = bar.case.id;
      });
    }
  });
  score.finish(settings);
  return score;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
/** Same text the app writes in src/interchange/notation.ts: Type, Length, Offset as a ratio of 960 ticks. */
export function fermataXml(probeCase) {
  const ticks = probeCase.beat * PPQ, divisor = gcd(ticks, PPQ);
  return `<Fermatas><Fermata><Type>${probeCase.type}</Type><Length>${probeCase.length}</Length><Offset>${ticks / divisor}/${PPQ / divisor}</Offset></Fermata></Fermatas>`;
}
/** Builds one probe file (zipped GPIF) at the given tempo. */
export function buildProbeFile(bpm) {
  const settings = new Settings(), plan = probePlan();
  const entries = unzipSync(new exporter.Gp7Exporter().export(buildScore(bpm, settings), settings));
  const parts = strFromU8(entries[GPIF]).replace(/<Fermatas>[\s\S]*?<\/Fermatas>/g, '').split('</MasterBar>');
  if (parts.length !== plan.length + 1) throw new Error(`Expected ${plan.length} master bars in the written GPIF, found ${parts.length - 1}.`);
  entries[GPIF] = strToU8(parts.map((part, i) => (i < plan.length ? part + (plan[i].case ? fermataXml(plan[i].case) : '') : part)).join('</MasterBar>'));
  return zipSync(entries);
}

export function readmeText() {
  const plan = probePlan();
  const barOf = (id) => plan.find((bar) => bar.case?.id === id).index + 1;
  const rows = plan.filter((bar) => bar.case).map((bar) => `  bar ${String(bar.index + 1).padStart(2)}: ${bar.case.label}`).join('\n');
  return `Fermata probe for Guitar Pro 8 (Linear THE-60)
==========================================

Why: TabPlayer stores Guitar Pro fermatas exactly but does not know what Length means or how Guitar Pro plays them.
These files isolate that. They are plain synthetic scores; do not edit them and do not save over them.

Files (in this folder):
  fermata-probe-120.gp   120 BPM
  fermata-probe-60.gp    60 BPM
Each has two tracks: "Fermata track" (quarter notes, the fermatas sit here) and "Sustain track" (a whole note held across
every fermata bar, quarter notes in the plain bars). Every bar is 4/4. Bar 1 is plain, then each case bar is followed by
a plain control bar. Each case bar is named in its section label and in the text on its first note. Case bars:
${rows}

Steps (about five minutes):
 1. Before exporting, look in Guitar Pro for options that add a count-in, metronome click or extra repeats to exports or
    playback, and switch them off. I do not know Guitar Pro's exact dialogs; please write down what you chose.
 2. Open fermata-probe-120.gp in Guitar Pro 8. Confirm fermata symbols show over the notes in the case bars.
    If a fermata can be clicked to show its properties (type, length), note what it shows for bar ${barOf('medium-0.5')} (Medium 0.5) and bar ${barOf('medium-2')}
    (Medium 2). If a bar shows no fermata symbol, tell me which one.
 3. File > Export > MIDI. Save in this same folder as:  fermata-probe-120.mid
 4. If the export dialog offers any option that changes how the MIDI is written (for example exporting "as played", with
    interpretation, with or without fermatas, or tempo/repeat handling), export once with the default settings as above and
    once more with the other setting, saving the second as fermata-probe-120-alt.mid. Note which option the second file used.
 5. Repeat steps 2 to 4 with fermata-probe-60.gp, saving fermata-probe-60.mid (and fermata-probe-60-alt.mid if you did step 4).
 6. Tell me the folder, and anything unusual (a warning on opening, missing fermata symbols, different option names).

Then run:  node scripts/fermata-probe.mjs analyse <this folder>
`;
}

export function writeProbe(dir) {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const bpm of TEMPOS) {
    const path = join(out, `fermata-probe-${bpm}.gp`);
    writeFileSync(path, buildProbeFile(bpm)); files.push(path);
  }
  const readme = join(out, 'README.txt');
  writeFileSync(readme, readmeText()); files.push(readme);
  const layout = join(out, 'probe-layout.json');
  writeFileSync(layout, JSON.stringify(probePlan().map((bar) => ({ bar: bar.index + 1, name: barName(bar), fermata: bar.case ? { type: bar.case.type, length: bar.case.length, offsetTicks: bar.case.beat * PPQ } : null })), null, 1));
  files.push(layout);
  return files;
}

// ---------------------------------------------------------------------------------------------------------------------
// Standard MIDI File reader. Never throws on input: problems are collected in `warnings`.
// ---------------------------------------------------------------------------------------------------------------------
export function parseSmf(input, maxBytes = MAX_MIDI_BYTES) {
  const out = { ok: false, warnings: [], format: -1, declaredTracks: 0, ppq: 0, tracks: 0, tempos: [], timeSigs: [], texts: [], notes: [] };
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  if (bytes.length > maxBytes) { out.warnings.push(`File is ${bytes.length} bytes, over the ${maxBytes} byte limit; not read.`); return out; }
  const ascii = (at, n) => String.fromCharCode(...bytes.slice(at, at + n));
  const u16 = (at) => (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at) => bytes[at] * 16777216 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
  if (bytes.length < 14 || ascii(0, 4) !== 'MThd') { out.warnings.push('Not a Standard MIDI File (no MThd header in the first 14 bytes).'); return out; }
  const headerLength = u32(4);
  if (headerLength < 6) { out.warnings.push(`MThd length is ${headerLength}, expected at least 6.`); return out; }
  out.format = u16(8); out.declaredTracks = u16(10);
  const division = u16(12);
  if (division & 0x8000) { out.warnings.push('SMPTE time division is not supported by this reader.'); return out; }
  if (division === 0) { out.warnings.push('Time division is 0.'); return out; }
  out.ppq = division;
  const readVar = (at, end) => {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      if (at + i >= end) return null;
      const b = bytes[at + i];
      value = value * 128 + (b & 127);
      if (!(b & 128)) return { value, next: at + i + 1 };
    }
    return null;
  };
  let p = 8 + headerLength, trackIndex = 0;
  while (p + 8 <= bytes.length && out.tracks < 4096) {
    const id = ascii(p, 4), size = u32(p + 4), start = p + 8;
    let end = start + size;
    if (id !== 'MTrk') { p = end; continue; }
    if (end > bytes.length) { out.warnings.push(`Track ${trackIndex} claims ${size} bytes but only ${bytes.length - start} remain (truncated file); read what is there.`); end = bytes.length; }
    out.tracks += 1;
    let at = start, tick = 0, running = -1, ended = false;
    const pending = new Map();
    const stop = (why) => { out.warnings.push(`Track ${trackIndex}: ${why} at byte ${at}; the rest of this track was skipped.`); };
    while (at < end) {
      const delta = readVar(at, end);
      if (!delta) { stop('bad or truncated delta time'); break; }
      tick += delta.value; at = delta.next;
      if (at >= end) { stop('delta time without an event'); break; }
      let status = bytes[at];
      if (status < 0x80) {
        if (running < 0) { stop('data byte with no running status'); break; }
        status = running;
      } else { at += 1; running = status < 0xf0 ? status : -1; }
      if (status === 0xff) {
        const type = bytes[at]; at += 1;
        const len = readVar(at, end);
        if (!len || at >= end) { stop('truncated meta event'); break; }
        at = len.next;
        if (at + len.value > end) { stop('meta event runs past the end of the track'); break; }
        const data = bytes.slice(at, at + len.value); at += len.value;
        if (type === 0x51 && data.length === 3) out.tempos.push({ tick, usPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2], track: trackIndex });
        else if (type === 0x58 && data.length >= 2) out.timeSigs.push({ tick, numerator: data[0], denominator: 2 ** data[1] });
        else if (type >= 1 && type <= 7) out.texts.push({ tick, kind: type, text: new TextDecoder('utf-8', { fatal: false }).decode(data), track: trackIndex });
        else if (type === 0x2f) { ended = true; break; }
      } else if (status === 0xf0 || status === 0xf7) {
        const len = readVar(at, end);
        if (!len || len.next + len.value > end) { stop('truncated system-exclusive event'); break; }
        at = len.next + len.value;
      } else if (status >= 0xf1) {
        stop(`unexpected status byte 0x${status.toString(16)}`); break;
      } else {
        const kind = status & 0xf0, channel = status & 15, one = kind === 0xc0 || kind === 0xd0;
        if (at + (one ? 1 : 2) > end || bytes[at] > 127 || (!one && bytes[at + 1] > 127)) { stop('truncated or invalid channel event'); break; }
        const a = bytes[at], b = one ? 0 : bytes[at + 1];
        at += one ? 1 : 2;
        const slot = `${channel}:${a}`;
        if (kind === 0x90 && b > 0) {
          const note = { track: trackIndex, channel, key: a, velocity: b, on: tick, off: null };
          out.notes.push(note);
          if (!pending.has(slot)) pending.set(slot, []);
          pending.get(slot).push(note);
        } else if (kind === 0x80 || kind === 0x90) {
          const queue = pending.get(slot);
          if (queue?.length) queue.shift().off = tick;
        }
      }
    }
    if (!ended && at >= end) out.warnings.push(`Track ${trackIndex}: no end-of-track event.`);
    const open = [...pending.values()].reduce((sum, queue) => sum + queue.length, 0);
    if (open) out.warnings.push(`Track ${trackIndex}: ${open} note(s) never released.`);
    trackIndex += 1;
    p = start + size;
  }
  if (out.tracks !== out.declaredTracks) out.warnings.push(`Header declares ${out.declaredTracks} track(s), ${out.tracks} read.`);
  out.notes.sort((a, b) => a.on - b.on || a.key - b.key);
  out.ok = out.tracks > 0;
  return out;
}

/** Tempo segments from every tempo event of every track; later events at the same tick win. */
export function tempoMap(tempos, ppq) {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick);
  const segments = [];
  for (const t of sorted) {
    if (segments.length && segments[segments.length - 1].tick === t.tick) segments.pop();
    segments.push({ tick: t.tick, usPerQuarter: t.usPerQuarter });
  }
  if (!segments.length || segments[0].tick > 0) segments.unshift({ tick: 0, usPerQuarter: 500000 });
  let seconds = 0;
  segments.forEach((s, i) => {
    if (i) seconds += ((s.tick - segments[i - 1].tick) / ppq) * (segments[i - 1].usPerQuarter / 1e6);
    s.seconds = seconds;
  });
  return segments;
}
export function tickToSeconds(map, ppq, tick) {
  let segment = map[0];
  for (const s of map) if (s.tick <= tick) segment = s; else break;
  return segment.seconds + ((tick - segment.tick) / ppq) * (segment.usPerQuarter / 1e6);
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------------
const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
const sign = (n, d = 3) => (n >= 0 ? '+' : '') + f(n, d);
const SEC_TOLERANCE = 0.004;

/** Aligns observed notes with the layout by order. Returns null plus a reason when the file does not match the probe. */
function align(observed, expected, label) {
  const sorted = [...observed].sort((a, b) => a.on - b.on || a.key - b.key);
  if (sorted.length !== expected.length) return { problem: `${label}: ${sorted.length} notes found, the probe has ${expected.length}.` };
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].key !== expected[i].note.key) return { problem: `${label}: note ${i + 1} has key ${sorted[i].key}, the probe has ${expected[i].note.key}.` };
  }
  return { notes: sorted };
}

/** Measures one MIDI file against the probe layout. `nominalBpm` is the tempo the probe file was written at. */
export function analyseSmf(smf, nominalBpm) {
  const ppq = smf.ppq, plan = probePlan(), problems = [];
  const bpm = nominalBpm ?? (smf.tempos.length ? 60e6 / smf.tempos[0].usPerQuarter : 120);
  const map = tempoMap(smf.tempos, ppq), seconds = (tick) => tickToSeconds(map, ppq, tick);
  const nominalSeconds = (beats) => (beats * 60) / bpm;
  const tickTol = Math.max(2, Math.round(ppq / 480));
  const expected = { t1: [], t2: [] };
  for (const bar of plan) for (const [track, key] of [['t1', 't1'], ['t2', 't2']]) {
    bar[key].forEach((note) => expected[track].push({ bar: bar.index, note }));
  }
  const a1 = align(smf.notes.filter((n) => n.key >= 60), expected.t1, 'Fermata track (keys 60 and up)');
  const a2 = align(smf.notes.filter((n) => n.key < 60), expected.t2, 'Sustain track (keys under 60)');
  if (a1.problem) problems.push(a1.problem);
  if (a2.problem) problems.push(a2.problem);
  if (problems.length) return { ppq, bpm, problems, cases: [], tickTol };
  const observed = (list, entries) => entries.map((entry, i) => ({ ...entry, obs: list[i] }));
  const t1 = observed(a1.notes, expected.t1), t2 = observed(a2.notes, expected.t2);
  const byBar = (rows) => plan.map((bar) => rows.filter((row) => row.bar === bar.index));
  const bars1 = byBar(t1), bars2 = byBar(t2);
  const startShift = (rows) => rows.map((barRows) => {
    const first = barRows[0];
    const expectedTick = (first.bar * 4 + first.note.start) * ppq;
    return { ticks: first.obs.on - expectedTick, seconds: seconds(first.obs.on) - nominalSeconds(expectedTick / ppq) };
  });
  const s1 = startShift(bars1), s2 = startShift(bars2);
  const cases = [];
  plan.forEach((bar) => {
    if (!bar.case) return;
    const b = bar.index, c = bar.case, next = b + 1;
    const barStartObsSeconds = seconds(bars1[b][0].obs.on);
    const notes = bars1[b].map((row) => {
      const expOn = (b * 4 + row.note.start) * ppq, expOff = (b * 4 + row.note.start + row.note.dur) * ppq;
      const obsOff = row.obs.off ?? NaN;
      return {
        key: row.note.key, start: row.note.start, expOn, expOff, obsOn: row.obs.on, obsOff,
        dOnTicks: row.obs.on - expOn - s1[b].ticks, dOffTicks: obsOff - expOff - s1[b].ticks,
        dOnSeconds: seconds(row.obs.on) - barStartObsSeconds - nominalSeconds(row.note.start),
        dOffSeconds: seconds(obsOff) - barStartObsSeconds - nominalSeconds(row.note.start + row.note.dur),
        lengthTicks: obsOff - row.obs.on, expLengthTicks: expOff - expOn,
        lengthSeconds: seconds(obsOff) - seconds(row.obs.on), expLengthSeconds: nominalSeconds(row.note.dur),
      };
    });
    const fermataNote = notes.find((n) => n.start === c.beat) ?? null;
    const whole = bars2[b][0];
    const wholeExpOff = (b * 4 + 4) * ppq;
    const sustain = {
      expOn: (b * 4) * ppq, expOff: wholeExpOff, obsOn: whole.obs.on, obsOff: whole.obs.off ?? NaN,
      lengthSeconds: seconds(whole.obs.off ?? NaN) - seconds(whole.obs.on), expLengthSeconds: nominalSeconds(4),
      dLengthTicks: (whole.obs.off ?? NaN) - whole.obs.on - 4 * ppq,
      dOffTicks: (whole.obs.off ?? NaN) - wholeExpOff - s2[b].ticks,
    };
    const added1 = { ticks: s1[next].ticks - s1[b].ticks, seconds: s1[next].seconds - s1[b].seconds };
    const added2 = { ticks: s2[next].ticks - s2[b].ticks, seconds: s2[next].seconds - s2[b].seconds };
    const windowStart = b * 4 * ppq - 1, windowEnd = (b + 2) * 4 * ppq;
    const tempoEvents = smf.tempos.filter((t) => t.tick >= windowStart && t.tick < windowEnd).map((t) => ({ tick: t.tick, bpm: 60e6 / t.usPerQuarter }));
    const changedTempo = tempoEvents.filter((t) => Math.abs(t.bpm - bpm) > 0.05);
    const controlDrift = bars1[next].reduce((worst, row) => {
      const expTick = (next * 4 + row.note.start) * ppq;
      const t = Math.abs(row.obs.on - expTick - s1[next].ticks);
      const sec = Math.abs(seconds(row.obs.on) - seconds(bars1[next][0].obs.on) - nominalSeconds(row.note.start));
      return { ticks: Math.max(worst.ticks, t), seconds: Math.max(worst.seconds, sec) };
    }, { ticks: 0, seconds: 0 });
    const markers = smf.texts.filter((t) => t.tick >= b * 4 * ppq - 1 && t.tick < (b + 1) * 4 * ppq + 1 && (t.kind === 1 || t.kind === 6 || t.kind === 7)).map((t) => t.text);
    const inBarShift = notes.some((n) => Math.abs(n.dOnTicks) > tickTol);
    const noteLonger = fermataNote !== null && (Math.abs(fermataNote.lengthTicks - fermataNote.expLengthTicks) > tickTol || Math.abs(fermataNote.lengthSeconds - fermataNote.expLengthSeconds) > SEC_TOLERANCE);
    const flags = {
      shiftTicks: Math.abs(added1.ticks) > tickTol, shiftSeconds: Math.abs(added1.seconds) > SEC_TOLERANCE,
      tempoChange: changedTempo.length > 0, noteLonger, inBarShift,
      sustainLonger: Math.abs(sustain.dLengthTicks) > tickTol || Math.abs(sustain.lengthSeconds - sustain.expLengthSeconds) > SEC_TOLERANCE,
      sustainDelayed: Math.abs(added2.seconds) > SEC_TOLERANCE || Math.abs(added2.ticks) > tickTol,
    };
    let mechanism;
    const anything = flags.shiftTicks || flags.shiftSeconds || flags.tempoChange || flags.noteLonger || flags.inBarShift;
    if (!anything) mechanism = 'none';
    else if (flags.tempoChange && !flags.shiftTicks) mechanism = 'tempo';
    else if (flags.shiftTicks && !flags.tempoChange) mechanism = 'shift';
    else if (flags.noteLonger && !flags.shiftTicks && !flags.shiftSeconds && !flags.tempoChange && !flags.inBarShift) mechanism = 'longer-only';
    else mechanism = 'mixed';
    cases.push({
      id: c.id, label: c.label, type: c.type, length: c.length, beat: c.beat, shape: c.shape, bar: b, notes, fermataNote, sustain,
      added1, added2, addedBeats: (added1.seconds * bpm) / 60, tempoEvents, changedTempo, controlDrift, markers, flags, mechanism,
      baseline: { ticks: s1[b].ticks, seconds: s1[b].seconds },
    });
  });
  return { ppq, bpm, problems, cases, tickTol, baseline: s1[0] };
}

const close = (a, b) => Math.abs(a - b) <= Math.max(0.01, 0.03 * Math.max(Math.abs(a), Math.abs(b)));
const MECHANISM_TEXT = {
  none: 'no difference from the plain grid',
  tempo: 'hold written as inserted tempo events (note positions in ticks unchanged, seconds longer)',
  shift: 'later events moved later in ticks at constant tempo',
  'longer-only': 'the fermata note is longer, later events are not moved',
  mixed: 'a combination (see the numbers)',
};

/** Prints the per-case detail of one analysed file. */
export function describeFile(name, result) {
  const lines = [`=== ${name}: ${result.bpm} BPM nominal, ${result.ppq} ticks per quarter ===`];
  if (result.problems.length) {
    lines.push('Could not compare this file with the probe layout:', ...result.problems.map((p) => `  - ${p}`));
    return lines;
  }
  lines.push(`Constant offset of the first bar (count-in or similar, not a hold): ${sign(result.baseline.ticks, 0)} ticks, ${sign(result.baseline.seconds)} s.`);
  for (const c of result.cases) {
    const span0 = (c.bar * 4 + c.beat) * result.ppq;
    lines.push('', `[${c.id}] bar ${c.bar + 1}: ${c.label}`);
    lines.push(`  expected fermata beat, no hold: ticks ${span0}-${span0 + result.ppq}, ${f((span0 * 60) / (result.bpm * result.ppq))}-${f(((span0 + result.ppq) * 60) / (result.bpm * result.ppq))} s from the start`);
    if (c.markers.length) lines.push(`  text/marker events in this bar: ${c.markers.map((m) => JSON.stringify(m)).join(', ')}`);
    lines.push('  fermata track (key: expected on-off -> observed on-off ticks; delta within the bar in ticks / seconds):');
    for (const n of c.notes) {
      lines.push(`    ${n.key}${n.start === c.beat ? '*' : ' '} ${n.expOn}-${n.expOff} -> ${n.obsOn}-${n.obsOff}  on ${sign(n.dOnTicks, 0)} t / ${sign(n.dOnSeconds)} s, off ${sign(n.dOffTicks, 0)} t / ${sign(n.dOffSeconds)} s, length ${n.lengthTicks} t (${f(n.lengthSeconds)} s, plain ${n.expLengthTicks} t)`);
    }
    if (c.fermataNote === null) lines.push('    (no note at the fermata beat: it is a rest)');
    lines.push(`  sustain track whole note (key 36): expected ${c.sustain.expOn}-${c.sustain.expOff} -> observed ${c.sustain.obsOn}-${c.sustain.obsOff}; length ${f(c.sustain.lengthSeconds)} s vs plain ${f(c.sustain.expLengthSeconds)} s`);
    lines.push(`  next (control) bar starts later by: fermata track ${sign(c.added1.ticks, 0)} ticks / ${sign(c.added1.seconds)} s (${sign(c.addedBeats)} beats at ${result.bpm} BPM); sustain track ${sign(c.added2.ticks, 0)} ticks / ${sign(c.added2.seconds)} s`);
    lines.push(`  control bar drift inside the following plain bar: max ${c.controlDrift.ticks} ticks, ${f(c.controlDrift.seconds)} s`);
    lines.push(`  tempo events across bars ${c.bar + 1}-${c.bar + 2}: ${c.tempoEvents.length ? c.tempoEvents.map((t) => `${f(t.bpm, 2)} BPM @tick ${t.tick}`).join(', ') : 'none'}`);
    lines.push(`  -> ${c.mechanism}: ${MECHANISM_TEXT[c.mechanism]}`);
  }
  return lines;
}

function dependencyLines(name, result) {
  const lines = [], byId = new Map(result.cases.map((c) => [c.id, c])), val = (id) => byId.get(id)?.added1.seconds;
  const have = (...ids) => ids.every((id) => val(id) !== undefined);
  const list = (ids) => ids.map((id) => `${id} ${f(val(id))} s`).join(', ');
  if (have('short-0', 'medium-0', 'long-0')) {
    const v = ['short-0', 'medium-0', 'long-0'].map(val);
    lines.push(close(v[0], v[1]) && close(v[1], v[2]) ? `Type (Length 0): no difference between Short, Medium and Long (${list(['short-0', 'medium-0', 'long-0'])}).` : `Type (Length 0): differs, ${list(['short-0', 'medium-0', 'long-0'])}.`);
  }
  if (have('medium-0', 'medium-0.5', 'medium-1', 'medium-2')) {
    const ids = ['medium-0', 'medium-0.5', 'medium-1', 'medium-2'], v = ids.map(val);
    if (v.every((x) => close(x, v[0]))) lines.push(`Length (Medium, 0 / 0.5 / 1 / 2): no difference (${list(ids)}).`);
    else {
      const k = v[2] - v[0], linear = close(v[1] - v[0], k * 0.5) && close(v[3] - v[0], k * 2);
      lines.push(linear ? `Length (Medium): linear, ${f(v[0])} s at 0 plus ${f(k)} s per Length unit (${list(ids)}).` : `Length (Medium): changes but not linearly (${list(ids)}).`);
    }
  }
  if (have('short-2', 'medium-2', 'long-2')) lines.push(`Type at Length 2: ${list(['short-2', 'medium-2', 'long-2'])}${have('short-0', 'medium-0', 'long-0') ? `; the Length 0 to 2 step is ${['short', 'medium', 'long'].map((t) => `${t} ${sign(val(`${t}-2`) - val(`${t}-0`))} s`).join(', ')}` : ''}.`);
  if (have('medium-0', 'rest', 'last-beat', 'mid-bar')) {
    const ids = ['medium-0', 'rest', 'last-beat', 'mid-bar'], v = ids.map(val);
    lines.push(v.every((x) => close(x, v[0])) ? `Position (beat 3, rest, beat 4, beat 2) and rest versus note: no difference (${list(ids)}).` : `Position and rest versus note: differs (${list(ids)}).`);
  }
  if (have('medium-0', 'half-note', 'eighth-note')) {
    const ids = ['medium-0', 'half-note', 'eighth-note'], v = ids.map(val);
    if (v.every((x) => close(x, v[0]))) lines.push(`Note length (quarter, half, eighth): no difference (${list(ids)}), so the added time does not scale with the note's length.`);
    else if (v[0] > 0.01 && close(v[1], v[0] * 2) && close(v[2], v[0] / 2)) lines.push(`Note length (quarter, half, eighth): scales with the note's length, 1x : 2x : 0.5x (${list(ids)}).`);
    else lines.push(`Note length (quarter, half, eighth): differs but not in proportion to length (${list(ids)}).`);
  }
  return lines.map((l) => `  ${name}: ${l}`);
}

/** Turns analysed files into conclusion lines that state only what the numbers show. */
export function conclude(files) {
  const lines = ['', '=== Conclusion (only what the numbers above show) ==='];
  const usable = files.filter((file) => !file.result.problems.length && file.result.cases.length);
  for (const file of files) if (file.result.problems.length) lines.push(`${file.name}: not analysed (${file.result.problems.join(' ')})`);
  if (!usable.length) { lines.push('No usable file, so no conclusion can be drawn.'); return lines; }
  for (const { name, result } of usable) {
    const counts = {}; for (const c of result.cases) counts[c.mechanism] = (counts[c.mechanism] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, n]) => `${n} x ${k}`).join(', ');
    lines.push('', `${name}: ${summary} of ${result.cases.length} cases.`);
    const changed = result.cases.filter((c) => c.mechanism !== 'none');
    if (!changed.length) {
      lines.push('  No difference at all: every fermata bar has the same note positions, lengths, tempo events and timing as the plain grid. In this export Guitar Pro does not express the fermata in MIDI. This is a valid finding: any hold would be Guitar Pro playback behaviour that its MIDI export leaves out (or an export option not chosen).');
      continue;
    }
    for (const mech of new Set(changed.map((c) => c.mechanism))) {
      const ids = changed.filter((c) => c.mechanism === mech).map((c) => c.id).join(', ');
      lines.push(`  ${MECHANISM_TEXT[mech]}: ${ids}.`);
    }
    const unchanged = result.cases.filter((c) => c.mechanism === 'none').map((c) => c.id);
    if (unchanged.length) lines.push(`  No difference in: ${unchanged.join(', ')}.`);
    const moved = changed.filter((c) => c.flags.shiftSeconds);
    if (moved.length) {
      const both = moved.filter((c) => Math.abs(c.added2.seconds - c.added1.seconds) <= SEC_TOLERANCE * 2 + 0.002).length;
      lines.push(both === moved.length ? `  The sustain track is delayed by the same amount as the fermata track in all ${moved.length} delayed cases: the hold applies to every track.` : both === 0 ? `  The sustain track is NOT delayed like the fermata track in any of the ${moved.length} delayed cases: the hold affects only the fermata track in this MIDI.` : `  The sustain track matches the fermata track's delay in ${both} of ${moved.length} delayed cases; see the numbers.`);
    }
    const longer = changed.filter((c) => c.flags.sustainLonger).map((c) => c.id);
    if (longer.length) lines.push(`  The held whole note on the sustain track changed length in: ${longer.join(', ')}.`);
    const unit = changed.filter((c) => c.flags.shiftSeconds).map((c) => `${c.id} ${f(c.added1.seconds)} s = ${f(c.addedBeats)} beats`).join('; ');
    if (unit) lines.push(`  Added time before the next bar (fermata track): ${unit}.`);
    lines.push(...dependencyLines(name, result));
  }
  const by = new Map(usable.map((file) => [file.bpm, file]));
  const slow = by.get(60), fast = by.get(120);
  if (slow && fast) {
    const rows = [];
    for (const c of fast.result.cases) {
      const s = slow.result.cases.find((x) => x.id === c.id);
      if (!s) continue;
      const a = c.added1.seconds, b = s.added1.seconds;
      if (Math.abs(a) <= SEC_TOLERANCE && Math.abs(b) <= SEC_TOLERANCE) continue;
      rows.push({ id: c.id, a, b, ratio: a !== 0 ? b / a : NaN });
    }
    if (!rows.length) lines.push('', 'Tempo: no added time at either tempo, so no tempo dependence to report.');
    else {
      const ratios = rows.map((r) => r.ratio).filter(Number.isFinite);
      const text = rows.map((r) => `${r.id} ${f(r.a)} s at 120, ${f(r.b)} s at 60 (x${f(r.ratio, 2)})`).join('; ');
      let verdict;
      if (ratios.length && ratios.every((r) => Math.abs(r - 1) < 0.08)) verdict = 'the added time is the same number of seconds at both tempos (constant seconds)';
      else if (ratios.length && ratios.every((r) => Math.abs(r - 2) < 0.15)) verdict = 'the added time doubles at half the tempo, i.e. the same number of beats at both tempos (constant beats; with quarter-note fermatas this cannot be told from a multiple of the note length, only the half-note and eighth-note cases do that)';
      else verdict = 'the added time follows neither constant seconds (ratio 1) nor constant beats (ratio 2)';
      lines.push('', `Tempo dependence: ${verdict}. ${text}.`);
    }
  } else {
    lines.push('', `Tempo dependence: only the ${usable.map((u) => u.bpm).join(', ')} BPM file was read; seconds versus beats cannot be told apart without the other tempo. Export ${fast ? '60' : '120'} BPM too.`);
  }
  if (usable.some((u) => u.result.cases.some((c) => c.mechanism === 'mixed'))) lines.push('', 'Some cases combine mechanisms (for example tick shifts together with tempo events). The candidates are in the per-case lines above; a further probe with only one tempo-neutral track would separate them.');
  return lines;
}

function nominalFromName(name) {
  const m = /(?:^|[^0-9])(120|60)(?![0-9])/.exec(name);
  return m ? Number(m[1]) : null;
}
export function analyseDirectory(dir) {
  const out = ['Fermata probe analysis', `Folder: ${resolve(dir)}`];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { out.push('That folder does not exist.'); return out; }
  const names = readdirSync(dir).filter((n) => /\.midi?$/i.test(n)).sort();
  if (!names.length) { out.push('No .mid files found. Export the probe files from Guitar Pro 8 as described in README.txt.'); return out; }
  const files = [];
  for (const name of names) {
    const path = join(dir, name);
    let bytes;
    try {
      const size = statSync(path).size;
      if (size > MAX_MIDI_BYTES) { out.push('', `${name}: ${size} bytes is over the ${MAX_MIDI_BYTES} byte limit; skipped.`); continue; }
      bytes = new Uint8Array(readFileSync(path));
    } catch (error) { out.push('', `${name}: could not be read (${error.message}).`); continue; }
    const smf = parseSmf(bytes);
    out.push('', `${name}: ${bytes.length} bytes, format ${smf.format}, ${smf.tracks} track(s), ${smf.ppq} ticks per quarter, ${smf.notes.length} notes, ${smf.tempos.length} tempo event(s).`);
    for (const w of smf.warnings) out.push(`  warning: ${w}`);
    if (!smf.ok) { out.push('  not analysed.'); continue; }
    const bpm = nominalFromName(name) ?? (smf.tempos[0] ? Math.round(60e6 / smf.tempos[0].usPerQuarter) : null);
    const result = analyseSmf(smf, bpm);
    files.push({ name, bpm: result.bpm, result });
    out.push(...describeFile(name, result));
  }
  out.push(...conclude(files));
  return out;
}

function main(argv) {
  const [command, dirArg] = argv;
  const dir = dirArg ?? DEFAULT_DIR;
  if (command === 'write') {
    if (!resolve(dir).replace(/\\/g, '/').includes('/.analysis/') && !/^[A-Za-z]:|^\//.test(dirArg ?? '')) console.warn(`Note: ${dir} is not under .analysis/, which is git-ignored. Do not commit the generated files.`);
    for (const file of writeProbe(dir)) console.log(`wrote ${file}`);
    console.log('\nNext: follow README.txt in that folder, then run: node scripts/fermata-probe.mjs analyse ' + dir);
  } else if (command === 'analyse' || command === 'analyze') {
    console.log(analyseDirectory(dir).join('\n'));
  } else {
    console.error('Usage: node scripts/fermata-probe.mjs write [dir] | analyse [dir]   (default dir: ' + DEFAULT_DIR + ')');
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
