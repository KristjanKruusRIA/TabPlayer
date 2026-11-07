import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** A NAM capture in the user's library, as the native player describes it. The file's path never reaches the page. */
export interface CaptureEntry { id:string;name:string;bytes:number }
/** Whether the library can supply a capture: `missing` when it holds none under that identity, `unreadable` when the file is damaged or has changed, `unsupported` when it is a model this version cannot play, `uncalibrated` when it can be read but produces invalid sound when its level is measured, so the built-in amp plays. */
export interface CaptureStatus { id:string;state:'ready'|'missing'|'unreadable'|'unsupported'|'uncalibrated';message:string|null }

/** The capture library: the user's own NAM captures, which live in the app's data folder. A document names a capture by identity and never holds it. */
export const ampCaptures={
  list:()=>invoke<CaptureEntry[]>('nam_capture_list'),
  /** Asks for a `.nam` file and copies it into the library; null when the dialog is cancelled, and a rejection says why a file was refused. */
  import:()=>invoke<CaptureEntry|null>('nam_capture_import'),
  remove:(id:string)=>invoke<void>('nam_capture_remove',{id}),
  status:(ids:string[])=>invoke<CaptureStatus[]>('nam_capture_status',{ids}),
};

const LIBRARY_CHANGED='tabplayer-capture-library-changed';
/** Says that the library gained or lost a capture, so whatever shows what it can supply asks again. */
export const announceCaptureLibrary=()=>{try{window.dispatchEvent(new Event(LIBRARY_CHANGED));}catch{/* No window, nothing is listening. */}};
/** Calls `listener` whenever the library gains or loses a capture, here or in the native player's event; returns how to stop. */
export const onCaptureLibrary=(listener:()=>void)=>{
  window.addEventListener(LIBRARY_CHANGED,listener);
  let stop:(()=>void)|null=null,stopped=false;
  try{listen('nam-capture-library',listener).then(off=>{if(stopped)off();else stop=off;},()=>{});}catch{/* No native event bridge, the window event still works. */}
  return()=>{stopped=true;window.removeEventListener(LIBRARY_CHANGED,listener);stop?.();};
};

/** Translates a notice key with its values, as `useI18n().t` does. */
export type Say=(key:'sound.capture_notice_missing'|'sound.capture_notice_unreadable'|'sound.capture_notice_unsupported'|'sound.capture_notice_uncalibrated',values:Record<string,string>)=>string;
/** The notice for a capture the library cannot supply, saying the built-in amp plays instead; null while it can. */
export function captureNotice(name:string,status:CaptureStatus|undefined,say:Say):string|null {
  if(!status||status.state==='ready')return null;
  const detail=status.message?` (${status.message.replace(/\.$/,'')})`:'';
  const key={missing:'sound.capture_notice_missing',unsupported:'sound.capture_notice_unsupported',uncalibrated:'sound.capture_notice_uncalibrated',unreadable:'sound.capture_notice_unreadable'} as const;
  return say(key[status.state],{name,detail});
}
