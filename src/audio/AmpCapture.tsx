import { useCallback, useEffect, useRef, useState } from 'react';
import type { AmpCapture as AmpCaptureRef } from '../edit-types';
import { useI18n } from '../i18n';
import { busyGuard, busySelect } from '../ui';
import { ampCaptures, announceCaptureLibrary, captureNotice, onCaptureLibrary, type CaptureEntry, type CaptureStatus } from './amp-capture';

/**
 * Picks a NAM capture for an amp block from the user's capture library, imports one, takes one out of the library and
 * trims its level. The capture plays in place of the built-in amp while the library has it; where it does not, a notice
 * says so and the built-in amp plays, and nothing in the document changes.
 */
export function AmpCapture({value,busy=false,label=text=>text,scope,onChange,onLibraryChange}:{
  value:AmpCaptureRef|undefined;
  busy?:boolean;
  /** Names a control for this pedalboard. */label?:(text:string)=>string;
  /** Names the sound this belongs to, so a choice made while the file dialog was open is not written to another. */scope?:string;
  onChange:(capture:AmpCaptureRef|undefined)=>void;
  /** Called when the library gains or loses a capture, so playback resolves the captures again. */
  onLibraryChange?:()=>void;
}) {
  const {t}=useI18n();
  const [entries,setEntries]=useState<CaptureEntry[]>([]),[found,setStatus]=useState<CaptureStatus>(),[message,setMessage]=useState(''),[problem,setProblem]=useState('');
  const [draft,setDraft]=useState<string|null>(null);
  const refresh=useCallback(()=>ampCaptures.list().then(setEntries,()=>setEntries([])),[]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>onCaptureLibrary(()=>{void refresh();}),[refresh]);
  const id=value?.id;
  // The file dialog is modal to the user, not to the app: when it closes the sound may have changed, so what follows reads this.
  const latest=useRef({value,scope,onChange,busy});latest.current={value,scope,onChange,busy};
  // The picker can be gone by then (another track or block was opened), and then nothing is written.
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  // The previous answer stays until the new one arrives, so a refresh does not blink the notice; one that belongs to another capture is never shown.
  const status=found&&found.id===id?found:undefined;
  useEffect(()=>{
    let alive=true;
    if(id)ampCaptures.status([id]).then(found=>{if(alive)setStatus(found.find(item=>item.id===id));},()=>{});
    return()=>{alive=false;};
  },[id,entries]);
  const listed=value?entries.find(entry=>entry.id===value.id):undefined;
  const warning=value?captureNotice(value.name,status,(key,values)=>t(key,values)):null;
  const pick=(entry:CaptureEntry)=>{if(entry.id!==value?.id)onChange({id:entry.id,name:entry.name,levelDb:value?.levelDb??0});};
  const importFile=async()=>{
    setProblem('');setMessage('');
    const opened=scope;
    try {
      const entry=await ampCaptures.import();
      if(!entry)return;
      await refresh();announceCaptureLibrary();onLibraryChange?.();
      if(!mounted.current)return;
      // The sound as it is now, not as it was when the dialog opened. A file that is the capture already named is not a
      // change; if the track changed meanwhile, nothing is written.
      const now=latest.current;let note='';
      if(now.scope!==opened)note=` ${t('sound.capture_track_changed')}`;
      else if(now.value?.id!==entry.id){
        if(now.busy)note=` ${t('sound.capture_busy')}`;
        else now.onChange({id:entry.id,name:entry.name,levelDb:now.value?.levelDb??0});
      }
      setMessage(`${t('sound.capture_imported',{name:entry.name})}${note}`);
    } catch(e) { setProblem(String(e instanceof Error?e.message:e)); }
  };
  const remove=async()=>{
    if(!value)return;
    setProblem('');setMessage('');
    try {
      await ampCaptures.remove(value.id);await refresh();announceCaptureLibrary();onLibraryChange?.();
      setMessage(t('sound.capture_removed',{name:value.name}));
    } catch(e) { setProblem(String(e instanceof Error?e.message:e)); }
  };
  /** The trim commits when the field is left or Enter is pressed, so typing a partial number loses nothing. */
  const commit=()=>{
    if(!value||draft===null)return;
    const level=Number(draft);setDraft(null);
    if(!busy&&draft.trim()!==''&&Number.isFinite(level)&&level>=-12&&level<=12&&level!==value.levelDb)onChange({...value,levelDb:level});
  };
  const name=t('sound.capture_label');
  return <div className="sound-cabinet-ir sound-amp-capture" role="group" aria-label={label(name)}>
    <label>{name}<select aria-label={label(name)} value={value?.id??''} {...busySelect(busy)} onChange={e=>{
      if(busy)return;
      const entry=entries.find(item=>item.id===e.target.value);
      if(entry)pick(entry);else if(!e.target.value&&value)onChange(undefined);
    }}>
      <option value="">{t('sound.capture_builtin')}</option>
      {entries.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
      {value&&!listed&&<option value={value.id}>{t('sound.capture_not_in_library',{name:value.name})}</option>}
    </select></label>
    <button type="button" aria-label={label(t('sound.capture_import'))} {...busyGuard({busy,onClick:()=>void importFile()})}>{t('sound.capture_import')}</button>
    <button type="button" aria-label={label(t('sound.capture_remove'))} {...busyGuard({busy,unavailable:!listed,onClick:()=>void remove()})}>{t('sound.capture_remove')}</button>
    {value&&<label>{t('sound.capture_level')}<input aria-label={label(t('sound.capture_level'))} type="number" min={-12} max={12} step={.5} value={draft??value.levelDb} aria-disabled={busy||undefined}
      onChange={e=>{if(!busy)setDraft(e.target.value);}} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')commit();else if(e.key==='Escape')setDraft(null);}}/></label>}
    {value&&status?.state==='ready'&&<p className="muted">{t('sound.capture_drive_unused')}</p>}
    {warning&&<p className="sound-ir-notice" role="status">{warning}</p>}
    {message&&<p className="muted" role="status">{message}</p>}
    {problem&&<p className="sound-ir-problem" role="alert">{problem}</p>}
    <p className="muted">{t('sound.capture_help')}</p>
  </div>;
}
