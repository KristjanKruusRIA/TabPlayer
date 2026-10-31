import { useEffect,useId,useRef,type KeyboardEvent } from 'react';
import type { RecoveryPreview } from './recovery-types';
import { projectCommands } from '../project';
import './recovery.css';

export interface RecoveryPromptProps {
  preview:RecoveryPreview;busy:boolean;
  onRestore:()=>void;onDiscard:()=>void;onStartNew:()=>void;
}
function documentTitle(document:RecoveryPreview['documents'][number]):string {
  const project=document.snapshot.project;
  const commands=projectCommands(project);
  for(let index=commands.length-1;index>=0;index--){
    const edit=commands[index];
    if(edit.type==='setScoreInfo')return edit.title.trim()?edit.title:'Untitled';
  }
  const title=project.base.kind==='blank'?project.base.title:project.base.filename.split(/[\\/]/).pop()??'';
  return title.trim()?title:'Untitled';
}

export function RecoveryPrompt({preview,busy,onRestore,onDiscard,onStartNew}:RecoveryPromptProps){
  const dialog=useRef<HTMLElement>(null),id=useId();
  const unavailable=preview.reason==='unavailable'||preview.documents.length===0;
  const automatic=!unavailable&&preview.reason==='clean';
  const title=unavailable?'Recovery unavailable':automatic?'Restoring previous session':'Recover unsaved work?';
  const description=unavailable?'TabPlayer could not recover a previous session. Start a new session to continue.':
    automatic?'Your previous session is being restored. Playback will remain stopped.':
    'Restore documents from the last completed backup. Changes after that checkpoint may be missing.';
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
    {captured&&Number.isFinite(captured.getTime())?<p className="recovery-time">Checkpoint: <time dateTime={captured.toISOString()}>{captured.toLocaleString()}</time></p>:
      <p className="recovery-time">Checkpoint time unavailable.</p>}
    {!unavailable&&<>
      <p className="recovery-count">{preview.documents.length} recoverable {preview.documents.length===1?'document':'documents'}</p>
      <div className="recovery-documents" role="region" aria-label="Recoverable documents" tabIndex={0}><ol>
        {preview.documents.map((document,index)=><li key={document.documentId} aria-label={`Score ${index+1} of ${preview.documents.length}: ${documentTitle(document)}`}>{documentTitle(document)}</li>)}
      </ol></div>
    </>}
    {preview.issues.length>0&&<section className="recovery-issues" aria-labelledby={`${id}-issues`}>
      <h3 id={`${id}-issues`}>Recovery details</h3><ul>{preview.issues.map((issue,index)=><li key={index}>{issue.message}</li>)}</ul>
    </section>}
    {(busy||automatic)&&<p role="status">{automatic?'Restoring session…':'Opening session…'}</p>}
    {!automatic&&<div className="recovery-actions">
      {unavailable?<button type="button" className="primary" disabled={busy} onClick={()=>{if(!busy)onStartNew();}}>Start new session</button>:<>
        <button type="button" className="primary" disabled={busy} onClick={()=>{if(!busy)onRestore();}}>Restore</button>
        <button type="button" disabled={busy} onClick={()=>{if(!busy)onDiscard();}}>Discard recovery</button>
      </>}
    </div>}
  </section></div>;
}
