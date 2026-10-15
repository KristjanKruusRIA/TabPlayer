import { useCallback,useLayoutEffect,useMemo,useRef,useSyncExternalStore,type KeyboardEvent } from 'react';
import { App } from '../App';
import { createDocumentBridge } from '../bridge';
import { createDocumentAudioBridge } from '../audio/bridge';
import { createDocumentExportBridge } from '../export/bridge';
import { DocumentTabs } from './DocumentTabs';
import type { WorkspaceController } from './WorkspaceController';
import type { DocumentViewState } from './types';
import './document-tabs.css';

export function WorkspaceApp({workspace}:{workspace:WorkspaceController}) {
  const state=useSyncExternalStore(workspace.subscribe,workspace.getState);
  const {documentId,activationId}=state.active;
  const active=state.documents.find(entry=>entry.id===documentId)!;
  const panel=useRef<HTMLDivElement>(null),tabFocus=useRef(false);
  const focusIntent=useRef<{activationId:string;origin:Element|null}|null>(null);
  const audio=useMemo(()=>createDocumentAudioBridge({documentId,activationId}),[documentId,activationId]);
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
  const onClose=useCallback(()=>perform(()=>workspace.close(documentId)),[workspace,documentId,perform]);
  const onCloseAll=useCallback(()=>perform(()=>workspace.closeAll()),[workspace,perform]);
  useLayoutEffect(()=>{
    if(state.busy)return;
    const intent=focusIntent.current;focusIntent.current=null;
    if(intent&&intent.activationId===activationId&&intent.origin?.isConnected){if(intent.origin instanceof HTMLElement)intent.origin.focus();}
    else if(intent||tabFocus.current)panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  },[activationId,state.busy]);
  const run=(job:Promise<unknown>)=>{void job.catch(()=>{});};
  function keys(event:KeyboardEvent) {
    const target=event.target;
    if(!(event.ctrlKey||event.metaKey)||event.altKey||!(target instanceof Element)||target.closest('input,select,textarea,[contenteditable="true"],[role="dialog"]'))return;
    const key=event.key.toLowerCase();if(key!=='w'&&key!=='tab')return;
    event.preventDefault();event.stopPropagation();
    if(state.busy||event.repeat)return;
    if(key==='w')run(onClose());
    else {const index=state.documents.indexOf(active),next=(index+(event.shiftKey?-1:1)+state.documents.length)%state.documents.length;run(perform(()=>workspace.activate(state.documents[next].id)));}
  }
  const tabs=state.documents.map(entry=>{const value=entry.controller.getState();return {id:entry.id,title:value.score.title,path:value.snapshot.path,dirty:value.snapshot.dirty};});
  return <div ref={panel} role="tabpanel" id={`document-panel-${encodeURIComponent(documentId)}`} aria-labelledby={`document-tab-${encodeURIComponent(documentId)}`}
    onKeyDownCapture={keys} onFocusCapture={event=>{tabFocus.current=event.target instanceof Element&&!!event.target.closest('[role="tablist"]');}}>
    <App key={activationId} controller={active.controller} audioBridge={audio} exportBridge={exports} documentBridge={documentBridge}
      documentView={active.view} onViewChange={onViewChange} clipboard={workspace.clipboard} workspaceBusy={state.busy} workspaceError={state.error}
      beginEditorOperation={beginEditorOperation} onNew={onNew} onOpen={onOpen} onClose={onClose} onCloseAll={onCloseAll}
      documentTabs={<DocumentTabs tabs={tabs} activeId={documentId} disabled={state.busy} onActivate={id=>run(perform(()=>workspace.activate(id)))} onClose={id=>run(perform(()=>workspace.close(id)))}/>}/>
  </div>;
}
