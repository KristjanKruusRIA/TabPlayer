import { useDeferredValue,useId,useMemo,useRef,useState } from 'react';
import { Settings } from '@coderline/alphatab';
import { asciiTabFileName,parseAsciiTab } from '../interchange/ascii-tab';
import { exportGpInterchange } from '../interchange/gp';
import { Dialog } from '../ui/Dialog';
import { useI18n } from '../i18n';
import { busyGuard } from '../ui/useBusyGuard';

const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FILE_LIMIT=256*1024;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/**
 * Pastes or loads ASCII tablature, shows what was understood, and opens it as a new untitled score.
 * The dialog stays open until the import succeeds, so a refused import keeps the text.
 */
export function AsciiTabImportDialog({busy,onImport,onClose}:{busy:boolean;onImport:(name:string,bytes:Uint8Array)=>Promise<boolean>;onClose:()=>void}) {
  const { t } = useI18n();
  const [text,setText]=useState(''),[source,setSource]=useState(''),[fileProblem,setFileProblem]=useState<string|null>(null),[importProblem,setImportProblem]=useState<string|null>(null),[importing,setImporting]=useState(false);
  const area=useRef<HTMLTextAreaElement>(null),file=useRef<HTMLInputElement>(null),reading=useRef(0),hint=useId(),status=useId();
  // Parsing a long tab takes a moment, so it follows typing rather than blocking it.
  const pending=useDeferredValue(text),title=source.replace(/\.[^.]*$/,'');
  const parsed=useMemo(()=>{
    if(!pending.trim())return null;
    try{return {value:parseAsciiTab(pending,title)};}catch(error){return {error:message(error)};}
  },[pending,title]);
  const current=pending===text,result=current&&parsed&&'value' in parsed?parsed.value:null,parseProblem=parsed&&'error' in parsed?parsed.error:null;
  const summary=result?`${result.summary.measures} ${result.summary.measures===1?'measure':'measures'}, ${result.summary.strings} strings tuned ${[...result.summary.tuning].reverse().map(pitch=>names[pitch%12]).join(' ')}.`
    +(result.summary.ignored?` ${result.summary.ignored} unsupported ${result.summary.ignored===1?'mark was':'marks were'} skipped.`:'')
    +result.summary.notes.map(note=>` ${note[0].toUpperCase()}${note.slice(1)}.`).join(''):'';
  const problem=importProblem??fileProblem??parseProblem;
  const edit=(value:string)=>{
    // Typing replaces any file that is still loading; clearing the text forgets the file's name.
    reading.current++;setFileProblem(null);setImportProblem(null);setText(value);if(!value.trim())setSource('');
  };
  const load=(chosen:File|undefined)=>{
    if(!chosen)return;
    // A newer choice, even a refused one, supersedes any file still loading.
    const request=++reading.current;setImportProblem(null);
    if(chosen.size>FILE_LIMIT){setFileProblem(t('ascii_import.size_limit', { name: chosen.name }));return;}
    const reader=new FileReader();
    reader.onload=()=>{if(request!==reading.current)return;setFileProblem(null);setSource(chosen.name);setText(String(reader.result??''));area.current?.focus();};
    reader.onerror=()=>{if(request===reading.current)setFileProblem(t('ascii_import.read_failed', { name: chosen.name }));};
    reader.readAsText(chosen);
  };
  const submit=async()=>{
    if(!result||busy||importing)return;
    let bytes:Uint8Array;
    try{bytes=exportGpInterchange(result.score,new Settings());}catch(error){setImportProblem(message(error));return;}
    setImporting(true);setImportProblem(null);
    try{if(await onImport(asciiTabFileName(source),bytes))onClose();else setImportProblem(t('ascii_import.not_opened'));}
    catch(error){setImportProblem(t('ascii_import.open_failed', { error: message(error) }));}
    finally{setImporting(false);}
  };
  const actions=<>
    <button type="button" {...busyGuard({busy:importing,className:'tp-button',onClick:()=>file.current?.click()})}>{t('ascii_import.choose_file')}</button>
    <button type="button" {...busyGuard({busy:busy||importing,unavailable:!result||!!parseProblem,className:'tp-button primary',onClick:()=>void submit()})}>{t('ascii_import.import_btn')}</button>
    <button type="button" {...busyGuard({busy:importing,className:'tp-button',onClick:onClose})}>{t('dialog.cancel')}</button>
  </>;
  return <Dialog title={t('ascii_import.title')} onClose={onClose} ariaDescribedBy={hint} busy={importing} closeDisabled={importing} dismissOnBackdrop className="ascii-import" onSubmit={event=>{event.preventDefault();void submit();}} actions={actions}>
    <div className="ascii-import-form">
      <p id={hint} className="muted">{t('ascii_import.hint')}</p>
      <label>{t('ascii_import.tab_label')}<textarea ref={area} data-autofocus value={text} rows={14} spellCheck={false} wrap="off" aria-describedby={status} aria-invalid={!!problem} readOnly={importing}
        onChange={event=>edit(event.target.value)}/></label>
      <input ref={file} type="file" accept=".txt,.tab,.text,text/plain" hidden onChange={event=>{load(event.target.files?.[0]);event.target.value='';}}/>
      <p id={status} role="status" className={problem?'error':'muted'}>{problem??(importing?t('ascii_import.opening'):result?summary:text.trim()?t('ascii_import.reading'):t('ascii_import.nothing_yet'))}</p>
    </div>
  </Dialog>;
}
