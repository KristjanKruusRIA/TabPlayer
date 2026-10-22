import { useState } from 'react';
import type { BeatTarget } from '../project';
import { describeScoreError,type ScoreError } from './score-errors';

/** Lists measures whose voices are too short or too long and jumps to them; marking in the score is a viewer choice. */
export function ScoreErrorsPanel({errors,mark,onMark,onSelect,shownTracks}:{errors:readonly ScoreError[];mark:boolean;onMark:(mark:boolean)=>void;onSelect:(target:BeatTarget)=>void;
  /** Tracks drawn in the score; errors elsewhere are named as not shown. */
  shownTracks?:readonly number[]}) {
  // The section opens once if the score starts with errors; afterwards only the user opens or closes it.
  const [open,setOpen]=useState(()=>errors.length>0);
  return <details className="editor-section" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>Score errors ({errors.length})</summary>
    <label className="check"><input type="checkbox" checked={mark} onChange={event=>onMark(event.target.checked)}/>Mark errors in the score</label>
    {errors.length?<ul className="score-error-list" aria-label="Score errors">{errors.map(error=>{
      const label=`${describeScoreError(error)}${shownTracks&&!shownTracks.includes(error.track)?' (track not shown)':''}`;
      return <li key={`${error.track}/${error.staff}/${error.bar}/${error.voice}`}><button onClick={()=>onSelect({track:error.track,staff:error.staff,bar:error.bar,voice:error.voice,beat:error.beat})}>{label}</button></li>;
    })}</ul>:<p className="muted">Every measure is complete.</p>}
  </details>;
}
