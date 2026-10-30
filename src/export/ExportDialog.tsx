import { useEffect,useId,useMemo,useRef,useState,type KeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import { PNG_RESOLUTIONS,validateSelection,type AudioExportOptions,type ExportOptions,type ExportProgress,type ExportSelection,type PngResolution,type PrintLayout } from './types';
import type { PageLayout } from '../engraving/types';
import { PageLayoutPanel } from '../engraving/PageLayoutPanel';
import { validatePageLayout } from '../engraving/page';
import { DEFAULT_FILE_NAME,FILE_NAME_TOKENS,PER_TRACK_FILE_NAME,expandFileName,fileNameContext,withExtension } from './file-name';
import './export-dialog.css';
const EXTENSIONS:Record<ExportOptions['format'],string>={gp:'gp',pdf:'pdf',print:'',svg:'svg',png:'png',midi:'mid',musicxml:'musicxml',ascii:'txt',wav:'wav',stems:''};
export function ExportDialog({score,layout,page,busy,progress,failure,currentSpeedAvailable,gpBackingIssue,onExport,onCancel,layoutLocked=false}:{score:model.Score;layout:PrintLayout;page?:PageLayout;busy:boolean;progress?:ExportProgress;failure?:string|null;currentSpeedAvailable:boolean;layoutLocked?:boolean;onExport:(options:ExportOptions)=>void;onCancel:()=>void;gpBackingIssue?:(selection:ExportSelection)=>string|null}) {
  const [format,setFormat]=useState<ExportOptions['format']>('gp');const [tracks,setTracks]=useState(score.tracks.map(t=>t.index));
  const [staves,setStaves]=useState<Record<number,number[]>>(Object.fromEntries(score.tracks.map(t=>[t.index,t.staves.map(s=>s.index)])));
  const [range,setRange]=useState(false),[first,setFirst]=useState('1'),[last,setLast]=useState(String(score.masterBars.length));
  const [print,setPrint]=useState({...layout});const [audio,setAudio]=useState<AudioExportOptions>({sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true});
  const [normalize,setNormalize]=useState(false),[normalizeLevel,setNormalizeLevel]=useState(-16);
  const [gpBacking,setGpBacking]=useState(true),[transparent,setTransparent]=useState(false),[perTrack,setPerTrack]=useState(false),[dpi,setDpi]=useState<PngResolution>(300);
  const paged=format==='pdf'||format==='print'||format==='svg'||format==='png';
  const splittable=format==='pdf'||format==='svg'||format==='png';
  const [fileName,setFileName]=useState(DEFAULT_FILE_NAME),[now,setNow]=useState(()=>new Date());
  // Keep %d and %h in the preview current while the dialog stays open.
  useEffect(()=>{const timer=setInterval(()=>setNow(new Date()),15000);return()=>clearInterval(timer);},[]);
  const savedName=withExtension(expandFileName(fileName,fileNameContext(score,{tracks:tracks.length?tracks:[0],range:null},now)),format==='wav'&&audio.container?audio.container:EXTENSIONS[format]);
  const [error,setError]=useState('');
  const [customPage,setCustomPage]=useState(()=>page?structuredClone(page):null);
  const topology=`${score.masterBars.length}:${score.tracks.map(track=>track.staves.length).join(',')}`;
  const dialog=useRef<HTMLDivElement>(null),cancel=useRef<HTMLButtonElement>(null);
  const errorId=useId();
  function exportSelection():ExportSelection {
    if(range&&(!first.trim()||!last.trim()||!Number.isInteger(Number(first))||!Number.isInteger(Number(last))))throw new Error('Enter whole measure numbers for the inclusive range.');
    const partial=Object.fromEntries(tracks.filter(t=>staves[t]?.length!==score.tracks[t]?.staves.length).map(t=>[t,staves[t]]));
    const selection={tracks,range:range?{first:Number(first)-1,last:Number(last)-1}:null,...(Object.keys(partial).length?{staves:partial}:{})};validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));
    return selection;
  }
  const selection=useMemo(()=>{try{return exportSelection();}catch{return null;}},[score,topology,tracks,staves,range,first,last]);
  const backingIssue=useMemo(()=>format==='gp'&&gpBacking&&selection?gpBackingIssue?.(selection)??null:null,[format,gpBacking,selection,gpBackingIssue]);
  const visibleError=backingIssue||error||progress?.error||failure;
  useEffect(()=>{
    const opener=document.activeElement;
    dialog.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')?.focus();
    return ()=>{if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();};
  },[]);
  useEffect(()=>{if(busy)cancel.current?.focus();},[busy]);
  useEffect(()=>{if(!currentSpeedAvailable)setAudio(previous=>previous.speed==='current'?{...previous,speed:'saved'}:previous);},[currentSpeedAvailable]);
  useEffect(()=>{
    setTracks(selected=>selected.filter(index=>score.tracks[index]!==undefined));
    setStaves(Object.fromEntries(score.tracks.map(track=>[track.index,track.staves.map(staff=>staff.index)])));
    setRange(false);setFirst('1');setLast(String(score.masterBars.length));setError('');
  },[topology]);
  function handleKeyDown(event:KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onCancel();return;}
    if(event.key!=='Tab')return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)'));
    const first=controls[0],last=controls[controls.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  function submit(){
    try {
      const selection=exportSelection();
      if(backingIssue)throw new Error(backingIssue);
      if(!Number.isFinite(audio.tailSeconds)||audio.tailSeconds<0||audio.tailSeconds>30)throw new Error('Effect tail must be between 0 and 30 seconds.');
      if(format==='wav'&&normalize&&!(Number.isFinite(normalizeLevel)&&normalizeLevel>=-30&&normalizeLevel<=-6))throw new Error('Choose a normalization level from -30 to -6 dB RMS.');
      if(paged&&!customPage&&(!Number.isFinite(print.marginMm)||print.marginMm<0||print.marginMm>50||!Number.isFinite(print.scale)||print.scale<.25||print.scale>3))throw new Error('Use margins from 0 to 50 mm and scale from 25% to 300%.');
      if(paged&&customPage)validatePageLayout(customPage);
      const named={...(format!=='print'&&fileName!==DEFAULT_FILE_NAME?{fileName}:{}),...(splittable&&perTrack?{perTrack:true}:{})};
      setError('');onExport({...(format==='svg'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent}:format==='png'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent,dpi}:format==='pdf'||format==='print'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{})}:format==='wav'?{format,selection,audio:normalize?{...audio,normalizeRmsDb:normalizeLevel}:audio}:format==='stems'?{format,selection,audio}:format==='gp'?{format,selection,...(!gpBacking?{backing:false}:{})}:{format,selection}),...named} as ExportOptions);
    }catch(e){setError((e as Error).message);}
  }
  return <div className="dialog-backdrop"><div ref={dialog} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-label="Export score" className="export-dialog"><h2>Export score</h2>
    <fieldset disabled={busy}>
      <label>Export format<select value={format} onChange={e=>{const next=e.target.value as ExportOptions['format'];setFormat(next);if(next!=='pdf'&&next!=='svg'&&next!=='png'&&perTrack){setPerTrack(false);if(fileName===PER_TRACK_FILE_NAME)setFileName(DEFAULT_FILE_NAME);}}}><option value="gp">Guitar Pro</option><option value="pdf">PDF</option><option value="print">Print</option><option value="svg">SVG</option><option value="png">PNG</option><option value="midi">MIDI</option><option value="musicxml">MusicXML</option><option value="ascii">ASCII tablature</option><option value="wav">Mixed audio</option><option value="stems">Audio stems</option></select></label>
      {format!=='print'&&<div className="export-file-name"><label>File name<input value={fileName} spellCheck={false} onChange={e=>setFileName(e.target.value)}/></label>
        <p className="muted">{`Tokens: ${FILE_NAME_TOKENS}. Track tokens use the first selected track.`}</p>
        <p aria-live="polite">{`Saves as ${savedName}`}</p>{(format==='svg'||format==='png')&&<p className="muted">Several pages are saved with -1, -2 and so on before the extension.</p>}</div>}
      <fieldset className="export-selection"><legend>Tracks to export</legend>{score.tracks.map(t=><div key={t.index} role="group" aria-label={`${t.name||`Track ${t.index+1}`} track and staves`} className="export-track">
        <label className="export-check"><input type="checkbox" checked={tracks.includes(t.index)} onChange={e=>setTracks(e.target.checked?[...tracks,t.index].sort((a,b)=>a-b):tracks.filter(n=>n!==t.index))}/>{t.name||`Track ${t.index+1}`}</label>
        {tracks.includes(t.index)&&t.staves.length>1&&<div className="export-staves">{t.staves.map(s=><label className="export-check" key={s.index}><input type="checkbox" checked={staves[t.index].includes(s.index)} onChange={e=>setStaves({...staves,[t.index]:e.target.checked?[...staves[t.index],s.index].sort((a,b)=>a-b):staves[t.index].filter(i=>i!==s.index)})}/>{t.name} staff {s.index+1}</label>)}</div>}
      </div>)}</fieldset>
      <fieldset className="export-selection"><legend>Measures to export</legend>
        <label className="export-check"><input type="checkbox" checked={range} onChange={e=>setRange(e.target.checked)}/>Measure range</label>
        {range?<div className="export-measures"><label>First measure<input type="number" min="1" max={score.masterBars.length} step="1" value={first} onChange={e=>setFirst(e.target.value)}/></label><label>Last measure<input type="number" min="1" max={score.masterBars.length} step="1" value={last} onChange={e=>setLast(e.target.value)}/></label></div>:<p className="muted">All measures</p>}
      </fieldset>
      {format==='gp'&&<label className="export-check"><input type="checkbox" checked={gpBacking} aria-invalid={backingIssue?true:undefined} aria-describedby={backingIssue?errorId:undefined} onChange={e=>setGpBacking(e.target.checked)}/>Include backing audio</label>}
      {paged&&layoutLocked&&<p className="muted">This document is finalized, so exports use its current layout.</p>}
      {paged&&(customPage?<PageLayoutPanel value={customPage} busy={busy||layoutLocked} onEdit={command=>setCustomPage(command.layout)}/>:<fieldset className="export-layout-fields" disabled={layoutLocked}>
        <label>Paper<select value={print.paper} onChange={e=>setPrint({...print,paper:e.target.value as PrintLayout['paper']})}><option>A4</option><option>Letter</option></select></label>
        <label>Orientation<select value={print.orientation} onChange={e=>setPrint({...print,orientation:e.target.value as PrintLayout['orientation']})}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
        <label>Margin (mm)<input type="number" min="0" max="50" value={print.marginMm} onChange={e=>setPrint({...print,marginMm:Number(e.target.value)})}/></label>
        <label>Print scale (%)<input type="number" min="25" max="300" value={print.scale*100} onChange={e=>setPrint({...print,scale:Number(e.target.value)/100})}/></label>
        <label>Staves<select value={print.profile} onChange={e=>setPrint({...print,profile:e.target.value as PrintLayout['profile']})}><option value="ScoreTab">Score and tab</option><option value="Score">Score</option><option value="Tab">Tab</option></select></label>
      </fieldset>)}
      {(format==='gp'||paged)&&<p>Engraving settings affect the screen and PDF. GP export preserves source styling and supports uniform common/cut choices; mixed measure choices cannot be exported.</p>}
      {splittable&&<><label className="export-check"><input type="checkbox" checked={perTrack} onChange={e=>{const checked=e.target.checked;setPerTrack(checked);if(checked&&fileName===DEFAULT_FILE_NAME)setFileName(PER_TRACK_FILE_NAME);if(!checked&&fileName===PER_TRACK_FILE_NAME)setFileName(DEFAULT_FILE_NAME);}}/>One file per track</label>{perTrack&&<p>Each selected track is saved as its own file in the folder you choose, named from the file name with that track's %t and %n. Names that would repeat get the track number.</p>}</>}
      {(format==='svg'||format==='png')&&<label className="export-check"><input type="checkbox" checked={transparent} onChange={e=>setTransparent(e.target.checked)}/>Transparent background</label>}
      {format==='svg'&&<p>SVG writes one file per page. Notation and text are written as outlines, so the files need no fonts to view.</p>}
      {format==='png'&&<><label>Resolution<select value={dpi} onChange={e=>setDpi(Number(e.target.value) as PngResolution)}>{PNG_RESOLUTIONS.map(value=><option key={value} value={value}>{value} dpi</option>)}</select></label><p>PNG writes one image per page at the chosen resolution.</p></>}
      {format==='musicxml'&&<p>MusicXML keeps notes, techniques, lyrics and tempo. It leaves out fermata lengths, backing audio, mixer settings, and layout and styling. Anything else it cannot write, such as instrument changes or gradual volume changes, stops the export with a message.</p>}
      {format==='ascii'&&<p>ASCII tablature writes the fret numbers of stringed tracks as plain text, with common techniques, repeats, endings, sections and directions, and a legend of the marks used. Rhythm is shown only by spacing, simile bars are written out, and where voices share a string at one moment the first voice is kept. Percussion and staves without strings are left out.</p>}
      {format==='midi'&&<p>MIDI preserves generated notes and controls. Ordinary MIDI players share pitch bends on a channel, so simultaneous independent bends may differ.</p>}
      {(format==='wav'||format==='stems')&&<fieldset className="export-audio"><legend>Audio</legend><div className="export-audio-options">
        <label>File type<select value={audio.container??'wav'} onChange={e=>{const {container:_,...rest}=audio;const value=e.target.value;setAudio(value==='aiff'||value==='flac'?{...rest,container:value}:rest);}}><option value="wav">WAV</option><option value="aiff">AIFF</option><option value="flac">FLAC (lossless)</option></select></label>
        <label>Sample rate<select value={audio.sampleRate} onChange={e=>setAudio({...audio,sampleRate:Number(e.target.value) as AudioExportOptions['sampleRate']})}><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></label>
        <label>Bit depth<select value={audio.bitDepth} onChange={e=>setAudio({...audio,bitDepth:Number(e.target.value) as AudioExportOptions['bitDepth']})}><option value="16">16 bit</option><option value="24">24 bit</option></select></label>
        <label>Speed<select value={audio.speed} onChange={e=>setAudio({...audio,speed:e.target.value as AudioExportOptions['speed']})}><option value="saved">100%</option><option value="current" disabled={!currentSpeedAvailable}>Current speed coefficient</option></select></label>
        {!currentSpeedAvailable&&<p>Fixed BPM has no single speed coefficient. Export at saved speed is available.</p>}
        <p>Audio export does not include count-in or progressive speed changes.</p>
        <label className="export-check"><input type="checkbox" checked={audio.metronome} onChange={e=>setAudio({...audio,metronome:e.target.checked})}/>Metronome</label>
        <label className="export-check"><input type="checkbox" checked={audio.backing} onChange={e=>setAudio({...audio,backing:e.target.checked})}/>Include backing</label>
        <label>Effect tail (seconds)<input type="number" min="0" max="30" step=".1" value={audio.tailSeconds} onChange={e=>setAudio({...audio,tailSeconds:Number(e.target.value)})}/></label>
        {format==='wav'&&<><label className="export-check"><input type="checkbox" checked={normalize} onChange={e=>setNormalize(e.target.checked)}/>Normalize</label>
        <label>Normalized level (dB RMS)<input type="number" min="-30" max="-6" step=".5" disabled={!normalize} value={normalizeLevel} onChange={e=>setNormalizeLevel(Number(e.target.value))}/></label>
        <p>Normalizing sets the whole export to this average level. It turns it down further if a peak would pass −1 dBFS, and raises it by at most 40 dB.</p></>}
        {format==='stems'&&<label className="export-check"><input type="checkbox" checked={audio.includeMix} onChange={e=>setAudio({...audio,includeMix:e.target.checked})}/>Include limited mix</label>}
      </div></fieldset>}
    </fieldset>
    {visibleError&&<p id={errorId} role="alert">{visibleError}</p>}{progress&&<><progress aria-label="Export progress" data-job-id={progress.id} max={Math.max(1,progress.totalFrames)} value={progress.frames}/><p role="status">{progress.status==='running'?'Exporting…':progress.status}</p></>}
    <div className="export-actions"><button type="button" className="export-submit" disabled={busy||Boolean(backingIssue)} onClick={submit}>Export</button><button ref={cancel} type="button" onClick={onCancel}>{busy?'Cancel export':'Cancel'}</button></div>
  </div></div>;
}
