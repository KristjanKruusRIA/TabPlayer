import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan, buildPlaybackPlanFromJson, noteAudioMidiAdjustments, validatePlaybackPlan } from './plan';
import { getNoteAudio, setNoteAudio, type NoteAudio } from '../editor/note-audio';
import { scoreFromJson } from '../model-clone';
import { exportMidi } from '../export/midi';
import { readMidiFile } from '../interchange/midi-smf';
import { buildScore } from '../engine';
import { blankProject, type EditCommand } from '../project';
import { previewEdit } from '../engine';

const settings = new Settings();
const plain: NoteAudio = { length: 100, offset: 0, velocity: 0 };
const audio = (patch: Partial<NoteAudio>): NoteAudio => ({ ...plain, ...patch });

function authored(bars = 2, beatsPerBar = 4, duration = model.Duration.Quarter) {
  const score = new model.Score();
  for (let b = 0; b < bars; b++) score.addMasterBar(new model.MasterBar());
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  const track = new model.Track(); track.playbackInfo.program = 25; track.playbackInfo.primaryChannel = 0; track.playbackInfo.secondaryChannel = 1;
  const staff = new model.Staff(); staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff); score.addTrack(track);
  for (let b = 0; b < bars; b++) {
    const bar = new model.Bar(); staff.addBar(bar);
    const voice = new model.Voice(); bar.addVoice(voice);
    for (let i = 0; i < beatsPerBar; i++) { const beat = new model.Beat(); beat.duration = duration; beat.isEmpty = false; voice.addBeat(beat); }
  }
  return score;
}
function note(score: model.Score, bar: number, beat: number, string = 1, fret = 3) {
  const n = new model.Note(); n.string = string; n.fret = fret;
  score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].addNote(n); return n;
}
const built = (score: model.Score) => { score.finish(settings); return score; };
const planOf = (score: model.Score) => buildPlaybackPlan(score, 1);
const attacks = (plan: ReturnType<typeof planOf>) => plan.notes.map(n => ({ start: n.startTick, end: n.endTick, velocity: n.velocity, key: n.key }));

describe('a note without audio settings', () => {
  it('plans byte-identically, and the JSON of a score without settings gains no field', () => {
    const score = built(authored()); note(score, 0, 0); note(score, 0, 1, 2, 5); note(score, 1, 2);
    const before = JSON.stringify(planOf(score)), json = model.JsonConverter.scoreToJson(score);
    expect(json).not.toContain('tabplayernoteaudio');
    setNoteAudio(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0], plain);
    expect(JSON.stringify(planOf(score))).toBe(before);
    expect(model.JsonConverter.scoreToJson(score)).toBe(json);
  });
  it('stores the plain values as no setting at all', () => {
    const score = built(authored()), n = note(score, 0, 0);
    setNoteAudio(n, audio({ offset: 5 })); expect(getNoteAudio(n)).toEqual(audio({ offset: 5 }));
    setNoteAudio(n, plain); expect(getNoteAudio(n)).toBeNull();
  });
});

describe('the playback plan', () => {
  it('moves, stretches and re-levels only the note that has settings, leaving the written position alone', () => {
    const score = built(authored()), a = note(score, 0, 0), b = note(score, 0, 1), c = note(score, 0, 2);
    const base = attacks(planOf(score));
    setNoteAudio(b, audio({ length: 50, offset: 100, velocity: 10 }));
    const plan = planOf(score), changed = attacks(plan);
    expect(changed[0]).toEqual(base[0]); expect(changed[2]).toEqual(base[2]);
    expect(changed[1]).toEqual({ start: base[1].start + 100, end: base[1].start + 100 + Math.round((base[1].end - base[1].start) / 2), velocity: base[1].velocity + 10, key: base[1].key });
    expect(plan.notes[1].source.target.beat).toBe(1);
    validatePlaybackPlan(plan); void a; void c;
  });
  it('keeps the noteOn and noteOff events and the pitch curve in step with the note', () => {
    const score = built(authored()), b = note(score, 0, 1);
    setNoteAudio(b, audio({ length: 200, offset: -50, velocity: -8 }));
    const plan = planOf(score), n = plan.notes[0];
    const on = plan.midi.find(e => e.type === 'noteOn')!, off = plan.midi.find(e => e.type === 'noteOff')!;
    expect(on.tick).toBe(n.startTick); expect(off.tick).toBe(n.endTick);
    expect((on as { velocity: number }).velocity).toBe(n.velocity);
    expect(n.pitch[0].tick).toBe(n.startTick); expect(n.pitch.every(p => p.tick >= n.startTick && p.tick <= n.endTick)).toBe(true);
  });
  it('never lets a velocity change leave 1 to 127', () => {
    const score = built(authored()), a = note(score, 0, 0), b = note(score, 0, 1);
    setNoteAudio(a, audio({ velocity: 64 })); setNoteAudio(b, audio({ velocity: -64 }));
    const velocities = planOf(score).notes.map(n => n.velocity);
    expect(velocities.every(v => v >= 1 && v <= 127)).toBe(true);
    expect(velocities[0]).toBeGreaterThan(velocities[1]);
  });
  it('holds an early offset at the start of the score and a long note inside the plan', () => {
    const score = built(authored()), a = note(score, 0, 0), z = note(score, 1, 3);
    const base = planOf(score);
    setNoteAudio(a, audio({ offset: -480 })); setNoteAudio(z, audio({ length: 400, offset: 480 }));
    const plan = planOf(score);
    expect(plan.notes[0].startTick).toBe(0);
    for (const n of plan.notes) expect(n.endTick).toBeGreaterThan(n.startTick);
    expect(plan.durationTick).toBeLessThanOrEqual(base.durationTick + 481);
    validatePlaybackPlan(plan);
  });
  it('never shortens a note to nothing, however small the length', () => {
    const score = built(authored(1, 4, model.Duration.ThirtySecond)), a = note(score, 0, 0);
    setNoteAudio(a, audio({ length: 10 }));
    const n = planOf(score).notes[0]; expect(n.endTick - n.startTick).toBeGreaterThanOrEqual(1);
  });
  it('keeps notes in order when neighbours move toward each other', () => {
    const score = built(authored(1, 4, model.Duration.Quarter)), a = note(score, 0, 0), b = note(score, 0, 1), c = note(score, 0, 2), d = note(score, 0, 3);
    setNoteAudio(a, audio({ offset: 480 })); setNoteAudio(b, audio({ offset: -480 })); setNoteAudio(c, audio({ offset: 480 })); setNoteAudio(d, audio({ offset: -480 }));
    const plan = planOf(score), starts = plan.notes.map(n => n.startTick);
    expect(plan.notes.map(n => n.source.target.beat)).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    validatePlaybackPlan(plan);
  });
  it('keeps a short note after a long one when the short one moves early', () => {
    const score = built(authored(1, 0)), voice = score.tracks[0].staves[0].bars[0].voices[0];
    const sixteenth = new model.Beat(); sixteenth.duration = model.Duration.Sixteenth; sixteenth.isEmpty = false; voice.addBeat(sixteenth);
    const half = new model.Beat(); half.duration = model.Duration.Half; half.isEmpty = false; voice.addBeat(half);
    const first = new model.Note(); first.string = 1; first.fret = 3; sixteenth.addNote(first);
    const second = new model.Note(); second.string = 1; second.fret = 5; half.addNote(second);
    built(score); setNoteAudio(first, audio({ offset: 480 })); setNoteAudio(second, audio({ offset: -480 }));
    const plan = planOf(score);
    expect(plan.notes[0].source.target.beat).toBe(0); expect(plan.notes[1].startTick).toBeGreaterThan(plan.notes[0].startTick);
    validatePlaybackPlan(plan);
  });
  it('keeps a tie as one sustained note, scaled whole', () => {
    const score = built(authored()), a = note(score, 0, 0), b = note(score, 0, 1);
    a.tieDestination = b; b.tieOrigin = a; b.isTieDestination = true; built(score);
    const base = planOf(score); expect(base.notes).toHaveLength(1);
    setNoteAudio(a, audio({ length: 50, offset: 40 }));
    const plan = planOf(score); expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].endTick - plan.notes[0].startTick).toBe(Math.round((base.notes[0].endTick - base.notes[0].startTick) / 2));
    expect(plan.notes[0].startTick).toBe(base.notes[0].startTick + 40);
  });
  it('ignores settings on a tie destination, which makes no attack', () => {
    const score = built(authored()), a = note(score, 0, 0), b = note(score, 0, 1);
    a.tieDestination = b; b.tieOrigin = a; b.isTieDestination = true; built(score);
    const base = JSON.stringify(planOf(score)); setNoteAudio(b, audio({ length: 50, offset: 40, velocity: 9 }));
    expect(JSON.stringify(planOf(score))).toBe(base);
  });
  it('keeps let ring ringing, scaled', () => {
    const score = built(authored()), a = note(score, 0, 0); a.isLetRing = true; built(score);
    const base = planOf(score).notes[0]; setNoteAudio(a, audio({ length: 150 }));
    const n = planOf(score).notes[0]; expect(n.endTick - n.startTick).toBe(Math.round((base.endTick - base.startTick) * 1.5));
  });
  it('moves every attack of a tremolo or a trill together and keeps their spacing', () => {
    const tremolo = built(authored(1, 2)), t = note(tremolo, 0, 0);
    tremolo.tracks[0].staves[0].bars[0].voices[0].beats[0].tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 2 }); built(tremolo);
    const base = planOf(tremolo); expect(base.notes.length).toBeGreaterThan(1);
    setNoteAudio(t, audio({ offset: 30 }));
    const moved = planOf(tremolo); expect(moved.notes).toHaveLength(base.notes.length);
    moved.notes.forEach((n, i) => { expect(n.startTick).toBe(base.notes[i].startTick + 30); expect(n.endTick - n.startTick).toBe(base.notes[i].endTick - base.notes[i].startTick); });
    const trill = built(authored(1, 2)), r = note(trill, 0, 1); r.trillValue = r.realValue + 2; r.trillSpeed = model.Duration.Sixteenth; built(trill);
    const trillBase = planOf(trill); expect(trillBase.notes.length).toBeGreaterThan(1);
    setNoteAudio(r, audio({ offset: -20, velocity: 5 }));
    const trillMoved = planOf(trill); expect(trillMoved.notes).toHaveLength(trillBase.notes.length);
    trillMoved.notes.forEach((n, i) => { expect(n.startTick).toBe(trillBase.notes[i].startTick - 20); expect(n.velocity).toBe(trillBase.notes[i].velocity + 5); });
    validatePlaybackPlan(trillMoved);
  });
  it('plays a grace note and its main note with their own settings', () => {
    const score = built(authored(1, 2)), voice = score.tracks[0].staves[0].bars[0].voices[0];
    const grace = new model.Beat(); grace.duration = model.Duration.Eighth; grace.graceType = model.GraceType.BeforeBeat; grace.isEmpty = false;
    const g = new model.Note(); g.string = 1; g.fret = 0; grace.addNote(g); voice.addBeat(grace);
    voice.beats.splice(0, 0, voice.beats.pop()!);
    const main = note(score, 0, 1); built(score);
    const base = planOf(score); setNoteAudio(g, audio({ velocity: -20 })); setNoteAudio(main, audio({ offset: 20 }));
    const plan = planOf(score); expect(plan.notes).toHaveLength(base.notes.length);
    validatePlaybackPlan(plan);
    expect(plan.notes.some((n, i) => n.velocity !== base.notes[i].velocity)).toBe(true);
  });
  it('keeps the start and length of a bent note and changes only its velocity', () => {
    const score = built(authored()), a = note(score, 0, 0); a.bendType = model.BendType.Bend; a.bendStyle = model.BendStyle.Default;
    a.addBendPoint(new model.BendPoint(0, 0)); a.addBendPoint(new model.BendPoint(60, 4)); built(score);
    const base = planOf(score).notes[0]; setNoteAudio(a, audio({ length: 50, offset: 100, velocity: 7 }));
    const n = planOf(score).notes[0]; expect(n.startTick).toBe(base.startTick); expect(n.endTick).toBe(base.endTick); expect(n.velocity).toBe(base.velocity + 7);
  });
  it('survives the JSON the plan worker and the audio export use', () => {
    const score = built(authored()), b = note(score, 0, 1); setNoteAudio(b, audio({ length: 75, offset: 12, velocity: 3 }));
    const json = model.JsonConverter.scoreToJson(score);
    expect(JSON.parse(json).tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].tabplayernoteaudio).toEqual({ length: 75, offset: 12, velocity: 3 });
    expect(JSON.stringify(buildPlaybackPlanFromJson(json, ['t'], 1))).toBe(JSON.stringify(buildPlaybackPlanFromJson(json, ['t'], 1)));
    const direct = buildPlaybackPlan(score, 1), viaJson = buildPlaybackPlanFromJson(json, score.tracks.map((_, i) => `t${i}`), 1);
    expect(attacks(viaJson)).toEqual(attacks(direct));
    expect(getNoteAudio(scoreFromJson(json, settings).tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0])).toEqual(audio({ length: 75, offset: 12, velocity: 3 }));
  });
});

describe('MIDI export', () => {
  const edit = (patch: object, beat = 1): EditCommand => ({ type: 'setNoteTechniquesByIndex', target: { track: 0, staff: 0, bar: 0, voice: 0, beat }, noteIndex: 0, patch } as EditCommand);
  it('writes the same start, length and velocity the plan plays, decoded independently', () => {
    let project = blankProject();
    for (const beat of [0, 1, 2]) project = previewEdit(project, { type: 'setNote', target: { track: 0, staff: 0, bar: 0, voice: 0, beat }, string: 1, fret: 3 + beat }).project;
    const plain = readMidiFile(exportMidi(buildScore(project), { tracks: [0], range: null } as never)).parts[0].notes;
    project = previewEdit(project, edit({ audio: { length: 50, offset: 60, velocity: 9 } })).project;
    const score = buildScore(project), changed = readMidiFile(exportMidi(score, { tracks: [0], range: null } as never)).parts[0].notes;
    const plan = planOf(score);
    expect(changed).toHaveLength(plain.length);
    expect(changed[0]).toEqual(plain[0]); expect(changed[2]).toEqual(plain[2]);
    expect(changed[1].start).toBe(plain[1].start + 60);
    expect(changed[1].end - changed[1].start).toBe(Math.round((plain[1].end - plain[1].start) / 2));
    expect(changed[1].velocity).toBe(plain[1].velocity + 9);
    const second = plan.notes.find(n => n.source.target.beat === 1)!;
    expect([changed[1].start, changed[1].end, changed[1].velocity]).toEqual([second.startTick, second.endTick, second.velocity]);
  });
  describe('a late note at the end of the plan', () => {
    const cases: [string, number, model.Duration, number, number, number][] = [
      ['eight eighths with the last offset +480 (it keeps half its length before the end)', 8, model.Duration.Eighth, 480, 3600, 3840],
      ['four quarters with the last offset +480', 4, model.Duration.Quarter, 480, 3360, 3840],
      ['a whole note offset +240', 1, model.Duration.Whole, 240, 240, 3840],
    ];
    for (const [name, count, duration, offset, start, end] of cases) {
      it(`keeps ${name} inside the plan, and the MIDI file agrees to the tick`, () => {
        const score = built(authored(1, count, duration)), notes = Array.from({ length: count }, (_, i) => note(score, 0, i));
        const base = planOf(score);
        setNoteAudio(notes[count - 1], audio({ offset }));
        const plan = planOf(score), last = plan.notes[count - 1];
        expect([last.startTick, last.endTick]).toEqual([start, end]);
        expect(plan.durationTick).toBe(base.durationTick);
        validatePlaybackPlan(plan);
        const midi = readMidiFile(exportMidi(score, { tracks: [0], range: null } as never)).parts[0].notes;
        expect(midi).toHaveLength(count);
        expect([midi[count - 1].start, midi[count - 1].end]).toEqual([last.startTick, last.endTick]);
      });
    }
    it('exports a note written in a range even when its offset carries it past the range end', () => {
      const score = built(authored(2, 8, model.Duration.Eighth)), notes = Array.from({ length: 8 }, (_, i) => note(score, 0, i));
      setNoteAudio(notes[7], audio({ offset: 480 }));
      const plan = planOf(score), last = plan.notes[7];
      expect(last.startTick).toBe(3840);
      const first = readMidiFile(exportMidi(score, { tracks: [0], range: { first: 0, last: 0 } } as never)).parts[0].notes;
      expect(first).toHaveLength(8);
      expect([first[7].start, first[7].end]).toEqual([3839, 3840]);
      expect(readMidiFile(exportMidi(score, { tracks: [0], range: null } as never)).parts[0].notes[7].start).toBe(3840);
    });
    it('exports a shifted note at the edge of a range with the start and the clipped end the plan has', () => {
      const score = built(authored(2, 4, model.Duration.Quarter)), notes = [0, 1, 2, 3].map(i => note(score, 0, i)); note(score, 1, 0);
      setNoteAudio(notes[3], audio({ offset: 480, length: 200 }));
      const plan = planOf(score), shifted = plan.notes[3];
      expect(shifted.startTick).toBeGreaterThan(2880); expect(shifted.startTick).toBeLessThan(3840);
      const midi = readMidiFile(exportMidi(score, { tracks: [0], range: { first: 0, last: 0 } } as never)).parts[0].notes;
      expect(midi).toHaveLength(4);
      expect([midi[3].start, midi[3].end]).toEqual([shifted.startTick, Math.min(shifted.endTick, 3840)]);
      const second = readMidiFile(exportMidi(score, { tracks: [0], range: { first: 1, last: 1 } } as never)).parts[0].notes;
      // A note belongs to the range it is written in, so its spill is not heard again in the next range.
      expect(second.map(n => [n.start, n.end])).toEqual([[0, 960]]);
    });
  });
  it('writes a score without settings exactly as before', () => {
    let project = blankProject();
    project = previewEdit(project, { type: 'setNote', target: { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 }, string: 1, fret: 3 }).project;
    expect(noteAudioMidiAdjustments(buildScore(project))).toEqual([]);
  });
});
