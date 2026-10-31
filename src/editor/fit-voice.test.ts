import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { model,Settings } from '@coderline/alphatab';
import { blankProject,type EditCommand } from '../project';
import { buildDocument,exportGp,previewEdit } from '../engine';
import { loadInterchangeScore } from '../interchange/gp';
import { validateParityCommand } from '../parity-commands';
import { findScoreErrors } from './score-errors';
import { music } from './fixtures';

const where={track:0,staff:0,bar:0,voice:0};
const fit=(patch:Partial<typeof where>={}):EditCommand=>({type:'fitVoice',...where,...patch});
const beatsOf=(score:model.Score,bar=0)=>score.tracks[0].staves[0].bars[bar].voices[0].beats.map(beat=>[beat.duration,beat.dots,beat.notes.length]);
/** A project whose first measure holds one quarter note of a 4/4 bar. */
const short=():EditCommand[]=>[{type:'deleteBeat',target:{...where,beat:3}},{type:'deleteBeat',target:{...where,beat:2}},{type:'deleteBeat',target:{...where,beat:1}}];

it('fills a short voice with the fewest rests and records one edit',()=>{
  const project={...blankProject(),edits:short()},before=buildDocument(project);
  expect(findScoreErrors(before.score).map(error=>[error.bar,error.kind,error.ticks])).toEqual([[0,'incomplete',2880]]);
  const result=previewEdit(project,fit(),before);
  expect(result.project.edits).toHaveLength(project.edits.length+1);
  expect(findScoreErrors(result.score)).toEqual([]);
  expect(beatsOf(result.score)).toEqual([[4,0,0],[2,1,0]]);
  expect(beatsOf(buildDocument(JSON.parse(JSON.stringify(result.project))).score)).toEqual(beatsOf(result.score));
});

it('keeps the existing notes when it fills',()=>{
  const edits:EditCommand[]=[...short().slice(0,2),{type:'setNote',target:{...where,beat:0},string:1,fret:3}];
  const result=previewEdit({...blankProject(),edits},fit());
  expect(beatsOf(result.score)).toEqual([[4,0,1],[4,0,0],[2,0,0]]);
});

it('splits an odd remainder into rests that sum exactly',()=>{
  const edits:EditCommand[]=[{type:'setDuration',target:{...where,beat:3},duration:16,dots:0},{type:'deleteBeat',target:{...where,beat:2}},{type:'deleteBeat',target:{...where,beat:1}}];
  const result=previewEdit({...blankProject(),edits},fit());
  expect(findScoreErrors(result.score)).toEqual([]);
});

it('refuses a voice that is already complete, so choosing the current state records nothing',()=>{
  expect(()=>previewEdit(blankProject(),fit())).toThrow(/already complete/i);
});

it('refuses a bar that does not exist or a free-time bar',()=>{
  expect(()=>previewEdit(blankProject(),fit({bar:99}))).toThrow();
  expect(()=>previewEdit({...blankProject(),edits:[{...short()[0]}]},fit({voice:5}))).toThrow();
});

it('trims an overfull voice back to the barline and fills what is left',()=>{
  const authored=music(),voice=authored.tracks[0].staves[0].bars[1].voices[0];
  const extra=new model.Beat();extra.duration=model.Duration.Half;const note=new model.Note();note.string=1;note.fret=5;extra.addNote(note);voice.addBeat(extra);
  const bytes=exportGp(authored),imported=loadInterchangeScore(bytes,new Settings());
  expect(findScoreErrors(imported).map(error=>[error.bar,error.kind])).toEqual([[1,'overfull']]);
  const project={...blankProject(),base:{kind:'file' as const,filename:'over.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},edits:[] as EditCommand[]};
  const built=buildDocument(project);
  const result=previewEdit(project,fit({bar:1}),built);
  expect(findScoreErrors(result.score)).toEqual([]);
  expect(beatsOf(result.score,1).slice(0,4)).toEqual(beatsOf(built.score,1).slice(0,4));
});

it('is a known command with exactly its four fields',()=>{
  expect(() =>validateParityCommand(fit())).not.toThrow();
  expect(() =>validateParityCommand({type:'fitVoice',...where,extra:1})).toThrow();
  expect(() =>validateParityCommand({type:'fitVoice',track:0,staff:0,bar:0})).toThrow();
  expect(() =>validateParityCommand(fit({bar:-1}))).toThrow();
});

/** An imported project whose bar 1 holds the beats `build` puts after three quarter notes. */
function overfull(build:(voice:model.Voice)=>void) {
  const authored=music(),voice=authored.tracks[0].staves[0].bars[1].voices[0];
  voice.beats.splice(3);build(voice);
  const bytes=exportGp(authored);
  return {...blankProject(),base:{kind:'file' as const,filename:'over.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},edits:[] as EditCommand[]};
}
const beat=(duration:number,tuplet=false,grace=false)=>{
  const value=new model.Beat();value.duration=duration;value.isEmpty=false;
  if(tuplet){value.tupletNumerator=3;value.tupletDenominator=2;}
  if(grace)value.graceType=model.GraceType.BeforeBeat;
  const note=new model.Note();note.string=1;note.fret=2;value.addNote(note);return value;
};

it('trims a tuplet that crosses the barline whole instead of keeping some of its beats',()=>{
  const project=overfull(voice=>{voice.addBeat(beat(8));for(let i=0;i<3;i++)voice.addBeat(beat(8,true));voice.addBeat(beat(8,true));});
  const built=buildDocument(project),before=beatsOf(built.score,1);
  expect(before.length).toBeGreaterThan(5);
  const result=previewEdit(project,fit({bar:1}),built);
  expect(findScoreErrors(result.score)).toEqual([]);
  const voice=result.score.tracks[0].staves[0].bars[1].voices[0];
  expect(voice.beats.every(value=>value.tupletNumerator<=1||value.tupletDenominator<=1)).toBe(true);
});

it('removes the grace note that belongs to a removed beat',()=>{
  const project=overfull(voice=>{voice.addBeat(beat(16,false,true));voice.addBeat(beat(2));});
  const built=buildDocument(project);
  expect(findScoreErrors(built.score).map(error=>error.kind)).toEqual(['overfull']);
  const result=previewEdit(project,fit({bar:1}),built);
  const voice=result.score.tracks[0].staves[0].bars[1].voices[0];
  expect(findScoreErrors(result.score)).toEqual([]);
  expect(voice.beats.some(value=>value.graceType!==model.GraceType.None)).toBe(false);
});

it('reports what Trim to fit would remove',()=>{
  const built=buildDocument(overfull(voice=>{voice.addBeat(beat(2));}));
  expect(findScoreErrors(built.score)[0].trim).toEqual({beats:1,notes:1});
});

it('will not put rests after a note that is tied into the next measure',()=>{
  const at=(bar:number,beatIndex:number)=>({...where,bar,beat:beatIndex});
  const edits:EditCommand[]=[{type:'appendMeasure'},{type:'setNote',target:at(0,2),string:1,fret:3},{type:'setNote',target:at(1,0),string:1,fret:3},
    {type:'setNoteLink',from:{target:at(0,2),string:1},to:{target:at(1,0),string:1},kind:'tie'},{type:'deleteBeat',target:at(0,3)}];
  expect(()=>previewEdit({...blankProject(),edits},fit())).toThrow(/tied into the next measure/);
});
