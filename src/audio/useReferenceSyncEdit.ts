import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {BackingSettings} from '../edit-types';
import {moveReferenceEndpoint} from './reference-sync';
import type {ReferenceEditBinding,ReferenceEditOptions,ReferenceEndpoint} from './reference-sync-types';

type Session={signature:string;endpoint:ReferenceEndpoint;surface:'number'|'waveform';settings:BackingSettings;document:ReferenceEditOptions['document'];timeline:NonNullable<ReferenceEditOptions['timeline']>;durationMs:number;candidate:BackingSettings;invalid:boolean;phase:'preview'|'commit';stale:boolean;release:()=>void};
const message=(reason:unknown)=>reason instanceof Error?reason.message:String(reason);

export function useReferenceSyncEdit(options:ReferenceEditOptions):ReferenceEditBinding {
  const latest=useRef(options),session=useRef<Session|null>(null),mounted=useRef(true);latest.current=options;
  const signature=JSON.stringify([options.owner,options.document,options.sourceKey,options.settings,options.timeline?.generation]);
  const currentSignature=useRef(signature);currentSignature.current=signature;
  const [active,setActive]=useState<ReferenceEditBinding['active']>(null),[preview,setPreview]=useState<BackingSettings|null>(null),[error,setError]=useState<string|null>(null);
  const current=useCallback((draft:Session)=>!draft.stale&&currentSignature.current===draft.signature&&latest.current.visible[draft.surface]&&latest.current.isCurrent(draft.document,draft.settings),[]);
  const clear=useCallback((draft:Session)=>{
    draft.release();
    if(session.current!==draft)return;
    session.current=null;
    if(mounted.current){setActive(null);setPreview(null);}
  },[]);
  const cancel=useCallback(()=>{
    const draft=session.current;if(!draft)return;
    if(draft.phase==='preview')clear(draft);
    else {draft.stale=true;if(mounted.current){setActive(null);setPreview(null);}}
  },[clear]);
  useEffect(()=>{
    mounted.current=true;window.addEventListener('blur',cancel);
    return ()=>{mounted.current=false;window.removeEventListener('blur',cancel);cancel();};
  },[cancel]);
  useEffect(()=>{setError(null);},[signature]);
  useEffect(()=>{const draft=session.current;if(draft&&!current(draft))cancel();});
  const begin=useCallback((endpoint:ReferenceEndpoint,surface:'number'|'waveform')=>{
    const now=latest.current;
    if(session.current||now.busy||!now.visible[surface]||!now.sourceKey||!now.settings?.referenceSync||!now.timeline||!now.timeline.occurrences.length||now.durationMs===null||!Number.isFinite(now.durationMs)||now.durationMs<=0)return false;
    const settings=structuredClone(now.settings),document={...now.document};
    if(!now.isCurrent(document,settings))return false;
    try {
      const end=now.beginOperation();let released=false;
      session.current={signature:currentSignature.current,endpoint,surface,settings,document,timeline:now.timeline,durationMs:now.durationMs,candidate:settings,invalid:false,phase:'preview',stale:false,release:()=>{if(!released){released=true;end();}}};
      setActive({endpoint,surface});setPreview(null);setError(null);return true;
    }catch(reason){setError(message(reason));return false;}
  },[]);
  const update=useCallback((sourceMs:number)=>{
    const draft=session.current;if(!draft||draft.phase!=='preview')return;
    if(!current(draft)){cancel();return;}
    try {
      if(!Number.isFinite(sourceMs))throw new Error('Enter a finite source time.');
      const bounds=draft.settings.referenceSync!,original=(draft.endpoint==='entry'?bounds.entryAudioMs:bounds.exitAudioMs)-draft.settings.offsetMs;
      draft.candidate=sourceMs===original?draft.settings:moveReferenceEndpoint(draft.settings,draft.endpoint,sourceMs,draft.timeline.occurrences,draft.durationMs);
      draft.invalid=false;setPreview(draft.candidate);setError(null);
    }catch(reason){draft.invalid=true;setError(message(reason));}
  },[cancel,current]);
  const commit=useCallback(()=>{
    const draft=session.current;if(!draft||draft.phase!=='preview')return;
    if(!current(draft)||draft.invalid||JSON.stringify(draft.candidate)===JSON.stringify(draft.settings)){clear(draft);return;}
    draft.phase='commit';
    let operation:Promise<void>;
    try {operation=latest.current.onCommit(draft.candidate,draft.document);}
    catch(reason){if(mounted.current&&current(draft))setError(message(reason));clear(draft);return;}
    void Promise.resolve(operation).catch(reason=>{if(mounted.current&&current(draft))setError(message(reason));}).finally(()=>clear(draft));
  },[clear,current]);
  return useMemo(()=>({active,preview,error,begin,update,commit,cancel}),[active,preview,error,begin,update,commit,cancel]);
}
