import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { buildDocument } from '../engine';
import { blankProject,type Project } from '../project';
import { exportGp5 } from '../export/gp5';
import { exportMusicXml } from '../export/musicxml';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import { insertLyricGap,tokenizeLyrics } from './lyrics';

/** The first version of the function, kept here only to prove the linear one writes the same text (with a space where the new one uses a space). */
function oldInsertLyricGap(text:string,at:number):string|null {
  const tokens=tokenizeLyrics(text);if(at<0||at>=tokens.length)return text;
  const wanted=JSON.stringify([...tokens.slice(0,at),'',...tokens.slice(at)]);
  for(let place=0;place<=text.length;place++) {
    if(place>0&&!/[ \t\r\n\]-]/.test(text[place-1]))continue;
    const next=text.slice(0,place)+' '+text.slice(place);
    if(JSON.stringify(tokenizeLyrics(next))===wanted)return next;
  }
  return null;
}
/** alphaTab's own reading of a raw lyric line (what Guitar Pro 5 files and other readers do with the text). */
const alphaChunks=(text:string)=>{const lyrics=new model.Lyrics();lyrics.text=text;lyrics.finish();return lyrics.chunks;};
const wantedAt=(text:string,at:number)=>{const tokens=tokenizeLyrics(text);return [...tokens.slice(0,at),'',...tokens.slice(at)];};

let seed=12345;const random=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const line=(alphabet:string[],length:number)=>Array.from({length},()=>alphabet[Math.floor(random()*alphabet.length)]).join('');

it('writes the same text as the first, quadratic version on a few thousand random lines (no hyphens)',()=>{
  const alphabet=['a','b','c','+',' ',' ','\t','\n','\r','[',']','[x]','  '];
  let compared=0,nulls=0;
  for(let round=0;round<4000;round++){
    const text=line(alphabet,Math.floor(random()*14)),at=Math.floor(random()*(tokenizeLyrics(text).length+1));
    const expected=oldInsertLyricGap(text,at);expect(insertLyricGap(text,at),JSON.stringify([text,at])).toBe(expected);compared++;if(expected===null)nulls++;
  }
  expect(compared).toBe(4000);expect(nulls).toBeGreaterThanOrEqual(0);
});
it('with hyphens it writes the same text except directly after a hyphen, where it writes an empty comment and a space',()=>{
  const alphabet=['a','b','-','-',' ','\n','[',']','[x]','+'];
  let compared=0;
  for(let round=0;round<4000;round++){
    const text=line(alphabet,Math.floor(random()*14)),at=Math.floor(random()*(tokenizeLyrics(text).length+1));
    const old=oldInsertLyricGap(text,at),got=insertLyricGap(text,at);
    if(got===null||old===null||got===text)continue;
    compared++;
    expect(tokenizeLyrics(got),JSON.stringify([text,at,got])).toEqual(wantedAt(text,at));
    if(got!==old)expect(got.replace('[] ',' '),JSON.stringify([text,at,got])).toBe(old);
  }
  expect(compared).toBeGreaterThan(1000);
});
it('takes a bounded amount of work on a very long line',()=>{
  // The first version rescanned the whole line for every place it tried: 100,000 characters took minutes. This one scans a few times; the guard is generous.
  const text=Array.from({length:26000},(_,index)=>`wo${index%10}`).join(' ');
  expect(text.length).toBeGreaterThan(100000);
  const started=Date.now(),tokens=tokenizeLyrics(text).length,result=insertLyricGap(text,tokens-3)!;
  expect(Date.now()-started).toBeLessThan(5000);
  expect(tokenizeLyrics(result)).toEqual(wantedAt(text,tokens-3));
  const comments='[a]'.repeat(40000)+' one two';
  expect(insertLyricGap(comments,1)).not.toBeUndefined();
});
it('puts a blank in the form both this editor and alphaTab read as one empty syllable, in every position',()=>{
  const cases:[string,number][]=[['one two three',1],['one two three',0],['one two three',2],['ky-ri-e',1],['ky-ri-e',2],['ky-ri e',2],['a-b-c-d',3],['one-two three',1],['one two\nthree',2],['one [c] two',1],['a+b c',1]];
  for(const [text,at] of cases){
    const gapped=insertLyricGap(text,at)!,wanted=wantedAt(text,at);
    expect(tokenizeLyrics(gapped),`editor: ${JSON.stringify([text,at,gapped])}`).toEqual(wanted);
    if(alphaChunks(text).join('|')===tokenizeLyrics(text).join('|'))expect(alphaChunks(gapped),`alphaTab: ${JSON.stringify([text,at,gapped])}`).toEqual(wanted);
  }
  // After a hyphen alphaTab skips spaces, so the blank there is an empty comment and a space.
  expect(insertLyricGap('ky-ri-e',2)).toBe('ky-ri-[] e');expect(alphaChunks('ky-ri-[] e')).toEqual(['ky-','ri-','','e']);
  expect(alphaChunks('ky-ri- e')).toEqual(['ky-','ri-','e']);
  // At the start and between words a plain space is read the same by both; an empty comment at the start is not (this editor drops leading comments with the space after them).
  expect(insertLyricGap('one two three',0)).toBe(' one two three');expect(insertLyricGap('one two three',1)).toBe('one  two three');
  expect(tokenizeLyrics('[] one')).toEqual(['one']);expect(alphaChunks('[] one')).toEqual(['','one']);
});
it('a blank needed at token 0 behind a leading comment is refused, not guessed',()=>{
  expect(insertLyricGap('[intro] one two',0)).toBeNull();
  expect(insertLyricGap('[intro] one two',1)).toBe('[intro] one  two');
});

// The blank survives every writer and reader: four notes, the blank on the second note, the third and fourth keep their syllables.
const four=():Project=>({...blankProject(),edits:[0,1,2,3].map(beat=>({type:'setNote' as const,target:{track:0,staff:0,bar:0,voice:0,beat},string:3,fret:beat+1}))});
const sung=(text:string)=>buildDocument({...four(),edits:[...four().edits,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text}]}]}).score;
const perBeat=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats.filter(beat=>beat.notes.length).map(beat=>beat.lyrics?.[0]??'');
const settings=new Settings();
const selection=(score:model.Score)=>({tracks:score.tracks.map((_,index)=>index),range:null});
for(const [name,source,at] of [['after a hyphen','ky-ri-e',2],['between words','one two three',1],['at the start','one two three',0],['after a hyphen in a hyphen run','a-b-c',1]] as [string,string,number][]) {
  it(`a gap ${name} keeps every syllable on its note through Guitar Pro 5, GPIF and MusicXML`,()=>{
    const text=insertLyricGap(source,at)!,score=sung(text),expected=perBeat(score);
    expect(expected.filter(item=>item==='').length).toBe(1);expect(expected.length).toBe(4);
    expect(perBeat(loadInterchangeScore(exportGp5(score,selection(score)).bytes,settings)),'Guitar Pro 5').toEqual(expected);
    expect(perBeat(loadInterchangeScore(exportGpInterchange(score,settings),settings)),'GPIF').toEqual(expected);
    expect(perBeat(loadInterchangeScore(exportMusicXml(score,selection(score)),settings)),'MusicXML').toEqual(expected);
  });
}
