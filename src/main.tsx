import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nativeWorkspaceBridge } from './bridge';
import { WorkspaceController } from './workspace/WorkspaceController';
import { WorkspaceApp } from './workspace/WorkspaceApp';

WorkspaceController.create(nativeWorkspaceBridge).then(async workspace=>{
  const window=getCurrentWindow();
  let closing=false;
  await window.onCloseRequested(async event=>{
    event.preventDefault();if(closing)return;closing=true;
    try {if(await workspace.requestWindowClose())await window.destroy();}
    catch(error){await workspace.resumeAfterWindowCloseFailure(error);}
    finally {closing=false;}
  });
  createRoot(document.getElementById('root')!).render(<WorkspaceApp workspace={workspace}/>);
})
  .catch(error=>{document.getElementById('root')!.textContent=`Could not open TabPlayer: ${String(error)}`;});
