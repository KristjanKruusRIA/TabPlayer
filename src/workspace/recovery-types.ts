import type {CloseDocument,DocumentId,DocumentSnapshot,DocumentViewState,WorkspaceSnapshot} from './types';

export interface SessionPreferences {version:1;restorePreviousSession:boolean}
export interface RecoveryIssue {documentId:DocumentId|null;message:string}
export interface RecoveryStatus {
  state:'idle'|'pending'|'writing'|'ready'|'failed';
  capturedAtUnixMs:number|null;generation:number|null;error:string|null;
}
export interface RecoveryPreview {
  token:string;reason:'crash'|'clean'|'unavailable';documents:DocumentSnapshot[];
  views:Record<DocumentId,DocumentViewState>;activeDocumentId:DocumentId|null;
  issues:RecoveryIssue[];capturedAtUnixMs:number|null;
}
export interface SessionStartup {preferences:SessionPreferences;preview:RecoveryPreview|null}
export interface SessionResolution {
  workspace:WorkspaceSnapshot;views:Record<DocumentId,DocumentViewState>;issues:RecoveryIssue[];
}
export interface NativeSessionBridge {
  startup():Promise<SessionStartup>;
  resolve(token:string|null,documentIds:readonly DocumentId[]):Promise<SessionResolution>;
  setView(documentId:DocumentId,view:DocumentViewState):Promise<void>;
  setPreferences(restorePreviousSession:boolean):Promise<SessionPreferences>;
  status():Promise<RecoveryStatus>;
  retry():Promise<RecoveryStatus>;
  shutdown(documents:readonly CloseDocument[]):Promise<void>;
  resume():Promise<void>;
}
