import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/types';
import { useEffect,useRef,useState } from 'react';
import type { BeatTarget } from '../project';
import { busyGuard } from '../ui/useBusyGuard';
import { describeScoreError,type ScoreError } from './score-errors';

const repairName=(error:ScoreError)=>error.kind==='incomplete'?'Fill with rests':'Trim to fit';
/** What Trim to fit does to an overfull voice, so it is read before the button is pressed: the notes it shortens (the crossing beat kept as tied pieces), then what it removes. */
function describeTrim(error:ScoreError,t:(key:MessageKey,params?:Record<string,string|number>)=>string) {
  if(error.kind!=='overfull')return '';
  const many=(count:number,base:'trim_shortens'|'trim_removes_beats'|'trim_removes_notes')=>t(`editor.${base}_${count===1?'one':'other'}` as MessageKey,{count});
  const shortens=error.shortened?many(error.shortened,'trim_shortens'):'';
  const removes=error.trim?(error.trim.notes?t('editor.trim_hint_and',{first:many(error.trim.beats,'trim_removes_beats'),second:many(error.trim.notes,'trim_removes_notes')}):many(error.trim.beats,'trim_removes_beats')):'';
  return shortens&&removes?t('editor.trim_hint_then',{first:shortens,second:removes}):shortens||removes;
}

/** Lists measures whose voices are too short or too long, jumps to them and repairs them; marking in the score is a viewer choice. */
export function ScoreErrorsPanel({errors,mark,onMark,onSelect,onFit,busy,shownTracks}:{errors:readonly ScoreError[];mark:boolean;onMark:(mark:boolean)=>void;onSelect:(target:BeatTarget)=>void;
  /** Repairs one voice (rests for a short one, trimming for a long one); left out when the score cannot be edited. */
  onFit?:(error:ScoreError)=>void;busy?:boolean;
  /** Tracks drawn in the score; errors elsewhere are named as not shown. */
  shownTracks?:readonly number[]}) {
  const { t } = useI18n();
  const hint=(error:ScoreError)=>describeTrim(error,t);
  // The section opens once if the score starts with errors; afterwards only the user opens or closes it.
  const [open,setOpen]=useState(()=>errors.length>0);
  // After a repair the row is gone; focus moves to the repair button now in its place, or the section heading when none is left.
  const list=useRef<HTMLDetailsElement>(null),pending=useRef<number|null>(null);
  useEffect(()=>{
    const row=pending.current;if(row===null)return;pending.current=null;
    const buttons=list.current?.querySelectorAll<HTMLButtonElement>('button[data-repair]');
    if(buttons?.length)buttons[Math.min(row,buttons.length-1)].focus();else list.current?.querySelector('summary')?.focus();
  },[errors]);
  return <details ref={list} className="editor-section" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{t('editor.score_errors_heading', { count: errors.length })}</summary>
    <label className="check"><input type="checkbox" checked={mark} onChange={event=>onMark(event.target.checked)}/>{t('editor.mark_errors_in_score')}</label>
    {errors.length?<ul className="score-error-list" aria-label={t('editor.score_errors')}>{errors.map((error,index)=>{
      const label=`${describeScoreError(error)}${shownTracks&&!shownTracks.includes(error.track)?' (track not shown)':''}`;
      return <li key={`${error.track}/${error.staff}/${error.bar}/${error.voice}`}><button onClick={()=>onSelect({track:error.track,staff:error.staff,bar:error.bar,voice:error.voice,beat:error.beat})}>{label}</button>
        {onFit&&<button data-repair {...busyGuard({busy,onClick:()=>{pending.current=index;onFit(error);}})} aria-label={`${repairName(error)}: measure ${error.bar+1}, ${error.place}, voice ${error.voice+1}${hint(error)?`, ${hint(error)}`:''}`}>{repairName(error)}{hint(error)&&<span className="muted"> · {hint(error)}</span>}</button>}</li>;
    })}</ul>:<p className="muted">{t('editor.every_measure_complete')}</p>}
  </details>;
}
