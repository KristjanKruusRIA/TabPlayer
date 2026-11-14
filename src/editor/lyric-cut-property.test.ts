import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { buildDocument } from '../engine';
import { blankProject,type EditCommand,type Project } from '../project';
import { rhythmTicks } from './common';
import { getLyricsSource } from './lyrics-source';
import { tokenizeLyrics } from './lyrics';

const at=(beat:number,bar:number)=>({track:0,staff:0,bar,voice:0,beat});
const range=(start:[number,number],end:[number,number])=>({kind:'range' as const,range:{start:{bar:start[0],tick:start[1]},end:{bar:end[0],tick:end[1]},lanes:[{track:0,staff:0,voice:0}]}});
const cutLog=(start:[number,number],end:[number,number]):EditCommand=>({type:'cutSelection',selection:range(start,end)});
/** How a bar of quarters becomes a layout: the beats it keeps, and which of them are lengthened. */
const layouts:{drop:number[];lengthen:number[];durations:number[]}[]=[
  {drop:[3,2,1],lengthen:[0],durations:[1]},
  {drop:[3,2],lengthen:[0,1],durations:[2,2]},
  {drop:[1],lengthen:[0],durations:[2]},
  {drop:[],lengthen:[],durations:[]},
  {drop:[2],lengthen:[2],durations:[2]},
  {drop:[2],lengthen:[1],durations:[2]},
];
function project(choice:number[],text:string|{startBar:number;text:string}[]):Project {
  const edits:EditCommand[]=[];
  choice.forEach((layout,bar)=>{
    const shape=layouts[layout],kept=4-shape.drop.length;
    for(const beat of shape.drop)edits.push({type:'deleteBeat',target:at(beat,bar)});
    shape.lengthen.forEach((beat,index)=>edits.push({type:'setDuration',target:at(beat,bar),duration:shape.durations[index],dots:0}));
    for(let beat=0;beat<kept;beat++)edits.push({type:'setNote',target:at(beat,bar),string:3,fret:beat+bar});
  });
  edits.push({type:'setTrackLyrics',track:0,visible:true,lines:typeof text==='string'?[{startBar:0,text}]:text});
  return {...blankProject(),edits};
}
interface Piece {text:string;bar:number;start:number;end:number}
/** Every note-bearing beat of the first voice with its syllable and its place. */
function pieces(score:model.Score,bars:number,line=0):Piece[] {
  return score.tracks[0].staves[0].bars.slice(0,bars).flatMap((bar,index)=>{let tick=0;return bar.voices[0].beats.flatMap(beat=>{const start=tick;tick+=rhythmTicks(beat);return beat.notes.length?[{text:beat.lyrics?.[line]??'',bar:index,start,end:tick}]:[];});});
}
const textOf=(score:model.Score)=>getLyricsSource(score.tracks[0])!.value.lines[0].text;

it('a head of two pieces, a wholly cut note and a tail of three pieces: the rule puts each syllable on its note, token by token',()=>{
  const base=project([0,0,0,0],'t0 t1 t2 t3');
  const before=buildDocument(base).score;expect(before.masterBars.length).toBeGreaterThan(3);
  const after=buildDocument({...base,edits:[...base.edits,cutLog([0,840],[2,1080])]}).score,found=pieces(after,4);
  // Note 0 (bar 1): 840 is two pieces. Note 1 (bar 2): wholly cut. Note 2 (bar 3): 2760 left, three pieces. Note 3 (bar 4): untouched.
  expect(found.filter(piece=>piece.bar===0).map(piece=>piece.text)).toEqual(['t0','']);
  expect(found.filter(piece=>piece.bar===1)).toEqual([]);
  expect(found.filter(piece=>piece.bar===2).map(piece=>piece.text)).toEqual(['t2','','']);
  expect(found.filter(piece=>piece.bar===3)).toEqual(pieces(before,4).filter(piece=>piece.bar===3));
  expect(found.map(piece=>piece.text)).toEqual(['t0','','t2','','','t3']);
  // The wholly cut note's syllable is dropped from the text, so no later syllable moves; a plain erase would have moved them.
  expect(tokenizeLyrics(textOf(after))).toEqual(['t0','','t2','','','t3']);
});
it('a wholly cut note takes its syllable out of the line, and the notes after it keep theirs',()=>{
  const base=project([0,0,0],'one two three'),after=buildDocument({...base,edits:[...base.edits,cutLog([0,0],[1,0])]}).score;
  expect(pieces(after,3).map(piece=>[piece.text,piece.bar])).toEqual([['two',1],['three',2]]);
  expect(tokenizeLyrics(textOf(after))).toEqual(['two','three']);
});

let seed=20261114;const random=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const trimBlanks=(items:string[])=>{const copy=[...items];while(copy.length&&copy.at(-1)==='')copy.pop();return copy;};
it('after any cut every surviving note carries its syllable on its attack piece or first surviving piece, every other piece is blank, later notes do not move, on two lines with different start bars',()=>{
  let checked=0,refused=0;const started=Date.now();
  for(let round=0;round<110;round++){
    const choice=[0,1,2].map(()=>Math.floor(random()*layouts.length));
    const notes=pieces(buildDocument(project(choice,'x')).score,3),hyphen=random()<0.3?'-':' ';
    // Line 0 starts in the first bar and has a word for every note; line 1 starts in the second bar and has a word for every note from there on.
    const second=notes.filter(note=>note.bar>=1).length;
    const lines=[{startBar:0,text:notes.map((_,index)=>`s${index}`).join(hyphen)},{startBar:1,text:Array.from({length:second},(_,index)=>`u${index}`).join(' ')}];
    const base=project(choice,lines),expected=lines.map(line=>tokenizeLyrics(line.text));
    const first=Math.floor(random()*(3*32-1)),last=first+1+Math.floor(random()*(3*32-first-1));
    const startAt:[number,number]=[Math.floor(first/32),(first%32)*120],endAt:[number,number]=[Math.floor(last/32),(last%32)*120];
    let after:model.Score;
    try{after=buildDocument({...base,edits:[...base.edits,cutLog(startAt,endAt)]}).score;}catch{refused++;continue;}
    checked++;
    const regionEnd=endAt[0]*3840+endAt[1],context=JSON.stringify([choice,lines,startAt,endAt]);
    lines.forEach((line,lineIndex)=>{
      const mine=notes.map((note,index)=>({note,index})).filter(item=>item.note.bar>=line.startBar);
      const survivors:string[]=[];
      mine.forEach(({note},position)=>{
        const found=pieces(after,3,lineIndex).filter(piece=>piece.bar===note.bar&&piece.start>=note.start&&piece.start<note.end);
        if(!found.length)return;
        survivors.push(expected[lineIndex][position]);
        expect(found[0].text,context+lineIndex+position).toBe(expected[lineIndex][position]);
        expect(found.slice(1).map(piece=>piece.text),context+lineIndex+position).toEqual(found.slice(1).map(()=>''));
        if(note.bar*3840+note.start>=regionEnd){expect(found).toHaveLength(1);expect(found[0].start).toBe(note.start);}
      });
      // The line holds exactly the surviving notes' words in order, with a blank for every extra piece, and nothing else.
      const sung=pieces(after,3,lineIndex).filter(piece=>piece.bar>=line.startBar).map(piece=>piece.text);
      expect(sung.filter(Boolean),context+lineIndex).toEqual(survivors);
      expect(trimBlanks(tokenizeLyrics(getLyricsSource(after.tracks[0])!.value.lines[lineIndex].text)),context+lineIndex).toEqual(trimBlanks(sung));
    });
  }
  expect(checked).toBeGreaterThan(40);expect(refused).toBeLessThan(70);expect(Date.now()-started).toBeLessThan(20000);
});
