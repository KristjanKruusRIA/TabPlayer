import type { model } from '@coderline/alphatab';
import { getLyricsSource,setLyricsSource } from '../editor/lyrics-source';
import type { TrackLyrics } from '../editor/lyrics-types';

function orderedTracks(doc:Document):(Element|undefined)[] {
  const tracks=new Map([...doc.querySelectorAll('GPIF > Tracks > Track')].map(track=>[track.getAttribute('id'),track]));
  return (doc.querySelector('GPIF > MasterTrack > Tracks')?.textContent??'').trim().split(/\s+/).filter(Boolean).map(id=>tracks.get(id));
}
function clearDisplayedLyrics(track:model.Track):void {
  for(const bar of track.staves[0].bars)for(const voice of bar.voices)for(const beat of voice.beats)beat.lyrics=null;
}
export function readGpifLyrics(score:model.Score,doc:Document):void {
  const sources:{track:model.Track;value:TrackLyrics}[]=[];
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index],lyrics=node?.querySelector(':scope > Lyrics');if(!track||!lyrics)return;
    const lines=[...lyrics.querySelectorAll(':scope > Line')].map(line=>({text:line.querySelector(':scope > Text')?.textContent??'',startBar:Number(line.querySelector(':scope > Offset')?.textContent??'0')}));
    if(lines.length>5||lines.some(line=>!Number.isInteger(line.startBar)||line.startBar<0||line.startBar>0xffffffff))throw new Error('Invalid GPIF lyrics.');
    const dispatched=lyrics.getAttribute('dispatched');sources.push({track,value:{visible:dispatched===null||dispatched==='true',lines}});
  });
  for(const {track,value}of sources){setLyricsSource(track,value,false);if(!value.visible)clearDisplayedLyrics(track);}
}
export function writeGpifLyrics(score:model.Score,doc:Document):void {
  const tracks=orderedTracks(doc);
  const replacements=score.tracks.flatMap((track,index)=>{
    const source=getLyricsSource(track);if(!source||(!source.managed&&source.value.visible&&!source.value.lines.some(line=>line.text.length>0)))return [];
    const node=tracks[index];if(!node)throw new Error('Missing GPIF track for lyrics export.');
    const lyrics=doc.createElement('Lyrics');lyrics.setAttribute('dispatched',String(source.value.visible));
    for(const value of source.value.lines) {
      const line=doc.createElement('Line'),text=doc.createElement('Text'),offset=doc.createElement('Offset');
      text.textContent=value.text;offset.textContent=String(value.startBar);line.append(text,offset);lyrics.append(line);
    }
    return [{node,lyrics}];
  });
  for(const {node,lyrics}of replacements){const old=node.querySelector(':scope > Lyrics');if(old)old.replaceWith(lyrics);else node.append(lyrics);}
}
