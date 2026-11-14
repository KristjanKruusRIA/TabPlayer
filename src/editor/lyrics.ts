import type { model } from '@coderline/alphatab';
import type { LyricsCommand,LyricsDraft,TrackLyrics } from './lyrics-types';
import { getLyricsSource,setLyricsSource } from './lyrics-source';

/** One pass over a lyric line: its tokens, where each starts and ends in the line with comments removed, and where every kept character was in the original text. */
function scanLyrics(text:string) {
  // Leading comments and the white space after them go first, then every other comment (an unclosed one runs to the end).
  const lead=/^(?:\[[^\]]*(?:\]|$)[ \t\r\n]*)+/.exec(text),leadEnd=lead?lead[0].length:0;
  const kept:number[]=[],letters:string[]=[];
  for(let i=leadEnd;i<text.length;) {
    if(text[i]==='['){const close=text.indexOf(']',i+1);i=close<0?text.length:close+1;}
    else{kept.push(i);letters.push(text[i]);i++;}
  }
  const stripped=letters.join(''),tokens:string[]=[],starts:number[]=[],ends:number[]=[];let start=0;
  for(const separator of stripped.matchAll(/[ \t-]|[\r\n]+/g)) {
    const chunk=stripped.slice(start,separator.index).replaceAll('+',' ');
    tokens.push(chunk+(separator[0]==='-'&&chunk?'-':''));starts.push(start);ends.push(separator.index);start=separator.index+separator[0].length;
  }
  if(start<stripped.length){tokens.push(stripped.slice(start).replaceAll('+',' '));starts.push(start);ends.push(stripped.length);}
  return {tokens,starts,ends,kept,stripped,leadEnd};
}
export function tokenizeLyrics(text:string):string[] {return scanLyrics(text).tokens;}
/**
 * The line with one blank token written in at `at`, so the syllable that was there and every later one move one beat on. A blank token is a beat that takes no syllable
 * (the editor's "extra spaces leave blank beats"). It is a single space written where the token starts, found in one pass from the token's offsets: the first place
 * (in the order a left-to-right search finds) whose tokens are exactly the old ones with an empty one at `at`, so comments, line breaks and hyphens stay as written.
 * Guitar Pro's and alphaTab's readers skip spaces after a hyphen, so directly after one the blank is an empty comment and a space (`ri-[] e`), which both read as one empty
 * syllable. At the start of a line only the space works in both (this editor drops a leading comment with the space after it). No single form serves every position.
 * The line unchanged when `at` is past the last token (nothing later to keep in place); null when no place gives exactly that (a blank before a token that follows a leading comment).
 */
export function insertLyricGap(text:string,at:number):string|null {
  const {tokens,starts,kept,stripped,leadEnd}=scanLyrics(text);
  if(at<0||at>=tokens.length)return text;
  const wanted=[...tokens.slice(0,at),'',...tokens.slice(at)],T=starts[at];
  // A blank can go anywhere in the run of separators (spaces, tabs, line breaks, hyphens) that ends at the token, since each separator already makes its own empty chunk;
  // the leftmost place that gives exactly one more empty token is the one a left-to-right search would find.
  let run=T;while(run>0&&/[ \t\r\n-]/.test(stripped[run-1]))run--;
  const positions:number[]=[];for(let q=run;q<=T;q++)positions.push(q);
  let tries=0;
  for(const q of positions) {
    // The places in the original text that sit at kept character `q`: at the start of a comment, or after one, never inside.
    const low=q===0?0:kept[q-1]+1,high=q<kept.length?kept[q]:text.length;
    for(let place=low;place<=high;) {
      const candidate=q===0&&leadEnd>0?place===0:place===0||/[ \t\r\n\]-]/.test(text[place-1]);
      if(candidate){
        if(++tries>24)return null;
        const next=text.slice(0,place)+(place>0&&text[place-1]==='-'?'[] ':' ')+text.slice(place),got=tokenizeLyrics(next);
        if(got.length===wanted.length&&got.every((token,index)=>token===wanted[index]))return next;
      }
      if(q===0&&leadEnd>0)break;
      if(place<high&&text[place]==='['){const close=text.indexOf(']',place+1);place=close<0?high:close+1;}else place++;
    }
  }
  return null;
}
/**
 * The line without the tokens at `indices` (and the separator after each), in one pass: the syllables of notes that no longer exist. The tokens left are exactly the old ones
 * minus those, so comments outside the removed spans, line breaks and hyphens stay as written. Indices past the last token are ignored. Null when removing them would not leave
 * exactly that (not reached by any tested text).
 */
export function deleteLyricTokens(text:string,indices:number[]):string|null {
  const {tokens,starts,ends,kept,stripped}=scanLyrics(text),gone=new Set(indices.filter(index=>index>=0&&index<tokens.length));
  if(!gone.size)return text;
  let result='',from=0;
  [...gone].sort((a,b)=>a-b).forEach(index=>{
    let sepEnd=ends[index];
    if(sepEnd<stripped.length){sepEnd++;if(/[\r\n]/.test(stripped[sepEnd-1]))while(sepEnd<stripped.length&&/[\r\n]/.test(stripped[sepEnd]))sepEnd++;}
    const lowOriginal=starts[index]<kept.length?kept[starts[index]]:text.length,highOriginal=sepEnd>0&&sepEnd-1<kept.length?kept[sepEnd-1]+1:text.length;
    if(lowOriginal<from)return;
    result+=text.slice(from,lowOriginal);from=Math.max(from,highOriginal);
  });
  result+=text.slice(from);
  const got=tokenizeLyrics(result),wanted=tokens.filter((_,index)=>!gone.has(index));
  return got.length===wanted.length&&got.every((token,index)=>token===wanted[index])?result:null;
}
const index=(value:number)=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
function trackAt(score:model.Score,track:number) {
  if(!index(track)||!score.tracks[track])throw new Error('Select an existing track.');return score.tracks[track];
}
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

export function getTrackLyrics(score:model.Score,track:number):LyricsDraft {
  const selected=trackAt(score,track),source=getLyricsSource(selected);
  if(source)return {...source.value,source:'raw'};
  return {...reconstructTrackLyrics(selected),source:'distributed'};
}
/** Reconstruct an excerpt from retained syllables even when a raw cache exists. */
export function reconstructTrackLyrics(track:model.Track):TrackLyrics {
  const eligible=track.staves[0].bars.flatMap(bar=>(bar.voices[0]?.beats??[]).filter(beat=>!beat.isEmpty&&!beat.isRest));
  const count=Math.min(5,eligible.reduce((max,beat)=>Math.max(max,beat.lyrics?.length??0),0));
  const lines=Array.from({length:count},(_,line)=>{
    const firstSyllable=eligible.findIndex(beat=>!!beat.lyrics?.[line]);
    if(firstSyllable<0)return {startBar:0,text:''};
    const startBar=eligible[firstSyllable].voice.bar.index,first=eligible.findIndex(beat=>beat.voice.bar.index===startBar);
    let last=eligible.length-1;while(last>first&&!eligible[last].lyrics?.[line])last--;
    const chunks=eligible.slice(first,last+1).map(beat=>beat.lyrics?.[line]??'');
    const text=chunks.reduce((text,chunk,i)=>text+(i===0||chunks[i-1].endsWith('-')?'':' ')+chunk.replaceAll(' ','+'),'');
    return {startBar,text};
  });
  return {visible:true,lines};
}
function placement(track:model.Track,value:TrackLyrics):Map<model.Beat,string[]> {
  const result=new Map<model.Beat,string[]>();if(!value.visible)return result;
  const bars=track.staves[0].bars;
  for(const [lineIndex,line]of value.lines.entries()) {
    const destinations=bars.slice(line.startBar).flatMap(bar=>bar.voices[0]?.beats??[]).filter(beat=>!beat.isEmpty&&!beat.isRest);
    for(const [i,chunk]of tokenizeLyrics(line.text).entries()) {
      const beat=destinations[i];if(!beat)break;
      let syllables=result.get(beat);if(!syllables){syllables=Array<string>(value.lines.length).fill('');result.set(beat,syllables);}
      syllables[lineIndex]=chunk;
    }
  }
  return result;
}
function distribute(track:model.Track,value:TrackLyrics):void {
  const assignments=placement(track,value);
  for(const bar of track.staves[0].bars)for(const voice of bar.voices)for(const beat of voice.beats)beat.lyrics=null;
  for(const [beat,syllables]of assignments)beat.lyrics=syllables;
}
export function applyLyricsEdit(score:model.Score,command:LyricsCommand):boolean {
  if(!exact(command,['type','track','visible','lines'])||command.type!=='setTrackLyrics'||typeof command.visible!=='boolean'||!Array.isArray(command.lines)||command.lines.length>5)throw new Error('Invalid track lyrics.');
  const track=trackAt(score,command.track);
  if(command.lines.some(line=>!exact(line,['startBar','text'])||!index(line.startBar)||!score.masterBars[line.startBar]||typeof line.text!=='string'))throw new Error('Lyrics require existing start measures and text, with at most five lines.');
  const value={visible:command.visible,lines:command.lines};
  distribute(track,value);setLyricsSource(track,value,true);return true;
}
export function reflowLyrics(score:model.Score):void {
  for(const track of score.tracks){const source=getLyricsSource(track);if(source&&(source.managed||!source.value.visible))distribute(track,source.value);}
}
/** Update source offsets before the actual structural removal. */
export function removeLyricsMeasure(score:model.Score,bar:number):void {
  if(!index(bar)||!score.masterBars[bar]||score.masterBars.length<2)throw new Error('Select a removable measure.');
  for(const track of score.tracks) {
    const source=getLyricsSource(track);if(!source)continue;
    const lines=source.value.lines.map(line=>({...line,startBar:Math.min(line.startBar>bar?line.startBar-1:line.startBar,score.masterBars.length-2)}));
    setLyricsSource(track,{...source.value,lines},source.managed);
  }
}
