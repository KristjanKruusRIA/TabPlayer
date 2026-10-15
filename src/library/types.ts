import type { DocumentIntake, DocumentRevision } from '../workspace/types';

export type LibrarySection='recent'|'templates'|'folders'|'examples';
export type LibrarySource={kind:'recent';id:string}|{kind:'indexed';rootId:string;id:string}
  |{kind:'template';id:string}|{kind:'example';id:string};
export interface LibraryMetadata {title:string;artist:string;album:string;trackNames:string[];metadataTruncated:boolean}
export interface RecentEntry {id:string;path:string;metadata:LibraryMetadata|null;pinned:boolean;lastOpenedUnixMs:number;availability:'available'|'missing'|'unreadable'|'unknown'}
export interface LibraryRoot {id:string;path:string;configurationRevision:number;availability:'available'|'missing'|'unreadable'|'unknown';indexedAtUnixMs:number|null}
export interface LibraryContent {id:string;title:string;description:string;instruments:string[];origin:'factory'|'personal'|'example';license:string|null;sha256:string}
export interface LibrarySnapshot {version:1;revision:number;welcomeSeen:boolean;recents:RecentEntry[];roots:LibraryRoot[];templates:LibraryContent[];examples:LibraryContent[];warning:string|null}
export interface BundledLibrary {templates:LibraryContent[];examples:LibraryContent[]}
export type LibraryChange={kind:'pin';id:string;pinned:boolean}|{kind:'removeRecent';id:string}
  |{kind:'removeRoot';id:string}|{kind:'renameTemplate';id:string;name:string}
  |{kind:'removeTemplate';id:string}|{kind:'welcomeSeen'};
export interface LibraryQuery {rootId:string|null;text:string;sort:'title'|'artist'|'modified';offset:number;limit:100}
export interface LibraryResult {id:string;rootId:string;path:string;metadata:LibraryMetadata|null;status:'indexed'|'metadataUnavailable'|'unavailable';modifiedUnixMs:number|null}
export interface LibraryPage {indexRevision:number;total:number;rows:LibraryResult[];warning:string|null}
export interface LibraryScan {jobId:string;rootId:string;configurationRevision:number;phase:'enumerating'|'reading'|'parsing'|'ready'|'failed'|'cancelled';discovered:number;processed:number;skipped:number;issues:string[]}
export interface LibraryBatch {scan:LibraryScan;files:{fileId:string;filename:string}[];done:boolean}
export type MetadataEdit={type:'setScoreInfo';title:string;artist:string}|{type:'setScoreMetadata';album:string}
  |{type:'setTrackInfo';track:number;name:string}
  |{type:'addTrack'|'addPitchedTrack'|'addPercussionTrack';name:string}|{type:'removeTrack';track:number};
export interface MetadataInput {sha256:string;base:{kind:'blank';title:string;artist:string}|{kind:'file';bytesBase64:string};edits:MetadataEdit[]}
export interface MetadataResult {sha256:string;metadata:LibraryMetadata|null;error:string|null}
export interface FileLibraryChangedEvent {revision:number;warning:string|null}
export interface ScoreFilesDroppedEvent {dropToken:string;count:number}

export interface NativeFileLibraryBridge {
  snapshot():Promise<LibrarySnapshot>;
  retry():Promise<LibrarySnapshot>;
  change(expectedRevision:number,change:LibraryChange):Promise<LibrarySnapshot>;
  pickRoot(expectedRevision:number):Promise<LibrarySnapshot|null>;
  saveTemplate(expectedRevision:number,document:DocumentRevision,name:string):Promise<LibrarySnapshot>;
  ackMetadata(document:DocumentRevision,metadata:LibraryMetadata):Promise<LibrarySnapshot>;
  stage(source:LibrarySource):Promise<DocumentIntake>;
  scanBegin(rootId:string):Promise<LibraryScan>;
  scanNext(jobId:string):Promise<LibraryBatch>;
  scanRead(jobId:string,fileId:string):Promise<MetadataInput>;
  scanAccept(jobId:string,fileId:string,result:MetadataResult):Promise<LibraryScan>;
  scanFinish(jobId:string):Promise<LibrarySnapshot>;
  scanCancel(jobId:string):Promise<void>;
  search(query:LibraryQuery):Promise<LibraryPage>;
  reveal(document:DocumentRevision):Promise<void>;
  dropStage(dropToken:string,index:number):Promise<DocumentIntake>;
}
