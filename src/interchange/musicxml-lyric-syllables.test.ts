// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { importer,model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { loadInterchangeScore } from './gp';

const settings=new Settings();
type Lyric={number?:string;syllabic?:string;text:string};
const note=(lyrics:Lyric[]=[],{voice=1,rest=false}:{voice?:number;rest?:boolean}={})=>`<note>${rest?'<rest/>':'<pitch><step>C</step><octave>5</octave></pitch>'}<duration>1</duration><voice>${voice}</voice><type>quarter</type>${lyrics.map(({number='1',syllabic,text})=>`<lyric number="${number}">${syllabic?`<syllabic>${syllabic}</syllabic>`:''}<text>${text}</text></lyric>`).join('')}</note>`;
const attributes='<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
const musicXml=(body:string)=>`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure number="1">${attributes}${body}</measure></part></score-partwise>`;
const sung=note([{syllabic:'begin',text:'Hel'},{number:'2',syllabic:'single',text:'a'}])+note([{syllabic:'middle',text:'lo'}])+note([{syllabic:'end',text:'there'},{number:'2',syllabic:'begin',text:'b'}])+note([{text:'world'},{number:'2',syllabic:'end',text:'c'}]);
const lyrics=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices.flatMap(voice=>voice.beats.map(beat=>beat.lyrics??[]));

describe('MusicXML lyric syllables',()=>{
  it('reproduces the stock loss of hyphens as the negative control',()=>{
    expect(lyrics(importer.ScoreLoader.loadScoreFromBytes(strToU8(musicXml(sung)),settings))).toEqual([['Hel','a'],['lo'],['there','b'],['world','c']]);
  });

  it('marks begin and middle syllables with a trailing hyphen per line',()=>{
    const bytes=strToU8(musicXml(sung)),copy=bytes.slice();
    expect(lyrics(loadInterchangeScore(bytes,settings))).toEqual([['Hel-','a'],['lo-'],['there','b-'],['world','c']]);
    expect(bytes).toEqual(copy);
  });

  it('keeps one hyphen on a syllable whose text ends in one',()=>{
    const xml=musicXml(note([{syllabic:'begin',text:'Hel-'}])+note([{syllabic:'end',text:'lo'}])+note()+note());
    expect(lyrics(loadInterchangeScore(strToU8(xml),settings)).slice(0,2)).toEqual([['Hel-'],['lo']]);
  });

  it('matches each line on its own, with alphaTab trimming the text',()=>{
    const xml=musicXml(note([{syllabic:'begin',text:'Hel'},{number:'2',text:' x '}])+note([{syllabic:'end',text:'lo'},{number:'2',text:'y'}])+note([{number:'2',syllabic:'begin',text:'a'}],{voice:1}).replace('<lyric number="2">','<lyric number="2"><text>z</text></lyric><lyric number="2">')+note());
    // Line 2's repeated lyric on one beat abandons the whole part's mapping: nothing changes.
    expect(lyrics(loadInterchangeScore(strToU8(xml),settings))).toEqual(lyrics(importer.ScoreLoader.loadScoreFromBytes(strToU8(xml),settings)));
    const padded=musicXml(note([{syllabic:'begin',text:' Hel '},{number:'2',text:' x '}])+note([{syllabic:'end',text:'lo'},{number:'2',text:'y'}])+note()+note());
    expect(lyrics(loadInterchangeScore(strToU8(padded),settings)).slice(0,2)).toEqual([['Hel-','x'],['lo','y']]);
  });

  it('maps parts to tracks by their part-list id',()=>{
    const part=(id:string,first:string,second:string)=>`<part id="${id}"><measure number="1">${attributes}${note([{syllabic:first,text:'la'}])+note([{syllabic:second,text:'la'}])+note([{text:'la'}])+note()}</measure></part>`;
    const xml=`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>A</part-name></score-part><score-part id="P2"><part-name>B</part-name></score-part></part-list>${part('P2','single','begin')}${part('P1','begin','end')}</score-partwise>`;
    const score=loadInterchangeScore(strToU8(xml),settings),first=(track:number)=>score.tracks[track].staves[0].bars[0].voices[0].beats.slice(0,3).map(beat=>beat.lyrics?.[0]);
    expect([score.tracks[0].name,first(0),first(1)]).toEqual(['A',['la-','la','la'],['la','la-','la']]);
  });

  it.each([
    ['lyrics in two voices',note([{syllabic:'begin',text:'Hel'}])+note([{syllabic:'end',text:'lo'}])+'<backup><duration>2</duration></backup>'+note([{syllabic:'begin',text:'x'}],{voice:2})+note([{syllabic:'end',text:'y'}],{voice:2})],
    ['two lyrics of one line on a beat',note([{syllabic:'begin',text:'Hel'},{syllabic:'end',text:'lo'}])+note()+note()+note()],
    ['an elision',note([{syllabic:'begin',text:'Hel'}]).replace('<text>Hel</text>','<text>Hel</text><elision/><text>x</text>')+note([{syllabic:'end',text:'lo'}])+note()+note()],
  ])('leaves %s to the stock import',(_name,body)=>{
    const xml=musicXml(body);
    expect(lyrics(loadInterchangeScore(strToU8(xml),settings))).toEqual(lyrics(importer.ScoreLoader.loadScoreFromBytes(strToU8(xml),settings)));
  });
});
