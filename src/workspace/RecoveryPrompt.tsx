import { useEffect,useId,useRef,type KeyboardEvent } from 'react';
import type { RecoveryPreview } from './recovery-types';
import { useI18n } from '../i18n';
import { projectCommands } from '../project';
import './recovery.css';

export interface RecoveryPromptProps {
  preview:RecoveryPreview;busy:boolean;
  onRestore:()=>void;onDiscard:()=>void;onStartNew:()=>void;
}
function documentTitle(document:RecoveryPreview['documents'][number],untitled:string):string {
  const project=document.snapshot.project;
  const commands=projectCommands(project);
  for(let index=commands.length-1;index>=0;index--){
    const edit=commands[index];
    if(edit.type==='setScoreInfo')return edit.title.trim()?edit.title:untitled;
  }
  const title=project.base.kind==='blank'?project.base.title:project.base.filename.split(/[\\/]/).pop()??'';
  return title.trim()?title:untitled;
}

export function RecoveryPrompt({preview,busy,onRestore,onDiscard,onStartNew}:RecoveryPromptProps){
  const { t } = useI18n();
  const dialog=useRef<HTMLElement>(null),id=useId();
  const unavailable=preview.reason==='unavailable'||preview.documents.length===0;
  const automatic=!unavailable&&preview.reason==='clean';
  const title=unavailable?t('recovery.unavailable_title'):automatic?t('recovery.restoring_title'):t('recovery.recover_title');
  const description=unavailable?t('recovery.unavailable_desc'):automatic?t('recovery.restoring_desc'):t('recovery.recover_desc');
  const [checkpointBefore,checkpointAfter]=t('recovery.checkpoint',{time:'{time}'}).split('{time}');
  const captured=preview.capturedAtUnixMs===null?null:new Date(preview.capturedAtUnixMs);

  useEffect(()=>{
    const opener=document.activeElement;
    dialog.current?.focus();
    return ()=>{if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();};
  },[preview.token]);
  useEffect(()=>{if(busy)dialog.current?.focus();},[busy]);

  function keyDown(event:KeyboardEvent<HTMLElement>){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();return;}
    if(event.key!=='Tab')return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[tabindex="0"],button:not(:disabled)'));
    const first=controls[0],last=controls[controls.length-1];
    if(!first){event.preventDefault();dialog.current?.focus();return;}
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){
      event.preventDefault();last.focus();
    }else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }

  return <div className="dialog-backdrop recovery-backdrop"><section ref={dialog} className="recovery-dialog" role="dialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy} tabIndex={-1} onKeyDown={keyDown}>
    <h2 id={`${id}-title`}>{title}</h2>
    <p id={`${id}-description`}>{description}</p>
    {captured&&Number.isFinite(captured.getTime())?<p className="recovery-time">{checkpointBefore}<time dateTime={captured.toISOString()}>{captured.toLocaleString()}</time>{checkpointAfter}</p>:
      <p className="recovery-time">{t('recovery.checkpoint_unavailable')}</p>}
    {!unavailable&&<>
      <p className="recovery-count">{t(preview.documents.length===1?'recovery.recoverable_one':'recovery.recoverable_other', { count: preview.documents.length })}</p>
      <div className="recovery-documents" role="region" aria-label={t('recovery.recoverable_region')} tabIndex={0}><ol>
        {preview.documents.map((document,index)=><li key={document.documentId} aria-label={t('recovery.score_entry', { index: index + 1, total: preview.documents.length, title: documentTitle(document,t('score.untitled')) })}>{documentTitle(document,t('score.untitled'))}</li>)}
      </ol></div>
    </>}
    {preview.issues.length>0&&<section className="recovery-issues" aria-labelledby={`${id}-issues`}>
      <h3 id={`${id}-issues`}>{t('recovery.details_heading')}</h3><ul>{preview.issues.map((issue,index)=><li key={index}>{issue.message}</li>)}</ul>
    </section>}
    {(busy||automatic)&&<p role="status">{automatic?t('recovery.restoring_status'):t('recovery.opening_status')}</p>}
    {!automatic&&<div className="recovery-actions">
      {unavailable?<button type="button" className="primary" disabled={busy} onClick={()=>{if(!busy)onStartNew();}}>{t('recovery.start_new')}</button>:<>
        <button type="button" className="primary" disabled={busy} onClick={()=>{if(!busy)onRestore();}}>{t('recovery.restore')}</button>
        <button type="button" disabled={busy} onClick={()=>{if(!busy)onDiscard();}}>{t('recovery.discard')}</button>
      </>}
    </div>}
  </section></div>;
}
