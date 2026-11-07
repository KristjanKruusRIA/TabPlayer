import { useEffect,useId,useRef,useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EngravingCommand,EngravingOverrides,StaffGroupKind } from './types';
import { addStaffGroup,groupStates,groupingProblem,removeAllStaffGroups,removeStaffGroup,resetAllStaffGaps,resetStaffGap,setStaffGap,setStaffGroupKind,staffGapOf,STAFF_GAP_RANGE,withLongFirstShortAfter,isLongFirstShortAfter } from './staff-groups';
import { busyGuard,busySelect } from '../ui';
import { useI18n } from '../i18n';

export interface StaffGroupsPanelProps {
  value:EngravingOverrides;
  score:model.Score;
  trackIds:readonly string[];
  /** Document track indices actually shown. The last one has no space below it in this view. */
  rendered:readonly number[];
  /** Whether the chosen layout stacks physical pages (the only screen layouts that apply staff gaps). */
  pageLayout:boolean;
  busy:boolean;
  locked?:boolean;
  onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown;
}

const percent=(scale:number)=>String(Math.round(scale*10000)/100);

/** Groups neighbouring tracks under a bracket or brace and sets the space below a track. Saved with the document and printed. */
export function StaffGroupsPanel({value,score,trackIds,rendered,pageLayout,busy,locked=false,onEdit}:StaffGroupsPanelProps) {
  const {t}=useI18n();
  const send=(engraving:EngravingOverrides)=>{if(engraving!==value)onEdit({type:'setEngraving',engraving});};
  const nameOf=(id:string)=>{const index=trackIds.indexOf(id);return index>=0?score.tracks[index]?.name??t('staff_groups.removed_track'):t('staff_groups.removed_track');};

  const [chosen,setChosen]=useState<ReadonlySet<string>>(()=>new Set()),[kind,setKind]=useState<StaffGroupKind>('bracket');
  const members=trackIds.filter(id=>chosen.has(id));
  const problem=groupingProblem(value,trackIds,members);
  const groups=value.staffGroups??[],states=groupStates(groups,trackIds,rendered);

  const shownIds=rendered.map(index=>trackIds[index]).filter((id):id is string=>id!==undefined);
  const [picked,setPicked]=useState<string|null>(null);
  const trackId=picked!==null&&shownIds.includes(picked)?picked:shownIds[0]??null;
  const last=trackId!==null&&trackId===shownIds[shownIds.length-1];
  const stored=trackId!==null?staffGapOf(value,trackId):1;
  const shown=percent(stored);
  const editable=trackId!==null&&!last&&!busy&&!locked;
  const [draft,setDraft]=useState(shown),[invalid,setInvalid]=useState(false);
  const edited=useRef<string|null>(null);
  const ids=useId(),alertId=ids+'-alert';
  useEffect(()=>{setDraft(shown);setInvalid(false);edited.current=null;},[shown,trackId,busy,last]);
  const min=STAFF_GAP_RANGE.min*100,max=STAFF_GAP_RANGE.max*100;
  /** true: handled (committed or nothing to do); false: the text is invalid. */
  const commit=(text:string):boolean=>{
    if(trackId===null||!editable||edited.current!==trackId)return true;
    const number=Number(text);
    if(text.trim()===''||!Number.isFinite(number)||number<min||number>max){setInvalid(true);return false;}
    edited.current=null;setInvalid(false);
    if(text.trim()===shown||Math.abs(number/100-stored)<=1e-9)return true;
    send(setStaffGap(value,trackId,number/100));
    return true;
  };

  const toggle=(id:string)=>{
    if(busy)return;
    setChosen(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
  };
  const problemKey=problem&&`staff_groups.problem_${problem}` as const;
  const longFirst=isLongFirstShortAfter(value);
  const hasGaps=!!value.staffGaps?.length;

  return <details><summary>{t('staff_groups.title')}</summary>
    <p className="muted">{t('staff_groups.help')}</p>
    {locked&&<p role="status" className="muted">{t('staff_groups.status_locked')}</p>}
    <fieldset>
      {score.tracks.map((track,index)=>{
        const id=trackIds[index];
        return <label key={id}><input type="checkbox" checked={chosen.has(id)} aria-disabled={busy?'true':undefined} onChange={()=>toggle(id)}/>{t('staff_groups.choose_track',{name:track.name})}</label>;
      })}
    </fieldset>
    <label>{t('staff_groups.kind')}<select value={kind} {...busySelect(busy)} onChange={event=>{if(!busy)setKind(event.target.value as StaffGroupKind);}}>
      <option value="bracket">{t('staff_groups.kind_bracket')}</option><option value="brace">{t('staff_groups.kind_brace')}</option>
    </select></label>
    {problemKey&&<p className="muted">{t(problemKey)}</p>}
    <button type="button" {...busyGuard({busy,unavailable:problem!==null,onClick:()=>{send(addStaffGroup(value,trackIds,members,kind));setChosen(new Set());}})}>{t('staff_groups.create')}</button>
    {groups.map((group,index)=>{
      const label=t('staff_groups.group_label',{names:group.trackIds.map(nameOf).join(', ')});
      const state=states[index];
      return <div key={index} className="staff-group">
        <p>{label}</p>
        <select aria-label={`${t('staff_groups.kind')}: ${label}`} value={group.kind} {...busySelect(busy)} onChange={event=>{if(!busy)send(setStaffGroupKind(value,index,event.target.value as StaffGroupKind));}}>
          <option value="bracket">{t('staff_groups.kind_bracket')}</option><option value="brace">{t('staff_groups.kind_brace')}</option>
        </select>
        <p className="muted">{t(`staff_groups.state_${state}` as const)}</p>
        <button type="button" {...busyGuard({busy,onClick:()=>send(removeStaffGroup(value,index))})}>{t('staff_groups.remove')}</button>
      </div>;
    })}
    <button type="button" {...busyGuard({busy,unavailable:!groups.length,onClick:()=>send(removeAllStaffGroups(value))})}>{t('staff_groups.remove_all')}</button>
    {!pageLayout&&<p className="muted">{t('staff_groups.gap_layout')}</p>}
    <label>{t('staff_groups.gap_track')}<select value={trackId??''} {...busySelect(busy)} onChange={event=>{if(!busy)setPicked(event.target.value);}}>
      {shownIds.map(id=><option key={id} value={id}>{nameOf(id)}</option>)}
    </select></label>
    {last&&<p className="muted">{t('staff_groups.gap_last')}</p>}
    <label>{t('staff_groups.gap_field')}<input type="number" min={min} max={max} step="any" value={draft} readOnly={!editable} aria-disabled={!editable?'true':undefined} aria-invalid={invalid||undefined} aria-describedby={invalid?alertId:undefined}
      onChange={event=>{if(!editable||trackId===null)return;edited.current=trackId;setDraft(event.target.value);setInvalid(false);}}
      onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit(event.currentTarget.value);}}}
      onBlur={event=>{if(!commit(event.currentTarget.value)){edited.current=null;setDraft(shown);setInvalid(false);}}}/></label>
    {invalid&&<p id={alertId} role="alert" className="muted">{t('staff_groups.gap_invalid',{min,max})}</p>}
    <button type="button" {...busyGuard({busy,unavailable:trackId===null||!value.staffGaps?.some(entry=>entry.trackId===trackId),onClick:()=>{if(trackId!==null)send(resetStaffGap(value,trackId));}})}>{t('staff_groups.gap_reset')}</button>
    <button type="button" {...busyGuard({busy,unavailable:!hasGaps,onClick:()=>send(resetAllStaffGaps(value))})}>{t('staff_groups.gap_reset_all')}</button>
    <p className="muted">{t('staff_groups.names_long_first_help')}</p>
    <button type="button" {...busyGuard({busy,unavailable:longFirst,onClick:()=>send(withLongFirstShortAfter(value))})}>{t('staff_groups.names_long_first')}</button>
    {longFirst&&<p className="muted">{t('staff_groups.names_already')}</p>}
  </details>;
}
