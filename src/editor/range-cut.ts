import type { model } from '@coderline/alphatab';
import { getMessage,getResolvedLanguage } from '../i18n';
import type { MessageKey } from '../i18n/types';
import { detachNote } from './links';
import { detachedCopy,rangeCutsSoundingBeat,splitRangeEdges } from './clipboard-subdivide';
import { getLyricsSource,copyLyricsSources } from './lyrics-source';
import { resolveSelectionNotes,validateMusicSelection } from './range-selection';
import type { BeatRange,MusicSelection,VoiceAddress } from './range-types';

/** A refusal worded in the interface language. */
export const cutRefusal=(key:MessageKey)=>new Error(getMessage(getResolvedLanguage(),key));

const sameLane=(a:VoiceAddress,b:VoiceAddress)=>a.track===b.track&&a.staff===b.staff&&a.voice===b.voice;
/** The lane the player shaped a range on: the one named, if the range has it, otherwise its first. Every other lane is erased by attack, as an erase always did. */
export function anchorLane(range:BeatRange,anchor?:VoiceAddress):VoiceAddress {return (anchor&&range.lanes.find(lane=>sameLane(lane,anchor)))||range.lanes[0];}

/** The beats that take a syllable of a lyric line starting at `startBar`: every beat with notes in the track's first staff and voice from that bar on, tied or not. */
const syllableBeats=(track:model.Track,startBar:number)=>track.staves[0].bars.slice(startBar).reduce((count,bar)=>count+(bar.voices[0]?.beats??[]).filter(beat=>!beat.isEmpty&&!beat.isRest).length,0);

function perform(score:model.Score,selection:Extract<MusicSelection,{kind:'range'}>):void {
  const range=selection.range,anchor=range.lanes[0];
  const lyrics=anchor.staff===0&&anchor.voice===0?getLyricsSource(score.tracks[anchor.track]):undefined,lines=lyrics?.value.visible?lyrics.value.lines.filter(line=>line.text.length>0):[];
  const before=lines.map(line=>syllableBeats(score.tracks[anchor.track],line.startBar));
  splitRangeEdges(score,{...range,lanes:[anchor]},true);
  for(const note of resolveSelectionNotes(score,selection)){const beat=note.beat;detachNote(note);beat.removeNote(note);beat.notes.forEach((member,index)=>member.index=index);beat.isEmpty=false;}
  // Each lyric line hands one syllable to each note-bearing beat in turn from its own start bar, so a cut that leaves MORE such beats from any line's start (a surviving head plus a tail, a tail written as two tied beats,
  // or a gain in a later bar that a loss in an earlier one hides in a track total) would move every later syllable of that line.
  // Fewer is what an erase of a whole beat does today (later syllables move earlier), so it is left as it is.
  if(lines.some((line,index)=>syllableBeats(score.tracks[anchor.track],line.startBar)>before[index]))throw cutRefusal('editor.cut_refusal_lyrics');
}

/**
 * Cut a range whose edge may fall inside a held beat of its first lane: that beat is split at the edge into pieces of exact written length,
 * then the notes of every beat attacked inside the range, in every lane, are removed as an erase removes them (links to them severed, the beats stay as rests).
 * The part outside the range stays as a shorter beat with its notes. Other lanes are never split. Nothing is changed unless all of it can be done.
 */
export function applyCutSelection(score:model.Score,selection:MusicSelection):void {
  if(selection.kind!=='range')throw cutRefusal('editor.cut_refusal_range');
  validateMusicSelection(score,selection);
  const probe=detachedCopy(score);copyLyricsSources(score,probe);perform(probe,selection);
  perform(score,selection);
}

/**
 * The edit that removes a selection's notes. A range with an edge inside a note of its anchor lane (the lane the player shaped it on, `anchor`, else the first)
 * is the splitting cut, with that lane first; everything else is the plain erase, exactly as it always was, whatever the other lanes hold (older builds read it).
 */
export function eraseCommandFor(score:model.Score,selection:MusicSelection,anchor?:VoiceAddress):{type:'eraseSelection'|'cutSelection';selection:MusicSelection} {
  if(selection.kind!=='range')return {type:'eraseSelection',selection};
  const lane=anchorLane(selection.range,anchor);
  if(!rangeCutsSoundingBeat(score,selection.range,[lane]))return {type:'eraseSelection',selection};
  return {type:'cutSelection',selection:{kind:'range',range:{...selection.range,lanes:[lane,...selection.range.lanes.filter(other=>!sameLane(other,lane))]}}};
}

/** True when the edit would act on whole notes started in a range whose edge, in its anchor lane, falls inside a note: the band shows part of that note, the edit takes all of it. */
const wholeBeatEdits=new Set<string>(['transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain','setSelectionStrokes','setSelectionTies','tieSelectionToEarlierPitch']);
export function acceptsOnlyWholeBeats(score:model.Score,command:{type:string;selection?:MusicSelection},anchor?:VoiceAddress):boolean {
  if(!wholeBeatEdits.has(command.type)||command.selection?.kind!=='range')return false;
  return rangeCutsSoundingBeat(score,command.selection.range,[anchorLane(command.selection.range,anchor)]);
}
