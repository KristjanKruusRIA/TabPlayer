import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildScore, previewEdit } from './engine';
import { blankProject, type Project } from './project';

function fixture(name: string): Project {
  const bytes = readFileSync(new URL(`../.analysis/compatibility/${name}`,import.meta.url));
  return {...blankProject(),base:{kind:'file',filename:name,bytesBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
}

for (const name of ['guitarpro3-notes.gp3','guitarpro4-notes.gp4','guitarpro5-notes.gp5','guitarpro6-notes.gpx','guitarpro7-notes.gp']) {
  it(`imports known frets, tuning, rests and durations from ${name}`, () => {
    const score = buildScore(fixture(name));
    const staff = score.tracks[0].staves[0];
    expect(staff.tuning).toEqual([64,59,55,50,45,40]);
    const beats = staff.bars[0].voices[0].beats;
    for (const [group,duration] of [1,2,4,8,16,32,64].entries()) {
      const notes = beats.slice(group*5,group*5+4);
      expect(notes.map(b => b.notes[0].fret)).toEqual([1,2,3,4]);
      expect(notes.map(b => b.notes[0].string)).toEqual([1,1,1,1]);
      expect(beats.slice(group*5,group*5+5).map(b => b.duration)).toEqual([duration,duration,duration,duration,duration]);
      expect(beats[group*5+4].isRest).toBe(true);
    }
    // The first Guitar Pro 7 file in a worker loads the whole importer and takes about 1 s alone, several times that on a loaded machine.
    // The limit is a hang guard, not a speed requirement.
  }, 30_000);
}

it('keeps GP8 tempo changes within beats and measures', () => {
  const score = buildScore(fixture('guitarpro8-beat-tempo-change.gp'));
  expect(score.masterBars[0].tempoAutomations.map(a => [a.value,a.ratioPosition])).toEqual([[120,0],[60,0.5]]);
  expect(score.masterBars[1].tempoAutomations.map(a => [a.value,a.ratioPosition])).toEqual([[100,0],[120,0.6375]]);
});

it('preserves an imported bend while editing that note fret', () => {
  const project = fixture('guitarpro7-bends.gp');
  const before = buildScore(project).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect(before.bendPoints?.map(p => [p.offset,p.value])).toEqual([[0,0],[60,4]]);
  const changed = previewEdit(project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:before.string,fret:before.fret+1});
  const note = changed.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect(note.fret).toBe(before.fret+1);
  expect(note.bendPoints?.map(p => [p.offset,p.value])).toEqual([[0,0],[60,4]]);
  expect(changed.project.base).toEqual(project.base);
});

it('rejects a corrupt score file', () => {
  expect(() => buildScore({...blankProject(),base:{kind:'file',filename:'bad.gp',bytesBase64:'Y29ycnVwdA==',sha256:'0'.repeat(64)}})).toThrow();
});
