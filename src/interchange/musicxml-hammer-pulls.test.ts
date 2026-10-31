// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { loadInterchangeScore } from './gp';
import { applyMusicXmlHammerPulls } from './musicxml-hammer-pulls';

const settings=new Settings();
type Note={fret:number;technical?:string;voice?:number;duration?:number;extra?:string};
const tuning=[['E',2],['A',2],['D',3],['G',3],['B',3],['E',4]].map(([step,octave],index)=>`<staff-tuning line="${index+1}"><tuning-step>${step}</tuning-step><tuning-octave>${octave}</tuning-octave></staff-tuning>`).join('');
// Notes on the A string (MusicXML string 5); the pitch element does not matter to the mapping.
const note=({fret,technical='',voice=1,duration=1,extra=''}:Note)=>`<note>${extra}<pitch><step>A</step><octave>2</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${duration===2?'half':'quarter'}</type><notations><technical>${technical}<string>5</string><fret>${fret}</fret></technical></notations></note>`;
const measure=(content:string,first=false)=>`<measure number="1">${first?`<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>${tuning}</staff-details></attributes>`:''}${content}</measure>`;
const musicXml=(...measures:string[])=>`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">${measures.map((content,index)=>measure(content,index===0)).join('')}</part></score-partwise>`;
const start='<hammer-on type="start">H</hammer-on>',stop='<hammer-on type="stop">H</hammer-on>';
const flags=(score:model.Score)=>score.tracks[0].staves[0].bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>beat.notes.map(note=>note.isHammerPullOrigin))));

describe('MusicXML hammer-ons and pull-offs',()=>{
  it('restores the origins alphaTab clears, with their destinations',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0,technical:start}),note({fret:2,technical:stop+'<pull-off type="start">P</pull-off>'}),note({fret:0,technical:'<pull-off type="stop">P</pull-off>'}),note({fret:3})].join(''))),settings);
    expect(flags(score)).toEqual([[[[true],[true],[false],[false]]]]);
    const beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats[0].notes[0].hammerPullDestination).toBe(beats[1].notes[0]);
    expect(beats[1].notes[0].hammerPullDestination).toBe(beats[2].notes[0]);
    expect(beats[2].notes[0].hammerPullOrigin).toBe(beats[1].notes[0]);
  });

  it('reaches a destination in the next measure',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0}),note({fret:0}),note({fret:0}),note({fret:5,technical:'<pull-off type="start">P</pull-off>'})].join(''),note({fret:0,duration:2,technical:'<pull-off type="stop">P</pull-off>'})+note({fret:3,duration:2}))),settings);
    expect(flags(score)).toEqual([[[[false],[false],[false],[true]]],[[[false],[false]]]]);
  });

  it('does not treat a lone stop as an origin',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0}),note({fret:2,technical:stop}),note({fret:0}),note({fret:3})].join(''))),settings);
    expect(flags(score)).toEqual([[[[false],[false],[false],[false]]]]);
  });

  it('skips cue notes, which alphaTab does not import',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0,extra:'<cue/>',technical:start}),note({fret:0,technical:start}),note({fret:2,technical:stop}),note({fret:0}),note({fret:3})].join(''))),settings);
    expect(flags(score)).toEqual([[[[true],[false],[false],[false]]]]);
  });

  it('keeps the same string and fret in another voice apart',()=>{
    const xml=musicXml(note({fret:0,duration:2,technical:start})+note({fret:2,duration:2,technical:stop})+'<backup><duration>4</duration></backup>'+note({fret:0,duration:2,voice:2})+note({fret:2,duration:2,voice:2}));
    const score=loadInterchangeScore(strToU8(xml),settings);
    expect(flags(score)).toEqual([[[[true],[false]],[[false],[false]]]]);
  });

  it('leaves the score untouched when the loaded notes differ from the source',()=>{
    const xml=musicXml([note({fret:0,technical:start}),note({fret:2}),note({fret:0}),note({fret:3})].join(''));
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0}),note({fret:2}),note({fret:0}),note({fret:3})].join(''))),settings);
    // A score whose notes do not match this source (one note moved to another fret).
    score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=1;
    expect(applyMusicXmlHammerPulls(score,strToU8(xml),settings)).toBe(score);
    expect(flags(score).flat(3).some(Boolean)).toBe(false);
  });

  it('leaves the stock import when the linked note does not stop the hammer-on',()=>{
    // The stop sits on another string, so alphaTab would link the later A-string note.
    const other=(fret:number,technical='')=>note({fret}).replace('<string>5</string>','<string>4</string>').replace('<technical>',`<technical>${technical}`);
    const score=loadInterchangeScore(strToU8(musicXml(note({fret:0,technical:start})+other(2,stop)+other(0)+note({fret:3}))),settings);
    expect(flags(score).flat(3).some(Boolean)).toBe(false);
  });

  it('leaves the stock import when alphaTab would link a span other than the one the source pairs',()=>{
    // Spans cross strings: A→B and C→D, then D→E. alphaTab links A to D, whose stop belongs to C.
    const other=(fret:number,technical='')=>note({fret}).replace('<string>5</string>','<string>4</string>').replace('<technical>',`<technical>${technical}`);
    const xml=musicXml(note({fret:0,technical:start})+other(2,stop)+other(0,start)+note({fret:2,technical:stop+start}),other(2,stop)+note({fret:3})+note({fret:3})+note({fret:3}));
    const score=loadInterchangeScore(strToU8(xml),settings);
    expect(flags(score).flat(3).some(Boolean)).toBe(false);
  });

  it('pairs numbered spans',()=>{
    const numbered=(type:string,number:number)=>`<hammer-on type="${type}" number="${number}">H</hammer-on>`;
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0,technical:numbered('start',3)}),note({fret:2,technical:numbered('stop',3)}),note({fret:0}),note({fret:3})].join(''))),settings);
    expect(flags(score)).toEqual([[[[true],[false],[false],[false]]]]);
  });

  it('keeps the other hammer-ons when one would link elsewhere',()=>{
    const other=(fret:number,technical='')=>note({fret}).replace('<string>5</string>','<string>4</string>').replace('<technical>',`<technical>${technical}`);
    const xml=musicXml(note({fret:0,technical:start})+other(2,stop)+other(0)+note({fret:3}),note({fret:0,technical:start})+note({fret:2,technical:stop})+note({fret:0})+note({fret:3}));
    const score=loadInterchangeScore(strToU8(xml),settings);
    expect(flags(score)).toEqual([[[[false],[false],[false],[false]]],[[[true],[false],[false],[false]]]]);
  });

  it('leaves the stock import for a start without any stop',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0,technical:start}),note({fret:2}),note({fret:0}),note({fret:3})].join(''))),settings);
    expect(flags(score).flat(3).some(Boolean)).toBe(false);
  });

  it('maps a chord note into its chord head\'s voice',()=>{
    // Voice 2 comes first; its chord note is tagged voice 1 but alphaTab adds it to voice 2.
    const chord=(fret:number,string:number,extra='')=>note({fret,voice:1,duration:2,extra}).replace('<string>5</string>',`<string>${string}</string>`);
    const xml=musicXml(note({fret:0,voice:2,duration:2}).replace('<string>5</string>','<string>3</string>')+chord(0,5,'<chord/>')+note({fret:9,voice:2,duration:2})
      +'<backup><duration>4</duration></backup>'+note({fret:0,duration:2,technical:start})+note({fret:2,duration:2,technical:stop}));
    const score=loadInterchangeScore(strToU8(xml),settings),voices=score.tracks[0].staves[0].bars[0].voices;
    expect(voices[0].beats.map(beat=>beat.notes.map(note=>note.isHammerPullOrigin))).toEqual([[true],[false]]);
    expect(voices[1].beats.map(beat=>beat.notes.map(note=>note.isHammerPullOrigin))).toEqual([[false,false],[false]]);
  });

  it('does not fold a notation + TAB part whose voices would relink a hammer-on elsewhere',()=>{
    // Notation voices shift between bars (2, then 1 and 2) while the TAB copy keeps 5 and 6,
    // so the folded origin would reach D3 in voice 2 instead of the B2 the source stops.
    const whole=(step:string,octave:number,voice:number,staff:number,technical='')=>`<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>4</duration><voice>${voice}</voice><type>whole</type><staff>${staff}</staff>${staff===2?`<notations><technical>${technical}<string>5</string><fret>${step==='A'?0:step==='B'?2:5}</fret></technical></notations>`:''}</note>`;
    const back='<backup><duration>4</duration></backup>';
    const attributes=`<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-type>alternate</staff-type><staff-lines>6</staff-lines>${tuning}</staff-details></attributes>`;
    const xml=`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">`
      +`<measure number="1">${attributes}${whole('A',2,2,1)}${back}${whole('A',2,5,2,start)}</measure>`
      +`<measure number="2">${whole('B',2,1,1)}${back}${whole('D',3,2,1)}${back}${whole('B',2,5,2,stop)}${back}${whole('D',3,6,2)}</measure></part></score-partwise>`;
    const score=loadInterchangeScore(strToU8(xml),settings);
    const linked=score.tracks[0].staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))).filter(note=>note.hammerPullOrigin);
    expect(linked.map(note=>note.fret)).toEqual([2]);
  });

  it('ignores sources without hammer-ons or pull-offs',()=>{
    const score=loadInterchangeScore(strToU8(musicXml([note({fret:0}),note({fret:2}),note({fret:0}),note({fret:3})].join(''))),settings);
    expect(applyMusicXmlHammerPulls(score,strToU8(musicXml(note({fret:0}))),settings)).toBe(score);
  });
});
