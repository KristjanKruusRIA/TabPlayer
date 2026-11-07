import { expect, it } from 'vitest';
import { buildDocument, forgetPreview, previewEdit, validateProject } from './engine';
import type { EditCommand } from './edit-types';
import { blankProject, projectCommands } from './project';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const steps=[
  {type:'setDuration',target,duration:8,dots:0},
  {type:'setNote',target,string:2,fret:3},
] as const;
const sequence={type:'sequence',commands:structuredClone(steps)} as unknown as EditCommand;
const validate=(edit:unknown)=>validateProject({...blankProject(),edits:[edit as EditCommand]}).edits;
const beatSummary=(edits:EditCommand[])=>{
  const beat=buildDocument({...blankProject(),edits}).score.tracks[0].staves[0].bars[0].voices[0].beats[0];
  return {duration:beat.duration,notes:beat.notes.map(note=>[note.string,note.fret])};
};

it('replays a sequence as the edits it holds, while history keeps one entry',()=>{
  expect(validate(sequence)).toEqual([sequence]);
  expect(beatSummary([sequence])).toEqual(beatSummary(structuredClone(steps) as unknown as EditCommand[]));
  expect(beatSummary([sequence])).toEqual({duration:8,notes:[[2,3]]});
  const preview=previewEdit(blankProject(),sequence);
  expect(preview.project.edits).toHaveLength(1);
  expect(projectCommands(preview.project).map(edit=>edit.type)).toEqual(['setDuration','setNote']);
});

it('refuses a sequence that is too short, too long, nested, or holds other edits',()=>{
  const one={type:'sequence',commands:[steps[0]]};
  const nine={type:'sequence',commands:Array.from({length:9},()=>steps[0])};
  const nested={type:'sequence',commands:[steps[0],sequence]};
  const other={type:'sequence',commands:[steps[0],{type:'appendMeasure'}]};
  for(const edit of [one,nine,nested,other,{type:'sequence',commands:{}},{type:'sequence'},{...sequence,extra:true}])expect(()=>validate(edit)).toThrow();
  // A bad step is refused with the whole sequence.
  expect(()=>validate({type:'sequence',commands:[steps[0],{...steps[1],target:{...target,beat:-1}}]})).toThrow();
  expect(()=>validate({type:'sequence',commands:[steps[0],{...steps[1],unknown:1}]})).toThrow();
});

it('fails the whole sequence when a step cannot apply, so nothing half-written is kept',()=>{
  const bad={type:'sequence',commands:[steps[0],{type:'setNote',target:{...target,beat:40},string:2,fret:3}]} as unknown as EditCommand;
  expect(()=>previewEdit(blankProject(),bad)).toThrow();
});

it('reuses a planned build once for the same edit on the same project, and never hands one score to two callers', () => {
  const project = blankProject(), command: EditCommand = { type: 'setNote', target: { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 }, string: 1, fret: 3 };
  const planned = previewEdit(project, command), recorded = previewEdit(project, command), again = previewEdit(project, command);
  expect(recorded.score).toBe(planned.score);
  expect(again.score).not.toBe(recorded.score);
  expect(previewEdit({ ...project }, command).score).not.toBe(again.score);
  previewEdit(project, command); forgetPreview();
  expect(previewEdit(project, command).score).not.toBe(again.score);
  expect(previewEdit(project, { ...command, fret: 4 }).score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(4);
});
