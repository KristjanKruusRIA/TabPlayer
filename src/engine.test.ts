import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildScore, previewEdit, exportGp, validateProject } from './engine';

const base = () => ({
  format: 'TabPlayer' as const, schemaVersion: 1 as const, engineVersion: '1.8.4' as const,
  base: { kind: 'blank' as const, title: 'Test', artist: '', tempo: 120, tuning: [64,59,55,50,45,40], measureCount: 4 },
  edits: [],
});
const target = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
const beat = (score: ReturnType<typeof buildScore>) => score.tracks[0].staves[0].bars[0].voices[0].beats[0];

describe('score editing', () => {
  it('rejects retuning that would push existing frets outside MIDI range',()=>{
    const note=previewEdit(base(),{type:'setNote',target,string:6,fret:7});
    expect(()=>previewEdit(note.project,{type:'setTuning',track:0,tuning:[127,59,55,50,45,40]})).toThrow(/pitch range/i);
  });
  it('turns a fret into its sounding MIDI pitch and adds chords', () => {
    const first = previewEdit(base(), { type: 'setNote', target, string: 6, fret: 7 });
    expect(beat(first.score).notes[0].realValue).toBe(71);
    const chord = previewEdit(first.project, { type: 'setNote', target, string: 5, fret: 5 });
    expect(beat(chord.score).notes.map(n => n.realValue).sort()).toEqual([64,71]);
    const rest = previewEdit(chord.project, { type: 'setRest', target });
    expect(beat(rest.score).isRest).toBe(true);
    expect(base().edits).toEqual([]);
  });
  it('validates measure capacity using dotted durations', () => {
    const short = previewEdit(base(), { type: 'setDuration', target, duration: 8, dots: 1 });
    expect(beat(short.score).playbackDuration).toBe(720);
    expect(() => previewEdit(base(), { type: 'setDuration', target, duration: 2, dots: 0 })).toThrow(/overfill/i);
  });
  it('rejects invalid pitches and targets without appending a command', () => {
    const project = base();
    expect(() => previewEdit(project, { type: 'setNote', target, string: 1, fret: -1 })).toThrow();
    expect(() => previewEdit(project, { type: 'setNote', target, string: 1, fret: 100 })).toThrow();
    expect(() => previewEdit(project, { type: 'setRest', target: {...target, bar: 99} })).toThrow();
    expect(project.edits).toHaveLength(0);
  });
  it('keeps every track aligned during measure edits', () => {
    const added = previewEdit(base(), { type: 'addTrack', name: 'Bass', tuning: [43,38,33,28], program: 33 });
    const longer = previewEdit(added.project, { type: 'appendMeasure' });
    expect(longer.score.masterBars).toHaveLength(5);
    expect(longer.score.tracks.map(t => t.staves[0].bars.length)).toEqual([5,5]);
    const shorter = previewEdit(longer.project, { type: 'removeMeasure', bar: 0 });
    expect(shorter.score.tracks.map(t => t.staves[0].bars.length)).toEqual([4,4]);
  });
  it('supports beat deletion to empty, insertion, retuning, and protected last track', () => {
    let project = base() as Parameters<typeof buildScore>[0];
    for (let i=0; i<4; i++) project = previewEdit(project, {type:'deleteBeat', target}).project;
    const inserted = previewEdit(project, { type:'insertBeat', target, duration:4, dots:0 });
    expect(beat(inserted.score).isRest).toBe(true);
    const note = previewEdit(inserted.project, { type:'setNote', target, string:1, fret:0 });
    const tuned = previewEdit(note.project, {type:'setTuning', track:0, tuning:[64,59,55,50,45,38]});
    expect(beat(tuned.score).notes[0].realValue).toBe(38);
    expect(() => previewEdit(base(), {type:'removeTrack', track:0})).toThrow();
  });
  it('exports supported music and imports the exported score without altering its source', () => {
    const changed = previewEdit(base(), {type:'setNote', target, string:6, fret:7});
    const bytes = exportGp(changed.score);
    const encoded = Buffer.from(bytes).toString('base64');
    const imported = {...base(), base: {kind:'file' as const,filename:'score.gp',bytesBase64:encoded,sha256:createHash('sha256').update(bytes).digest('hex')}};
    const score = buildScore(imported);
    expect(beat(score).notes[0].realValue).toBe(71);
    expect(imported.base.bytesBase64).toBe(encoded);
  });
  it('rejects incompatible native documents and malformed replay commands', () => {
    expect(() => validateProject({...base(),engineVersion:'future'})).toThrow(/version|requires/i);
    expect(() => buildScore({...base(),edits:[{type:'unknown'}]} as never)).toThrow();
  });
});
