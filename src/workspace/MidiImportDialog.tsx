import { useDeferredValue,useId,useMemo,useRef,useState } from 'react';
import { Settings } from '@coderline/alphatab';
import { exportGpInterchange } from '../interchange/gp';
import { defaultMidiImportOptions,importMidi,midiImportFileName,type MidiImport,type MidiImportOptions,type MidiQuantization,type MidiTrackKind,type MidiTupletMode } from '../interchange/midi-import';
import { MIDI_FILE_LIMIT,readMidiFile,type MidiSong } from '../interchange/midi-smf';
import { Dialog } from '../ui/Dialog';
import { useI18n } from '../i18n';
import { Segmented } from '../ui/Segmented';
import { busyGuard,busySelect } from '../ui/useBusyGuard';
import './midi-import.css';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const quantizationOptions=[
  {value:'4',label:'Quarter note (1/4)'},
  {value:'8',label:'Eighth note (1/8)'},
  {value:'16',label:'16th note (1/16)'},
  {value:'32',label:'32nd note (1/32)'},
  {value:'64',label:'64th note (1/64)'},
] as const;
const voiceOptions=[
  {value:'1',label:'1'},
  {value:'2',label:'2'},
  {value:'3',label:'3'},
  {value:'4',label:'4'},
] as const;
const tupletModes:[MidiTupletMode,string][]=[['none','None'],['triplets','Triplets'],['triplets-quintuplets','Triplets and quintuplets']];
const kinds:Record<MidiTrackKind,string>={guitar:'guitar tab',bass:'bass tab',keys:'notation',drums:'drums'};
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`;

/**
 * Reads a Standard MIDI File, lets the quantization, tuplet, voice and tablature options be chosen while showing what
 * they produce, and opens the result as a new untitled score. Nothing is opened until Import, and a file that cannot be
 * read only shows its reason, so the score that is open stays as it was.
 */
export function MidiImportDialog({busy,onImport,onClose}:{busy:boolean;onImport:(name:string,bytes:Uint8Array)=>Promise<boolean>;onClose:()=>void}) {
  const { t } = useI18n();
  const [file,setFile]=useState<{name:string;bytes:Uint8Array}|null>(null),[fileProblem,setFileProblem]=useState<string|null>(null),[importProblem,setImportProblem]=useState<string|null>(null),[importing,setImporting]=useState(false);
  const [options,setOptions]=useState<MidiImportOptions>(defaultMidiImportOptions);
  const picker=useRef<HTMLInputElement>(null),reading=useRef(0),hint=useId(),status=useId();
  const song=useMemo<{value:MidiSong}|{error:string}|null>(()=>{
    if(!file)return null;
    try{return {value:readMidiFile(file.bytes)};}catch(error){return {error:message(error)};}
  },[file]);
  // Converting a long file takes a moment, so it follows the option controls rather than blocking them.
  const settled=useDeferredValue(options);
  const result=useMemo<{value:MidiImport}|{error:string}|null>(()=>{
    if(!file||!song||!('value' in song))return null;
    try{return {value:importMidi(song.value,settled,file.name.replace(/\.[^.]*$/,''))};}catch(error){return {error:message(error)};}
  },[file,song,settled]);
  const imported=settled===options&&result&&'value' in result?result.value:null;
  const problem=importProblem??fileProblem??(song&&'error' in song?song.error:null)??(result&&'error' in result?result.error:null);
  const choice=<K extends keyof MidiImportOptions>(key:K,value:MidiImportOptions[K])=>{setImportProblem(null);setOptions(current=>{
    const next={...current,[key]:value};
    // A tuplet kind the new grid cannot hold gives way to the nearest one it can.
    if(next.quantization<8)next.tuplets='none';else if(next.quantization<16&&next.tuplets==='triplets-quintuplets')next.tuplets='triplets';
    return next;
  });};
  const load=(chosen:File|undefined)=>{
    if(!chosen)return;
    // A newer choice, even a refused one, supersedes any file still loading.
    const request=++reading.current;setImportProblem(null);
    if(chosen.size>MIDI_FILE_LIMIT){setFile(null);setFileProblem(t('midi_import.size_limit', { name: chosen.name }));return;}
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
    try{if(await onImport(midiImportFileName(file.name),bytes))onClose();else setImportProblem(t('midi_import.not_opened'));}
    catch(error){setImportProblem(t('midi_import.open_failed', { error: message(error) }));}
    finally{setImporting(false);}
  };
  const summary=imported?`${imported.summary.format===0?'Format 0':'Format 1'}, ${plural(imported.summary.tracks.length,'part')}, ${plural(imported.summary.measures,'measure')} at ${imported.summary.tempo} BPM.`:'';
  const actions=<>
    <button type="submit" {...busyGuard({busy:busy||importing,unavailable:!imported,className:'tp-button primary'})}>{t('midi_import.import_btn')}</button>
    <button type="button" {...busyGuard({busy:importing,className:'tp-button',onClick:onClose})}>{t('dialog.cancel')}</button>
  </>;
  return <Dialog title={t('midi_import.title')} onClose={onClose} ariaDescribedBy={hint} busy={importing} closeDisabled={importing} dismissOnBackdrop className="ascii-import midi-import" onSubmit={event=>{event.preventDefault();void submit();}} actions={actions}>
    <div className="ascii-import-form">
      <p id={hint} className="muted">Choose a Standard MIDI file (format 0 or 1). Each instrument part becomes a track with its program, tempo and time signatures. The quantization sets the shortest note value, so check the rhythm after importing.</p>
      <input ref={picker} type="file" accept=".mid,.midi,audio/midi,audio/x-midi" hidden aria-label="MIDI file" onChange={event=>{load(event.target.files?.[0]);event.target.value='';}}/>
      <div className="midi-file"><button type="button" data-autofocus {...busyGuard({busy:importing,onClick:()=>picker.current?.click()})}>{t('midi_import.choose_file')}</button><span>{file?file.name:'No file chosen'}</span></div>
      <fieldset className="midi-options">
        <div className="tp-field midi-full-row">
          <span className="tp-field-label" aria-hidden="true">Quantization</span>
          <Segmented label="Quantization" disabled={importing} value={String(options.quantization)} options={quantizationOptions} onChange={val=>choice('quantization',Number(val) as MidiQuantization)}/>
        </div>
        <label>Tuplets<select value={options.tuplets} {...busySelect(importing)} onChange={event=>{if(!importing)choice('tuplets',event.target.value as MidiTupletMode);}}>{tupletModes.map(([value,label])=><option key={value} value={value} disabled={(value!=='none'&&options.quantization<8)||(value==='triplets-quintuplets'&&options.quantization<16)}>{label}</option>)}</select></label>
        <div className="tp-field">
          <span className="tp-field-label" aria-hidden="true">Voices per track</span>
          <Segmented label="Voices per track" disabled={importing} value={String(options.voices)} options={voiceOptions} onChange={val=>choice('voices',Number(val) as MidiImportOptions['voices'])}/>
        </div>
        <label className="check"><input type="checkbox" checked={options.tablature} aria-disabled={importing||undefined} onChange={event=>{if(!importing)choice('tablature',event.target.checked);}}/>Guitar and bass as tablature</label>
      </fieldset>
      <p id={status} role="status" className={problem?'error':'muted'}>{problem??(importing?'Opening the score…':settled!==options?'Updating…':imported?summary:'Nothing to import yet.')}</p>
      {imported&&!problem&&<>
        <ul className="midi-parts" aria-label="Parts">{imported.summary.tracks.map((part,index)=><li key={index}>{part.name}: {kinds[part.kind]}, {plural(part.notes,'note')}{part.voices>1?`, ${part.voices} voices`:''}</li>)}</ul>
        {imported.summary.notes.length>0&&<p className="muted">{imported.summary.notes.map(note=>`${note[0].toUpperCase()}${note.slice(1)}.`).join(' ')}</p>}
      </>}
    </div>
  </Dialog>;
}
