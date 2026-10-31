import { useEffect,useId,useRef,useState,type KeyboardEvent } from 'react';
import { batchKinds,runBatch,summarize,TRUNCATED_NOTE,type BatchBridge,type BatchKind,type BatchRow,type BatchScan } from './convert';
import type { Probe } from './probe';
import { nativeBatchBridge } from './bridge';
import './batch-convert.css';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
type Phase='idle'|'picking'|'scanning'|'running'|'done';

/**
 * Converts a folder of older score files to the current GP format. Source and destination are picked natively,
 * originals are only read, and the open score is never touched. The report lists every file.
 */
export function BatchConvertDialog({busy,bridge=nativeBatchBridge,probe,onClose}:{busy:boolean;bridge?:BatchBridge;probe?:Probe;onClose:()=>void}) {
  const [source,setSource]=useState<string|null>(null),[destination,setDestination]=useState<string|null>(null);
  const [kinds,setKinds]=useState<Set<BatchKind>>(()=>new Set(batchKinds.filter(kind=>kind.on).map(kind=>kind.id)));
  const [keepFolders,setKeepFolders]=useState(true),[phase,setPhase]=useState<Phase>('idle'),[problem,setProblem]=useState<string|null>(null);
  const [progress,setProgress]=useState<[number,number]>([0,0]),[rows,setRows]=useState<BatchRow[]|null>(null),[summary,setSummary]=useState('');
  const form=useRef<HTMLFormElement>(null),cancelButton=useRef<HTMLButtonElement>(null),closeButton=useRef<HTMLButtonElement>(null),cancelled=useRef(false),run=useRef<AbortController|null>(null),heading=useId(),hint=useId(),status=useId();
  const working=phase!=='idle'&&phase!=='done',running=phase==='running'||phase==='scanning';
  // Cancel also ends a file check under way. Closing forgets the folders on the native side.
  const stop=()=>{cancelled.current=true;run.current?.abort();};
  useEffect(()=>{form.current?.querySelector<HTMLElement>('button')?.focus();return ()=>{cancelled.current=true;run.current?.abort();void bridge.reset().catch(()=>{});};},[]);
  // Focus stays inside the dialog while the button that started the run is disabled, so Escape still reaches it.
  useEffect(()=>{if(running)cancelButton.current?.focus();else if(phase==='done')closeButton.current?.focus();},[running,phase]);
  const pick=async(role:'source'|'destination')=>{
    setPhase('picking');setProblem(null);
    try{
      const folder=await bridge.pickFolder(role);
      if(folder!==null){(role==='source'?setSource:setDestination)(folder);setRows(null);setSummary('');}
    }catch(error){setProblem(message(error));}
    finally{setPhase('idle');}
  };
  const toggle=(kind:BatchKind,on:boolean)=>setKinds(current=>{const next=new Set(current);if(on)next.add(kind);else next.delete(kind);return next;});
  const convert=async()=>{
    cancelled.current=false;run.current=new AbortController();setProblem(null);setRows(null);setSummary('');setPhase('scanning');
    let scan:BatchScan;
    try{
      scan=await bridge.scan(batchKinds.filter(kind=>kinds.has(kind.id)).map(kind=>kind.id));
    }catch(error){setProblem(message(error));setPhase('idle');return;}
    if(!scan.files.length&&!scan.skipped.length){setSummary(`No matching files were found.${scan.truncated?` ${TRUNCATED_NOTE}`:''}`);setPhase('done');return;}
    setPhase('running');setProgress([0,scan.files.length]);
    try{
      const result=await runBatch({bridge,scan,keepFolders,cancelled:()=>cancelled.current,signal:run.current?.signal,probe,onProgress:(done,total)=>setProgress([done,total])});
      setRows(result);setSummary(summarize(result,scan));
    }catch(error){setProblem(message(error));}
    setPhase('done');
  };
  const close=()=>{if(!working)onClose();};
  const trap=(event:KeyboardEvent)=>{
    const items=[...form.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')??[]];if(!items.length)return;
    const index=items.indexOf(document.activeElement as HTMLElement),next=event.shiftKey?(index<=0?items.length-1:index-1):(index<0||index===items.length-1?0:index+1);
    event.preventDefault();items[next].focus();
  };
  const ready=!!source&&!!destination&&kinds.size>0&&!busy&&!working;
  const text=problem??(phase==='scanning'?'Looking for scores…':phase==='running'?`Converting ${Math.min(progress[0]+1,progress[1])} of ${progress[1]}…`:summary||(source&&destination?'Ready to convert.':'Choose a source and a destination folder.'));
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close();}}>
    <form ref={form} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={hint} aria-busy={working} className="batch-convert" onSubmit={event=>{event.preventDefault();if(ready)void convert();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(running)stop();else close();}else if(event.key==='Tab')trap(event);}}>
      <h2 id={heading}>Batch convert scores</h2>
      <p id={hint} className="muted">Converts every score of the chosen types in a folder and its subfolders to the current Guitar Pro format. The originals are only read, and each result is saved as a new file. The score you have open is not changed.</p>
      <div className="batch-folder"><button type="button" disabled={working} onClick={()=>void pick('source')}>Choose source folder…</button><span aria-label="Source folder">{source??'No folder chosen'}</span></div>
      <div className="batch-folder"><button type="button" disabled={working} onClick={()=>void pick('destination')}>Choose destination folder…</button><span aria-label="Destination folder">{destination??'No folder chosen'}</span></div>
      <fieldset disabled={working}><legend>File types</legend>
        {batchKinds.map(kind=><label key={kind.id} className="check"><input type="checkbox" checked={kinds.has(kind.id)} onChange={event=>toggle(kind.id,event.target.checked)}/>{kind.label}</label>)}
        <label className="check"><input type="checkbox" checked={keepFolders} onChange={event=>setKeepFolders(event.target.checked)}/>Keep the subfolders in the destination</label>
      </fieldset>
      <p id={status} role={problem?'alert':'status'} className={problem?'error':'muted'}>{text}</p>
      {rows&&<div className="batch-report"><table aria-label="Conversion report"><thead><tr><th scope="col">File</th><th scope="col">Result</th><th scope="col">Details</th></tr></thead>
        <tbody>{rows.map((row,index)=><tr key={index} data-status={row.status}><th scope="row">{row.relative}</th><td>{row.status}</td><td>{row.detail}</td></tr>)}</tbody></table></div>}
      <div className="dialog-actions">
        <button type="submit" className="primary" disabled={!ready}>Convert</button>
        {running?<button ref={cancelButton} type="button" onClick={stop}>Cancel conversion</button>:null}
        <button ref={closeButton} type="button" disabled={working} onClick={close}>Close</button>
      </div>
    </form>
  </div>;
}
