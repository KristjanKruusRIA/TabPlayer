import { invoke } from '@tauri-apps/api/core';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import type { EditCommand } from './project';
import type { DocumentId,DocumentSnapshot,NativeWorkspaceBridge } from './workspace/types';
import {readExportBackingAsset} from './export/backing-asset-read';

export interface NativeBridge {
  readonly documentId:DocumentId;
  snapshot(): Promise<DocumentSnapshot>;
  cancelAsset(token: string): Promise<boolean>;
  applyEdit(command: EditCommand, revision:number, assetToken?:string): Promise<DocumentSnapshot>;
  undo(revision:number): Promise<DocumentSnapshot>;
  redo(revision:number): Promise<DocumentSnapshot>;
  saveProject(saveAs: boolean,revision:number): Promise<DocumentSnapshot | null>;
  exportGp(bytes: Uint8Array,revision:number): Promise<boolean>;
  readBackingAsset(assetId:string,revision:number):Promise<Uint8Array>;
  askUnsaved(title:string,path:string|null): Promise<'save' | 'discard' | 'cancel'>;
  confirmExport(): Promise<boolean>;
}

const desktopTest=import.meta.env.VITE_DESKTOP_TEST==='1';
export const nativeWorkspaceBridge:NativeWorkspaceBridge={
  snapshot:()=>invoke('workspace_snapshot'),
  readDocument: () => desktopTest?invoke('desktop_test_io',{action:'read'}):invoke('read_document'),
  createBlankDocument: () => invoke('new_document'),
  cancelDocument: token => invoke('cancel_document',{token}),
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
  saveProject: async (saveAs,revision) => {
    const record=await (desktopTest?invoke<DocumentSnapshot|null>('desktop_test_io',{action:'save',documentId,revision}):invoke<DocumentSnapshot|null>('save_project',{document:{documentId,revision},saveAs}));
    if(record?.documentId===documentId&&observer)void Promise.resolve().then(()=>observer.saved(record)).catch(error=>observer.failed(error));
    return record;
  },
  exportGp: (bytes,revision) => desktopTest?invoke('desktop_test_io',{action:'export',documentId,revision,bytes:Array.from(bytes)}):invoke('export_gp',{document:{documentId,revision},bytes:Array.from(bytes)}),
  readBackingAsset: (assetId,revision) => readExportBackingAsset({document:{documentId,revision},assetId}),
  askUnsaved: async (title,path) => {
    const result = await message(`Save changes to “${title}” before closing?${path?`\n${path}`:''}`,{title:'Unsaved score',kind:'warning',buttons:{yes:'Save',no:'Discard',cancel:'Cancel'}});
    return result === 'Yes' || result === 'Save' ? 'save' : result === 'No' || result === 'Discard' ? 'discard' : 'cancel';
  },
  confirmExport: () => desktopTest?Promise.resolve(true):confirm('Guitar Pro export rebuilds the score. Some techniques, layout, or sound settings may change. Your native project and original file are preserved.',{title:'Export Guitar Pro file',kind:'warning'}),
  };
}
