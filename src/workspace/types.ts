import type { TrackView } from '../engraving/view';
import type { ScoreDisplayPreferences } from '../engraving/screen-view';
import type { BeatTarget, DocumentCandidate, ProjectSnapshot } from '../project';

export type DocumentId=string;
export interface DocumentRevision {documentId:DocumentId;revision:number}
export interface DocumentSnapshot extends DocumentRevision {snapshot:ProjectSnapshot}
export interface AudioOwner {documentId:DocumentId;activationId:string}
export interface WorkspaceSnapshot {documents:DocumentSnapshot[];active:AudioOwner}
export type DocumentIntake={kind:'candidate';candidate:DocumentCandidate}|{kind:'existing';documentId:DocumentId};
export interface CloseDocument extends DocumentRevision {discard:boolean}
export interface DocumentViewState {
  target:BeatTarget;selectedString:number;selectedNoteIndex:number|null;
  zoom:number;trackView:TrackView;instrumentVisible:boolean;
  scoreDisplay?:ScoreDisplayPreferences;
}
export interface DocumentTab {id:DocumentId;title:string;path:string|null;dirty:boolean}
export interface NativeWorkspaceBridge {
  snapshot():Promise<WorkspaceSnapshot>;
  readDocument():Promise<DocumentIntake|null>;
  /** Stages a score converted in the frontend, such as imported ASCII tab, as a new untitled document. */
  importConverted?(name:string,bytes:Uint8Array):Promise<DocumentIntake>;
  createBlankDocument():Promise<DocumentCandidate>;
  cancelDocument(token:string):Promise<boolean>;
  addDocument(token:string):Promise<WorkspaceSnapshot>;
  activateDocument(documentId:DocumentId):Promise<WorkspaceSnapshot>;
  closeDocuments(documents:readonly CloseDocument[]):Promise<WorkspaceSnapshot>;
}
