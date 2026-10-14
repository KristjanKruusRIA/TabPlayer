import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AlphaTabApi } from '@coderline/alphatab';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nativeBridge } from './bridge';
import { DocumentController } from './controller';

function Desktop({controller}: {controller: DocumentController}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const container=useRef<HTMLDivElement>(null); const api=useRef<AlphaTabApi | null>(null);
  useEffect(()=>{
    const view=new AlphaTabApi(container.current!,{core:{fontDirectory:'/font/',scriptFile:'/alphatab/alphaTab.mjs'}}); api.current=view;
    view.renderScore(controller.getState().score);
    return ()=>{view.destroy();api.current=null;};
  },[controller]);
  useEffect(()=>{api.current?.renderScore(state.score);},[state.score]);
  useEffect(()=>{
    const listener=getCurrentWindow().onCloseRequested(async event=>{
      event.preventDefault(); if (await controller.requestClose().catch(()=>false)) await getCurrentWindow().destroy();
    });
    return ()=>{void listener.then(unlisten=>unlisten());};
  },[controller]);
  return <main><h1>TabPlayer</h1><nav>
    <button disabled={state.busy} onClick={()=>void controller.open().catch(()=>{})}>Open</button>
    <button disabled={state.busy} onClick={()=>void controller.save().catch(()=>{})}>Save</button>
  </nav>{state.error && <p role="alert">{state.error}</p>}<div ref={container}/></main>;
}

DocumentController.create(nativeBridge).then(controller=>createRoot(document.getElementById('root')!).render(<Desktop controller={controller}/>))
  .catch(error=>{document.getElementById('root')!.textContent=`Could not open TabPlayer: ${String(error)}`;});
