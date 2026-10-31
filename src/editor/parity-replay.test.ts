import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { blankProject, type EditCommand, type Project } from '../project';
import { buildScore, previewEdit, trackIdentity } from '../engine';
import { buildPlaybackPlan } from '../audio/plan';
import { isNoteCautionary } from './cautionary';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
function apply(edits:EditCommand[]) {
  let project=blankProject();for(const edit of edits)project=previewEdit(project,edit).project;
  return {project,score:buildScore(JSON.parse(JSON.stringify(project)))};
}
it('replays song metadata, directions and indexed spelling with undo and redo',()=>{
  const fields={subTitle:'Subtitle',album:'Album',words:'Words',music:'Music',copyright:'Copyright',tab:'Tab',notices:'Notices',instructions:'Instructions'};
  const {project,score}=apply([
    {type:'setScoreMetadata',fields},{type:'setDirections',bar:3,directions:[model.Direction.JumpDaCapoAlFine]},
    {type:'setNote',target,string:1,fret:2},{type:'setNoteSpelling',target,noteIndex:0,accidentalMode:model.NoteAccidentalMode.ForceFlat},
  ]);
  for(const [key,value]of Object.entries(fields))expect(score[key as keyof model.Score]).toBe(value);
  expect(score.masterBars[3].directions?.has(model.Direction.JumpDaCapoAlFine)).toBe(true);
  const note=(value:model.Score)=>value.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect(note(score).accidentalMode).toBe(model.NoteAccidentalMode.ForceFlat);expect(note(score).realValue).toBe(42);
  expect(note(buildScore({...project,edits:project.edits.slice(0,-1)})).accidentalMode).toBe(model.NoteAccidentalMode.Default);
  expect(note(buildScore(project)).accidentalMode).toBe(model.NoteAccidentalMode.ForceFlat);
});
it('replays new piano and drum tracks, preserves identities and validates non-tab staff transposition',()=>{
  const piano={...target,track:1},drums={...target,track:2};
  const {project,score}=apply([
    {type:'addPitchedTrack',name:'Piano',program:0},{type:'addPercussionTrack',name:'Drums',program:0},
    {type:'addPitchedNote',target:piano,pitch:60},{type:'addPitchedNote',target:piano,pitch:69},
    {type:'addPercussionNote',target:drums,articulation:91},
    {type:'setStaffSettings',track:1,staff:0,settings:{tuning:[],capo:0,transposition:12,displayTransposition:0,clef:4,showTab:false,showNotation:true}},
    {type:'setNoteTechniquesByIndex',target:piano,noteIndex:0,patch:{dynamics:3}},{type:'appendMeasure'},
  ]);
  const pianoNotes=score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes;
  expect(score.tracks[2].staves[0].bars.at(-1)?.clef).toBe(model.Clef.Neutral);
  expect(pianoNotes.map(n=>n.realValue)).toEqual([48,57]);expect(pianoNotes.map(n=>n.dynamics)).toEqual([3,5]);
  expect(trackIdentity(score.tracks[1])).toBe(`added/0/${JSON.stringify(project.edits[0])}`);
  expect(trackIdentity(score.tracks[2])).toBe(`added/1/${JSON.stringify(project.edits[1])}`);
  const plan=buildPlaybackPlan(score,1);
  expect(plan.notes.filter(n=>n.trackId===trackIdentity(score.tracks[1])) .map(n=>n.key)).toEqual([48,57]);
  expect(plan.notes.find(n=>n.trackId===trackIdentity(score.tracks[2]))).toMatchObject({key:38,channel:9});
  const invalid:EditCommand={type:'setStaffSettings',track:1,staff:0,settings:{tuning:[],capo:0,transposition:127,displayTransposition:0,clef:4,showTab:false,showNotation:true}};
  expect(()=>previewEdit(project,invalid)).toThrow(/pitch|range/i);
  const source=JSON.stringify(project);expect(JSON.stringify(project)).toBe(source);
  const deleted=previewEdit(project,{type:'removeTrack',track:0});expect(trackIdentity(deleted.score.tracks[0])).toBe(trackIdentity(score.tracks[1]));
  expect(buildScore({...project,edits:project.edits.slice(0,-1)} as Project).masterBars).toHaveLength(4);
});

it('replays courtesy accidentals with undo and redo while preserving existing logs', () => {
  const { project, score } = apply([
    { type: 'setNote', target, string: 1, fret: 0 },
    { type: 'setNoteCautionary', target, noteIndex: 0, cautionary: true },
  ]);
  const note = (value: model.Score) => value.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect(isNoteCautionary(note(score))).toBe(true);
  expect(note(score).accidentalMode).toBe(model.NoteAccidentalMode.ForceNatural);
  // Undo:
  const undone = buildScore({ ...project, edits: project.edits.slice(0, -1) });
  expect(isNoteCautionary(note(undone))).toBe(false);
  expect(note(undone).accidentalMode).toBe(model.NoteAccidentalMode.Default);
  // Redo:
  const redone = buildScore(project);
  expect(isNoteCautionary(note(redone))).toBe(true);
  expect(note(redone).accidentalMode).toBe(model.NoteAccidentalMode.ForceNatural);
});
