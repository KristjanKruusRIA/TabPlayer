import { midi, model, Settings } from '@coderline/alphatab';
import '../tremolo-guard';
import { buildScore, trackIdentity } from '../engine';
import { captureNoteLinks, restoreNoteLinks } from '../editor/links';
import type { ProjectView } from '../project';
import type { BackingSettings, TrackInterpretation } from '../edit-types';
import type { Articulation, MeasureOccurrence, PlanMidiEvent, PlanNote, PlanTempo, PlaybackPlan } from './types';
import { scoreFromJson } from '../model-clone';
import { gpControllerEvents, prepareGpMidiScore } from '../interchange/automation';
import { preparePitchedGpScore } from '../interchange/pitched';
import { buildPerformedBeats } from './performed-beats';
import { applyNoteAudio, collectAudible, collectNoteAudio, type AudibleAttack, type AudioAdjustment } from './note-audio-plan';
import { hasNoteAudio } from '../editor/note-audio';
import type { ReferenceLocation } from './reference-sync-types';
import { interpretAttacks, type Attack } from './interpretation';

const settings = new Settings();
const validMeter = (numerator:number,denominator:number) => Number.isSafeInteger(numerator) && numerator > 0 && numerator <= 0xffffffff && [1,2,4,8,16,32,64,128,256].includes(denominator);
const beatsOf = (score: model.Score) => score.tracks.flatMap(t => t.staves.flatMap(s => s.bars.flatMap(b => b.voices.flatMap(v => v.beats))));
function cloneWithLinks(score: model.Score) {
  const copy = scoreFromJson(model.JsonConverter.scoreToJson(score), settings);
  restoreNoteLinks(copy, captureNoteLinks(score)); return copy;
}

// 1.8.4 multiplies negative whole-note enum values by the mark count instead of
// dividing their whole-note multiplier. Normalize only the transient MIDI model.
export function prepareMidiScore(score: model.Score): model.Score {
  score = preparePitchedGpScore(score, settings);
  const original = beatsOf(score);
  if (!original.some(b => b.duration < 0 && b.tremoloPicking)) return score;
  const copy = cloneWithLinks(score), byId = new Map(original.map(b => [b.id, b]));
  for (const beat of beatsOf(copy)) {
    if (beat.duration >= 0 || !beat.tremoloPicking) continue;
    const source = byId.get(beat.id)!;
    // Keep marks: public generation multiplies the picking tick interval by
    // playbackDuration / wholeDuration, which restores the original multiplier.
    beat.duration = model.Duration.Whole;
    beat.overrideDisplayDuration = source.overrideDisplayDuration ?? (source.graceType === model.GraceType.BendGrace ? source.playbackDuration * 2 : source.displayDuration);
  }
  return copy;
}

type RawNote = { track: number; trackAttack: number; onOrder: number; offOrder: number; start: number; end: number; channel: number; program?: number; key: number; rawKey: number; velocity: number; provenance?: string };
type RawEvent = (Omit<Extract<PlanMidiEvent, { type: 'program' }>, 'trackId'> & { track: number }
  | { type: 'controller'; track: number; tick: number; channel: number; controller: number; value: number }
  | { type: 'bend' | 'noteBend'; track: number; tick: number; channel: number; key?: number; value: number }) & { order: number };
type OrderedMidiEvent = PlanMidiEvent & { order: number };

// The public handler preserves addNote pairs and generation order, which an SMF
// loses when several same-pitch note-ons overlap on the same MIDI channel.
class Collector implements midi.IMidiFileHandler {
  notes: RawNote[] = [];
  events: RawEvent[] = [];
  tempos: PlanTempo[] = [];
  shift = 0;
  end = 0;
  provenance?: string;
  private attacks = new Map<number, number>();
  private order = 0;
  addTickShift(tickShift: number) { this.shift = tickShift; }
  addTimeSignature() {}
  addRest() {}
  addNote(track: number, start: number, length: number, key: number, velocity: number, channel: number) {
    const trackAttack = this.attacks.get(track) ?? 0; this.attacks.set(track, trackAttack + 1);
    this.notes.push({ track, trackAttack, onOrder: this.order++, offOrder: this.order++, start: start + this.shift, end: start + length + this.shift, key: Math.max(0, Math.min(127, key)), rawKey: key, velocity: Math.max(0, Math.min(127, velocity)), channel, provenance: this.provenance });
  }
  addControlChange(track: number, tick: number, channel: number, controller: midi.ControllerType, value: number) { this.events.push({ type: 'controller', track, tick: tick + this.shift, channel, controller, value: Math.max(0, Math.min(127, value)), order: this.order++ }); }
  addProgramChange(track: number, tick: number, channel: number, program: number) {
    if (program >= 128) this.provenance = `${program}/${tick + this.shift}`;
    this.events.push({ type: 'program', track, tick: tick + this.shift, channel, program, order: this.order++ });
  }
  addTempo(tick: number, bpm: number) { this.tempos.push({ tick: tick + this.shift, bpm }); }
  addBend(track: number, tick: number, channel: number, value: number) { this.events.push({ type: 'bend', track, tick: tick + this.shift, channel, value: Math.min(16384, Math.floor(value)), order: this.order++ }); this.own(); }
  addNoteBend(track: number, tick: number, channel: number, key: number, value: number) { this.events.push({ type: 'noteBend', track, tick: tick + this.shift, channel, key, value, order: this.order++ }); this.own(); }
  // The tick at which the beat that generated a bend began, by the bend's order.
  starts = new Map<number, number>();
  private own() { if (this.provenance) this.starts.set(this.order - 1, Number(this.provenance.slice(this.provenance.indexOf('/') + 1))); }
  finishTrack(_track: number, tick: number) { this.end = Math.max(this.end, tick + this.shift); }
}
function generate(score: model.Score) {
  const events = new Collector(), generator = new midi.MidiFileGenerator(score, settings, events); generator.generate();
  return { events, lookup: generator.tickLookup };
}

function resolvePrograms(score: model.Score, events: Collector) {
  const stream = [
    ...events.events.filter(e => e.type === 'program').map(e => ({ tick: e.tick, order: e.order, channel: e.channel, program: e.program })),
    ...events.notes.map(note => ({ tick: note.start, order: note.onOrder, channel: note.channel, note })),
  ].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const programs = new Map<number, number>();
  // Start with the first public channel program for leading attacks, then
  // follow actual playback order, including same-tick source event order.
  for (const event of stream) if ('program' in event && event.program < 128 && !programs.has(event.channel)) programs.set(event.channel, event.program);
  for (const event of stream) {
    if ('note' in event) event.note.program = programs.get(event.channel) ?? score.tracks[event.note.track].playbackInfo.program;
    else if (event.program < 128) programs.set(event.channel, event.program);
  }
}

export function backingLocationsForScore(score:model.Score):readonly ReferenceLocation[] {
  let shift = 0;
  const handler: midi.IMidiFileHandler = {
    addTickShift(value) { shift = value; }, addTimeSignature() {}, addRest() {}, addNote() {}, addControlChange() {}, addProgramChange() {}, addTempo() {}, addBend() {}, addNoteBend() {}, finishTrack() {},
  };
  const generator = new midi.MidiFileGenerator(score, settings, handler); generator.generate();
  const counts = new Map<number, number>();
  return generator.tickLookup.masterBars.map(m => {
    const bar = m.masterBar.index, occurrence = counts.get(bar) ?? 0; counts.set(bar, occurrence + 1);
    return { bar, occurrence, startTick: m.start + shift, endTick: m.end + shift };
  });
}
// Legacy settings validation can reuse committed immutable score geometry.
// Reference replay uses the fresh resolver above after each musical edit.
const backingLocations=new WeakMap<model.Score,readonly ReferenceLocation[]>();
export function validateBackingAnchors(score: model.Score, backing: Pick<BackingSettings, 'offsetMs' | 'anchors' | 'referenceSync'> | null | undefined): void {
  if (!backing) return;
  if (!Number.isFinite(backing.offsetMs)) throw new Error('Invalid backing offset.');
  const bounds=backing.referenceSync;
  if (!backing.anchors.length&&!bounds) return;
  let locations=backing.referenceSync?undefined:backingLocations.get(score);
  if(!locations){locations=backingLocationsForScore(score);if(!backing.referenceSync)backingLocations.set(score,locations);}
  const entrySourceMs=bounds?bounds.entryAudioMs-backing.offsetMs:0,exitSourceMs=bounds?bounds.exitAudioMs-backing.offsetMs:0;
  if(bounds&&(!locations.length||!Number.isFinite(bounds.entryAudioMs)||!Number.isFinite(bounds.exitAudioMs)||!Number.isFinite(entrySourceMs)||entrySourceMs<0||!Number.isFinite(exitSourceMs)||exitSourceMs<=entrySourceMs||!Number.isFinite(exitSourceMs-entrySourceMs)))throw new Error('Invalid reference synchronization bounds.');
  const points = backing.anchors.map(anchor => {
    if (!Number.isSafeInteger(anchor.bar) || anchor.bar < 0 || anchor.bar > 0xffffffff || !Number.isSafeInteger(anchor.occurrence) || anchor.occurrence < 0 || anchor.occurrence > 0xffffffff || !Number.isFinite(anchor.ratio) || anchor.ratio < 0 || anchor.ratio > 1 || !Number.isFinite(anchor.audioMs) || (!bounds&&anchor.audioMs < 0)) throw new Error('Backing anchor has an invalid synchronization position.');
    const occurrence = locations.find(o => o.bar === anchor.bar && o.occurrence === anchor.occurrence);
    if (!occurrence) throw new Error('Backing anchor refers to missing score music.');
    const tick=occurrence.startTick + (occurrence.endTick - occurrence.startTick) * anchor.ratio;
    const sourceMs=anchor.audioMs-backing.offsetMs;
    if(bounds&&(tick<=locations[0].startTick||tick>=locations[locations.length-1].endTick||!Number.isFinite(sourceMs)||sourceMs<=entrySourceMs||sourceMs>=exitSourceMs))throw new Error('Reference anchors must lie inside the synchronization endpoints.');
    return { tick, audioMs: bounds?sourceMs:anchor.audioMs };
  }).sort((a, b) => a.tick - b.tick);
  if (points.some((point, i) => i > 0 && (points[i - 1].tick >= point.tick || points[i - 1].audioMs >= point.audioMs))) throw new Error('Backing anchors must have distinct score positions and increasing audio times in playback order.');
}
function timeAt(tick: number, tempos: PlanTempo[]) {
  let seconds = 0, previous = 0, bpm = tempos[0].bpm;
  for (const tempo of tempos) { if (tempo.tick > tick) break; seconds += (tempo.tick - previous) * 60 / (960 * bpm); previous = tempo.tick; bpm = tempo.bpm; }
  return (seconds + (tick - previous) * 60 / (960 * bpm)) * 1000;
}
function channelMapping(score: model.Score, events: Collector) {
  const maps = score.tracks.map(track => {
    const channels = new Set([track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel, ...events.notes.filter(n => n.track === track.index).map(n => n.channel), ...events.events.filter(e => e.track === track.index).map(e => e.channel)]);
    const map = new Map<number, number>(), used = new Set<number>();
    // Channel nine has percussion-bank semantics in both synthesizers.
    if (channels.has(9)) { map.set(9, 9); used.add(9); }
    for (const channel of channels) {
      if (map.has(channel)) continue;
      if (!Number.isSafeInteger(channel) || channel < 0) throw new Error('Invalid source MIDI channel.');
      let native = channel & 15;
      if (native === 9 || used.has(native)) native = Array.from({ length: 16 }, (_, i) => i).find(i => i !== 9 && !used.has(i)) ?? -1;
      if (native < 0) throw new Error('Too many independent MIDI channels in one track.');
      map.set(channel, native); used.add(native);
    }
    return map;
  });
  return (track: number, channel: number) => maps[track].get(channel)!;
}
function converted(events: RawEvent[], identities: string[], nativeChannel: (track: number, channel: number) => number): OrderedMidiEvent[] {
  const states = new Map<string, { msb: number; lsb: number; range: number; coarse: number }>();
  // alphaTab can place an initial whammy controller at -1 tick. At a native
  // clock starting at zero it is initial state, after the channel range setup.
  return [...events].sort((a, b) => Math.max(0, a.tick) - Math.max(0, b.tick)).map(event => {
    const identity = `${event.track}/${event.channel}`;
    let state = states.get(identity);
    if (!state) { state = { msb: 127, lsb: 127, range: 2, coarse: 2 }; states.set(identity, state); }
    const { track, ...data } = event;
    data.tick = Math.max(0, data.tick);
    data.channel = nativeChannel(track, event.channel);
    if (event.type === 'controller') {
      if (event.controller === 101) state.msb = event.value;
      if (event.controller === 100) state.lsb = event.value;
      if (state.msb === 0 && state.lsb === 0) {
        if (event.controller === 6) { state.coarse = event.value; state.range = event.value; }
        if (event.controller === 38) state.range = state.coarse + event.value / 100;
      }
    }
    // Guitar Pro mixes are fractional on the 0–16 scale and alphaTab scales them by 8
    // unrounded; round volume and pan as gpControllerEvents does.
    if (event.type === 'controller' && (event.controller === 7 || event.controller === 10)) return { ...data, trackId: identities[track], value: Math.max(0, Math.min(127, Math.round(event.value))) } as OrderedMidiEvent;
    if (event.type === 'bend' || event.type === 'noteBend') return { ...data, trackId: identities[track], value: (event.value - 8192) / 8192 * state.range } as OrderedMidiEvent;
    return { ...data, trackId: identities[track] } as OrderedMidiEvent;
  });
}
type Source = { note: model.Note; track: number; staff: number; bar: number; voice: number; beat: number; index: number; lane: string };
function sources(score: model.Score) {
  const all: Source[] = [];
  for (const track of score.tracks) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
    const ordinals = new Map<number, number>();
    for (const note of beat.notes) {
      const ordinal = ordinals.get(note.string) ?? 0; ordinals.set(note.string, ordinal + 1);
      all.push({ note, track: track.index, staff: staff.index, bar: bar.index, voice: voice.index, beat: beat.index, index: note.index, lane: `${track.index}/${staff.index}/${voice.index}/${note.string}/${ordinal}` });
    }
  }
  return all;
}
function laneScore(json: ReturnType<typeof model.JsonConverter.scoreToJson>, lane: Source[]) {
  const score = scoreFromJson(json, settings), first = lane[0];
  const track = score.tracks[first.track], staff = track.staves[first.staff];
  // Finish before removing notes: retain original grace/tuplet rhythm and all
  // derived tie/let-ring/slide links. Do not refinish an isolated musical lane.
  const keep = new Set(lane.map(s => `${s.bar}/${s.beat}/${s.index}`));
  const markers = new Map<string, number>(); let marker = 0;
  for (const bar of staff.bars) {
    const voice = bar.voices[first.voice];
    if (!voice) { bar.voices = []; continue; }
    for (const beat of voice.beats) {
      // Public beat automations run immediately before its notes, including
      // attacks beyond the bar boundary. Reserved transient programs identify
      // the authored beat without guessing from attack pitch or onset windows.
      const tag = 128 + marker++ % 128;
      markers.set(`${bar.index}/${beat.index}`, tag);
      // Force the marker callback even if skipped empty voices made the last
      // emitted tag equal this one; public program changes are deduplicated.
      beat.automations.push(model.Automation.buildInstrumentAutomation(false, 0, 127));
      beat.automations.push(model.Automation.buildInstrumentAutomation(false, 0, tag));
      for (const note of beat.notes) {
        if (keep.has(`${bar.index}/${beat.index}/${note.index}`)) continue;
        // Keep chord carriers so the public generator computes brush, rasgueado
        // and shared whammy timing from the complete original chord. Tag their
        // raw pitch outside MIDI solely in this transient public model; the
        // custom handler discards carriers before producing the playback DTO.
        note.harmonicType = model.HarmonicType.None;
        note.ornament = model.NoteOrnament.None;
        if (note.isTrill) note.trillValue = 1000;
        if (note.isPercussion) note.percussionArticulation = 1000;
        else if (note.isStringed) note.fret += 1000 - note.calculateRealValue(true, false);
        else { note.octave = 83; note.tone = 4; }
      }
    }
    bar.voices = [voice];
  }
  track.staves = [staff]; score.tracks = [track]; return { score, markers };
}
function playbackBar(bar: model.Bar): model.Bar {
  switch (bar.simileMark) {
    case model.SimileMark.Simple: return bar.previousBar ? playbackBar(bar.previousBar) : bar;
    case model.SimileMark.FirstOfDouble:
    case model.SimileMark.SecondOfDouble: return bar.previousBar?.previousBar ? playbackBar(bar.previousBar.previousBar) : bar;
    default: return bar;
  }
}
function articulation(note: model.Note, program: number, legato: boolean, style?: TrackInterpretation['style']): Articulation {
  if (note.isDead) return 'dead';
  if (note.isPalmMute) return 'muted';
  if (note.isGhost) return 'ghost';
  if (note.isStaccato) return 'staccato';
  if (note.isLeftHandTapped || note.beat.tap) return 'tapped';
  if (note.harmonicType !== model.HarmonicType.None) return 'harmonic';
  if (legato) return 'legato';
  if (note.beat.pickStroke !== model.PickStroke.None) return 'picked';
  // A written right-hand finger outranks the track's playing style, as a written pick stroke does above.
  if (note.rightHandFinger >= 0) return 'fingered';
  return style ? style === 'fingers' ? 'fingered' : 'picked' : program >= 32 && program <= 39 ? 'fingered' : 'picked';
}
function pitchCurve(note: RawNote, destination: RawNote, events: PlanMidiEvent[]) {
  const relevant = events.filter(e => e.channel === note.channel && (e.type === 'bend' || e.type === 'noteBend' && e.key === note.key) && e.tick <= note.end);
  let channel = 0, individual = 0;
  const values = new Map<number, number>();
  for (const event of relevant) {
    if (event.type === 'bend') channel = event.value;
    else if (event.type === 'noteBend') individual = event.value;
    if (event.tick >= note.start) values.set(Math.min(destination.end, destination.start + event.tick - note.start), channel + individual);
  }
  // Compute the initial value separately so a later point cannot overwrite it.
  channel = 0; individual = 0;
  for (const event of relevant) { if (event.tick > note.start) break; if (event.type === 'bend') channel = event.value; else if (event.type === 'noteBend') individual = event.value; }
  values.set(destination.start, channel + individual);
  return [...values].filter(([tick]) => tick >= destination.start && tick <= destination.end).sort(([a], [b]) => a - b).map(([tick, semitones]) => ({ tick, semitones }));
}

/** `interpretations` is by track identity; a track missing from it, or any track when it is absent, plays as written. */
function buildWithIdentities(original: model.Score, generation: number, ids: string[], corrected?: (track: number, attack: number, length: number) => void, interpretations?: Record<string, TrackInterpretation>): PlaybackPlan {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid playback generation.');
  if (original.masterBars.some(bar=>!validMeter(bar.timeSignatureNumerator,bar.timeSignatureDenominator))) throw new Error('Invalid score meter.');
  const score = prepareGpMidiScore(prepareMidiScore(original),settings);
  if (ids.length !== score.tracks.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid playback track identities.');
  const complete = generate(score), all = sources(score), nativeChannel = channelMapping(score, complete.events);
  // An over-full last bar plays past its end: its beats' slices bound performed beats
  // and, with the (dead-brush corrected) note ends, the plan's duration.
  const sliceExtent = Math.max(0, ...complete.lookup.masterBars.map(bar => {
    let end = bar.end; for (let slice = bar.firstBeat; slice; slice = slice.nextBeat) end = Math.max(end, bar.start + slice.end); return end + complete.events.shift;
  }));
  const performedBeats=buildPerformedBeats(score,complete.lookup,complete.events.shift,sliceExtent);
  resolvePrograms(score, complete.events);
  const tempos = [...new Map(complete.events.tempos.map(t => [t.tick, t])).values()].sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: score.tempo });
  const counts = new Map<number, number>();
  const occurrences: MeasureOccurrence[] = complete.lookup.masterBars.map(m => {
    const bar = m.masterBar.index, occurrence = counts.get(bar) ?? 0; counts.set(bar, occurrence + 1);
    const startTick = m.start + complete.events.shift, endTick = m.end + complete.events.shift;
    const step = 960 * 4 / m.masterBar.timeSignatureDenominator, clickTicks: number[] = [];
    if (!Number.isFinite(step) || step <= 0) throw new Error('Invalid score meter.');
    for (let pulse = 0; startTick + pulse * step < endTick; pulse++) clickTicks.push(startTick + pulse * step);
    return { bar, occurrence, meterNumerator:m.masterBar.timeSignatureNumerator, meterDenominator:m.masterBar.timeSignatureDenominator, startTick, endTick, startMs: timeAt(startTick, tempos), endMs: timeAt(endTick, tempos), clickTicks };
  });
  const lanes = new Map<string, Source[]>();
  for (const source of all) { const lane = lanes.get(source.lane) ?? []; lane.push(source); lanes.set(source.lane, lane); }
  const json = model.JsonConverter.scoreToJson(score);
  const serialized = JSON.parse(json) as {tracks:{staves:unknown[]}[]};
  const fullTracks = new Set<number>();
  for (const source of all) {
    const note = source.note;
    for (const linked of [note.tieOrigin,note.tieDestination,note.slurOrigin,note.slurDestination,note.slideOrigin,note.slideTarget,note.hammerPullOrigin,note.hammerPullDestination,note.bendOrigin,note.letRingDestination,note.palmMuteDestination]) {
      if (!linked) continue;
      const other = linked.beat.voice.bar.staff.track.index;
      if (other !== source.track) { fullTracks.add(source.track);fullTracks.add(other); }
    }
  }
  // Pickup duration is the maximum across all tracks, including silent staves.
  const fullTiming = score.masterBars.some(bar=>bar.isAnacrusis);
  const trackJson = new Map<number,string>();
  const jsonForTrack = (track:number):string => {
    if (fullTiming || fullTracks.has(track)) return json;
    let value = trackJson.get(track);
    if (!value) {
      // Keep global timing and every target staff/voice through finish. Empty
      // track slots preserve the original indices before lane isolation.
      value = JSON.stringify({...serialized,tracks:serialized.tracks.map((source,index)=>index===track?source:{...source,staves:[]})});
      trackJson.set(track,value);
    }
    return value;
  };
  const laneData = new Map<string, { events: Collector; gaps: number[]; bends: PlanMidiEvent[]; markers: Map<string, number>; attacks: Map<string, RawNote[]> }>();
  const audible: AudibleAttack[] = [];
  for (const [id, lane] of lanes) {
    const isolated = laneScore(jsonForTrack(lane[0].track), lane), generated = generate(isolated.score);
    generated.events.notes = generated.events.notes.filter(n => n.rawKey < 500);
    generated.events.events = generated.events.events.filter(e => e.type !== 'noteBend' || e.key! < 500);
    const attacks = new Map<string, RawNote[]>();
    for (const note of generated.events.notes) { const group = attacks.get(note.provenance!) ?? []; group.push(note); attacks.set(note.provenance!, group); }
    // The public generator sizes a pickup bar from the staves present, so a lane
    // holding only a shorter pickup track starts every later bar earlier than the
    // complete score does. Map the lane's clock onto the complete score's, bar by
    // bar, for its attacks and for the bends that continue across the gap.
    const laneBars = generated.lookup.masterBars, completeBars = complete.lookup.masterBars;
    if (laneBars.length !== completeBars.length) throw new Error('Public MIDI bars disagree between the complete score and a source-note lane.');
    const gaps = completeBars.map((bar, index) => bar.start - laneBars[index].start), laneShift = generated.events.shift;
    // A note keeps its own clock from where it starts, so a bend runs on from the bar
    // it began in; the bends of a note that begins after the gap move with its bar.
    // A tick on a bar boundary opens the later bar.
    const gapAt = (tick: number) => { let low = 0, high = laneBars.length - 1; while (low < high) { const middle = (low + high + 1) >> 1; if (laneBars[middle].start + laneShift <= tick) low = middle; else high = middle - 1; } return gaps[low]; };
    const bends = converted(generated.events.events, ids, nativeChannel).filter(event => event.type === 'bend' || event.type === 'noteBend')
      .map(event => ({ ...event, tick: event.tick + gapAt(generated.events.starts.get(event.order) ?? event.tick) })).sort((a, b) => a.tick - b.tick);
    laneData.set(id, { events: generated.events, gaps, markers: isolated.markers, attacks, bends });
  }
  const notes: PlanNote[] = [], played = new Map<model.Note, PlanNote[]>(), interpreted: Attack[] = [];
  const byNote = new Map(all.map(source => [source.note, source]));
  let fullIndex = 0;
  // How far a pickup bar is right-aligned: the heard bar's meter less its written length in the longest part of any track or staff.
  const pickups = new Map<number, number>();
  const pickupShift = (bar: number) => {
    let shift = pickups.get(bar);
    if (shift === undefined) {
      const heard = score.masterBars[bar];
      shift = heard.isAnacrusis ? Math.max(0, heard.timeSignatureNumerator * 3840 / heard.timeSignatureDenominator - Math.max(0, ...score.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars[bar]?.voices ?? [])).filter(voice => !voice.isEmpty).map(voice => { const last = voice.beats.at(-1); return last ? last.displayStart + last.displayDuration : 0; }))) : 0;
      pickups.set(bar, shift);
    }
    return shift;
  };
  for (const [occurrenceIndex, occurrence] of occurrences.entries()) {
    const occurrenceSources = score.tracks.flatMap(t => t.staves.flatMap(staff => {
      const bar = staff.bars[occurrence.bar];
      return bar ? playbackBar(bar).voices.flatMap(v => v.beats.flatMap(b => (b.deadSlapped ? b.notes.slice(0, 1) : b.notes).map(n => byNote.get(n)!))) : [];
    }));
    for (const source of occurrenceSources) {
      const lane = laneData.get(source.lane)!;
      const marker = lane.markers.get(`${source.bar}/${source.beat}`);
      const barGap = lane.gaps[occurrenceIndex];
      const logicalTick = occurrence.startTick + source.note.beat.playbackStart - complete.events.shift + lane.events.shift - barGap;
      const generated = lane.attacks.get(`${marker}/${logicalTick}`) ?? [];
      // Within one lane there is one source note per beat, including any trill,
      // tremolo or rasgueado attacks. The full handler uses score source order.
      for (const [attack, isolated] of generated.entries()) {
        const actual = complete.events.notes[fullIndex++];
        // A grace beat in a different track/voice shifts the complete clock;
        // a filtered lane has its own public initial-grace shift.
        const shiftDifference = complete.events.shift - lane.events.shift + barGap;
        const mismatch = !actual ? 'missing attack' : actual.track !== source.track ? 'track' : actual.key !== isolated.key ? 'key' : actual.velocity !== isolated.velocity ? 'velocity' : source.note.beat.brushType === model.BrushType.None && !source.note.beat.hasRasgueado && Math.abs(actual.start - isolated.start - shiftDifference) > 0.001 ? 'timing' : null;
        if (mismatch) throw new Error(`Public MIDI timing disagrees with the source-note playback lanes (${mismatch}; track ${source.track}, staff ${source.staff}, bar ${source.bar}, voice ${source.voice}, beat ${source.beat}).`);
        if (actual.end <= actual.start && source.note.isDead) {
          // alphaTab subtracts brush offset from its short static dead duration.
          // Recover that public duration with the same transient beat unbrushed;
          // keep the original delayed attack and avoid an off-before-on voice.
          const plain = laneScore(jsonForTrack(source.track), lanes.get(source.lane)!);
          plain.score.tracks[0].staves[0].bars[source.bar].voices[0].beats[source.beat].brushType = model.BrushType.None;
          const baseline = generate(plain.score).events.notes.filter(n => n.rawKey < 500 && n.provenance === `${marker}/${logicalTick}`)[attack];
          if (!baseline || baseline.end <= baseline.start) throw new Error('Invalid public dead-note duration.');
          actual.end = actual.start + baseline.end - baseline.start;
          corrected?.(actual.track, actual.trackAttack, actual.end - actual.start);
        }
        let origin = source.note.hammerPullOrigin ?? (source.note.slideOrigin?.slideOutType === model.SlideOutType.Legato ? source.note.slideOrigin : null) ?? source.note.slurOrigin;
        while (origin?.tieOrigin) origin = origin.tieOrigin;
        const from = origin && !source.note.beat.deadSlapped ? [...(played.get(origin) ?? [])].reverse().find(n => n.startTick < actual.start && n.source.target.track === source.track && n.source.target.staff === source.staff && n.source.target.voice === source.voice && n.source.string === Math.max(0, source.note.string)) : undefined;
        const string = source.note.beat.deadSlapped ? score.tracks[source.track].staves[source.staff].tuning.length - attack : Math.max(0, source.note.string);
        const profile = interpretations?.[ids[source.track]], styled = profile && source.note.isStringed;
        const note: PlanNote = {
          id: `${ids[source.track]}/${source.staff}/${source.bar}/${source.voice}/${source.beat}/${source.index}/${occurrence.bar}/${occurrence.occurrence}/${attack}`,
          trackId: ids[source.track], source: { target: { track: source.track, staff: source.staff, bar: source.bar, voice: source.voice, beat: source.beat }, string },
          ...(source.bar !== occurrence.bar ? { playedBar: occurrence.bar } : {}),
          occurrence: occurrence.occurrence, startTick: actual.start, endTick: actual.end, key: actual.key, velocity: actual.velocity,
          channel: nativeChannel(source.track, actual.channel), program: actual.program ?? score.tracks[source.track].playbackInfo.program,
          articulation: source.note.beat.deadSlapped ? 'dead' : articulation(source.note, actual.program ?? score.tracks[source.track].playbackInfo.program, !!from, styled && !source.note.beat.slap && !source.note.beat.pop ? profile.style : undefined), legatoFrom: from?.id ?? null, pitch: pitchCurve({ ...isolated, channel: nativeChannel(source.track, isolated.channel), start: isolated.start + barGap, end: isolated.end + barGap }, actual, lane.bends),
        };
        if (styled) {
          const beat = source.note.beat, masterBar = beat.voice.bar.masterBar;
          // Strong beats are counted from the written start; a pickup bar is right-aligned by its written length, ending where a full bar does.
          const pickup = profile.accent ? pickupShift(occurrence.bar) : 0;
          interpreted.push({ note, raw: actual, staff: source.staff, offset: beat.displayStart + pickup, accentable: attack === 0 && beat.graceType === model.GraceType.None, meter: [masterBar.timeSignatureNumerator, masterBar.timeSignatureDenominator], occurrenceEnd: occurrence.endTick, beat: `${source.staff}/${source.voice}/${source.bar}/${source.beat}`,
            brushable: generated.length === 1 && beat.brushType === model.BrushType.None && !beat.hasRasgueado && !beat.deadSlapped && beat.pickStroke === model.PickStroke.None && note.pitch.every(point => point.semitones === note.pitch[0].semitones) });
        }
        notes.push(note); const chain = played.get(source.note) ?? []; chain.push(note); played.set(source.note, chain);
        collectAudible(audible, source.note, note, actual);
      }
    }
  }
  if (fullIndex !== complete.events.notes.length) throw new Error('The score has MIDI attacks without an unambiguous source-note lane.');
  if (interpreted.length) interpretAttacks(interpreted, interpretations!);
  const events: OrderedMidiEvent[] = converted(complete.events.events, ids, nativeChannel);
  for(const event of gpControllerEvents(score,occurrences))events.push({type:'controller',trackId:ids[event.track],tick:event.tick,channel:nativeChannel(event.track,event.channel),controller:event.controller,value:event.value,order:Number.MAX_SAFE_INTEGER});
  if (audible.length) applyNoteAudio(audible, notes, Math.max(sliceExtent, complete.events.end, ...complete.events.notes.map(n => n.end)));
  for (const note of complete.events.notes) {
    const common = { trackId: ids[note.track], channel: nativeChannel(note.track, note.channel), key: note.key, velocity: note.velocity };
    events.push({ ...common, type: 'noteOn', tick: note.start, order: note.onOrder }, { ...common, type: 'noteOff', tick: note.end, order: note.offOrder });
  }
  const durationTick = Math.max(sliceExtent, complete.events.end, ...complete.events.notes.map(n => n.end), 0);
  const plan: PlaybackPlan = { generation, ppq: 960, durationTick, durationMs: timeAt(durationTick, tempos), tracks: score.tracks.map(t => ({ id: ids[t.index], program: t.playbackInfo.program, percussion: t.isPercussion })), tempos, occurrences, performedBeats, notes: notes.sort((a, b) => a.startTick - b.startTick), midi: events.sort((a, b) => a.tick - b.tick || a.order - b.order).map(({ order, ...event }) => event as PlanMidiEvent) };
  validatePlaybackPlan(plan); return plan;
}

export function buildPlaybackPlan(score: model.Score, generation: number): PlaybackPlan {
  return buildWithIdentities(score, generation, score.tracks.map(trackIdentity));
}

// What a score's per-note audio settings do to each attack, for a MIDI export that generates its own attacks.
export function noteAudioMidiAdjustments(score: model.Score): AudioAdjustment[] {
  return hasNoteAudio(score) ? collectNoteAudio(() => buildWithIdentities(score, 0, score.tracks.map(trackIdentity))).adjustments : [];
}

// Export adapters use zero-based public addNote ordinals per track, preserving
// identity even when same-pitch attacks overlap or occur out of tick order.
export function deadBrushMidiDurations(score: model.Score): { track: number; attack: number; length: number }[] {
  const corrections: { track: number; attack: number; length: number }[] = [];
  buildWithIdentities(score, 0, score.tracks.map(trackIdentity), (track, attack, length) => corrections.push({ track, attack, length }));
  return corrections;
}

export function buildPlaybackPlanFromJson(json: ReturnType<typeof model.JsonConverter.scoreToJson>, identities: string[], generation: number, interpretations?: Record<string, TrackInterpretation>): PlaybackPlan {
  return buildWithIdentities(scoreFromJson(json, settings), generation, identities, undefined, interpretations);
}

export function validatePlaybackPlan(plan: PlaybackPlan) {
  const validTime = (n: number) => Number.isFinite(n) && n >= 0;
  const integer = (n: number, maximum: number) => Number.isSafeInteger(n) && n >= 0 && n <= maximum;
  const fail = (reason = 'structure') => { throw new Error(`Invalid native playback plan (${reason}).`); };
  if (!integer(plan.generation, Number.MAX_SAFE_INTEGER) || plan.ppq !== 960 || !validTime(plan.durationTick) || !validTime(plan.durationMs) || !plan.tracks.length) fail();
  const tracks = new Set(plan.tracks.map(t => t.id)), ids = new Map<string, PlanNote>();
  if (tracks.size !== plan.tracks.length || plan.tracks.some(t => !t.id || !integer(t.program, 127) || typeof t.percussion !== 'boolean')) fail();
  let previous = -1;
  if (!plan.tempos.length || plan.tempos[0].tick !== 0) fail();
  for (const tempo of plan.tempos) { if (!validTime(tempo.tick) || tempo.tick <= previous || tempo.tick > plan.durationTick || !Number.isFinite(tempo.bpm) || tempo.bpm <= 0 || !Number.isFinite(60 / (tempo.bpm * 960))) fail(); previous = tempo.tick; }
  const occurrences = new Set<string>(), counts = new Map<number, number>(); previous = 0;
  for (const o of plan.occurrences) {
    if (!validMeter(o.meterNumerator,o.meterDenominator)) fail('meter');
    if (!integer(o.bar, 0xffffffff) || !integer(o.occurrence, 0xffffffff) || o.occurrence !== (counts.get(o.bar) ?? 0) || !validTime(o.startTick) || o.startTick < previous || !validTime(o.endTick) || o.endTick <= o.startTick || o.endTick > plan.durationTick || !validTime(o.startMs) || !validTime(o.endMs) || o.endMs <= o.startMs || o.endMs > plan.durationMs + .001) fail();
    counts.set(o.bar, o.occurrence + 1); occurrences.add(`${o.bar}/${o.occurrence}`); previous = o.endTick;
    if (o.clickTicks !== undefined && (!o.clickTicks.length || o.clickTicks[0] !== o.startTick || o.clickTicks.some((tick, i) => !validTime(tick) || tick < o.startTick || tick >= o.endTick || i > 0 && tick <= o.clickTicks![i - 1]))) fail('metronome ticks');
  }
  if(Object.hasOwn(plan,'playbackEndTick')&&(!Number.isFinite(plan.playbackEndTick)||plan.playbackEndTick!<=0||plan.playbackEndTick!>plan.durationTick||plan.playbackEndTick!==plan.occurrences.at(-1)?.endTick))fail('active end');
  if (Object.hasOwn(plan,'performedBeats')) {
    const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
    if (!Array.isArray(plan.performedBeats)) fail('performed beats');
    const mapped=new Set<string>();
    for (const row of plan.performedBeats!) {
      if (!exact(row,['target','occurrence','startTick','endTick','leadInTick'])||!exact(row.target,['track','staff','bar','voice','beat'])) fail('performed beats');
      const target=row.target;
      if (Object.values(target).some(value=>!integer(value,0xffffffff))||target.track>=plan.tracks.length||!integer(row.occurrence,0xffffffff)||!occurrences.has(`${target.bar}/${row.occurrence}`)||!validTime(row.leadInTick)||!validTime(row.startTick)||!validTime(row.endTick)||row.leadInTick>row.startTick||row.startTick>row.endTick||row.endTick>plan.durationTick) fail('performed beats');
      const key=`${target.track}/${target.staff}/${target.bar}/${target.voice}/${target.beat}/${row.occurrence}`;
      if(mapped.has(key))fail('performed beats');mapped.add(key);
    }
  }
  previous = -1;
  for (const n of plan.notes) {
    if (n.channel !== undefined && !integer(n.channel, 15) || n.program !== undefined && !integer(n.program, 127)) fail('note channel/program');
    if (n.endTick <= n.startTick) fail(n.endTick === n.startTick ? 'zero note duration' : 'negative note duration');
    if (!integer(n.key, 127) || !integer(n.velocity, 127)) fail('note value');
    if (!n.id || ids.has(n.id) || !tracks.has(n.trackId) || plan.tracks[n.source.target.track]?.id !== n.trackId || Object.values(n.source.target).some(v => !integer(v, 0xffffffff)) || !integer(n.source.string, 0xffffffff) || n.playedBar !== undefined && (!integer(n.playedBar, 0xffffffff) || n.playedBar < n.source.target.bar) || !occurrences.has(`${n.playedBar ?? n.source.target.bar}/${n.occurrence}`) || !validTime(n.startTick) || n.startTick < previous || !validTime(n.endTick) || n.endTick > plan.durationTick || !n.pitch.length || n.pitch[0].tick !== n.startTick) fail('note structure');
    if (n.legatoFrom) { const from = ids.get(n.legatoFrom); if (!from || from.startTick >= n.startTick || from.trackId !== n.trackId || from.source.target.staff !== n.source.target.staff || from.source.target.voice !== n.source.target.voice || from.source.string !== n.source.string) fail('legato'); }
    let pitchPrevious = -1;
    for (const p of n.pitch) { if (!validTime(p.tick) || p.tick < n.startTick || p.tick > n.endTick || p.tick <= pitchPrevious || !Number.isFinite(p.semitones)) fail('pitch'); pitchPrevious = p.tick; }
    ids.set(n.id, n); previous = n.startTick;
  }
  previous = -1;
  for (const event of plan.midi) {
    if (!validTime(event.tick)) fail(`MIDI ${event.type} time`);
    if (event.tick > plan.durationTick) fail(`MIDI ${event.type} after duration`);
    if (!integer(event.channel, 15)) fail('MIDI channel');
    if (!tracks.has(event.trackId) || event.tick < previous) fail('MIDI structure');
    if ((event.type === 'noteOn' || event.type === 'noteOff') && (!integer(event.key, 127) || !integer(event.velocity, 127))) fail();
    if (event.type === 'program' && !integer(event.program, 127)) fail();
    if (event.type === 'controller' && (!integer(event.controller, 127) || !integer(event.value, 127))) fail();
    if ((event.type === 'bend' || event.type === 'noteBend') && !Number.isFinite(event.value)) fail();
    if (event.type === 'noteBend' && !integer(event.key, 127)) fail();
    previous = event.tick;
  }
  const duration = timeAt(plan.durationTick, plan.tempos);
  if (!Number.isFinite(duration) || Math.abs(duration - plan.durationMs) > .01 || plan.occurrences.some(o => Math.abs(timeAt(o.startTick, plan.tempos) - o.startMs) > .01 || Math.abs(timeAt(o.endTick, plan.tempos) - o.endMs) > .01)) fail();
}

// Worker inputs contain only transient public model data and stable track IDs.
// Audio asset payloads remain outside this boundary.
export async function preparePlan(project: ProjectView, generation: number, interpretations?: Record<string, TrackInterpretation>): Promise<PlaybackPlan> {
  return preparePlanFromScore(buildScore(project),generation,interpretations);
}

export async function preparePlanFromScore(score:model.Score,generation:number,interpretations?:Record<string,TrackInterpretation>):Promise<PlaybackPlan> {
  if (typeof Worker === 'undefined') return buildWithIdentities(score, generation, score.tracks.map(trackIdentity), undefined, interpretations);
  const worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<PlaybackPlan>((resolve, reject) => {
      worker.onmessage = event => { const reply = event.data as { cmd?: string; plan?: PlaybackPlan; error?: string }; if (reply.cmd !== 'tabplayer.plan.result') return; if (reply.plan?.generation === generation) resolve(reply.plan); else reject(new Error(reply.error ?? 'Playback plan generation changed.')); };
      worker.onerror = event => reject(new Error(event.message || 'Playback preparation failed.'));
      worker.postMessage({ cmd: 'tabplayer.plan.prepare', json: model.JsonConverter.scoreToJson(score), identities: score.tracks.map(trackIdentity), generation, ...interpretations ? { interpretations } : {} });
    });
  } finally { worker.terminate(); }
}
