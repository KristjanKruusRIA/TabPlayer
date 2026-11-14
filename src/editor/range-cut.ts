import type { model } from '@coderline/alphatab';
import { getMessage,getResolvedLanguage } from '../i18n';
import type { MessageKey } from '../i18n/types';
import { detachNote } from './links';
import { rhythmTicks } from './common';
import { detachedCopy,rangeCutsSoundingBeat,splitRangeEdges } from './clipboard-subdivide';
import { deleteLyricTokens,insertLyricGap,tokenizeLyrics } from './lyrics';
import { getLyricsSource,copyLyricsSources,setLyricsSource } from './lyrics-source';
import { resolveSelectionNotes,validateMusicSelection } from './range-selection';
import type { BeatRange,MusicSelection,VoiceAddress } from './range-types';

/** A refusal worded in the interface language. */
export const cutRefusal=(key:MessageKey)=>new Error(getMessage(getResolvedLanguage(),key));

const sameLane=(a:VoiceAddress,b:VoiceAddress)=>a.track===b.track&&a.staff===b.staff&&a.voice===b.voice;
/** The lane the player shaped a range on: the one named, if the range has it, otherwise its first. Every other lane is erased by attack, as an erase always did. */
export function anchorLane(range:BeatRange,anchor?:VoiceAddress):VoiceAddress {return (anchor&&range.lanes.find(lane=>sameLane(lane,anchor)))||range.lanes[0];}

/** A beat that takes a syllable of a lyric line, with where it sits in its bar. */
interface SyllableBeat {beat:model.Beat;bar:number;start:number;end:number}
/** The beats that take a syllable of a lyric line starting at `startBar`, in order: every beat with notes in the track's first staff and voice from that bar on, tied or not. */
function syllableBeats(track:model.Track,startBar:number):SyllableBeat[] {
  const result:SyllableBeat[]=[];
  track.staves[0].bars.slice(startBar).forEach((bar,offset)=>{
    let tick=0;
    for(const beat of bar.voices[0]?.beats??[]){const start=tick;tick+=rhythmTicks(beat);if(!beat.isEmpty&&!beat.isRest)result.push({beat,bar:startBar+offset,start,end:tick});}
  });
  return result;
}

/**
 * How many pieces each note of a lyric line has after a cut: the original beat that kept its attack plus the tied pieces the split made, or only the pieces left of a note whose
 * attack was cut, or none. A piece belongs to the beat before the cut whose time it lies in.
 */
export function lyricPieceCounts(before:SyllableBeat[],after:SyllableBeat[]):number[] {
  const own=new Map(before.map((item,index)=>[item.beat,index])),counts=before.map(()=>0);
  let search=0;
  for(const item of after) {
    let origin=own.get(item.beat);
    if(origin===undefined){
      while(search<before.length-1&&(before[search].bar<item.bar||before[search].bar===item.bar&&before[search].end<=item.start))search++;
      const candidate=before[search];
      origin=candidate&&candidate.bar===item.bar&&candidate.start<=item.start&&item.start<candidate.end?search:-1;
    }
    if(origin>=0)counts[origin]++;
  }
  return counts;
}

/** Returns how many lyric words (tokens that are not blanks) the cut took out of the lyric lines with the notes that were cut away whole. */
function perform(score:model.Score,selection:Extract<MusicSelection,{kind:'range'}>):number {
  const range=selection.range,anchor=range.lanes[0],track=score.tracks[anchor.track];
  const source=anchor.staff===0&&anchor.voice===0?getLyricsSource(track):undefined;
  const lines=(source?.value.lines??[]).map((line,index)=>({line,index})).filter(item=>item.line.text.length>0);
  const before=lines.map(({line})=>syllableBeats(track,line.startBar));
  splitRangeEdges(score,{...range,lanes:[anchor]},true);
  for(const note of resolveSelectionNotes(score,selection)){const beat=note.beat;detachNote(note);beat.removeNote(note);beat.notes.forEach((member,index)=>member.index=index);beat.isEmpty=false;}
  if(!source||!lines.length)return 0;
  // Each lyric line hands one syllable to each note-bearing beat in turn from its own start bar, so every tied piece the cut adds (a head or a tail written as several tied beats) would push each later
  // syllable on by a beat, and a note cut away whole would pull them back. The rule: a note's syllable stays on the piece that keeps its attack, or on the first piece left of it when the attack was cut;
  // every other piece of that note gets a blank token written into the line, in the same edit; a note with no piece left loses its syllable (the token is taken out of the line, where a plain erase of a whole
  // beat would move it onto a later note and every syllable after it one note earlier). Hidden lines get the same, for when they are shown.
  const next=source.value.lines.map(line=>({...line}));let changed=false,lost=0;
  lines.forEach(({line,index},order)=>{
    const counts=lyricPieceCounts(before[order],syllableBeats(track,line.startBar)),words=tokenizeLyrics(line.text),tokenCount=words.length;
    const removed=counts.flatMap((count,note)=>count===0&&note<tokenCount?[note]:[]);
    let text=deleteLyricTokens(line.text,removed);
    lost+=removed.filter(note=>words[note]!=='').length;
    if(text===null)throw cutRefusal('editor.cut_refusal_lyrics');
    // Blanks go after the note's token, before the next one: from the last note back, so earlier indices stay as counted.
    for(let note=counts.length-1;note>=0;note--) {
      for(let extra=1;extra<counts[note];extra++) {
        const gapped=insertLyricGap(text,note+1-removed.filter(gone=>gone<note+1).length);
        if(gapped===null)throw cutRefusal('editor.cut_refusal_lyrics');
        text=gapped;
      }
    }
    if(text!==line.text){next[index].text=text;changed=true;}
  });
  if(changed)setLyricsSource(track,{visible:source.value.visible,lines:next},source.managed);
  return lost;
}

/** How many lyric words a cut of this range would take out of the lyrics (words of notes cut away whole), read from a detached copy; 0 when it would not run. For the notice after the gesture, never part of the edit. */
export function cutLyricWordsLost(score:model.Score,selection:MusicSelection):number {
  if(selection.kind!=='range')return 0;
  try{const probe=detachedCopy(score);copyLyricsSources(score,probe);return perform(probe,selection);}catch{return 0;}
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
