import { useEffect,useId,useMemo,useState } from 'react';
import type { model } from '@coderline/alphatab';
import { PNG_RESOLUTIONS,validateSelection,type AudioExportOptions,type ExportOptions,type ExportProgress,type ExportSelection,type PngResolution,type PrintLayout } from './types';
import type { PageLayout } from '../engraving/types';
import { PageLayoutPanel } from '../engraving/PageLayoutPanel';
import { validatePageLayout } from '../engraving/page';
import { DEFAULT_FILE_NAME,FILE_NAME_TOKENS,PER_TRACK_FILE_NAME,expandFileName,fileNameContext,withExtension } from './file-name';
import { Dialog,Segmented,busyGuard,busyRegion } from '../ui';
import { CabinetNotices } from '../audio/CabinetNotices';
import type { TrackSound } from '../edit-types';
import { previewGp5 } from './gp5';
import './export-dialog.css';
const EXTENSIONS:Record<ExportOptions['format'],string>={gp:'gp',gp5:'gp5',pdf:'pdf',print:'',svg:'svg',png:'png',midi:'mid',musicxml:'musicxml',ascii:'txt',wav:'wav',stems:''};
export function ExportDialog({score,layout,page,busy,progress,failure,currentSpeedAvailable,gpBackingIssue,hasBacking=false,onExport,onCancel,layoutLocked=false,sounds,trackNames}:{sounds?:Record<string,TrackSound>;trackNames?:Record<string,string>;score:model.Score;layout:PrintLayout;page?:PageLayout;busy:boolean;progress?:ExportProgress;failure?:string|null;currentSpeedAvailable:boolean;layoutLocked?:boolean;onExport:(options:ExportOptions)=>void;onCancel:()=>void;gpBackingIssue?:(selection:ExportSelection)=>string|null;hasBacking?:boolean}) {
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
  const errorId=useId();
  function exportSelection():ExportSelection {
    if(range&&(!first.trim()||!last.trim()||!Number.isInteger(Number(first))||!Number.isInteger(Number(last))))throw new Error('Enter whole measure numbers for the inclusive range.');
    const partial=Object.fromEntries(tracks.filter(t=>staves[t]?.length!==score.tracks[t]?.staves.length).map(t=>[t,staves[t]]));
    const selection={tracks,range:range?{first:Number(first)-1,last:Number(last)-1}:null,...(Object.keys(partial).length?{staves:partial}:{})};validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));
    return selection;
  }
  const selection=useMemo(()=>{try{return exportSelection();}catch{return null;}},[score,topology,tracks,staves,range,first,last]);
  const backingIssue=useMemo(()=>format==='gp'&&gpBacking&&selection?gpBackingIssue?.(selection)??null:null,[format,gpBacking,selection,gpBackingIssue]);
  // What a Guitar Pro 5 file would leave out of this selection, or why it cannot be written, before anything is saved.
  const gp5=useMemo(()=>format==='gp5'&&selection?previewGp5(score,selection,{backing:hasBacking}):null,[format,selection,score,hasBacking]);
  const gp5Issue=gp5&&'refusal' in gp5?gp5.refusal:null;
  const visibleError=backingIssue||gp5Issue||error||progress?.error||failure;
  useEffect(()=>{if(!currentSpeedAvailable)setAudio(previous=>previous.speed==='current'?{...previous,speed:'saved'}:previous);},[currentSpeedAvailable]);
  useEffect(()=>{
    setTracks(selected=>selected.filter(index=>score.tracks[index]!==undefined));
    setStaves(Object.fromEntries(score.tracks.map(track=>[track.index,track.staves.map(staff=>staff.index)])));
    setRange(false);setFirst('1');setLast(String(score.masterBars.length));setError('');
  },[topology]);
  function submit(){
    try {
      const selection=exportSelection();
      if(backingIssue)throw new Error(backingIssue);
      if(gp5Issue)throw new Error(gp5Issue);
      if(!Number.isFinite(audio.tailSeconds)||audio.tailSeconds<0||audio.tailSeconds>30)throw new Error('Effect tail must be between 0 and 30 seconds.');
      if(format==='wav'&&normalize&&!(Number.isFinite(normalizeLevel)&&normalizeLevel>=-30&&normalizeLevel<=-6))throw new Error('Choose a normalization level from -30 to -6 dB RMS.');
      if(paged&&!customPage&&(!Number.isFinite(print.marginMm)||print.marginMm<0||print.marginMm>50||!Number.isFinite(print.scale)||print.scale<.25||print.scale>3))throw new Error('Use margins from 0 to 50 mm and scale from 25% to 300%.');
      if(paged&&customPage)validatePageLayout(customPage);
      const named={...(format!=='print'&&fileName!==DEFAULT_FILE_NAME?{fileName}:{}),...(splittable&&perTrack?{perTrack:true}:{})};
      setError('');onExport({...(format==='svg'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent}:format==='png'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent,dpi}:format==='pdf'||format==='print'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{})}:format==='wav'?{format,selection,audio:normalize?{...audio,normalizeRmsDb:normalizeLevel}:audio}:format==='stems'?{format,selection,audio}:format==='gp'?{format,selection,...(!gpBacking?{backing:false}:{})}:{format,selection}),...named} as ExportOptions);
    }catch(e){setError((e as Error).message);}
  }
  return <Dialog title="Export score" onClose={onCancel} closeLabel={busy?'Cancel':'Close'} busy={busy} className="export-dialog" actions={<><button type="button" {...busyGuard({busy,unavailable:Boolean(backingIssue)||Boolean(gp5Issue),className:'tp-primary export-submit',onClick:submit})}>Export</button><button type="button" onClick={onCancel}>{busy?'Cancel export':'Cancel'}</button></>}>
    <fieldset {...busyRegion(busy)}>
      <label>Export format<select data-autofocus={!busy||undefined} value={format} onChange={e=>{const next=e.target.value as ExportOptions['format'];setFormat(next);if(next!=='pdf'&&next!=='svg'&&next!=='png'&&perTrack){setPerTrack(false);if(fileName===PER_TRACK_FILE_NAME)setFileName(DEFAULT_FILE_NAME);}}}><option value="gp">Guitar Pro</option><option value="gp5">Guitar Pro 5</option><option value="pdf">PDF</option><option value="print">Print</option><option value="svg">SVG</option><option value="png">PNG</option><option value="midi">MIDI</option><option value="musicxml">MusicXML</option><option value="ascii">ASCII tablature</option><option value="wav">Mixed audio</option><option value="stems">Audio stems</option></select></label>
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
        <div className="export-field"><span className="export-field-label" aria-hidden="true">Paper</span><Segmented label="Paper" value={print.paper} disabled={busy||layoutLocked} options={[{value:'A4',label:'A4'},{value:'Letter',label:'Letter'}]} onChange={paper=>setPrint({...print,paper})}/></div>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">Orientation</span><Segmented label="Orientation" value={print.orientation} disabled={busy||layoutLocked} options={[{value:'portrait',label:'Portrait'},{value:'landscape',label:'Landscape'}]} onChange={orientation=>setPrint({...print,orientation})}/></div>
        <label>Margin (mm)<input type="number" min="0" max="50" value={print.marginMm} onChange={e=>setPrint({...print,marginMm:Number(e.target.value)})}/></label>
        <label>Print scale (%)<input type="number" min="25" max="300" value={print.scale*100} onChange={e=>setPrint({...print,scale:Number(e.target.value)/100})}/></label>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">Staves</span><Segmented label="Staves" value={print.profile} disabled={busy||layoutLocked} options={[{value:'ScoreTab',label:'Score and tab'},{value:'Score',label:'Score'},{value:'Tab',label:'Tab'}]} onChange={profile=>setPrint({...print,profile})}/></div>
      </fieldset>)}
      {(format==='gp'||paged)&&<p>Engraving settings affect the screen and PDF. GP export preserves source styling and supports uniform common/cut choices; mixed measure choices cannot be exported.</p>}
      {splittable&&<><label className="export-check"><input type="checkbox" checked={perTrack} onChange={e=>{const checked=e.target.checked;setPerTrack(checked);if(checked&&fileName===DEFAULT_FILE_NAME)setFileName(PER_TRACK_FILE_NAME);if(!checked&&fileName===PER_TRACK_FILE_NAME)setFileName(DEFAULT_FILE_NAME);}}/>One file per track</label>{perTrack&&<p>Each selected track is saved as its own file in the folder you choose, named from the file name with that track's %t and %n. Names that would repeat get the track number.</p>}</>}
      {(format==='svg'||format==='png')&&<label className="export-check"><input type="checkbox" checked={transparent} onChange={e=>setTransparent(e.target.checked)}/>Transparent background</label>}
      {format==='svg'&&<p>SVG writes one file per page. Notation and text are written as outlines, so the files need no fonts to view.</p>}
      {format==='png'&&<><div className="export-field"><span className="export-field-label" aria-hidden="true">Resolution</span><Segmented label="Resolution" value={dpi} disabled={busy} options={PNG_RESOLUTIONS.map(value=>({value,label:`${value} dpi`}))} onChange={setDpi}/></div><p>PNG writes one image per page at the chosen resolution.</p></>}
      {format==='musicxml'&&<p>MusicXML keeps notes, techniques, lyrics and tempo. It leaves out fermata lengths, backing audio, mixer settings, and layout and styling. Anything else it cannot write, such as instrument changes or gradual volume changes, stops the export with a message.</p>}
      {format==='ascii'&&<p>ASCII tablature writes the fret numbers of stringed tracks as plain text, with common techniques, repeats, endings, sections and directions, and a legend of the marks used. Rhythm is shown only by spacing, simile bars are written out, and where voices share a string at one moment the first voice is kept. Percussion and staves without strings are left out.</p>}
      {format==='gp5'&&<><p>Guitar Pro 5 keeps notes and rhythm, tuning and capo, repeats and endings, sections, tempo, key and time signatures, lyrics, chord diagrams and the common techniques. It leaves out page layout, styling, sound settings and backing audio, and anything the older format has no place for. What this selection loses is listed here, and you confirm it before the save dialog opens. Guitar Pro 6 (.gpx) export is not available.</p>
        {gp5&&'losses' in gp5&&(gp5.losses.length?<div role="status"><p>Left out or changed in this selection:</p><ul>{gp5.losses.map(item=><li key={item}>{item}</li>)}</ul></div>:<p role="status">Nothing in this selection is left out beyond layout, styling, sound settings and backing audio.</p>)}</>}
      {format==='midi'&&<p>MIDI preserves generated notes and controls. Ordinary MIDI players share pitch bends on a channel, so simultaneous independent bends may differ.</p>}
      {(format==='wav'||format==='stems')&&<fieldset className="export-audio"><legend>Audio</legend><div className="export-audio-options">
        <div className="export-field"><span className="export-field-label" aria-hidden="true">File type</span><Segmented label="File type" value={audio.container??'wav'} disabled={busy} options={[{value:'wav' as const,label:'WAV'},{value:'aiff' as const,label:'AIFF'},{value:'flac' as const,label:'FLAC (lossless)'}]} onChange={value=>{const {container:_,...rest}=audio;setAudio(value==='aiff'||value==='flac'?{...rest,container:value}:rest);}}/></div>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">Sample rate</span><Segmented label="Sample rate" value={audio.sampleRate} disabled={busy} options={[{value:44100 as const,label:'44.1 kHz'},{value:48000 as const,label:'48 kHz'}]} onChange={sampleRate=>setAudio({...audio,sampleRate})}/></div>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">Bit depth</span><Segmented label="Bit depth" value={audio.bitDepth} disabled={busy} options={[{value:16 as const,label:'16 bit'},{value:24 as const,label:'24 bit'}]} onChange={bitDepth=>setAudio({...audio,bitDepth})}/></div>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">Speed</span><Segmented label="Speed" value={audio.speed} disabled={busy} options={[{value:'saved' as const,label:'100%'},{value:'current' as const,label:'Current speed coefficient',disabled:!currentSpeedAvailable}]} onChange={speed=>setAudio({...audio,speed})}/></div>
        {!currentSpeedAvailable&&<p>Fixed BPM has no single speed coefficient. Export at saved speed is available.</p>}
        <p>Audio export does not include count-in or progressive speed changes.</p>
        <CabinetNotices sounds={sounds} trackNames={trackNames} className="export-cabinet-notices"/>
        <label className="export-check"><input type="checkbox" checked={audio.metronome} onChange={e=>setAudio({...audio,metronome:e.target.checked})}/>Metronome</label>
        <label className="export-check"><input type="checkbox" checked={audio.backing} onChange={e=>setAudio({...audio,backing:e.target.checked})}/>Include backing</label>
        <label>Effect tail (seconds)<input type="number" min="0" max="30" step=".1" value={audio.tailSeconds} onChange={e=>setAudio({...audio,tailSeconds:Number(e.target.value)})}/></label>
        {format==='wav'&&<><label className="export-check"><input type="checkbox" checked={normalize} onChange={e=>setNormalize(e.target.checked)}/>Normalize</label>
        <label>Normalized level (dB RMS)<input type="number" min="-30" max="-6" step=".5" disabled={!normalize} value={normalizeLevel} onChange={e=>setNormalizeLevel(Number(e.target.value))}/></label>
        <p>Normalizing sets the whole export to this average level. It turns it down further if a peak would pass −1 dBFS, and raises it by at most 40 dB.</p></>}
        {format==='stems'&&<label className="export-check"><input type="checkbox" checked={audio.includeMix} onChange={e=>setAudio({...audio,includeMix:e.target.checked})}/>Include limited mix</label>}
      </div></fieldset>}
    </fieldset>
    {visibleError&&<p id={errorId} role="alert">{visibleError}</p>}{busy&&!progress&&<p role="status">Preparing the export…</p>}{progress&&<><progress aria-label="Export progress" data-job-id={progress.id} max={Math.max(1,progress.totalFrames)} value={progress.frames}/><p role="status">{progress.status==='running'?'Exporting…':progress.status}</p></>}
  </Dialog>;
}
