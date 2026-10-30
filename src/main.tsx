import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { nativeWorkspaceBridge } from './bridge';
import { buildDocument } from './engine';
import { admitDocumentBase } from './interchange/archive-gate';
import { WorkspaceController } from './workspace/WorkspaceController';
import { WorkspaceApp } from './workspace/WorkspaceApp';
import { RecoveryPrompt } from './workspace/RecoveryPrompt';
import { nativeSessionBridge } from './workspace/session-bridge';
import type { RecoveryIssue,RecoveryPreview,RecoveryStatus,SessionPreferences } from './workspace/recovery-types';
import { nativeFileLibraryBridge } from './library/bridge';
import { createMetadataRunner } from './library/metadata-runner';
import { WorkspaceLibrary } from './workspace/WorkspaceLibrary';
import type { FileLibraryChangedEvent,ScoreFilesDroppedEvent } from './library/types';

const root=createRoot(document.getElementById('root')!);
let workspace:WorkspaceController|null=null,preview:RecoveryPreview|null=null;
let startupToken:string|null=null,statusSequence=0;
let preferences:SessionPreferences={version:1,restorePreviousSession:true};
let status:RecoveryStatus={state:'idle',capturedAtUnixMs:null,generation:null,error:null};
let pending=false,sessionError:string|null=null,resumeFailure:string|null=null;
let library:WorkspaceLibrary|undefined,closing=false,destroyed=false;
const libraryUnlisteners:(()=>void)[]=[];
let issues:RecoveryIssue[]=[];
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
function retainLibraryListener(unlisten:()=>void){if(destroyed)void Promise.resolve().then(unlisten).catch(()=>{});else libraryUnlisteners.push(unlisten);}

function renderWorkspace() {
  if(!workspace||destroyed)return;
  root.render(<WorkspaceApp workspace={workspace} library={library} session={{preferences,status:resumeFailure!==null?{...status,state:'failed',error:'Recovery could not resume. Retry to enable editing.'}:status,error:sessionError,issues,pending,
    onPreferencesChange:value=>{void changePreference(value);},onRetry:()=>{void retry();}}}/>);
}
function renderPreview() {
  root.render(<>{preview?<RecoveryPrompt preview={preview} busy={pending} onRestore={()=>{void resolve(true);}} onDiscard={()=>{void resolve(false);}} onStartNew={()=>{void resolve(false);}}/>:<p className="startup-state" role="status">Opening TabPlayer…</p>}{sessionError&&<p className="startup-state" role="alert">{sessionError}</p>}</>);
}
async function resolve(restore:boolean) {
  if(pending)return;
  pending=true;renderPreview();
  try {
    const result=await nativeSessionBridge.resolve(startupToken,restore?preview!.documents.map(document=>document.documentId):[]);
    const seen=new Set<string>();
    issues=[...(preview?.issues ?? []),...result.issues].filter(issue=>{const key=JSON.stringify(issue);if(seen.has(key))return false;seen.add(key);return true;});
    // Only restored documents keep a native view; a fresh startup blank starts in the saved default view.
    const restoredIds=new Set(restore?preview!.documents.map(document=>document.documentId):[]);
    const views=Object.fromEntries(Object.entries(result.views).filter(([documentId])=>restoredIds.has(documentId)));
    workspace=await WorkspaceController.create(nativeWorkspaceBridge,{workspace:result.workspace,views});
    workspace.setSessionBridge(nativeSessionBridge);
    try {await refreshStatus();}
    catch(error){status={...status,state:'failed',error:message(error)};}
    pending=false;renderWorkspace();
    const restoredWorkingDocument=restore&&!!preview?.documents.some(document=>result.workspace.documents.some(record=>record.documentId===document.documentId));
    try {
      const created=await WorkspaceLibrary.create(workspace,nativeFileLibraryBridge,createMetadataRunner(),{restoredWorkingDocument,blocked:()=>pending?'Wait for the current session operation to finish.':closing||resumeFailure!==null?'Wait until the workspace is ready before using the Library.':null});
      if(destroyed)created.dispose();else library=created;
    }catch(error){sessionError=`Library unavailable: ${message(error)}`;}
    if(!destroyed)renderWorkspace();
  } catch(error) {
    pending=false;
    preview={...(preview ?? {token:'',reason:'unavailable',documents:[],views:{},activeDocumentId:null,issues:[],capturedAtUnixMs:null}),
      issues:[...(preview?.issues ?? []),{documentId:null,message:message(error)}]};
    if(preview.reason==='clean')preview={...preview,reason:'crash'};
    renderPreview();
  }
}
async function refreshStatus() {
  const sequence=statusSequence,current=await nativeSessionBridge.status();
  if(sequence===statusSequence)status=current;
}
async function changePreference(value:boolean) {
  if(pending||workspace?.getState().busy)return;
  pending=true;sessionError=null;renderWorkspace();
  try {preferences=await nativeSessionBridge.setPreferences(value);}
  catch(error){sessionError=message(error);}
  finally {pending=false;renderWorkspace();}
}
async function retry() {
  if(pending||!workspace)return;
  pending=true;sessionError=null;renderWorkspace();
  try {
    if(resumeFailure!==null){await workspace.resumeAfterWindowCloseFailure(resumeFailure);if(workspace.getState().busy)return;resumeFailure=null;await refreshStatus();}
    else {const sequence=statusSequence,current=await workspace.retryRecovery();if(sequence===statusSequence)status=current;}
  } catch(error){status={...status,state:'failed',error:message(error)};}
  finally {pending=false;renderWorkspace();}
}

(async()=>{
  renderPreview();
  const window=getCurrentWindow();
  await window.onCloseRequested(async event=>{
    event.preventDefault();if(closing||pending)return;closing=true;
    try {if(!workspace||await workspace.requestWindowClose()){await window.destroy();destroyed=true;library?.dispose();for(const unlisten of libraryUnlisteners.splice(0))void Promise.resolve().then(unlisten).catch(()=>{});}}
    catch(error){if(workspace){await workspace.resumeAfterWindowCloseFailure(error);if(workspace.getState().busy)resumeFailure=message(error);renderWorkspace();}}
    finally {closing=false;}
  });
  await listen<RecoveryStatus>('recovery-status',event=>{statusSequence++;status=event.payload;renderWorkspace();});
  try {
    retainLibraryListener(await listen<FileLibraryChangedEvent>('file-library-changed',event=>{if(!destroyed&&library){if(event.payload.warning)library.reportError(event.payload.warning);void library.refresh();}}));
    retainLibraryListener(await listen<ScoreFilesDroppedEvent>('score-files-dropped',event=>{
      if(destroyed)return;
      if(!workspace||!library||pending||closing||resumeFailure!==null){sessionError='Dropped scores were not opened. Finish startup or the current workspace operation, then drop them again.';if(workspace)renderWorkspace();else renderPreview();return;}
      void library.drop(event.payload);
    }));
  }catch(error){sessionError=`Library events unavailable: ${message(error)}`;}
  const startup=await nativeSessionBridge.startup();preferences=startup.preferences;preview=startup.preview?{...startup.preview,issues:[...startup.preview.issues]}:null;startupToken=preview?.token ?? null;
  const emptyClean=preview?.reason==='clean'&&preview.documents.length===0;
  if(preview) {
    const valid:typeof preview.documents=[];
    for(const document of preview.documents) {
      try {await admitDocumentBase(document.snapshot.project);buildDocument(document.snapshot.project,document.snapshot.canRedo);valid.push(document);}
      catch(error){preview.issues=[...preview.issues,{documentId:document.documentId,message:`A recovered score could not be opened: ${message(error)}`}];}
    }
    preview={...preview,documents:valid};
    if(!valid.length&&!emptyClean)preview={...preview,reason:'unavailable'};
  }
  if(!preview||emptyClean||preview.reason==='clean')await resolve(!!preview?.documents.length&&preferences.restorePreviousSession);
  else renderPreview();
})().catch(error=>{root.render(<p className="startup-state" role="alert">Could not open TabPlayer: {message(error)}</p>);});
