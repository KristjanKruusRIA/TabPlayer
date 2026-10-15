import { model } from '@coderline/alphatab';

export function detachNote(note:model.Note) {
  if(note.tieOrigin?.tieDestination===note)note.tieOrigin.tieDestination=note.beat.notes.find(other=>other!==note&&other.tieOrigin===note.tieOrigin)??null;
  if(note.tieDestination)for(const destination of note.tieDestination.beat.notes)if(destination.tieOrigin===note){destination.tieOrigin=null;destination.isTieDestination=false;destination.bendOrigin=null;destination.isContinuedBend=false;}
  if(note.slurOrigin)note.slurOrigin.slurDestination=null;
  if(note.slurDestination){note.slurDestination.slurOrigin=null;note.slurDestination.isSlurDestination=false;}
  if(note.slideOrigin){note.slideOrigin.slideTarget=null;note.slideOrigin.slideOutType=model.SlideOutType.None;}
  if(note.slideTarget)note.slideTarget.slideOrigin=null;
  if(note.hammerPullOrigin){note.hammerPullOrigin.hammerPullDestination=null;note.hammerPullOrigin.isHammerPullOrigin=false;}
  if(note.hammerPullDestination)note.hammerPullDestination.hammerPullOrigin=null;
  note.tieOrigin=null;note.tieDestination=null;note.isTieDestination=false;
  note.slurOrigin=null;note.slurDestination=null;note.isSlurDestination=false;
  note.slideOrigin=null;note.slideTarget=null;note.slideOutType=model.SlideOutType.None;
  note.hammerPullOrigin=null;note.hammerPullDestination=null;note.isHammerPullOrigin=false;
  note.bendOrigin=null;note.isContinuedBend=false;
}
export const allNotes=(score:model.Score)=>score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(beat=>beat.notes)))));
export type NoteLinks={from:number;to:number;kind:'tie'|'slur'|'slide'|'hammerPull';slideOutType?:model.SlideOutType}[];
export function captureNoteLinks(score:model.Score):NoteLinks {
  const links:NoteLinks=[],notes=allNotes(score);
  // Duplicate chord notes can share an origin. Restore their incoming-only
  // ties first so the final forward edge retains the original destination.
  for(const note of notes)if(note.tieOrigin&&note.tieOrigin.tieDestination!==note)links.push({from:note.tieOrigin.id,to:note.id,kind:'tie'});
  for(const note of notes)for(const [kind,destination] of [['tie',note.tieDestination],['slur',note.slurDestination],['slide',note.slideTarget],['hammerPull',note.hammerPullDestination]] as const)if(destination)links.push({from:note.id,to:destination.id,kind,...kind==='slide'?{slideOutType:note.slideOutType}:{}});
  return links;
}
export function restoreNoteLinks(score:model.Score,links:NoteLinks) {
  const notes=allNotes(score),lookup=new Map(notes.map(n=>[n.id,n]));
  for(const note of notes){note.tieOrigin=null;note.tieDestination=null;note.isTieDestination=false;note.slurOrigin=null;note.slurDestination=null;note.isSlurDestination=false;note.slideOrigin=null;note.slideTarget=null;note.hammerPullOrigin=null;note.hammerPullDestination=null;note.isHammerPullOrigin=false;}
  for(const link of links){const from=lookup.get(link.from),to=lookup.get(link.to);if(!from||!to)continue;
    if(link.kind==='tie'){from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;}
    if(link.kind==='slur'){from.slurDestination=to;to.slurOrigin=from;to.isSlurDestination=true;}
    if(link.kind==='slide'){from.slideTarget=to;from.slideOutType=link.slideOutType??model.SlideOutType.Shift;to.slideOrigin=from;}
    if(link.kind==='hammerPull'){from.hammerPullDestination=to;from.isHammerPullOrigin=true;to.hammerPullOrigin=from;}
  }
}
