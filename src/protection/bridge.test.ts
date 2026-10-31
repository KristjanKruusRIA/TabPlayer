import { expect,it,vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createDocumentBridge,nativeWorkspaceBridge } from '../bridge';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({}))}));

it('sends a protection request to its own command at the document revision, and a password attempt to the waiting file',async()=>{
  const bridge=createDocumentBridge('document-7');
  await bridge.protect!({kind:'setOpenPassword',current:null,password:'a good long phrase'},3);
  expect(invoke).toHaveBeenLastCalledWith('document_protection',{document:{documentId:'document-7',revision:3},request:{kind:'setOpenPassword',current:null,password:'a good long phrase'}});
  await nativeWorkspaceBridge.unlockDocument!('candidate-9','a good long phrase');
  expect(invoke).toHaveBeenLastCalledWith('unlock_locked_document',{token:'candidate-9',password:'a good long phrase'});
  // A refusal reaches the caller untouched, so the dialog can show the one reason.
  vi.mocked(invoke).mockRejectedValueOnce('The password is incorrect, or this file is damaged.');
  await expect(nativeWorkspaceBridge.unlockDocument!('candidate-9','nope nope nope')).rejects.toBe('The password is incorrect, or this file is damaged.');
});
