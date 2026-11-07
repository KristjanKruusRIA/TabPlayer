import { useEffect, useMemo, useState } from 'react';
import type { TrackSound } from '../edit-types';
import { useI18n } from '../i18n';
import { ampCaptures, captureNotice, onCaptureLibrary, type CaptureStatus } from './amp-capture';
import './sound-panel.css';

/** The captures in use: one for each amp that is on and names one, in a pedalboard or its second. */
function captureUses(sounds:Record<string,TrackSound>|undefined){
  const uses:{trackId:string;id:string;name:string}[]=[];
  for(const [trackId,sound] of Object.entries(sounds??{})){
    for(const board of [sound.effects,...(sound.effects.second?[sound.effects.second]:[])]){
      const capture=board.amp.capture;
      if(board.amp.enabled&&capture)uses.push({trackId,id:capture.id,name:capture.name});
    }
  }
  return uses;
}
/**
 * What to tell about the captures a document's sounds name that this computer's library cannot supply, one line each,
 * with the track. Asked again when the library changes. It reads the document and never changes it.
 */
export function useCaptureNotices(sounds:Record<string,TrackSound>|undefined,trackNames?:Record<string,string>):string[] {
  const {t}=useI18n();
  const uses=useMemo(()=>captureUses(sounds),[sounds]);
  const ids=useMemo(()=>[...new Set(uses.map(use=>use.id))],[uses]);
  const key=ids.join(',');
  const [found,setFound]=useState<{key:string;status:CaptureStatus[]}>({key:'',status:[]});
  const [changed,setChanged]=useState(0);
  useEffect(()=>onCaptureLibrary(()=>setChanged(count=>count+1)),[]);
  useEffect(()=>{
    // A document that names no capture never asks the library anything.
    if(!ids.length)return;
    let alive=true;
    ampCaptures.status(ids).then(status=>{if(alive)setFound({key,status});},()=>{});
    return()=>{alive=false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,changed]);
  return useMemo(()=>{
    if(!ids.length||found.key!==key)return [];
    const lines:string[]=[];
    for(const use of uses){
      const text=captureNotice(use.name,found.status.find(item=>item.id===use.id),(k,values)=>t(k,values));
      const track=trackNames?.[use.trackId];
      if(text)lines.push(track?`${track}: ${text}`:text);
    }
    return [...new Set(lines)];
  },[uses,ids,found,key,trackNames,t]);
}
/** The notices for the captures a document cannot find, shown where the document is open and in the export. */
export function CaptureNotices({sounds,trackNames,className='cabinet-notices'}:{sounds:Record<string,TrackSound>|undefined;trackNames?:Record<string,string>;className?:string}) {
  const notices=useCaptureNotices(sounds,trackNames);
  if(!notices.length)return null;
  return <div className={className}>{notices.map(text=><p key={text} className="sound-ir-notice" role="status">{text}</p>)}</div>;
}
