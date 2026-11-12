import { useEffect,useId,useRef,useState,type KeyboardEvent } from 'react';
import { batchCounts,batchKinds,formatBatchDetail,runBatch,type BatchBridge,type BatchKind,type BatchRow,type BatchScan,type BatchStatus } from './convert';
import type { Probe } from './probe';
import { nativeBatchBridge } from './bridge';
import { useI18n,type MessageKey } from '../i18n';
import './batch-convert.css';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
type Phase='idle'|'picking'|'scanning'|'running'|'done';
/** What a finished run came to, kept as data so it is worded in the language shown now. `counts` is null when no file matched. */
type Outcome={counts:ReturnType<typeof batchCounts>|null;truncated:boolean};
const statusKeys:Record<BatchStatus,MessageKey>={'Converted':'batch.status_converted','Failed':'batch.status_failed','Skipped':'batch.status_skipped','Not converted':'batch.status_not_converted'};
const kindKeys:Record<BatchKind,MessageKey>={gp345:'batch.kind_gp345',gpx:'batch.kind_gpx',gp:'batch.kind_gp',musicxml:'batch.kind_musicxml'};

/**
 * Converts a folder of older score files to the current GP format. Source and destination are picked natively,
 * originals are only read, and the open score is never touched. The report lists every file.
 */
export function BatchConvertDialog({busy,bridge=nativeBatchBridge,probe,onClose}:{busy:boolean;bridge?:BatchBridge;probe?:Probe;onClose:()=>void}) {
  const { t } = useI18n();
  const [source,setSource]=useState<string|null>(null),[destination,setDestination]=useState<string|null>(null);
  const [kinds,setKinds]=useState<Set<BatchKind>>(()=>new Set(batchKinds.filter(kind=>kind.on).map(kind=>kind.id)));
  const [keepFolders,setKeepFolders]=useState(true),[phase,setPhase]=useState<Phase>('idle'),[problem,setProblem]=useState<string|null>(null);
  const [progress,setProgress]=useState<[number,number]>([0,0]),[rows,setRows]=useState<BatchRow[]|null>(null),[outcome,setOutcome]=useState<Outcome|null>(null);
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
      if(folder!==null){(role==='source'?setSource:setDestination)(folder);setRows(null);setOutcome(null);}
    }catch(error){setProblem(message(error));}
    finally{setPhase('idle');}
  };
  const toggle=(kind:BatchKind,on:boolean)=>setKinds(current=>{const next=new Set(current);if(on)next.add(kind);else next.delete(kind);return next;});
  const convert=async()=>{
    cancelled.current=false;run.current=new AbortController();setProblem(null);setRows(null);setOutcome(null);setPhase('scanning');
    let scan:BatchScan;
    try{
      scan=await bridge.scan(batchKinds.filter(kind=>kinds.has(kind.id)).map(kind=>kind.id));
    }catch(error){setProblem(message(error));setPhase('idle');return;}
    if(!scan.files.length&&!scan.skipped.length){setOutcome({counts:null,truncated:scan.truncated});setPhase('done');return;}
    setPhase('running');setProgress([0,scan.files.length]);
    try{
      const result=await runBatch({bridge,scan,keepFolders,cancelled:()=>cancelled.current,signal:run.current?.signal,probe,onProgress:(done,total)=>setProgress([done,total])});
      setRows(result);setOutcome({counts:batchCounts(result),truncated:scan.truncated});
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
  const summary=outcome?(outcome.counts?[t('batch.summary_converted',{count:outcome.counts.converted}),t('batch.summary_failed',{count:outcome.counts.failed}),...(outcome.counts.skipped?[t('batch.summary_skipped',{count:outcome.counts.skipped})]:[]),...(outcome.counts.notConverted?[t('batch.summary_not_converted',{count:outcome.counts.notConverted})]:[])].join(', ')+'.':t('batch.no_matching_files'))+(outcome.truncated?` ${t('batch.truncated_note')}`:''):'';
  const text=problem??(phase==='scanning'?t('batch.looking_for_scores'):phase==='running'?t('batch.converting_progress',{current:Math.min(progress[0]+1,progress[1]),total:progress[1]}):summary||(source&&destination?t('batch.ready_to_convert'):t('batch.choose_folders_prompt')));
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close();}}>
    <form ref={form} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={hint} aria-busy={working} className="batch-convert" onSubmit={event=>{event.preventDefault();if(ready)void convert();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(running)stop();else close();}else if(event.key==='Tab')trap(event);}}>
      <h2 id={heading}>{t('batch.title')}</h2>
      <p id={hint} className="muted">{t('batch.description')}</p>
      <div className="batch-folder"><button type="button" disabled={working} onClick={()=>void pick('source')}>{t('batch.choose_source')}</button><span aria-label={t('batch.source_folder_aria')}>{source??t('batch.no_folder_chosen')}</span></div>
      <div className="batch-folder"><button type="button" disabled={working} onClick={()=>void pick('destination')}>{t('batch.choose_dest')}</button><span aria-label={t('batch.destination_folder_aria')}>{destination??t('batch.no_folder_chosen')}</span></div>
      <fieldset disabled={working}><legend>{t('batch.file_types')}</legend>
        {batchKinds.map(kind=><label key={kind.id} className="check"><input type="checkbox" checked={kinds.has(kind.id)} onChange={event=>toggle(kind.id,event.target.checked)}/>{t(kindKeys[kind.id])}</label>)}
        <label className="check"><input type="checkbox" checked={keepFolders} onChange={event=>setKeepFolders(event.target.checked)}/>{t('batch.keep_subfolders')}</label>
      </fieldset>
      <p id={status} role={problem?'alert':'status'} className={problem?'error':'muted'}>{text}</p>
      {rows&&<div className="batch-report"><table aria-label={t('batch.report_aria')}><thead><tr><th scope="col">{t('batch.col_file')}</th><th scope="col">{t('batch.col_result')}</th><th scope="col">{t('batch.col_details')}</th></tr></thead>
        <tbody>{rows.map((row,index)=><tr key={index} data-status={row.status}><th scope="row">{row.relative}</th><td>{t(statusKeys[row.status])}</td><td>{formatBatchDetail(row.detail,t)}</td></tr>)}</tbody></table></div>}
      <div className="dialog-actions">
        <button type="submit" className="primary" disabled={!ready}>{t('batch.convert_btn')}</button>
        {running?<button ref={cancelButton} type="button" onClick={stop}>{t('batch.cancel_conversion')}</button>:null}
        <button ref={closeButton} type="button" disabled={working} onClick={close}>{t('dialog.close')}</button>
      </div>
    </form>
  </div>;
}
