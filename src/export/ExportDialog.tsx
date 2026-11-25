import { useEffect,useId,useMemo,useState } from 'react';
import type { model } from '@coderline/alphatab';
import { PNG_RESOLUTIONS,validateSelection,type AudioExportOptions,type ExportOptions,type ExportProgress,type ExportSelection,type PngResolution,type PrintLayout,type ExportInspection } from './types';
import type { TrackPluginStatus } from '../audio/plugin-host';
import type { PageLayout } from '../engraving/types';
import { PageLayoutPanel } from '../engraving/PageLayoutPanel';
import { validatePageLayout } from '../engraving/page';
import { DEFAULT_FILE_NAME,PER_TRACK_FILE_NAME,expandFileName,fileNameContext,withExtension } from './file-name';
import { Dialog,Segmented,busyGuard,busyRegion } from '../ui';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import { CabinetNotices } from '../audio/CabinetNotices';
import { CaptureNotices } from '../audio/CaptureNotices';
import { PluginNotices } from '../audio/PluginNotices';
import type { TrackSound } from '../edit-types';
import { previewGp5 } from './gp5';
import './export-dialog.css';
const FORMATS:ReadonlyArray<[ExportOptions['format'],MessageKey|string]>=[['gp','export.opt_gp'],['gp5','export.opt_gp5'],['pdf','PDF'],['print','export.opt_print'],['svg','SVG'],['png','PNG'],['midi','MIDI'],['musicxml','MusicXML'],['ascii','export.opt_ascii'],['wav','export.opt_wav'],['stems','export.opt_stems']];
const EXTENSIONS:Record<ExportOptions['format'],string>={gp:'gp',gp5:'gp5',pdf:'pdf',print:'',svg:'svg',png:'png',midi:'mid',musicxml:'musicxml',ascii:'txt',wav:'wav',stems:''};
export function ExportDialog({score,layout,page,busy,progress,failure,currentSpeedAvailable,gpBackingIssue,hasBacking=false,countInBars=0,onExport,onCancel,layoutLocked=false,layoutLockedNote,plainNote,sounds,trackNames,pluginWarnings,inspection}:{layoutLockedNote?:string;/** Shown when the score is password-protected: what an export does not carry. */plainNote?:string;sounds?:Record<string,TrackSound>;trackNames?:Record<string,string>;pluginWarnings?:TrackPluginStatus[];inspection?:ExportInspection;score:model.Score;layout:PrintLayout;page?:PageLayout;busy:boolean;progress?:ExportProgress;failure?:string|null;currentSpeedAvailable:boolean;layoutLocked?:boolean;onExport:(options:ExportOptions)=>void;onCancel:()=>void;gpBackingIssue?:(selection:ExportSelection)=>string|null;hasBacking?:boolean;/** The bars the practice settings define for a count-in; with none the option is disabled. */countInBars?:number}) {
  const { t } = useI18n();
  const [format,setFormat]=useState<ExportOptions['format']>('gp');const [tracks,setTracks]=useState(score.tracks.map(t=>t.index));
  const [staves,setStaves]=useState<Record<number,number[]>>(Object.fromEntries(score.tracks.map(t=>[t.index,t.staves.map(s=>s.index)])));
  const [range,setRange]=useState(false),[first,setFirst]=useState('1'),[last,setLast]=useState(String(score.masterBars.length));
  const [print,setPrint]=useState({...layout});const [audio,setAudio]=useState<AudioExportOptions>({sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:2,backing:true,includeMix:true});
  const [countIn,setCountIn]=useState(false);const [normalize,setNormalize]=useState(false),[normalizeLevel,setNormalizeLevel]=useState(-16);
  const [gpBacking,setGpBacking]=useState(true),[midiDrumMaps,setMidiDrumMaps]=useState(false),[transparent,setTransparent]=useState(false),[perTrack,setPerTrack]=useState(false),[dpi,setDpi]=useState<PngResolution>(300);
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
    if(range&&(!first.trim()||!last.trim()||!Number.isInteger(Number(first))||!Number.isInteger(Number(last))))throw new Error(t('export.err_range'));
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
      if(!Number.isFinite(audio.tailSeconds)||audio.tailSeconds<0||audio.tailSeconds>30)throw new Error(t('export.err_tail'));
      if(format==='wav'&&normalize&&!(Number.isFinite(normalizeLevel)&&normalizeLevel>=-30&&normalizeLevel<=-6))throw new Error(t('export.err_normalize'));
      if(paged&&!customPage&&(!Number.isFinite(print.marginMm)||print.marginMm<0||print.marginMm>50||!Number.isFinite(print.scale)||print.scale<.25||print.scale>3))throw new Error(t('export.err_margin'));
      if(paged&&customPage)validatePageLayout(customPage);
      const named={...(format!=='print'&&fileName!==DEFAULT_FILE_NAME?{fileName}:{}),...(splittable&&perTrack?{perTrack:true}:{})};
      setError('');onExport({...(format==='svg'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent}:format==='png'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{}),transparent,dpi}:format==='pdf'||format==='print'?{format,selection,layout:print,...(customPage?{page:structuredClone(customPage)}:{})}:format==='wav'?{format,selection,audio:{...audio,...(normalize?{normalizeRmsDb:normalizeLevel}:{}),...(countIn&&countInBars>0?{countIn:true}:{})}}:format==='stems'?{format,selection,audio}:format==='gp'?{format,selection,...(!gpBacking?{backing:false}:{})}:format==='midi'?{format,selection,...(midiDrumMaps?{drumMaps:true}:{})}:{format,selection}),...named} as ExportOptions);
    }catch(e){setError((e as Error).message);}
  }
  return <Dialog title={t('export.title')} onClose={onCancel} closeLabel={busy?t('dialog.cancel'):t('dialog.close')} busy={busy} className="export-dialog" actions={<><button type="button" onClick={onCancel}>{busy?t('export.cancel_export'):t('dialog.cancel')}</button><button type="button" {...busyGuard({busy,unavailable:Boolean(backingIssue)||Boolean(gp5Issue),className:'tp-primary export-submit',onClick:submit})}>{t('export.submit')}</button></>}>
    <fieldset {...busyRegion(busy)}>
      <label>{t('export.format')}<select data-autofocus={!busy||undefined} value={format} onChange={e=>{const next=e.target.value as ExportOptions['format'];setFormat(next);if(next!=='pdf'&&next!=='svg'&&next!=='png'&&perTrack){setPerTrack(false);if(fileName===PER_TRACK_FILE_NAME)setFileName(DEFAULT_FILE_NAME);}}}>{FORMATS.map(([value,label])=><option key={value} value={value}>{label.startsWith('export.')?t(label as MessageKey):label}</option>)}</select></label>
      {format!=='print'&&<div className="export-file-name"><label>{t('export.file_name')}<input value={fileName} spellCheck={false} onChange={e=>setFileName(e.target.value)} onKeyDown={event=>{
        if(event.key!=='Enter'||event.nativeEvent.isComposing)return;
        event.preventDefault();
        if(!busy&&!backingIssue&&!gp5Issue)submit();
      }}/></label>
        <p className="muted">{t('export.file_tokens')}</p>
        <p aria-live="polite">{t('export.saves_as',{name:savedName})}</p>{(format==='svg'||format==='png')&&<p className="muted">{t('export.pages_suffix')}</p>}</div>}
      <fieldset className="export-selection"><legend>{t('export.tracks_to_export')}</legend>{score.tracks.map(tr=><div key={tr.index} role="group" aria-label={t('export.track_staves_aria',{name:tr.name||t('mixer.track_number',{number:tr.index+1})})} className="export-track">
        <label className="export-check"><input type="checkbox" checked={tracks.includes(tr.index)} onChange={e=>setTracks(e.target.checked?[...tracks,tr.index].sort((a,b)=>a-b):tracks.filter(n=>n!==tr.index))}/>{tr.name||t('mixer.track_number',{number:tr.index+1})}</label>
        {tracks.includes(tr.index)&&tr.staves.length>1&&<div className="export-staves">{tr.staves.map(s=><label className="export-check" key={s.index}><input type="checkbox" checked={staves[tr.index].includes(s.index)} onChange={e=>setStaves({...staves,[tr.index]:e.target.checked?[...staves[tr.index],s.index].sort((a,b)=>a-b):staves[tr.index].filter(i=>i!==s.index)})}/>{t('export.staff_n',{track:tr.name,number:s.index+1})}</label>)}</div>}
      </div>)}</fieldset>
      <fieldset className="export-selection"><legend>{t('export.measures_to_export')}</legend>
        <label className="export-check"><input type="checkbox" checked={range} onChange={e=>setRange(e.target.checked)}/>{t('export.measure_range')}</label>
        {range?<div className="export-measures"><label>{t('export.first_measure')}<input type="number" min="1" max={score.masterBars.length} step="1" value={first} onChange={e=>setFirst(e.target.value)}/></label><label>{t('export.last_measure')}<input type="number" min="1" max={score.masterBars.length} step="1" value={last} onChange={e=>setLast(e.target.value)}/></label></div>:<p className="muted">{t('export.all_measures')}</p>}
      </fieldset>
      {format==='gp'&&<label className="export-check"><input type="checkbox" checked={gpBacking} aria-invalid={backingIssue?true:undefined} aria-describedby={backingIssue?errorId:undefined} onChange={e=>setGpBacking(e.target.checked)}/>{t('export.include_backing_audio')}</label>}
      {plainNote&&<p className="muted">{plainNote}</p>}
      {paged&&layoutLocked&&<p className="muted">{layoutLockedNote??t('export.layout_finalized_note')}</p>}
      {paged&&(customPage?<PageLayoutPanel value={customPage} busy={busy||layoutLocked} onEdit={command=>setCustomPage(command.layout)}/>:<fieldset className="export-layout-fields" disabled={layoutLocked}>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">{t('export.paper')}</span><Segmented label={t('export.paper')} value={print.paper} disabled={busy||layoutLocked} options={[{value:'A4',label:'A4'},{value:'Letter',label:'Letter'}]} onChange={paper=>setPrint({...print,paper})}/></div>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">{t('export.orientation')}</span><Segmented label={t('export.orientation')} value={print.orientation} disabled={busy||layoutLocked} options={[{value:'portrait',label:t('export.portrait')},{value:'landscape',label:t('export.landscape')}]} onChange={orientation=>setPrint({...print,orientation})}/></div>
        <label>{t('export.margin_mm')}<input type="number" min="0" max="50" value={print.marginMm} onChange={e=>setPrint({...print,marginMm:Number(e.target.value)})}/></label>
        <label>{t('export.print_scale')}<input type="number" min="25" max="300" value={print.scale*100} onChange={e=>setPrint({...print,scale:Number(e.target.value)/100})}/></label>
        <div className="export-field"><span className="export-field-label" aria-hidden="true">{t('export.staves')}</span><Segmented label={t('export.staves')} value={print.profile} disabled={busy||layoutLocked} options={[{value:'ScoreTab',label:t('export.staves_score_tab')},{value:'Score',label:t('export.staves_score')},{value:'Tab',label:t('export.staves_tab')}]} onChange={profile=>setPrint({...print,profile})}/></div>
      </fieldset>)}
      {(format==='gp'||paged)&&<p>{t('export.engraving_note')}</p>}
      {splittable&&<><label className="export-check"><input type="checkbox" checked={perTrack} onChange={e=>{const checked=e.target.checked;setPerTrack(checked);if(checked&&fileName===DEFAULT_FILE_NAME)setFileName(PER_TRACK_FILE_NAME);if(!checked&&fileName===PER_TRACK_FILE_NAME)setFileName(DEFAULT_FILE_NAME);}}/>{t('export.one_file_per_track')}</label>{perTrack&&<p>{t('export.one_file_note')}</p>}</>}
      {(format==='svg'||format==='png')&&<label className="export-check"><input type="checkbox" checked={transparent} onChange={e=>setTransparent(e.target.checked)}/>{t('export.transparent')}</label>}
      {format==='svg'&&<p>{t('export.svg_note')}</p>}
      {format==='png'&&<><div className="export-field"><span className="export-field-label" aria-hidden="true">{t('export.resolution')}</span><Segmented label={t('export.resolution')} value={dpi} disabled={busy} options={PNG_RESOLUTIONS.map(value=>({value,label:t('export.dpi',{value})}))} onChange={setDpi}/></div><p>{t('export.png_note')}</p></>}
      {format==='musicxml'&&<p>{t('export.musicxml_note')}</p>}
      {format==='ascii'&&<p>{t('export.ascii_note')}</p>}
      {format==='gp5'&&<><p>{t('export.gp5_note')}</p>
        {gp5&&'losses' in gp5&&(gp5.losses.length?<div role="status"><p>{t('export.gp5_losses')}</p><ul>{gp5.losses.map(item=><li key={item}>{item}</li>)}</ul></div>:<p role="status">{t('export.gp5_no_losses')}</p>)}</>}
      {format==='midi'&&<><p>{t('export.midi_note')}</p><label className="export-check"><input type="checkbox" checked={midiDrumMaps} onChange={e=>setMidiDrumMaps(e.target.checked)}/>{t('export.midi_drum_maps')}</label>{midiDrumMaps&&<p className="muted">{t('export.midi_drum_maps_note')}</p>}</>}
      {(format==='wav'||format==='stems')&&<fieldset className="export-audio"><legend>{t('export.audio')}</legend><div className="export-audio-options">
        <div className="export-field"><span className="export-field-label" aria-hidden="true">{t('export.file_type')}</span><Segmented label={t('export.file_type')} value={audio.container??'wav'} disabled={busy} options={[{value:'wav' as const,label:'WAV'},{value:'aiff' as const,label:'AIFF'},{value:'flac' as const,label:t('export.flac')},{value:'ogg' as const,label:t('export.ogg')},{value:'mp3' as const,label:t('export.mp3')}]} onChange={value=>{const {container:_,...rest}=audio;setAudio(value==='wav'?rest:{...rest,container:value});}}/></div>
        {audio.container==='ogg'&&<p>{t('export.ogg_note')}</p>}
        {audio.container==='mp3'&&<p>{t('export.mp3_note')}</p>}
        <div className="export-field"><span className="export-field-label" aria-hidden="true">{t('audio.sample_rate')}</span><Segmented label={t('audio.sample_rate')} value={audio.sampleRate} disabled={busy} options={[{value:44100 as const,label:'44.1 kHz'},{value:48000 as const,label:'48 kHz'}]} onChange={sampleRate=>setAudio({...audio,sampleRate})}/></div>
        {audio.container!=='ogg'&&audio.container!=='mp3'&&<div className="export-field"><span className="export-field-label" aria-hidden="true">{t('export.bit_depth')}</span><Segmented label={t('export.bit_depth')} value={audio.bitDepth} disabled={busy} options={[{value:16 as const,label:t('export.bits',{value:16})},{value:24 as const,label:t('export.bits',{value:24})}]} onChange={bitDepth=>setAudio({...audio,bitDepth})}/></div>}
        <div className="export-field"><span className="export-field-label" aria-hidden="true">{t('transport.speed')}</span><Segmented label={t('transport.speed')} value={audio.speed} disabled={busy} options={[{value:'saved' as const,label:'100%'},{value:'current' as const,label:t('export.speed_current'),disabled:!currentSpeedAvailable}]} onChange={speed=>setAudio({...audio,speed})}/></div>
        {!currentSpeedAvailable&&<p>{t('export.no_current_speed')}</p>}
        <p>{t(format==='stems'?'export.no_countin':'export.no_progressive')}</p>
        <CabinetNotices sounds={sounds} trackNames={trackNames} className="export-cabinet-notices"/>
        <CaptureNotices sounds={sounds} trackNames={trackNames} className="export-cabinet-notices"/>
        <PluginNotices statuses={pluginWarnings ?? inspection?.pluginWarnings} trackNames={trackNames} instrumentTracks={Object.keys(sounds??{}).filter(id=>sounds?.[id]?.plugin?.kind==='instrument')} className="export-cabinet-notices"/>
        <label className="export-check"><input type="checkbox" checked={audio.metronome} onChange={e=>setAudio({...audio,metronome:e.target.checked})}/>{t('transport.metronome')}</label>
        <label className="export-check"><input type="checkbox" checked={audio.backing} onChange={e=>setAudio({...audio,backing:e.target.checked})}/>{t('export.include_backing')}</label>
        <label>{t('export.effect_tail')}<input type="number" min="0" max="30" step=".1" value={audio.tailSeconds} onChange={e=>setAudio({...audio,tailSeconds:Number(e.target.value)})}/></label>
        {format==='wav'&&<><label className="export-check"><input type="checkbox" checked={countIn&&countInBars>0} disabled={countInBars<=0} onChange={e=>setCountIn(e.target.checked)}/>{t('export.count_in')}</label>
        <p>{countInBars>0?t('export.count_in_note',{bars:countInBars}):t('export.count_in_unavailable')}</p>
        <label className="export-check"><input type="checkbox" checked={normalize} onChange={e=>setNormalize(e.target.checked)}/>{t('export.normalize')}</label>
        <label>{t('export.normalize_level')}<input type="number" min="-30" max="-6" step=".5" disabled={!normalize} value={normalizeLevel} onChange={e=>setNormalizeLevel(Number(e.target.value))}/></label>
        <p>{t('export.normalize_note')}</p></>}
        {format==='stems'&&<label className="export-check"><input type="checkbox" checked={audio.includeMix} onChange={e=>setAudio({...audio,includeMix:e.target.checked})}/>{t('export.include_mix')}</label>}
      </div></fieldset>}
    </fieldset>
    {visibleError&&<p id={errorId} role="alert">{visibleError}</p>}{busy&&!progress&&<p role="status">{t('export.preparing')}</p>}{progress&&<><progress aria-label={t('export.progress_aria')} data-job-id={progress.id} max={Math.max(1,progress.totalFrames)} value={progress.frames}/><p role="status">{progress.status==='running'?t('export.exporting'):progress.status}</p></>}
  </Dialog>;
}
