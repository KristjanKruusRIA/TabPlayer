import { invoke } from '@tauri-apps/api/core';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import type { DocumentCandidate, EditCommand, Project, ProjectSnapshot } from './project';

export interface NativeBridge {
  snapshot(): Promise<ProjectSnapshot>;
  readDocument(): Promise<DocumentCandidate | null>;
  replaceProject(project: Project, path: string | null): Promise<ProjectSnapshot>;
  applyEdit(command: EditCommand): Promise<ProjectSnapshot>;
  undo(): Promise<ProjectSnapshot>;
  redo(): Promise<ProjectSnapshot>;
  saveProject(saveAs: boolean): Promise<ProjectSnapshot | null>;
  exportGp(bytes: Uint8Array): Promise<boolean>;
  askUnsaved(): Promise<'save' | 'discard' | 'cancel'>;
  confirmExport(): Promise<boolean>;
}

const desktopTest=import.meta.env.VITE_DESKTOP_TEST==='1';
export const nativeBridge: NativeBridge = {
  snapshot: () => invoke('project_snapshot'),
  readDocument: () => desktopTest?invoke('desktop_test_io',{action:'read'}):invoke('read_document'),
  replaceProject: (project,path) => invoke('replace_project',{project,path}),
  applyEdit: command => invoke('apply_edit',{command}),
  undo: () => invoke('undo_edit'), redo: () => invoke('redo_edit'),
  saveProject: saveAs => desktopTest?invoke('desktop_test_io',{action:'save'}):invoke('save_project',{saveAs}),
  exportGp: bytes => desktopTest?invoke('desktop_test_io',{action:'export',bytes:Array.from(bytes)}):invoke('export_gp',{bytes:Array.from(bytes)}),
  askUnsaved: async () => {
    const result = await message('Save your changes before continuing?',{title:'Unsaved score',kind:'warning',buttons:{yes:'Save',no:'Discard',cancel:'Cancel'}});
    return result === 'Yes' || result === 'Save' ? 'save' : result === 'No' || result === 'Discard' ? 'discard' : 'cancel';
  },
  confirmExport: () => desktopTest?Promise.resolve(true):confirm('Guitar Pro export rebuilds the score. Some imported techniques, layout, or sound settings may change. Your native project and original file are preserved.',{title:'Export Guitar Pro file',kind:'warning'}),
};
