import { useEffect,useRef,useState,type KeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import { validateSelection,type AudioExportOptions,type ExportOptions,type ExportProgress,type PrintLayout } from './types';
export function ExportDialog({score,layout,busy,progress,failure,onExport,onCancel}:{score:model.Score;layout:PrintLayout;busy:boolean;progress?:ExportProgress;failure?:string|null;onExport:(options:ExportOptions)=>void;onCancel:()=>void}) {
  const [format,setFormat]=useState<ExportOptions['format']>('gp');const [tracks,setTracks]=useState(score.tracks.map(t=>t.index));
  const [staves,setStaves]=useState<Record<number,number[]>>(Object.fromEntries(score.tracks.map(t=>[t.index,t.staves.map(s=>s.index)])));
  const [range,setRange]=useState(false),[first,setFirst]=useState('1'),[last,setLast]=useState(String(score.masterBars.length));
  const [print,setPrint]=useState({...layout});const [audio,setAudio]=useState<AudioExportOptions>({sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true});
  const [error,setError]=useState('');
  const dialog=useRef<HTMLDivElement>(null),cancel=useRef<HTMLButtonElement>(null);
  const visibleError=error||progress?.error||failure;
  useEffect(()=>{
    const opener=document.activeElement;
    dialog.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')?.focus();
    return ()=>{if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();};
  },[]);
  useEffect(()=>{if(busy)cancel.current?.focus();},[busy]);
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
      if(range&&(!first.trim()||!last.trim()||!Number.isInteger(Number(first))||!Number.isInteger(Number(last))))throw new Error('Enter whole measure numbers for the inclusive range.');
      const partial=Object.fromEntries(tracks.filter(t=>staves[t].length!==score.tracks[t].staves.length).map(t=>[t,staves[t]]));
      const selection={tracks,range:range?{first:Number(first)-1,last:Number(last)-1}:null,...(Object.keys(partial).length?{staves:partial}:{})};validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));
      if(!Number.isFinite(audio.tailSeconds)||audio.tailSeconds<0||audio.tailSeconds>30)throw new Error('Effect tail must be between 0 and 30 seconds.');
      if(!Number.isFinite(print.marginMm)||print.marginMm<0||print.marginMm>50||!Number.isFinite(print.scale)||print.scale<.25||print.scale>3)throw new Error('Use margins from 0 to 50 mm and scale from 25% to 300%.');
      setError('');onExport(format==='pdf'||format==='print'?{format,selection,layout:print}:format==='wav'||format==='stems'?{format,selection,audio}:{format,selection});
    }catch(e){setError((e as Error).message);}
  }
  return <div ref={dialog} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-label="Export score" className="export-dialog"><h2>Export score</h2>
    <fieldset disabled={busy}>
      <label>Export format<select value={format} onChange={e=>setFormat(e.target.value as ExportOptions['format'])}><option value="gp">Guitar Pro</option><option value="pdf">PDF</option><option value="print">Print</option><option value="midi">MIDI</option><option value="wav">Mixed WAV</option><option value="stems">WAV stems</option></select></label>
      <><div aria-label="Tracks to export">{score.tracks.map(t=><label key={t.index}><input type="checkbox" checked={tracks.includes(t.index)} onChange={e=>setTracks(e.target.checked?[...tracks,t.index].sort((a,b)=>a-b):tracks.filter(n=>n!==t.index))}/>{t.name||`Track ${t.index+1}`}</label>)}</div>
        {score.tracks.filter(t=>tracks.includes(t.index)&&t.staves.length>1).map(t=><div key={t.index}>{t.staves.map(s=><label key={s.index}><input type="checkbox" checked={staves[t.index].includes(s.index)} onChange={e=>setStaves({...staves,[t.index]:e.target.checked?[...staves[t.index],s.index].sort((a,b)=>a-b):staves[t.index].filter(i=>i!==s.index)})}/>{t.name} staff {s.index+1}</label>)}</div>)}
        <label><input type="checkbox" checked={range} onChange={e=>setRange(e.target.checked)}/>Measure range</label>
        {range&&<><label>First measure<input type="number" min="1" max={score.masterBars.length} step="1" value={first} onChange={e=>setFirst(e.target.value)}/></label><label>Last measure<input type="number" min="1" max={score.masterBars.length} step="1" value={last} onChange={e=>setLast(e.target.value)}/></label></>}
      </>
      {(format==='pdf'||format==='print')&&<>
        <label>Paper<select value={print.paper} onChange={e=>setPrint({...print,paper:e.target.value as PrintLayout['paper']})}><option>A4</option><option>Letter</option></select></label>
        <label>Orientation<select value={print.orientation} onChange={e=>setPrint({...print,orientation:e.target.value as PrintLayout['orientation']})}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
        <label>Margin (mm)<input type="number" min="0" max="50" value={print.marginMm} onChange={e=>setPrint({...print,marginMm:Number(e.target.value)})}/></label>
        <label>Print scale (%)<input type="number" min="25" max="300" value={print.scale*100} onChange={e=>setPrint({...print,scale:Number(e.target.value)/100})}/></label>
        <label>Staves<select value={print.profile} onChange={e=>setPrint({...print,profile:e.target.value as PrintLayout['profile']})}><option value="ScoreTab">Score and tab</option><option value="Score">Score</option><option value="Tab">Tab</option></select></label>
      </>}
      {format==='midi'&&<p>MIDI preserves generated notes and controls. Ordinary MIDI players share pitch bends on a channel, so simultaneous independent bends may differ.</p>}
      {(format==='wav'||format==='stems')&&<>
        <label>Sample rate<select value={audio.sampleRate} onChange={e=>setAudio({...audio,sampleRate:Number(e.target.value) as AudioExportOptions['sampleRate']})}><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></label>
        <label>Bit depth<select value={audio.bitDepth} onChange={e=>setAudio({...audio,bitDepth:Number(e.target.value) as AudioExportOptions['bitDepth']})}><option value="16">16 bit</option><option value="24">24 bit</option></select></label>
        <label>Speed<select value={audio.speed} onChange={e=>setAudio({...audio,speed:e.target.value as AudioExportOptions['speed']})}><option value="saved">100%</option><option value="current">Current practice speed</option></select></label>
        <label><input type="checkbox" checked={audio.metronome} onChange={e=>setAudio({...audio,metronome:e.target.checked})}/>Metronome</label>
        <label><input type="checkbox" checked={audio.backing} onChange={e=>setAudio({...audio,backing:e.target.checked})}/>Include backing</label>
        <label>Effect tail (seconds)<input type="number" min="0" max="30" step=".1" value={audio.tailSeconds} onChange={e=>setAudio({...audio,tailSeconds:Number(e.target.value)})}/></label>
        {format==='stems'&&<label><input type="checkbox" checked={audio.includeMix} onChange={e=>setAudio({...audio,includeMix:e.target.checked})}/>Include limited mix</label>}
      </>}
    </fieldset>
    {visibleError&&<p role="alert">{visibleError}</p>}{progress&&<><progress aria-label="Export progress" data-job-id={progress.id} max={Math.max(1,progress.totalFrames)} value={progress.frames}/><p role="status">{progress.status==='running'?'Exporting…':progress.status}</p></>}
    <button type="button" disabled={busy} onClick={submit}>Export</button><button ref={cancel} type="button" onClick={onCancel}>{busy?'Cancel export':'Cancel'}</button>
  </div>;
}
