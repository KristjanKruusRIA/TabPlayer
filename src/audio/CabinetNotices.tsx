import { useEffect, useMemo, useState } from 'react';
import type { FxSettings, TrackSound } from '../edit-types';
import { cabinetIrs, irNotice, onCabinetLibrary, type CabinetIrStatus } from './cabinet-ir';
import './sound-panel.css';

/** The cabinet responses in use: one for each cabinet that is on and names one, in a pedalboard or its second. */
function cabinetUses(sounds:Record<string,TrackSound>|undefined){
  const uses:{trackId:string;id:string;name:string;model:string}[]=[];
  for(const [trackId,sound] of Object.entries(sounds??{})){
    const boards:FxSettings[]=[sound.effects,...(sound.effects.second?[sound.effects.second]:[])];
    for(const board of boards){
      const ir=board.cabinet.ir;
      if(board.cabinet.enabled&&ir)uses.push({trackId,id:ir.id,name:ir.name,model:board.cabinet.model});
    }
  }
  return uses;
}
/**
 * What to tell about the cabinet responses a document's sounds name that this computer's library cannot supply, one
 * line each, with the track. Asked again when the library changes. It reads the document and never changes it.
 */
export function useCabinetNotices(sounds:Record<string,TrackSound>|undefined,trackNames?:Record<string,string>):string[] {
  const uses=useMemo(()=>cabinetUses(sounds),[sounds]);
  const ids=useMemo(()=>[...new Set(uses.map(use=>use.id))],[uses]);
  const key=ids.join(',');
  const [found,setFound]=useState<{key:string;status:CabinetIrStatus[]}>({key:'',status:[]});
  const [changed,setChanged]=useState(0);
  useEffect(()=>onCabinetLibrary(()=>setChanged(count=>count+1)),[]);
  useEffect(()=>{
    // A document that names no response never asks the library anything.
    if(!ids.length)return;
    let alive=true;
    cabinetIrs.status(ids).then(status=>{if(alive)setFound({key,status});},()=>{});
    return()=>{alive=false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,changed]);
  return useMemo(()=>{
    if(!ids.length||found.key!==key)return [];
    const lines:string[]=[];
    for(const use of uses){
      const text=irNotice(use.name,found.status.find(item=>item.id===use.id),use.model.replace(/[A-Z]/g,letter=>` ${letter.toLowerCase()}`));
      const track=trackNames?.[use.trackId];
      if(text)lines.push(track?`${track}: ${text}`:text);
    }
    return [...new Set(lines)];
  },[uses,ids,found,key,trackNames]);
}
/** The notices for the cabinet responses a document cannot find, shown where the document is open and in the export. */
export function CabinetNotices({sounds,trackNames,className='cabinet-notices'}:{sounds:Record<string,TrackSound>|undefined;trackNames?:Record<string,string>;className?:string}) {
  const notices=useCabinetNotices(sounds,trackNames);
  if(!notices.length)return null;
  return <div className={className}>{notices.map(text=><p key={text} className="sound-ir-notice" role="status">{text}</p>)}</div>;
}
