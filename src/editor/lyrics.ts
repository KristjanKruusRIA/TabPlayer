import type { model } from '@coderline/alphatab';
import type { LyricsCommand,LyricsDraft,TrackLyrics } from './lyrics-types';
import { getLyricsSource,setLyricsSource } from './lyrics-source';

export function tokenizeLyrics(text:string):string[] {
  const withoutComments=text.replace(/^(?:\[[^\]]*(?:\]|$)[ \t\r\n]*)+/,'').replace(/\[[^\]]*(?:\]|$)/g,'');
  const chunks:string[]=[];let start=0;
  for(const separator of withoutComments.matchAll(/[ \t-]|[\r\n]+/g)) {
    const chunk=withoutComments.slice(start,separator.index).replaceAll('+',' ');
    chunks.push(chunk+(separator[0]==='-'&&chunk?'-':''));start=separator.index+separator[0].length;
  }
  if(start<withoutComments.length)chunks.push(withoutComments.slice(start).replaceAll('+',' '));
  return chunks;
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
