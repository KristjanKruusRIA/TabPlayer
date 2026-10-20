// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,zipSync } from 'fflate';
import { buildPlaybackPlan } from '../audio/plan';
import { loadInterchangeScore } from './gp';
import { prepareMusicXmlLoaderBytes } from './musicxml-tempo-offsets';
import { numberTransposedTies } from './musicxml-transposed-ties';

const settings=new Settings();
type Note={step:string;octave:number;alter?:number;tie?:'start'|'stop'|'continue';chord?:boolean;staff?:number;duration?:number};
const note=({step,octave,alter,tie,chord,staff,duration=1}:Note)=>`<note>${chord?'<chord/>':''}<pitch><step>${step}</step>${alter?`<alter>${alter}</alter>`:''}<octave>${octave}</octave></pitch><duration>${duration}</duration>${tie?`<tie type="${tie}"/>`:''}<voice>1</voice><type>quarter</type>${staff?`<staff>${staff}</staff>`:''}${tie?`<notations><tied type="${tie}"/></notations>`:''}</note>`;
// A G-clef guitar written an octave above sounding, with unnumbered ties.
function musicXml(measures:Note[][],{transpose=true,attributes=''}:{transpose?:boolean;attributes?:string}={}){
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">${measures.map((notes,index)=>`<measure number="${index+1}">${index?'':`<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>${attributes}<clef><sign>G</sign><line>2</line></clef>${transpose?'<transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>':''}</attributes>`}${notes.map(note).join('')}</measure>`).join('')}</part></score-partwise>`;
}
const quarter=(step:string,octave:number,tie?:Note['tie']):Note=>({step,octave,tie});
// Bar 1: C, D, E tied into E; bar 2: E–G chord tied into the same chord, then a rest-free fill.
const tied:Note[][]=[[quarter('C',4),quarter('D',4),quarter('E',4,'start'),quarter('E',4,'stop')],[{step:'E',octave:4,tie:'start'},{step:'G',octave:4,tie:'start',chord:true},{step:'E',octave:4,tie:'stop'},{step:'G',octave:4,tie:'stop',chord:true},{...quarter('C',5,'start'),duration:2}],[{...quarter('C',5,'stop'),duration:4}]];
const destinations=(score:model.Score)=>score.tracks[0].staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes.map(note=>[note.realValue,note.isTieDestination]))));
const attacks=(score:model.Score)=>buildPlaybackPlan(score,1).notes.map(note=>[note.startTick,note.key]);

describe('MusicXML ties in transposing parts',()=>{
  it('reproduces the stock loss as the negative control',()=>{
    const score=importer.ScoreLoader.loadScoreFromBytes(strToU8(musicXml(tied)),settings);
    expect(destinations(score).filter(([,destination])=>destination)).toEqual([]);
  });

  it.each(['xml','mxl'] as const)('pairs unnumbered ties under transpose in %s',kind=>{
    const xml=musicXml(tied),bytes=kind==='xml'?strToU8(xml):zipSync({'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>'),'score.xml':strToU8(xml)});
    const copy=bytes.slice(),score=loadInterchangeScore(bytes,settings);
    // Sounding an octave below written: E4 → 52, G4 → 55, C5 → 60.
    expect(destinations(score)).toEqual([[48,false],[50,false],[52,false],[52,true],[52,false],[55,false],[52,true],[55,true],[60,false],[60,true]]);
    expect(attacks(score)).toEqual([[0,48],[960,50],[1920,52],[3840,52],[3840,55],[5760,60]]);
    expect(bytes).toEqual(copy);
  });

  it('pairs ties per staff in a two-staff part',()=>{
    const both=[[...tied[0].map(value=>({...value,staff:1}))]];
    const text=musicXml(both,{attributes:'<staves>2</staves>'}).replace('</measure>',`<backup><duration>4</duration></backup>${tied[0].map(value=>note({...value,staff:2})).join('')}</measure>`);
    const numbered=numberTransposedTies(text)!;
    expect([...new DOMParser().parseFromString(numbered,'application/xml').querySelectorAll('tied')].map(tie=>`${tie.getAttribute('type')}${tie.getAttribute('number')}`)).toEqual(['start1','stop1','start1','stop1']);
  });

  // A TAB guitar: unison E4 on string 1 (open) and string 2 (fret 5), tied into the
  // same chord; most-recent-first pairing would cross the strings.
  const tuning=[['E',2],['A',2],['D',3],['G',3],['B',3],['E',4]].map(([step,octave],index)=>`<staff-tuning line="${index+1}"><tuning-step>${step}</tuning-step><tuning-octave>${octave}</tuning-octave></staff-tuning>`).join('');
  const tab=(string:number,fret:number,tie:string,chord=false,duration=2)=>`<note>${chord?'<chord/>':''}<pitch><step>E</step><octave>5</octave></pitch><duration>${duration}</duration><tie type="${tie}"/><voice>1</voice><type>half</type><notations><tied type="${tie}"/><technical><string>${string}</string><fret>${fret}</fret></technical></notations></note>`;
  const unison=musicXml([[]],{attributes:`<staff-details><staff-lines>6</staff-lines>${tuning}</staff-details>`}).replace('<clef><sign>G</sign><line>2</line></clef>','<clef><sign>TAB</sign><line>5</line></clef>').replace('</measure>',`${tab(1,0,'start')}${tab(2,5,'start',true)}${tab(1,0,'stop')}${tab(2,5,'stop',true)}</measure>`);
  it('pairs unison ties on their own strings',()=>{
    const levels=[...new DOMParser().parseFromString(numberTransposedTies(unison)!,'application/xml').querySelectorAll('note')].map(note=>`${note.querySelector('string')?.textContent}:${note.querySelector('tied')?.getAttribute('type')}${note.querySelector('tied')?.getAttribute('number')}`);
    expect(levels).toEqual(['1:start1','2:start2','1:stop1','2:stop2']);
    const beats=loadInterchangeScore(strToU8(unison),settings).tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats[1].notes.map(note=>[note.string,note.fret,note.realValue,note.isTieDestination]).sort()).toEqual([[5,5,64,true],[6,0,64,true]]);
  });

  it('never ties a note to itself when its start is written before its stop',()=>{
    const chain=musicXml([[quarter('E',4,'start'),quarter('E',4),quarter('E',4,'stop'),quarter('C',4)]]).replace('<tie type="start"/><voice>1</voice><type>quarter</type><notations><tied type="start"/></notations></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>','<tie type="start"/><voice>1</voice><type>quarter</type><notations><tied type="start"/></notations></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><tie type="start"/><tie type="stop"/><voice>1</voice><type>quarter</type><notations><tied type="start"/><tied type="stop"/></notations></note>');
    const score=loadInterchangeScore(strToU8(chain),settings);
    expect(destinations(score)).toEqual([[52,false],[52,true],[52,true],[48,false]]);
    expect(attacks(score)).toEqual([[0,52],[2880,48]]);
  });

  it('leaves an unpaired stop untied instead of guessing its start',()=>{
    // E5–E5 tied, C5, then a stray E4 stop: stock alphaTab ties it to the E5 start.
    const score=loadInterchangeScore(strToU8(musicXml([[quarter('E',5,'start'),quarter('E',5,'stop'),quarter('C',5),quarter('E',4,'stop')]])),settings);
    expect(destinations(score)).toEqual([[64,false],[64,true],[60,false],[52,false]]);
    expect(attacks(score)).toEqual([[0,64],[1920,60],[2880,52]]);
  });

  it('keeps later ties when many starts never close',()=>{
    const unclosed=Array.from({length:17},()=>({step:'D',octave:4,tie:'start' as const,duration:1}));
    const text=musicXml([[quarter('C',4),quarter('C',4),quarter('C',4),quarter('C',4)],...Array.from({length:17},(_,index)=>[unclosed[index],{...quarter('C',4),duration:3}]),[quarter('E',4,'start'),quarter('E',4,'stop'),{...quarter('C',4),duration:2}]]);
    const bars=loadInterchangeScore(strToU8(text),settings).tracks[0].staves[0].bars;
    expect(bars[bars.length-1].voices[0].beats[1].notes[0].isTieDestination).toBe(true);
  });

  it('changes only the tied start tags and keeps every other character',()=>{
    const text=musicXml(tied),numbered=numberTransposedTies(text)!;
    expect(numbered.replace(/(<tied[^>]*?) number="\d+"/g,'$1')).toBe(text);
    expect([...numbered.matchAll(/<tied type="(\w+)" number="(\d+)"\/>/g)].map(match=>match[1]+match[2])).toEqual(['start1','stop1','start1','start2','stop1','stop2','start1','stop1']);
  });

  it('composes with the tempo-offset rewrite',()=>{
    const text=musicXml(tied).replace('<note>','<direction><direction-type><words>Slower</words></direction-type><offset sound="yes">2</offset><sound tempo="60"/></direction><note>');
    const prepared=strFromU8(prepareMusicXmlLoaderBytes(strToU8(text),settings));
    expect(prepared).toContain('<offset sound="yes">1920</offset>');expect(prepared).toContain('<tied type="start" number="1"/>');
  });

  it.each([
    ['no transpose',musicXml(tied,{transpose:false})],
    ['already numbered ties',musicXml(tied).replace('<tied type="start"/>','<tied type="start" number="3"/>')],
    ['a continue tie',musicXml([[quarter('E',4,'start'),quarter('E',4,'continue'),quarter('E',4,'stop'),quarter('C',4)]])],
  ])('leaves the loader input unchanged for %s',(_name,text)=>{
    expect(numberTransposedTies(text)).toBeNull();
    const bytes=strToU8(text);expect(prepareMusicXmlLoaderBytes(bytes,settings)).toBe(bytes);
  });
});
