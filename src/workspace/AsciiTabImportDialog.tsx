import { useDeferredValue,useEffect,useId,useMemo,useRef,useState,type KeyboardEvent } from 'react';
import { Settings } from '@coderline/alphatab';
import { asciiTabFileName,parseAsciiTab } from '../interchange/ascii-tab';
import { exportGpInterchange } from '../interchange/gp';

const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FILE_LIMIT=256*1024;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/**
 * Pastes or loads ASCII tablature, shows what was understood, and opens it as a new untitled score.
 * The dialog stays open until the import succeeds, so a refused import keeps the text.
 */
export function AsciiTabImportDialog({busy,onImport,onClose}:{busy:boolean;onImport:(name:string,bytes:Uint8Array)=>Promise<boolean>;onClose:()=>void}) {
  const [text,setText]=useState(''),[source,setSource]=useState(''),[fileProblem,setFileProblem]=useState<string|null>(null),[importProblem,setImportProblem]=useState<string|null>(null),[importing,setImporting]=useState(false);
  const form=useRef<HTMLFormElement>(null),area=useRef<HTMLTextAreaElement>(null),file=useRef<HTMLInputElement>(null),reading=useRef(0),heading=useId(),hint=useId(),status=useId();
  useEffect(()=>{area.current?.focus();},[]);
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
    setImportProblem(null);
    if(chosen.size>FILE_LIMIT){setFileProblem(`${chosen.name} is larger than 256 KB, so it was not loaded.`);return;}
    const request=++reading.current,reader=new FileReader();
    reader.onload=()=>{if(request!==reading.current)return;setFileProblem(null);setSource(chosen.name);setText(String(reader.result??''));area.current?.focus();};
    reader.onerror=()=>{if(request===reading.current)setFileProblem(`${chosen.name} could not be read.`);};
    reader.readAsText(chosen);
  };
  const submit=async()=>{
    if(!result||busy||importing)return;
    let bytes:Uint8Array;
    try{bytes=exportGpInterchange(result.score,new Settings());}catch(error){setImportProblem(message(error));return;}
    setImporting(true);setImportProblem(null);
    try{if(await onImport(asciiTabFileName(source),bytes))onClose();else setImportProblem('The score was not opened.');}
    catch(error){setImportProblem(`The score could not be opened: ${message(error)}`);}
    finally{setImporting(false);}
  };
  const trap=(event:KeyboardEvent)=>{
    const items=[...form.current?.querySelectorAll<HTMLElement>('textarea,button:not(:disabled)')??[]];if(!items.length)return;
    const index=items.indexOf(document.activeElement as HTMLElement),next=event.shiftKey?(index<=0?items.length-1:index-1):(index<0||index===items.length-1?0:index+1);
    event.preventDefault();items[next].focus();
  };
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!importing)onClose();}}>
    <form ref={form} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={hint} aria-busy={importing} className="ascii-import" onSubmit={event=>{event.preventDefault();void submit();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!importing)onClose();}else if(event.key==='Tab')trap(event);}}>
      <h2 id={heading}>Import ASCII tab</h2>
      <p id={hint} className="muted">Paste tablature with one line per string, or choose a text file. String names set the tuning, and the spacing between notes sets the rhythm, so check the rhythm after importing.</p>
      <label>ASCII tab<textarea ref={area} value={text} rows={14} spellCheck={false} wrap="off" aria-describedby={status} aria-invalid={!!problem} readOnly={importing}
        onChange={event=>edit(event.target.value)}/></label>
      <input ref={file} type="file" accept=".txt,.tab,.text,text/plain" hidden onChange={event=>{load(event.target.files?.[0]);event.target.value='';}}/>
      <p id={status} role="status" className={problem?'error':'muted'}>{problem??(importing?'Opening the score…':result?summary:text.trim()?'Reading the tab…':'Nothing to import yet.')}</p>
      <div className="dialog-actions">
        <button type="button" disabled={importing} onClick={()=>file.current?.click()}>Choose text file…</button>
        <button type="submit" className="primary" disabled={!result||!!parseProblem||busy||importing}>Import</button>
        <button type="button" disabled={importing} onClick={onClose}>Cancel</button>
      </div>
    </form>
  </div>;
}
