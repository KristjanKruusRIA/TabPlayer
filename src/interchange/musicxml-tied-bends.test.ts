// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { importer,model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { loadInterchangeScore } from './gp';

const settings=new Settings();
type Note={step:string;octave:number;bend?:number;tie?:'start'|'stop'|'continue';duration?:number;vibrato?:boolean};
const tied=(tie:Note['tie'])=>tie==='continue'?'<tied type="stop"/><tied type="start"/>':tie?`<tied type="${tie}"/>`:'';
const ties=(tie:Note['tie'])=>tie==='continue'?'<tie type="stop"/><tie type="start"/>':tie?`<tie type="${tie}"/>`:'';
const note=({step,octave,bend,tie,duration=1,vibrato}:Note)=>`<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration>${ties(tie)}<voice>1</voice><type>quarter</type>${bend!==undefined||tie?`<notations>${bend!==undefined?`<technical><bend><bend-alter>${bend}</bend-alter></bend></technical>`:''}${tied(tie)}${vibrato?'<ornaments><wavy-line type="start"/></ornaments>':''}</notations>`:''}</note>`;
const musicXml=(notes:Note[])=>`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${notes.map(note).join('')}</measure></part></score-partwise>`;
const curves=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes.map(note=>[note.isTieDestination,note.bendType,note.isContinuedBend,note.bendPoints?.map(point=>point.value)??[]])[0]);
const E='E',bendHeld:Note[]=[{step:E,octave:4,bend:2,tie:'start'},{step:E,octave:4,tie:'continue'},{step:E,octave:4,tie:'stop'},{step:'C',octave:4}];

describe('MusicXML bends held over ties',()=>{
  it('reproduces the stock unbent tie destination as the negative control',()=>{
    const score=importer.ScoreLoader.loadScoreFromBytes(strToU8(musicXml(bendHeld)),settings);
    expect(curves(score).slice(1,3).map(curve=>curve[3])).toEqual([[],[]]);
  });

  it('holds the bent pitch over every tied note without its own bend',()=>{
    const bytes=strToU8(musicXml(bendHeld)),copy=bytes.slice(),score=loadInterchangeScore(bytes,settings);
    const hold=[true,model.BendType.Hold,true,[4,4]];
    expect(curves(score).slice(1)).toEqual([hold,hold,[false,model.BendType.None,false,[]]]);
    expect(score.tracks[0].staves[0].bars[0].voices[0].beats[2].notes[0].bendOrigin).toBe(score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0]);
    expect(bytes).toEqual(copy);
  });

  it('leaves a tied note with its own vibrato to the stock playback',()=>{
    const notes:Note[]=[{step:E,octave:4,bend:2,tie:'start'},{step:E,octave:4,tie:'stop',vibrato:true},{step:'C',octave:4},{step:'C',octave:4}];
    const score=loadInterchangeScore(strToU8(musicXml(notes)),settings),stock=importer.ScoreLoader.loadScoreFromBytes(strToU8(musicXml(notes)),settings);
    expect(stock.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].vibrato).not.toBe(model.VibratoType.None);
    expect(curves(score)).toEqual(curves(stock));
  });

  it('leaves ties after an unbent note and tied notes with their own bend alone',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([{step:E,octave:4,tie:'start'},{step:E,octave:4,tie:'stop'},{step:E,octave:4,bend:2,tie:'start'},{step:E,octave:4,bend:-2,tie:'stop'}])),settings);
    const stock=importer.ScoreLoader.loadScoreFromBytes(strToU8(musicXml([{step:E,octave:4,tie:'start'},{step:E,octave:4,tie:'stop'},{step:E,octave:4,bend:2,tie:'start'},{step:E,octave:4,bend:-2,tie:'stop'}])),settings);
    expect(curves(score)).toEqual(curves(stock));
  });
});
