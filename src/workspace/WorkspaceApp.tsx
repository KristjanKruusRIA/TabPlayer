import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useSyncExternalStore,type KeyboardEvent } from 'react';
import { App } from '../App';
import { createDocumentBridge } from '../bridge';
import { createDocumentAudioBridge } from '../audio/bridge';
import { createDocumentBackingWaveformBridge } from '../audio/backing-waveform-bridge';
import { createDocumentExportBridge } from '../export/bridge';
import { DocumentTabs } from './DocumentTabs';
import type { WorkspaceController } from './WorkspaceController';
import type { WorkspaceLibrary,WorkspaceLibraryState } from './WorkspaceLibrary';
import { LibraryDialog } from '../library/LibraryDialog';
import type { LibrarySection } from '../library/types';
import type { DocumentViewState } from './types';
import type { RecoveryIssue,RecoveryStatus,SessionPreferences } from './recovery-types';
import { useI18n } from '../i18n';
import './document-tabs.css';

export interface WorkspaceSession {
  preferences:SessionPreferences;status:RecoveryStatus;error:string|null;issues:readonly RecoveryIssue[];pending:boolean;
  onPreferencesChange:(value:boolean)=>void;onRetry:()=>void;
}
const noLibrarySubscribe=()=>()=>{};
const noLibraryState:WorkspaceLibraryState={open:false,welcome:false,error:null,closeReason:null};
export function WorkspaceApp({workspace,session,library}:{workspace:WorkspaceController;session?:WorkspaceSession;library?:WorkspaceLibrary}) {
  const { t } = useI18n();
  const state=useSyncExternalStore(workspace.subscribe,workspace.getState);
  const libraryState=useSyncExternalStore(library?.subscribe??noLibrarySubscribe,library?.getState??(()=>noLibraryState));
  const {documentId,activationId}=state.active;
  const active=state.documents.find(entry=>entry.id===documentId)!;
  const panel=useRef<HTMLDivElement>(null),tabFocus=useRef(false);
  const focusIntent=useRef<{activationId:string;origin:Element|null}|null>(null);
  const libraryInvoker=useRef<HTMLElement|null>(null);
  const audio=useMemo(()=>createDocumentAudioBridge({documentId,activationId}),[documentId,activationId]);
  const waveform=useMemo(()=>createDocumentBackingWaveformBridge({documentId,activationId}),[documentId,activationId]);
  const exports=useMemo(()=>createDocumentExportBridge(documentId),[documentId]);
  const documentBridge=useMemo(()=>createDocumentBridge(documentId),[documentId]);
  const onViewChange=useCallback((view:DocumentViewState)=>workspace.setView(documentId,view),[workspace,documentId]);
  const beginEditorOperation=useCallback(()=>workspace.beginEditorOperation(documentId),[workspace,documentId]);
  const perform=useCallback((action:()=>Promise<boolean>)=>{
    focusIntent.current={activationId:workspace.getState().active.activationId,origin:document.activeElement};
    return action();
  },[workspace]);
  const onNew=useCallback(()=>perform(()=>workspace.newDocument()),[workspace,perform]);
  const onOpen=useCallback(()=>perform(()=>workspace.openDocument()),[workspace,perform]);
  const onImportConverted=useCallback((name:string,bytes:Uint8Array)=>perform(()=>workspace.importConverted(name,bytes)),[workspace,perform]);
  const onClose=useCallback(()=>perform(()=>workspace.close(documentId)),[workspace,documentId,perform]);
  const onCloseAll=useCallback(()=>perform(()=>workspace.closeAll()),[workspace,perform]);
  useLayoutEffect(()=>{
    if(state.busy)return;
    const intent=focusIntent.current;focusIntent.current=null;
    if(intent&&intent.activationId===activationId&&intent.origin?.isConnected){if(intent.origin instanceof HTMLElement)intent.origin.focus();}
    else if(intent||tabFocus.current)panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  },[activationId,state.busy]);
  const run=(job:Promise<unknown>)=>{void job.catch(()=>{});};
  useEffect(()=>{
    if(!library)return;
    if(libraryState.open){library.shown();return;}
    if(!libraryState.closeReason)return;
    const reason=libraryState.closeReason,opener=library.opener;
    queueMicrotask(()=>{
      if(library.getState().open)return;
      if(reason==='opened')panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
      else if(opener?.isConnected){const disclosure=opener.closest('details');if(disclosure)disclosure.open=true;opener.focus();}
    });
  },[library,libraryState.open,libraryState.closeReason]);
  const captureLibraryInvoker=(element:HTMLElement)=>{libraryInvoker.current=element.closest<HTMLElement>('[data-library-section]');};
  function showLibrary(section:LibrarySection,button:HTMLButtonElement){
    if(!library)return;const opener=libraryInvoker.current??button;libraryInvoker.current=null;
    const disclosure=opener.closest('details');if(disclosure)disclosure.open=true;opener.focus();library.show(section,opener);
  }
  const libraryMenu=library&&<section aria-label={t('library.menu_section')}>
    {([['recent',t('library.menu_library')],['recent',t('library.menu_recent')],['templates',t('library.menu_templates')],['examples',t('library.menu_examples')],['templates',t('library.menu_save_template')]] as const).map(([section,label])=><button key={label} data-library-section={section} disabled={state.busy||!!session?.pending} onClick={event=>showLibrary(section,event.currentTarget)}>{label}</button>)}
    <button disabled={state.busy||!!session?.pending||!active.controller.getState().snapshot.path} onClick={()=>run(library.reveal())}>{t('library.open_containing_folder')}</button>
  </section>;
  function keys(event:KeyboardEvent) {
    const target=event.target;
    if(!(event.ctrlKey||event.metaKey)||event.altKey||!(target instanceof Element)||target.closest('input,select,textarea,[contenteditable="true"],[role="dialog"]'))return;
    const key=event.key.toLowerCase();if(key!=='w'&&key!=='tab')return;
    event.preventDefault();event.stopPropagation();
    if(state.busy||event.repeat)return;
    if(key==='w')run(onClose());
    else {const index=state.documents.indexOf(active),next=(index+(event.shiftKey?-1:1)+state.documents.length)%state.documents.length;run(perform(()=>workspace.activate(state.documents[next].id)));}
  }
  const tabs=state.documents.map(entry=>{const value=entry.controller.getState();return {id:entry.id,title:value.score.title,path:value.snapshot.path,dirty:value.snapshot.dirty,locked:value.snapshot.project.lock?.kind==='finalized'};});
  const backupError=state.recoveryError ?? (session?.status.state==='failed'?session.status.error:null);
  const backupState=session?.status.state;
  const backupTime=session?.status.capturedAtUnixMs===null||session?.status.capturedAtUnixMs===undefined?null:new Date(session.status.capturedAtUnixMs);
  const backupText=backupError?t('session.backup_failed_error', { error: backupError }):backupState==='failed'?t('session.backup_failed'):backupState==='writing'?t('session.backup_updating'):backupState==='pending'?t('session.backup_pending'):backupState==='ready'?t('session.backup_complete'):t('session.backup_none');
  const sessionMenu=session&&<section className="session-options" aria-label={t('session.settings')}>
    <label className="check"><input type="checkbox" checked={session.preferences.restorePreviousSession} disabled={session.pending||state.busy} onChange={event=>session.onPreferencesChange(event.target.checked)}/>{t('session.restore_previous_session')}</label>
  </section>;
  const recoveryStatus=session&&<div className="recovery-feedback">
    <span className="recovery-status" role="status">{backupText}{backupTime&&Number.isFinite(backupTime.getTime())&&<> {t('session.last_backup')}<time dateTime={backupTime.toISOString()}>{backupTime.toLocaleTimeString()}</time>.</>}</span>
    {session.status.state==='ready'&&session.status.error&&<span className="recovery-status">{session.status.error}</span>}
    {(backupError||backupState==='failed')&&<button disabled={session.pending} onClick={session.onRetry}>{t('action.retry')}</button>}
    {session.error&&<span className="session-error" role="alert">{session.error}</span>}
    {session.issues.length>0&&<details className="recovery-notices"><summary>{t('session.details_count', { count: session.issues.length })}</summary><ul>{session.issues.map((issue,index)=><li key={index}>{issue.message}</li>)}</ul></details>}
  </div>;
  return <div ref={panel} role="tabpanel" id={`document-panel-${encodeURIComponent(documentId)}`} aria-labelledby={`document-tab-${encodeURIComponent(documentId)}`}
    onKeyDownCapture={keys} onFocusCapture={event=>{tabFocus.current=event.target instanceof Element&&!!event.target.closest('[role="tablist"]');}}>
    <App key={activationId} controller={active.controller} audioBridge={audio} waveformBridge={waveform} exportBridge={exports} documentBridge={documentBridge}
      documentView={active.view} onViewChange={onViewChange} clipboard={workspace.clipboard} workspaceBusy={state.busy} workspaceError={state.error} playbackResumeEpoch={state.playbackResumeEpoch}
      beginEditorOperation={beginEditorOperation} onNew={onNew} onOpen={onOpen} onImportConverted={onImportConverted} onClose={onClose} onCloseAll={onCloseAll}
      sessionMenu={sessionMenu} libraryMenu={libraryMenu} onFileCommandCapture={captureLibraryInvoker} recoveryStatus={<>{recoveryStatus}{libraryState.error&&<p className="session-error" role="alert">{libraryState.error}</p>}</>}
      documentTabs={<DocumentTabs tabs={tabs} activeId={documentId} disabled={state.busy} onActivate={id=>run(perform(()=>workspace.activate(id)))} onClose={id=>run(perform(()=>workspace.close(id)))}/>}/>
    {library&&libraryState.open&&<LibraryDialog controller={library.controller} welcome={libraryState.welcome} onClose={()=>library.close()}/>}
  </div>;
}
