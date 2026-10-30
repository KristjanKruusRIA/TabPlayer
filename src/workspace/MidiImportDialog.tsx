import { useEffect,useId,useMemo,useRef,useState,type KeyboardEvent } from 'react';
import { Settings } from '@coderline/alphatab';
import { exportGpInterchange } from '../interchange/gp';
import { defaultMidiImportOptions,importMidi,midiImportFileName,type MidiImport,type MidiImportOptions,type MidiQuantization,type MidiTrackKind,type MidiTupletMode } from '../interchange/midi-import';
import { MIDI_FILE_LIMIT,readMidiFile,type MidiSong } from '../interchange/midi-smf';
import './midi-import.css';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const quantizations:[MidiQuantization,string][]=[[4,'Quarter note (1/4)'],[8,'Eighth note (1/8)'],[16,'16th note (1/16)'],[32,'32nd note (1/32)'],[64,'64th note (1/64)']];
const tupletModes:[MidiTupletMode,string][]=[['none','None'],['triplets','Triplets'],['triplets-quintuplets','Triplets and quintuplets']];
const kinds:Record<MidiTrackKind,string>={guitar:'guitar tab',bass:'bass tab',keys:'notation',drums:'drums'};
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`;

/**
 * Reads a Standard MIDI File, lets the quantization, tuplet, voice and tablature options be chosen while showing what
 * they produce, and opens the result as a new untitled score. Nothing is opened until Import, and a file that cannot be
 * read only shows its reason, so the score that is open stays as it was.
 */
export function MidiImportDialog({busy,onImport,onClose}:{busy:boolean;onImport:(name:string,bytes:Uint8Array)=>Promise<boolean>;onClose:()=>void}) {
  const [file,setFile]=useState<{name:string;bytes:Uint8Array}|null>(null),[fileProblem,setFileProblem]=useState<string|null>(null),[importProblem,setImportProblem]=useState<string|null>(null),[importing,setImporting]=useState(false);
  const [options,setOptions]=useState<MidiImportOptions>(defaultMidiImportOptions);
  const form=useRef<HTMLFormElement>(null),picker=useRef<HTMLInputElement>(null),choose=useRef<HTMLButtonElement>(null),reading=useRef(0),heading=useId(),hint=useId(),status=useId();
  useEffect(()=>{choose.current?.focus();},[]);
  const song=useMemo<{value:MidiSong}|{error:string}|null>(()=>{
    if(!file)return null;
    try{return {value:readMidiFile(file.bytes)};}catch(error){return {error:message(error)};}
  },[file]);
  const result=useMemo<{value:MidiImport}|{error:string}|null>(()=>{
    if(!file||!song||!('value' in song))return null;
    try{return {value:importMidi(song.value,options,file.name.replace(/\.[^.]*$/,''))};}catch(error){return {error:message(error)};}
  },[file,song,options]);
  const imported=result&&'value' in result?result.value:null;
  const problem=importProblem??fileProblem??(song&&'error' in song?song.error:null)??(result&&'error' in result?result.error:null);
  const choice=<K extends keyof MidiImportOptions>(key:K,value:MidiImportOptions[K])=>{setImportProblem(null);setOptions(current=>({...current,[key]:value}));};
  const load=(chosen:File|undefined)=>{
    if(!chosen)return;
    // A newer choice, even a refused one, supersedes any file still loading.
    const request=++reading.current;setImportProblem(null);
    if(chosen.size>MIDI_FILE_LIMIT){setFile(null);setFileProblem(`${chosen.name} is larger than 8 MB, so it was not loaded.`);return;}
    const reader=new FileReader();
    reader.onload=()=>{if(request!==reading.current)return;setFileProblem(null);setFile({name:chosen.name,bytes:new Uint8Array(reader.result as ArrayBuffer)});};
    reader.onerror=()=>{if(request===reading.current){setFile(null);setFileProblem(`${chosen.name} could not be read.`);}};
    reader.readAsArrayBuffer(chosen);
  };
  const submit=async()=>{
    if(!imported||!file||busy||importing)return;
    let bytes:Uint8Array;
    try{bytes=exportGpInterchange(imported.score,new Settings());}catch(error){setImportProblem(message(error));return;}
    setImporting(true);setImportProblem(null);
    try{if(await onImport(midiImportFileName(file.name),bytes))onClose();else setImportProblem('The score was not opened.');}
    catch(error){setImportProblem(`The score could not be opened: ${message(error)}`);}
    finally{setImporting(false);}
  };
  const trap=(event:KeyboardEvent)=>{
    const items=[...form.current?.querySelectorAll<HTMLElement>('select:not(:disabled),input[type="checkbox"]:not(:disabled),button:not(:disabled)')??[]];if(!items.length)return;
    const index=items.indexOf(document.activeElement as HTMLElement),next=event.shiftKey?(index<=0?items.length-1:index-1):(index<0||index===items.length-1?0:index+1);
    event.preventDefault();items[next].focus();
  };
  const summary=imported?`${imported.summary.format===0?'Format 0':'Format 1'}, ${plural(imported.summary.tracks.length,'part')}, ${plural(imported.summary.measures,'measure')} at ${imported.summary.tempo} BPM.`:'';
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!importing)onClose();}}>
    <form ref={form} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={hint} aria-busy={importing} className="ascii-import midi-import" onSubmit={event=>{event.preventDefault();void submit();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!importing)onClose();}else if(event.key==='Tab')trap(event);}}>
      <h2 id={heading}>Import MIDI</h2>
      <p id={hint} className="muted">Choose a Standard MIDI file (format 0 or 1). Each instrument part becomes a track with its program, tempo and time signatures. The quantization sets the shortest note value, so check the rhythm after importing.</p>
      <input ref={picker} type="file" accept=".mid,.midi,audio/midi,audio/x-midi" hidden aria-label="MIDI file" onChange={event=>{load(event.target.files?.[0]);event.target.value='';}}/>
      <div className="midi-file"><button type="button" ref={choose} disabled={importing} onClick={()=>picker.current?.click()}>Choose MIDI file…</button><span>{file?file.name:'No file chosen'}</span></div>
      <div className="midi-options">
        <label>Quantization<select value={options.quantization} disabled={importing} onChange={event=>choice('quantization',Number(event.target.value) as MidiQuantization)}>{quantizations.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Tuplets<select value={options.tuplets} disabled={importing} onChange={event=>choice('tuplets',event.target.value as MidiTupletMode)}>{tupletModes.map(([value,label])=><option key={value} value={value} disabled={(value!=='none'&&options.quantization<8)||(value==='triplets-quintuplets'&&options.quantization<16)}>{label}</option>)}</select></label>
        <label>Voices per track<select value={options.voices} disabled={importing} onChange={event=>choice('voices',Number(event.target.value) as MidiImportOptions['voices'])}>{[1,2,3,4].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={options.tablature} disabled={importing} onChange={event=>choice('tablature',event.target.checked)}/>Guitar and bass as tablature</label>
      </div>
      <p id={status} role="status" className={problem?'error':'muted'}>{problem??(importing?'Opening the score…':imported?summary:'Nothing to import yet.')}</p>
      {imported&&!problem&&<>
        <ul className="midi-parts" aria-label="Parts">{imported.summary.tracks.map((part,index)=><li key={index}>{part.name}: {kinds[part.kind]}, {plural(part.notes,'note')}{part.voices>1?`, ${part.voices} voices`:''}</li>)}</ul>
        {imported.summary.notes.length>0&&<p className="muted">{imported.summary.notes.map(note=>`${note[0].toUpperCase()}${note.slice(1)}.`).join(' ')}</p>}
      </>}
      <div className="dialog-actions">
        <button type="submit" className="primary" disabled={!imported||busy||importing}>Import</button>
        <button type="button" disabled={importing} onClick={onClose}>Cancel</button>
      </div>
    </form>
  </div>;
}
