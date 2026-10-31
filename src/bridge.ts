import { invoke } from '@tauri-apps/api/core';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import type { DocumentLock, EditCommand } from './project';
import type { ProtectionRequest } from './protection/protection';
import type { DocumentId,DocumentSnapshot,NativeWorkspaceBridge } from './workspace/types';
import {readExportBackingAsset} from './export/backing-asset-read';
import { newScoreDefaults } from './workspace/author-defaults';

export interface NativeBridge {
  readonly documentId:DocumentId;
  snapshot(): Promise<DocumentSnapshot>;
  cancelAsset(token: string): Promise<boolean>;
  applyEdit(command: EditCommand, revision:number, assetToken?:string): Promise<DocumentSnapshot>;
  undo(revision:number): Promise<DocumentSnapshot>;
  redo(revision:number): Promise<DocumentSnapshot>;
  /** Finalizes or unfinalizes the document. The lock is not an edit and has no history entry. */
  setLock(lock:DocumentLock|null,revision:number): Promise<DocumentSnapshot>;
  /** Sets, changes or removes a password, or gives or withdraws the password to edit. Not an edit: no history entry. Absent bridges have no passwords. */
  protect?(request:ProtectionRequest,revision:number): Promise<DocumentSnapshot>;
  /** Marks a score read from a file as one whose partial capo applies; not an edit. Absent bridges leave the project unmarked. */
  markPartialCapo?(revision:number): Promise<DocumentSnapshot>;
  saveProject(saveAs: boolean,revision:number): Promise<DocumentSnapshot | null>;
  exportGp(bytes: Uint8Array,revision:number,fileName?:string): Promise<boolean>;
  readBackingAsset(assetId:string,revision:number):Promise<Uint8Array>;
  askUnsaved(title:string,path:string|null): Promise<'save' | 'discard' | 'cancel'>;
  /** Asks before a Guitar Pro export; `detail` replaces the general warning with what this export leaves out. */
  confirmExport(detail?:{title:string;message:string}): Promise<boolean>;
}

const desktopTest=import.meta.env.VITE_DESKTOP_TEST==='1';
export const nativeWorkspaceBridge:NativeWorkspaceBridge={
  snapshot:()=>invoke('workspace_snapshot'),
  readDocument: () => desktopTest?invoke('desktop_test_io',{action:'read'}):invoke('read_document'),
  createBlankDocument: () => invoke('new_document',{defaults:newScoreDefaults()}),
  importConverted:(name,bytes)=>invoke('import_converted',{name,bytes:Array.from(bytes)}),
  cancelDocument: token => invoke('cancel_document',{token}),
  unlockDocument: (token,password) => invoke('unlock_locked_document',{token,password}),
  addDocument:token=>invoke('workspace_add',{token}),
  activateDocument:documentId=>invoke('workspace_activate',{documentId}),
  closeDocuments:documents=>invoke('workspace_close',{documents}),
};
export interface DocumentSaveObserver {saved(record:DocumentSnapshot):void|Promise<void>;failed(error:unknown):void}
export function createDocumentBridge(documentId:DocumentId,observer?:DocumentSaveObserver):NativeBridge {
  return {
  documentId,
  snapshot: () => invoke('project_snapshot',{documentId}),
  cancelAsset: token => invoke('cancel_asset',{documentId,token}),
  applyEdit: (command,revision,assetToken) => invoke('apply_edit',{document:{documentId,revision},command,assetToken}),
  undo: revision => invoke('undo_edit',{document:{documentId,revision}}), redo: revision => invoke('redo_edit',{document:{documentId,revision}}),
  setLock: (lock,revision) => invoke('document_set_lock',{document:{documentId,revision},lock}),
  protect: (request,revision) => invoke('document_protection',{document:{documentId,revision},request}),
  markPartialCapo: revision => invoke('document_mark_partial_capo',{document:{documentId,revision}}),
  saveProject: async (saveAs,revision) => {
    const record=await (desktopTest?invoke<DocumentSnapshot|null>('desktop_test_io',{action:'save',documentId,revision}):invoke<DocumentSnapshot|null>('save_project',{document:{documentId,revision},saveAs}));
    if(record?.documentId===documentId&&observer)void Promise.resolve().then(()=>observer.saved(record)).catch(error=>observer.failed(error));
    return record;
  },
  exportGp: (bytes,revision,fileName) => desktopTest?invoke('desktop_test_io',{action:'export',documentId,revision,bytes:Array.from(bytes)}):invoke('export_gp',{document:{documentId,revision},bytes:Array.from(bytes),fileName:fileName??null}),
  readBackingAsset: (assetId,revision) => readExportBackingAsset({document:{documentId,revision},assetId}),
  askUnsaved: async (title,path) => {
    const result = await message(`Save changes to “${title}” before closing?${path?`\n${path}`:''}`,{title:'Unsaved score',kind:'warning',buttons:{yes:'Save',no:'Discard',cancel:'Cancel'}});
    return result === 'Yes' || result === 'Save' ? 'save' : result === 'No' || result === 'Discard' ? 'discard' : 'cancel';
  },
  confirmExport: detail => desktopTest?Promise.resolve(true):confirm(detail?.message??'Guitar Pro export rebuilds the score. Some techniques, layout, or sound settings may change. Your native project and original file are preserved.',{title:detail?.title??'Export Guitar Pro file',kind:'warning'}),
  };
}
