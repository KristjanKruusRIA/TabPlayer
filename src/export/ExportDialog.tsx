import { useEffect,useId,useMemo,useRef,useState,type KeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import { validateSelection,type AudioExportOptions,type ExportOptions,type ExportProgress,type ExportSelection,type PrintLayout } from './types';
import type { PageLayout } from '../engraving/types';
import { PageLayoutPanel } from '../engraving/PageLayoutPanel';
import { validatePageLayout } from '../engraving/page';
import './export-dialog.css';
export function ExportDialog({score,layout,page,busy,progress,failure,currentSpeedAvailable,gpBackingIssue,onExport,onCancel}:{score:model.Score;layout:PrintLayout;page?:PageLayout;busy:boolean;progress?:ExportProgress;failure?:string|null;currentSpeedAvailable:boolean;onExport:(options:ExportOptions)=>void;onCancel:()=>void;gpBackingIssue?:(selection:ExportSelection)=>string|null}) {
  const [format,setFormat]=useState<ExportOptions['format']>('gp');const [tracks,setTracks]=useState(score.tracks.map(t=>t.index));
  const [staves,setStaves]=useState<Record<number,number[]>>(Object.fromEntries(score.tracks.map(t=>[t.index,t.staves.map(s=>s.index)])));
  const [range,setRange]=useState(false),[first,setFirst]=useState('1'),[last,setLast]=useState(String(score.masterBars.length));
  const [print,setPrint]=useState({...layout});const [audio,setAudio]=useState<AudioExportOptions>({sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true});
  const [gpBacking,setGpBacking]=useState(true),[transparent,setTransparent]=useState(false);
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
      if((format==='pdf'||format==='print'||format==='svg')&&!customPage&&(!Number.isFinite(print.marginMm)||print.marginMm<0||print.marginMm>50||!Number.isFinite(print.scale)||print.scale<.25||print.scale>3))throw new Error('Use margins from 0 to 50 mm and scale from 25% to 300%.');
      if((format==='pdf'||format==='print'||format==='svg')&&customPage)validatePageLayout(customPage);
      setError('');onExport(format==='svg'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent}:format==='pdf'||format==='print'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{})}:format==='wav'||format==='stems'?{format,selection,audio}:format==='gp'?{format,selection,...(!gpBacking?{backing:false}:{})}:{format,selection});
    }catch(e){setError((e as Error).message);}
  }
  return <div className="dialog-backdrop"><div ref={dialog} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-label="Export score" className="export-dialog"><h2>Export score</h2>
    <fieldset disabled={busy}>
      <label>Export format<select value={format} onChange={e=>setFormat(e.target.value as ExportOptions['format'])}><option value="gp">Guitar Pro</option><option value="pdf">PDF</option><option value="print">Print</option><option value="svg">SVG</option><option value="midi">MIDI</option><option value="musicxml">MusicXML</option><option value="wav">Mixed WAV</option><option value="stems">WAV stems</option></select></label>
      <fieldset className="export-selection"><legend>Tracks to export</legend>{score.tracks.map(t=><div key={t.index} role="group" aria-label={`${t.name||`Track ${t.index+1}`} track and staves`} className="export-track">
        <label className="export-check"><input type="checkbox" checked={tracks.includes(t.index)} onChange={e=>setTracks(e.target.checked?[...tracks,t.index].sort((a,b)=>a-b):tracks.filter(n=>n!==t.index))}/>{t.name||`Track ${t.index+1}`}</label>
        {tracks.includes(t.index)&&t.staves.length>1&&<div className="export-staves">{t.staves.map(s=><label className="export-check" key={s.index}><input type="checkbox" checked={staves[t.index].includes(s.index)} onChange={e=>setStaves({...staves,[t.index]:e.target.checked?[...staves[t.index],s.index].sort((a,b)=>a-b):staves[t.index].filter(i=>i!==s.index)})}/>{t.name} staff {s.index+1}</label>)}</div>}
      </div>)}</fieldset>
      <fieldset className="export-selection"><legend>Measures to export</legend>
        <label className="export-check"><input type="checkbox" checked={range} onChange={e=>setRange(e.target.checked)}/>Measure range</label>
        {range?<div className="export-measures"><label>First measure<input type="number" min="1" max={score.masterBars.length} step="1" value={first} onChange={e=>setFirst(e.target.value)}/></label><label>Last measure<input type="number" min="1" max={score.masterBars.length} step="1" value={last} onChange={e=>setLast(e.target.value)}/></label></div>:<p className="muted">All measures</p>}
      </fieldset>
      {format==='gp'&&<label className="export-check"><input type="checkbox" checked={gpBacking} aria-invalid={backingIssue?true:undefined} aria-describedby={backingIssue?errorId:undefined} onChange={e=>setGpBacking(e.target.checked)}/>Include backing audio</label>}
      {(format==='pdf'||format==='print'||format==='svg')&&(customPage?<PageLayoutPanel value={customPage} busy={busy} onEdit={command=>setCustomPage(command.layout)}/>:<>
        <label>Paper<select value={print.paper} onChange={e=>setPrint({...print,paper:e.target.value as PrintLayout['paper']})}><option>A4</option><option>Letter</option></select></label>
        <label>Orientation<select value={print.orientation} onChange={e=>setPrint({...print,orientation:e.target.value as PrintLayout['orientation']})}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
        <label>Margin (mm)<input type="number" min="0" max="50" value={print.marginMm} onChange={e=>setPrint({...print,marginMm:Number(e.target.value)})}/></label>
        <label>Print scale (%)<input type="number" min="25" max="300" value={print.scale*100} onChange={e=>setPrint({...print,scale:Number(e.target.value)/100})}/></label>
        <label>Staves<select value={print.profile} onChange={e=>setPrint({...print,profile:e.target.value as PrintLayout['profile']})}><option value="ScoreTab">Score and tab</option><option value="Score">Score</option><option value="Tab">Tab</option></select></label>
      </>)}
      {(format==='gp'||format==='pdf'||format==='print'||format==='svg')&&<p>Engraving settings affect the screen and PDF. GP export preserves source styling and supports uniform common/cut choices; mixed measure choices cannot be exported.</p>}
      {format==='svg'&&<><label className="export-check"><input type="checkbox" checked={transparent} onChange={e=>setTransparent(e.target.checked)}/>Transparent background</label><p>SVG writes one file per page. Notation and text are written as outlines, so the files need no fonts to view.</p></>}
      {format==='musicxml'&&<p>MusicXML keeps notes, techniques, lyrics and tempo. It leaves out fermata lengths, backing audio, mixer settings, and layout and styling. Anything else it cannot write, such as instrument changes or gradual volume changes, stops the export with a message.</p>}
      {format==='midi'&&<p>MIDI preserves generated notes and controls. Ordinary MIDI players share pitch bends on a channel, so simultaneous independent bends may differ.</p>}
      {(format==='wav'||format==='stems')&&<fieldset className="export-audio"><legend>Audio</legend><div className="export-audio-options">
        <label>Sample rate<select value={audio.sampleRate} onChange={e=>setAudio({...audio,sampleRate:Number(e.target.value) as AudioExportOptions['sampleRate']})}><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></label>
        <label>Bit depth<select value={audio.bitDepth} onChange={e=>setAudio({...audio,bitDepth:Number(e.target.value) as AudioExportOptions['bitDepth']})}><option value="16">16 bit</option><option value="24">24 bit</option></select></label>
        <label>Speed<select value={audio.speed} onChange={e=>setAudio({...audio,speed:e.target.value as AudioExportOptions['speed']})}><option value="saved">100%</option><option value="current" disabled={!currentSpeedAvailable}>Current speed coefficient</option></select></label>
        {!currentSpeedAvailable&&<p>Fixed BPM has no single speed coefficient. Export at saved speed is available.</p>}
        <p>Audio export does not include count-in or progressive speed changes.</p>
        <label className="export-check"><input type="checkbox" checked={audio.metronome} onChange={e=>setAudio({...audio,metronome:e.target.checked})}/>Metronome</label>
        <label className="export-check"><input type="checkbox" checked={audio.backing} onChange={e=>setAudio({...audio,backing:e.target.checked})}/>Include backing</label>
        <label>Effect tail (seconds)<input type="number" min="0" max="30" step=".1" value={audio.tailSeconds} onChange={e=>setAudio({...audio,tailSeconds:Number(e.target.value)})}/></label>
        {format==='stems'&&<label className="export-check"><input type="checkbox" checked={audio.includeMix} onChange={e=>setAudio({...audio,includeMix:e.target.checked})}/>Include limited mix</label>}
      </div></fieldset>}
    </fieldset>
    {visibleError&&<p id={errorId} role="alert">{visibleError}</p>}{progress&&<><progress aria-label="Export progress" data-job-id={progress.id} max={Math.max(1,progress.totalFrames)} value={progress.frames}/><p role="status">{progress.status==='running'?'Exporting…':progress.status}</p></>}
    <div className="export-actions"><button type="button" className="export-submit" disabled={busy||Boolean(backingIssue)} onClick={submit}>Export</button><button ref={cancel} type="button" onClick={onCancel}>{busy?'Cancel export':'Cancel'}</button></div>
  </div></div>;
}
