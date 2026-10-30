import { invoke } from '@tauri-apps/api/core';

/** A cabinet impulse response in the user's own library, as the native player describes it. */
export interface CabinetIrEntry { id:string;name:string;sampleRate:number;channels:number;durationMs:number;bytes:number;
  /** Said once, by an import: that a long response was cut. */notice?:string }
/** Whether the library can supply a response: `missing` when it holds none under that identity, `unreadable` when the file is damaged or has changed. */
export interface CabinetIrStatus { id:string;state:'ready'|'missing'|'unreadable';message:string|null }

/** The personal cabinet library, kept in the app's data folder. A document names a response by identity and never holds its audio. */
export const cabinetIrs={
  list:()=>invoke<CabinetIrEntry[]>('cabinet_ir_list'),
  /** Asks for a WAV file and copies it into the library; null when the dialog is cancelled, and a rejection says why a file was refused. */
  import:()=>invoke<CabinetIrEntry|null>('cabinet_ir_import'),
  remove:(id:string)=>invoke<void>('cabinet_ir_remove',{id}),
  status:(ids:string[])=>invoke<CabinetIrStatus[]>('cabinet_ir_status',{ids}),
};

const LIBRARY_CHANGED='tabplayer-cabinet-library-changed';
/** Says that the library gained or lost a response, so whatever shows what it can supply asks again. */
export const announceCabinetLibrary=()=>{try{window.dispatchEvent(new Event(LIBRARY_CHANGED));}catch{/* No window, nothing is listening. */}};
/** Calls `listener` whenever the library gains or loses a response; returns how to stop. */
export const onCabinetLibrary=(listener:()=>void)=>{window.addEventListener(LIBRARY_CHANGED,listener);return()=>window.removeEventListener(LIBRARY_CHANGED,listener);};

/** A response's length for the picker, such as `0.35 s`. */
export const irDuration=(milliseconds:number)=>`${(milliseconds/1000).toFixed(2)} s`;
/** The notice for a response the library cannot supply, saying which cabinet plays instead; null while it can. */
export function irNotice(name:string,status:CabinetIrStatus|undefined,fallback:string):string|null {
  if(!status||status.state==='ready')return null;
  return status.state==='missing'
    ?`The impulse response “${name}” is not in this computer's cabinet library, so the built-in ${fallback} cabinet plays instead. Import the file to use it; the document is unchanged.`
    :`The impulse response “${name}” cannot be read${status.message?` (${status.message.replace(/\.$/,'')})`:''}, so the built-in ${fallback} cabinet plays instead. The document is unchanged.`;
}
