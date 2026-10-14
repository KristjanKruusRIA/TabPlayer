import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nativeBridge } from './bridge';
import { DocumentController } from './controller';
import { App } from './App';

DocumentController.create(nativeBridge).then(async controller=>{
  await getCurrentWindow().onCloseRequested(async event=>{
    event.preventDefault(); if(await controller.requestClose().catch(()=>false)) await getCurrentWindow().destroy();
  });
  createRoot(document.getElementById('root')!).render(<App controller={controller}/>);
})
  .catch(error=>{document.getElementById('root')!.textContent=`Could not open TabPlayer: ${String(error)}`;});
