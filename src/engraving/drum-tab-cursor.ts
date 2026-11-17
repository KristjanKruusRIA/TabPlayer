import type { model } from '@coderline/alphatab';
import { assignDrumTabLines,drumTabLine,drumTabNumber,type TabCandidate } from './drum-tab';

/**
 * Where ArrowUp/ArrowDown take the note cursor on a drum track shown as drum tab: to the hit drawn on the neighbouring tab line of the same
 * beat, not to the neighbouring note in storage order. The lines are the ones the projection draws: hits are grouped per moment across all
 * voices of the bar (a grace beat is a moment of its own), taken voice by voice in storage order, and given lines by `assignDrumTabLines`.
 *
 * - 'up' goes to the hit on the nearest line above the cursor's (a smaller line number), 'down' to the one below. At the top or bottom
 *   the cursor stays where it is.
 * - A hit the tab leaves off (more than six hits on one moment, or an articulation with no number) has no line, so it is skipped when
 *   stepping from a drawn hit. When the cursor itself sits on such a hit, it re-enters the drawn hits from the side the key points
 *   away from: 'up' lands on the lowest drawn hit of the beat, 'down' on the highest. A beat with no drawn hit leaves the cursor alone.
 * - Pure: nothing is written and no edit is recorded; the result is only the note index to select.
 */
export function stepDrumTabNote(track:model.Track,beat:model.Beat,noteIndex:number,direction:'up'|'down'):number {
  const wanted=drawnLines(track,beat);
  const drawn=beat.notes.map((_,index)=>({index,line:wanted.get(beat.notes[index])??null})).filter((entry):entry is {index:number;line:number}=>entry.line!==null);
  if(!drawn.length)return noteIndex;
  const here=wanted.get(beat.notes[noteIndex])??null;
  if(here===null){
    // Not drawn: enter from the far side. Lines are distinct, so the extreme is unique.
    const pick=direction==='up'?drawn.reduce((a,b)=>b.line>a.line?b:a):drawn.reduce((a,b)=>b.line<a.line?b:a);
    return pick.index;
  }
  const beyond=drawn.filter(entry=>direction==='up'?entry.line<here:entry.line>here);
  if(!beyond.length)return noteIndex;
  return beyond.reduce((a,b)=>direction==='up'?(b.line>a.line?b:a):(b.line<a.line?b:a)).index;
}

/** The tab line (1 top to 6) of each note of `beat`, or null for a note the tab leaves off. */
function drawnLines(track:model.Track,beat:model.Beat):Map<model.Note,number|null> {
  const result=new Map<model.Note,number|null>();
  const bar=beat.voice.bar,grace=(candidate:model.Beat)=>candidate.graceType!==0;
  const sameMoment=(candidate:model.Beat)=>candidate===beat||(!grace(beat)&&!grace(candidate)&&candidate.displayStart===beat.displayStart);
  const group:Array<{note:model.Note;candidate:TabCandidate}>=[];
  for(const voice of bar.voices)for(const other of voice.beats){
    if(!sameMoment(other))continue;
    for(const note of other.notes){
      const like={percussionArticulation:note.percussionArticulation},number=drumTabNumber(track,like);
      if(number===null){result.set(note,null);continue;}
      group.push({note,candidate:{number,line:drumTabLine(track,like)!}});
    }
  }
  const {lines}=assignDrumTabLines(group.map(entry=>entry.candidate));
  group.forEach((entry,at)=>result.set(entry.note,lines[at]));
  return result;
}
