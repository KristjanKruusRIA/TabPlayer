import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { model,Settings } from '@coderline/alphatab';
import { blankProject,type EditCommand } from '../project';
import { buildDocument,exportGp,previewEdit } from '../engine';
import { loadInterchangeScore } from '../interchange/gp';
import { validateParityCommand } from '../parity-commands';
import { findScoreErrors } from './score-errors';
import { crossingBeat,withShortening } from './fit-shorten';
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

/** Bar 1 of an imported project: two quarters, a dotted eighth (2640 ticks), then a half note that crosses the barline with 1200 ticks left. */
function crossing(tweak:(last:model.Beat)=>void=()=>undefined) {
  return overfull(voice=>{
    voice.beats.splice(2);
    const dotted=beat(8);dotted.dots=1;voice.addBeat(dotted);
    const last=beat(2);tweak(last);voice.addBeat(last);
  });
}
const shorten=(patch:Partial<typeof where>={}):EditCommand=>({type:'fitVoice',...where,bar:1,shorten:true,...patch});

it('shortens the beat that crosses the barline into tied pieces of exact written length',()=>{
  const project=crossing(),built=buildDocument(project);
  expect(findScoreErrors(built.score).map(error=>error.kind)).toEqual(['overfull']);
  const result=previewEdit(project,shorten(),built);
  expect(findScoreErrors(result.score)).toEqual([]);
  const voice=result.score.tracks[0].staves[0].bars[1].voices[0];
  expect(voice.beats.map(value=>[value.duration,value.dots,value.notes.length])).toEqual([[4,0,1],[4,0,1],[8,1,1],[4,0,1],[16,0,1]]);
  const [first,second]=[voice.beats[3].notes[0],voice.beats[4].notes[0]];
  expect(first.tieDestination).toBe(second);expect(second.isTieDestination).toBe(true);expect(second.tieDestination).toBeNull();
  expect(result.project.edits).toHaveLength(1);
  expect(JSON.parse(JSON.stringify(result.project)).edits[0]).toEqual(shorten());
  const replayed=buildDocument(JSON.parse(JSON.stringify(result.project))).score.tracks[0].staves[0].bars[1].voices[0];
  expect(replayed.beats.map(value=>[value.duration,value.dots,value.notes.length])).toEqual([[4,0,1],[4,0,1],[8,1,1],[4,0,1],[16,0,1]]);
});

it('replays an edit recorded in the old shape exactly as before: the crossing beat is removed',()=>{
  const project=crossing(),old=fit({bar:1});
  expect(Object.keys(old)).not.toContain('shorten');
  const result=previewEdit(project,old);
  const voice=result.score.tracks[0].staves[0].bars[1].voices[0];
  expect(voice.beats.map(value=>[value.duration,value.dots,value.notes.length])).toEqual([[4,0,1],[4,0,1],[8,1,1],[4,0,0],[16,0,0]]);
  expect(findScoreErrors(result.score)).toEqual([]);
});

it('falls back to removing the beat when it cannot be cut exactly',()=>{
  const project=crossing(last=>{last.notes[0].isDead=true;});
  const result=previewEdit(project,shorten());
  const voice=result.score.tracks[0].staves[0].bars[1].voices[0];
  expect(findScoreErrors(result.score)).toEqual([]);
  expect(voice.beats.map(value=>value.notes.length)).toEqual([1,1,1,0,0]);
});

it('keeps the tuplet and grace rules when asked to shorten',()=>{
  const project=overfull(voice=>{voice.addBeat(beat(8));for(let i=0;i<3;i++)voice.addBeat(beat(8,true));voice.addBeat(beat(8,true));});
  const result=previewEdit(project,shorten());
  const voice=result.score.tracks[0].staves[0].bars[1].voices[0];
  expect(findScoreErrors(result.score)).toEqual([]);
  expect(voice.beats.every(value=>value.tupletNumerator<=1||value.tupletDenominator<=1)).toBe(true);
});

it('knows the shorten flag only as true',()=>{
  expect(()=>validateParityCommand(shorten())).not.toThrow();
  expect(()=>validateParityCommand({...shorten(),shorten:false})).toThrow();
  expect(()=>validateParityCommand({...shorten(),shorten:1})).toThrow();
  expect(()=>validateParityCommand({...shorten(),extra:1})).toThrow();
});

const hint=(project:ReturnType<typeof overfull>)=>{const score=buildDocument(project).score;return {plain:findScoreErrors(score)[0],shown:withShortening(score,findScoreErrors(score))[0]};};
const notesOf=(project:ReturnType<typeof overfull>,edit:EditCommand)=>previewEdit(project,edit).score.tracks[0].staves[0].bars[1].voices[0].beats.map(value=>[value.duration,value.dots,value.notes.length]);

it('the Trim hint says the crossing note is shortened, not removed, by the same decision the edit takes',()=>{
  const {plain,shown}=hint(crossing());
  expect(plain.trim).toEqual({beats:1,notes:1});
  expect(shown.shortened).toBe(1);
  expect(shown.trim).toBeUndefined();
});

it('the Trim hint counts only what the edit removes after the shortened note',()=>{
  const project=overfull(voice=>{
    voice.beats.splice(2);
    const dotted=beat(8);dotted.dots=1;voice.addBeat(dotted);voice.addBeat(beat(2));voice.addBeat(beat(4));
  });
  const {shown}=hint(project);
  expect(shown.shortened).toBe(1);expect(shown.trim).toEqual({beats:1,notes:1});
  // The edit keeps the quarter, dotted eighth and two tied pieces of the half, and drops the trailing quarter.
  expect(notesOf(project,shorten())).toEqual([[4,0,1],[4,0,1],[8,1,1],[4,0,1],[16,0,1]]);
});

const declined:Array<[string,()=>ReturnType<typeof overfull>]>=[
  ['a dead note that Cut cannot split',()=>crossing(last=>{last.notes[0].isDead=true;})],
  ['a grace note earlier in the bar',()=>overfull(voice=>{voice.beats.splice(2);voice.addBeat(beat(16,false,true));const dotted=beat(8);dotted.dots=1;voice.addBeat(dotted);voice.addBeat(beat(2));})],
  ['a tuplet earlier in the bar',()=>overfull(voice=>{voice.beats.splice(2);for(let i=0;i<3;i++)voice.addBeat(beat(8,true));voice.addBeat(beat(2));})],
];
for(const [name,build] of declined)it(`falls back to the old removal, and the hint stays as it was, for ${name}`,()=>{
  const project=build(),{plain,shown}=hint(project);
  expect(plain?.kind).toBe('overfull');
  expect(shown.shortened).toBeUndefined();expect(shown.trim).toEqual(plain.trim);
  expect(notesOf(project,shorten())).toEqual(notesOf(project,fit({bar:1})));
  expect(findScoreErrors(previewEdit(project,shorten()).score)).toEqual([]);
});

it('replays a recorded shorten edit through the Cut rules as it was recorded: a dead note stays removed',()=>{
  const project=crossing(last=>{last.notes[0].isDead=true;}),result=previewEdit(project,shorten());
  const replayed=buildDocument(JSON.parse(JSON.stringify(result.project))).score.tracks[0].staves[0].bars[1].voices[0];
  expect(replayed.beats.map(value=>[value.duration,value.dots,value.notes.length])).toEqual([[4,0,1],[4,0,1],[8,1,1],[4,0,0],[16,0,0]]);
  // A plain note replays as two tied pieces; if Cut's rules change which notes it can split, this pair of results changes and this test names it.
  const plain=buildDocument(JSON.parse(JSON.stringify(previewEdit(crossing(),shorten()).project))).score.tracks[0].staves[0].bars[1].voices[0];
  expect(plain.beats.map(value=>[value.duration,value.dots,value.notes.length])).toEqual([[4,0,1],[4,0,1],[8,1,1],[4,0,1],[16,0,1]]);
});

/** Guitar Pro files turn an empty beat into a rest and drop a display length override, so these two are decided on the score as authored. */
const authoredCases:Array<[string,(first:model.Beat)=>void]>=[
  ['an empty beat',first=>{first.isEmpty=true;first.notes.length=0;}],
  ['a display length override',first=>{first.overrideDisplayDuration=720;}],
];
for(const [name,tweak] of authoredCases)it(`declines shortening for ${name} earlier in the bar and leaves the hint as it was`,()=>{
  const authored=music(),voice=authored.tracks[0].staves[0].bars[1].voices[0];voice.beats.splice(2);
  const dotted=beat(8);dotted.dots=1;voice.addBeat(dotted);voice.addBeat(beat(2));
  tweak(voice.beats[1]);
  const errors=findScoreErrors(authored);
  expect(errors.map(error=>error.kind)).toEqual(['overfull']);
  expect(crossingBeat(voice,3840)).toBe(-1);
  expect(withShortening(authored,errors)).toEqual(errors);
});

it('declines a full-bar rest before the crossing beat',()=>{
  const authored=music(),voice=authored.tracks[0].staves[0].bars[1].voices[0];voice.beats.splice(2);
  Object.defineProperty(voice.beats[0],'isFullBarRest',{get:()=>true});voice.addBeat(beat(2));
  expect(crossingBeat(voice,3840)).toBe(-1);
});
