import { useI18n, type MessageKey } from '../i18n';
import { useEffect,useMemo,useState } from 'react';
import { musicClipSelection,readMusicClip } from './clipboard-source';
import type { ClipboardMode,ClipboardPanelProps,MusicClip,PasteFilters,PasteOptions } from './clipboard-types';

interface ClipMetadata {kind:MusicClip['kind'];mode:ClipboardMode;bars:number;tracks:{name:string;voices:number[]}[]}
interface MappingDraft {track:string;staffMap:string[]}
const index=(value:number)=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const numeric=(value:string)=>value.trim()?Number(value):NaN;
const defaults=(multi:boolean,diagrams=true):PasteFilters=>({diagrams,texts:true,timers:true,trackAutomations:true,masterAutomations:multi,sections:multi});
const filterLabels:[keyof PasteFilters,MessageKey][]=[['diagrams','editor.filter_diagrams'],['texts','editor.filter_texts'],['timers','editor.filter_timers'],['trackAutomations','editor.filter_track_automations'],['masterAutomations','editor.filter_master_automations'],['sections','editor.filter_sections']];

function metadata(clip:MusicClip|null):{value:ClipMetadata|null;error:string} {
  if(!clip)return {value:null,error:''};
  try {
    const accepted=readMusicClip(clip),score=JSON.parse(accepted.scoreJson) as {masterbars:unknown[];tracks:{name:string;staves:{bars:{voices:unknown[]}[]}[]}[]};
    return {value:{kind:accepted.kind,mode:accepted.mode,bars:score.masterbars.length,tracks:score.tracks.map(track=>({name:track.name,voices:track.staves.map(staff=>staff.bars.reduce((max,bar)=>Math.max(max,bar.voices.length),0))}))},error:''};
  }catch{return {value:null,error:'Clipboard content is invalid or unsupported.'};}
}

export function ClipboardPanel({score,target,selection,clip,busy,locked=false,diagramsDefault=true,onCopy,onCut,onPaste}:ClipboardPanelProps):React.JSX.Element {
  const { t, lang } = useI18n();
  const payload=useMemo(()=>metadata(clip),[clip]),source=payload.value;
  const [mode,setMode]=useState<ClipboardMode>('singleTrack'),[count,setCount]=useState('1'),[filters,setFilters]=useState(()=>defaults(source?.mode==='multiTrack',diagramsDefault)),[mappings,setMappings]=useState<MappingDraft[]>([]),[error,setError]=useState('');
  useEffect(()=>{
    setCount('1');setFilters(defaults(source?.mode==='multiTrack',diagramsDefault));setError('');
    // A multitrack bar clip with more tracks than the destination maps the rest to new tracks appended after the last one.
    const creates=source?.kind==='bars'&&source.mode==='multiTrack';let appended=score.tracks.length;
    setMappings(source?.tracks.map((track,sourceTrack)=>{
      const destination=target.track+sourceTrack,existing=score.tracks[destination];
      if(!existing&&creates)return {track:String(appended++),staffMap:track.voices.map((_,staff)=>String(staff))};
      return {track:existing?String(destination):'',staffMap:track.voices.map((_,staff)=>{const destinationStaff=source.kind==='phrase'?target.staff:staff;return existing?.staves[destinationStaff]?String(destinationStaff):'';})};
    })??[]);
  },[source,score,target.track,target.staff,target.bar,target.voice,target.beat]);
  // Changing the preference only moves the diagram filter; the repeat count and mappings being typed stay.
  useEffect(()=>{setFilters(old=>old.diagrams===diagramsDefault?old:{...old,diagrams:diagramsDefault});},[diagramsDefault]);
  const scope=useMemo(()=>{
    if(!selection)return {text:t('editor.select_music_to_copy'),error:''};
    try {
      const selected=musicClipSelection(score,selection,mode);
      if(selected.kind==='bars')return {text:t('editor.bars_tracks_summary',{first:selected.firstBar+1,last:selected.lastBar+1,tracks:selected.tracks.map(track=>track+1).join(', ')}),error:''};
      const lane=selected.kind==='range'?selected.range.lanes[0]:selected.notes[0].target;
      return {text:t('editor.selected_phrase',{track:lane.track+1,staff:lane.staff+1,voice:lane.voice+1}),error:''};
    }catch(reason){return {text:'',error:reason instanceof Error?reason.message:String(reason)};}
  },[score,selection,mode,lang]);
  const action=(work:()=>void)=>{if(busy||locked)return;try{work();setError('');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
  const paste=()=>action(()=>{
    if(!source)throw new Error('Copy music before pasting.');
    const repetitions=numeric(count);
    if(!Number.isInteger(repetitions)||repetitions<1||repetitions>1000)throw new Error('Paste repetitions must be a whole number from 1 to 1000.');
    if(source.kind==='bars'&&source.bars*repetitions>1000)throw new Error('Paste can insert at most 1000 measures at once.');
    if(!Object.values(target).every(index)||!score.masterBars[target.bar]||!score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]||(source.kind==='phrase'&&!score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice].beats[target.beat]))throw new Error('Choose an existing destination track, staff, measure, voice and beat.');
    const destinations=mappings.map((mapping,sourceTrack)=>({sourceTrack,track:numeric(mapping.track),staffMap:mapping.staffMap.map(numeric)}));
    const creates=source.kind==='bars'&&source.mode==='multiTrack',created=destinations.filter(mapping=>index(mapping.track)&&mapping.track>=score.tracks.length).sort((a,b)=>a.track-b.track);
    if(created.length&&(!creates||created.some((mapping,offset)=>mapping.track!==score.tracks.length+offset)))throw new Error('New destination tracks must directly follow the existing tracks, in order.');
    if(destinations.length!==source.tracks.length||new Set(destinations.map(mapping=>mapping.track)).size!==destinations.length||destinations.some(mapping=>!index(mapping.track)||!score.tracks[mapping.track]&&!created.includes(mapping)))throw new Error('Map every copied track to a unique existing destination track.');
    for(const mapping of destinations){
      const track=score.tracks[mapping.track],staffCounts=source.tracks[mapping.sourceTrack].voices;
      if(!track){if(mapping.staffMap.length!==staffCounts.length||mapping.staffMap.some((staff,index)=>staff!==index))throw new Error('A new destination track keeps the copied staff order.');continue;}
      if(mapping.staffMap.length!==staffCounts.length||new Set(mapping.staffMap).size!==mapping.staffMap.length||mapping.staffMap.some(staff=>!index(staff)||!track.staves[staff]))throw new Error('Map every copied staff to a unique existing destination staff.');
      if(source.kind==='bars'&&mapping.staffMap.some((staff,index)=>(track.staves[staff].bars[target.bar]?.voices.length??0)<staffCounts[index]))throw new Error('The destination must already contain every copied voice.');
    }
    if(source.kind==='phrase'&&(destinations[0].track!==target.track||destinations[0].staffMap[0]!==target.staff))throw new Error('Map a phrase to the selected destination staff and voice.');
    const options:PasteOptions={target:{track:target.track,staff:target.staff,bar:target.bar,voice:target.voice,beat:target.beat},destinations,count:repetitions,placement:source.kind==='phrase'?'currentBar':'beforeBar',filters:{...filters,masterAutomations:source.mode==='multiTrack'&&filters.masterAutomations,sections:source.mode==='multiTrack'&&filters.sections}};
    onPaste(options);
  });
  const visibleError=payload.error||error||scope.error;
  return <details className="editor-section"><summary>{t('editor.musical_clipboard')}</summary><fieldset disabled={busy}>
    <label>{t('editor.copy_cut_mode')}<select value={mode} onChange={event=>{setMode(event.target.value as ClipboardMode);setError('');}}><option value="singleTrack">{t('editor.mode_single_track')}</option><option value="multiTrack">{t('editor.mode_multi_track')}</option></select></label>
    <p>{scope.text}</p>
    {mode==='multiTrack'?<><p>{t('editor.clipboard_multi_hint')}</p><p>{t('editor.clipboard_multi_cut_hint')}</p></>:<p>{t('editor.clipboard_single_hint')}</p>}
    <div className="editor-actions"><button type="button" disabled={!selection||!!scope.error} onClick={()=>{if(selection&&!scope.error&&!busy)try{onCopy(mode);setError('');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}}}>{t('editor.copy_music')}</button><button type="button" disabled={locked||!selection||!!scope.error} onClick={()=>selection&&!scope.error&&action(()=>onCut(mode))}>{t('editor.cut_music')}</button></div>
    {source?<>
      <p>{source.kind==='phrase'?t('editor.paste_phrase_source',{measure:target.bar+1,beat:target.beat+1}):t('editor.paste_bars_source',{measure:target.bar+1})}</p>
      <p>{t('editor.paste_context_hint')}</p>
      {source.tracks.map((track,sourceTrack)=><fieldset key={sourceTrack}><legend>{t('editor.copied_track',{n:sourceTrack+1,name:track.name||t('score.untitled')})}</legend>
        <label>{t('editor.destination_track_for',{n:sourceTrack+1})}<select value={mappings[sourceTrack]?.track??''} disabled={source.kind==='phrase'} onChange={event=>{const destination=event.target.value,created=numeric(destination)>=score.tracks.length;setMappings(value=>value.map((mapping,index)=>index===sourceTrack?{...mapping,track:destination,staffMap:created?mapping.staffMap.map((_,staff)=>String(staff)):mapping.staffMap}:mapping));}}><option value="">{t('editor.choose_a_track')}</option>{score.tracks.map((track,index)=><option key={index} value={index}>Track {index+1}: {track.name||'Untitled'}</option>)}{source.kind==='bars'&&source.mode==='multiTrack'&&source.tracks.map((_,offset)=><option key={`new-${offset}`} value={score.tracks.length+offset}>{t('editor.new_track_option',{n:score.tracks.length+offset+1})}</option>)}</select></label>
        {track.voices.map((_,sourceStaff)=><label key={sourceStaff}>{t('editor.destination_staff_for',{n:sourceTrack+1,staff:sourceStaff+1})}<select value={mappings[sourceTrack]?.staffMap[sourceStaff]??''} disabled={source.kind==='phrase'||numeric(mappings[sourceTrack]?.track??'')>=score.tracks.length} onChange={event=>{const staff=event.target.value;setMappings(value=>value.map((mapping,index)=>index===sourceTrack?{...mapping,staffMap:mapping.staffMap.map((value,index)=>index===sourceStaff?staff:value)}:mapping));}}><option value="">{t('editor.choose_a_staff')}</option>{(score.tracks[numeric(mappings[sourceTrack]?.track??'')]?.staves??(numeric(mappings[sourceTrack]?.track??'')>=score.tracks.length?track.voices:[])).map((_,index)=><option key={index} value={index}>Staff {index+1}</option>)}</select></label>)}
      </fieldset>)}
      <label>{t('editor.paste_repetitions')}<input type="number" min={1} max={1000} step={1} value={count} onChange={event=>setCount(event.target.value)}/></label>
      <fieldset><legend>{t('editor.paste_special')}</legend>{filterLabels.map(([key,label])=><label className="check" key={key}><input type="checkbox" checked={filters[key]} disabled={source.mode==='singleTrack'&&(key==='masterAutomations'||key==='sections')} onChange={event=>{const enabled=event.target.checked;setFilters(value=>({...value,[key]:enabled}));}}/>{t(label)}</label>)}</fieldset>
    </>:!payload.error&&<p>{t('editor.clipboard_empty')}</p>}
    <button type="button" disabled={locked||!source} onClick={paste}>{t('editor.paste_music')}</button>
    {visibleError&&<p role="alert">{visibleError}</p>}
  </fieldset></details>;
}
