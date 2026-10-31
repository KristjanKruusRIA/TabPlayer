import {useCallback,useEffect,useRef,useState} from 'react';
import {MAX_WAVEFORM_BUCKETS} from './backing-waveform-types';
import type {BackingWaveform,NativeBackingWaveformBridge,WaveformSourceInput} from './backing-waveform-types';
import type {DocumentRevision} from '../workspace/types';

export function useBackingWaveform({bridge,document,source,enabled}:{bridge:NativeBackingWaveformBridge;document:DocumentRevision;source:WaveformSourceInput|null;enabled:boolean}):{kind:'none'|'loading'|'ready'|'error';data:BackingWaveform|null;error:string|null;retry:()=>void} {
  const [attempt,setAttempt]=useState(0),[,render]=useState(0);
  const sourceKey=JSON.stringify([bridge.owner.documentId,bridge.owner.activationId,document.documentId,source?.kind,source?.kind==='asset'?source.assetId:source?.sourceKey,source?.kind==='embedded'?source.sha256:null]);
  const requestedKey=JSON.stringify([sourceKey,document.revision,attempt]);
  const generation=useRef({key:requestedKey,value:0});
  if(generation.current.key!==requestedKey)generation.current={key:requestedKey,value:generation.current.value+1};
  const key=JSON.stringify([requestedKey,generation.current.value]);
  const desired=useRef({bridge,document:{...document},source,enabled,key,sourceKey});
  desired.current={bridge,document:{...document},source,enabled,key,sourceKey};
  const cache=useRef<{sourceKey:string;data:BackingWaveform}|null>(null),lastSource=useRef(sourceKey);
  const error=useRef<{key:string;message:string}|null>(null),running=useRef(false),mounted=useRef(false),lifetime=useRef(0);
  // Rendering a new identity must never expose the old source, even before effects.
  if(lastSource.current!==sourceKey){lastSource.current=sourceKey;cache.current=null;error.current=null;}
  const pump=useCallback(()=>{
    const request=desired.current;
    if(!mounted.current||running.current||!request.enabled||!request.source||cache.current?.sourceKey===request.sourceKey||error.current?.key===request.key)return;
    running.current=true;
    const owner={...request.bridge.owner},document={...request.document},source={...request.source},life=lifetime.current;
    const current=()=>mounted.current&&lifetime.current===life&&desired.current.key===request.key&&desired.current.bridge.owner.documentId===owner.documentId&&desired.current.bridge.owner.activationId===owner.activationId;
    void Promise.resolve().then(()=>current()&&desired.current.enabled?request.bridge.read(document,source,MAX_WAVEFORM_BUCKETS):null).then(data=>{
      if(data===null||!current())return;
      const sameSource=data.source?.kind===source.kind&&(source.kind==='asset'?data.source.kind==='asset'&&data.source.assetId===source.assetId:data.source.kind==='embedded'&&data.source.sourceKey===source.sourceKey&&data.source.sha256===source.sha256);
      if(data.owner?.documentId!==owner.documentId||data.owner.activationId!==owner.activationId||data.document?.documentId!==document.documentId||data.document.revision!==document.revision||!sameSource)throw new Error('Waveform response does not match the current document and source.');
      cache.current={sourceKey:request.sourceKey,data};error.current=null;render(value=>value+1);
    }).catch(reason=>{
      if(current()){error.current={key:request.key,message:reason instanceof Error?reason.message:String(reason)};render(value=>value+1);}
    }).finally(()=>{running.current=false;if(mounted.current)pump();});
  },[]);
  useEffect(()=>{mounted.current=true;pump();return ()=>{mounted.current=false;lifetime.current++;cache.current=null;};},[pump]);
  useEffect(()=>{pump();},[key,enabled,pump]);
  const retry=useCallback(()=>{cache.current=null;error.current=null;setAttempt(value=>value+1);},[]);
  if(!enabled||!source)return {kind:'none',data:null,error:null,retry};
  if(cache.current?.sourceKey===sourceKey)return {kind:'ready',data:cache.current.data,error:null,retry};
  if(error.current?.key===key)return {kind:'error',data:null,error:error.current.message,retry};
  return {kind:'loading',data:null,error:null,retry};
}
