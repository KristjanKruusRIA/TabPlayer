import { useEffect,useMemo,useState } from 'react';
import { musicClipSelection,readMusicClip } from './clipboard-source';
import type { ClipboardMode,ClipboardPanelProps,MusicClip,PasteFilters,PasteOptions } from './clipboard-types';

interface ClipMetadata {kind:MusicClip['kind'];mode:ClipboardMode;bars:number;tracks:{name:string;voices:number[]}[]}
interface MappingDraft {track:string;staffMap:string[]}
const index=(value:number)=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const numeric=(value:string)=>value.trim()?Number(value):NaN;
const defaults=(multi:boolean):PasteFilters=>({diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:multi,sections:multi});
const filterLabels:[keyof PasteFilters,string][]=[['diagrams','Chord diagrams'],['texts','Beat texts'],['timers','Timers'],['trackAutomations','Track automations'],['masterAutomations','Master tempo automations'],['sections','Sections']];

function metadata(clip:MusicClip|null):{value:ClipMetadata|null;error:string} {
  if(!clip)return {value:null,error:''};
  try {
    const accepted=readMusicClip(clip),score=JSON.parse(accepted.scoreJson) as {masterbars:unknown[];tracks:{name:string;staves:{bars:{voices:unknown[]}[]}[]}[]};
    return {value:{kind:accepted.kind,mode:accepted.mode,bars:score.masterbars.length,tracks:score.tracks.map(track=>({name:track.name,voices:track.staves.map(staff=>staff.bars.reduce((max,bar)=>Math.max(max,bar.voices.length),0))}))},error:''};
  }catch{return {value:null,error:'Clipboard content is invalid or unsupported.'};}
}

export function ClipboardPanel({score,target,selection,clip,busy,onCopy,onCut,onPaste}:ClipboardPanelProps):React.JSX.Element {
  const payload=useMemo(()=>metadata(clip),[clip]),source=payload.value;
  const [mode,setMode]=useState<ClipboardMode>('singleTrack'),[count,setCount]=useState('1'),[filters,setFilters]=useState(()=>defaults(source?.mode==='multiTrack')),[mappings,setMappings]=useState<MappingDraft[]>([]),[error,setError]=useState('');
  useEffect(()=>{
    setCount('1');setFilters(defaults(source?.mode==='multiTrack'));setError('');
    setMappings(source?.tracks.map((track,sourceTrack)=>{
      const destination=target.track+sourceTrack,existing=score.tracks[destination];
      return {track:existing?String(destination):'',staffMap:track.voices.map((_,staff)=>{const destinationStaff=source.kind==='phrase'?target.staff:staff;return existing?.staves[destinationStaff]?String(destinationStaff):'';})};
    })??[]);
  },[source,score,target.track,target.staff,target.bar,target.voice,target.beat]);
  const scope=useMemo(()=>{
    if(!selection)return {text:'Select music to copy or cut.',error:''};
    try {
      const selected=musicClipSelection(score,selection,mode);
      if(selected.kind==='bars')return {text:`Measures ${selected.firstBar+1}–${selected.lastBar+1} · Tracks ${selected.tracks.map(track=>track+1).join(', ')}`,error:''};
      const lane=selected.kind==='range'?selected.range.lanes[0]:selected.notes[0].target;
      return {text:`Selected phrase · Track ${lane.track+1} · Staff ${lane.staff+1} · Voice ${lane.voice+1}`,error:''};
    }catch(reason){return {text:'',error:reason instanceof Error?reason.message:String(reason)};}
  },[score,selection,mode]);
  const action=(work:()=>void)=>{if(busy)return;try{work();setError('');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
  const paste=()=>action(()=>{
    if(!source)throw new Error('Copy music before pasting.');
    const repetitions=numeric(count);
    if(!Number.isInteger(repetitions)||repetitions<1||repetitions>1000)throw new Error('Paste repetitions must be a whole number from 1 to 1000.');
    if(source.kind==='bars'&&source.bars*repetitions>1000)throw new Error('Paste can insert at most 1000 measures at once.');
    if(!Object.values(target).every(index)||!score.masterBars[target.bar]||!score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]||(source.kind==='phrase'&&!score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice].beats[target.beat]))throw new Error('Choose an existing destination track, staff, measure, voice and beat.');
    const destinations=mappings.map((mapping,sourceTrack)=>({sourceTrack,track:numeric(mapping.track),staffMap:mapping.staffMap.map(numeric)}));
    if(destinations.length!==source.tracks.length||new Set(destinations.map(mapping=>mapping.track)).size!==destinations.length||destinations.some(mapping=>!index(mapping.track)||!score.tracks[mapping.track]))throw new Error('Map every copied track to a unique existing destination track.');
    for(const mapping of destinations){
      const track=score.tracks[mapping.track],staffCounts=source.tracks[mapping.sourceTrack].voices;
      if(mapping.staffMap.length!==staffCounts.length||new Set(mapping.staffMap).size!==mapping.staffMap.length||mapping.staffMap.some(staff=>!index(staff)||!track.staves[staff]))throw new Error('Map every copied staff to a unique existing destination staff.');
      if(source.kind==='bars'&&mapping.staffMap.some((staff,index)=>(track.staves[staff].bars[target.bar]?.voices.length??0)<staffCounts[index]))throw new Error('The destination must already contain every copied voice.');
    }
    if(source.kind==='phrase'&&(destinations[0].track!==target.track||destinations[0].staffMap[0]!==target.staff))throw new Error('Map a phrase to the selected destination staff and voice.');
    const options:PasteOptions={target:{track:target.track,staff:target.staff,bar:target.bar,voice:target.voice,beat:target.beat},destinations,count:repetitions,placement:source.kind==='phrase'?'currentBar':'beforeBar',filters:{...filters,masterAutomations:source.mode==='multiTrack'&&filters.masterAutomations,sections:source.mode==='multiTrack'&&filters.sections}};
    onPaste(options);
  });
  const visibleError=payload.error||error||scope.error;
  return <details className="editor-section"><summary>Musical clipboard</summary><fieldset disabled={busy}>
    <label>Copy/cut mode<select value={mode} onChange={event=>{setMode(event.target.value as ClipboardMode);setError('');}}><option value="singleTrack">Single track</option><option value="multiTrack">Multitrack</option></select></label>
    <p>{scope.text}</p>
    {mode==='multiTrack'?<><p>Multitrack copy expands to complete measures and all staves and voices of the selected tracks.</p><p>Cut removes these measures from every track, including unselected tracks.</p></>:<p>Single-track phrases require one voice lane. Complete bars include all staves and voices of that track.</p>}
    <div className="editor-actions"><button type="button" disabled={!selection||!!scope.error} onClick={()=>selection&&!scope.error&&action(()=>onCopy(mode))}>Copy music</button><button type="button" disabled={!selection||!!scope.error} onClick={()=>selection&&!scope.error&&action(()=>onCut(mode))}>Cut music</button></div>
    {source?<>
      <p>{source.kind==='phrase'?`Phrase at the current beat · Measure ${target.bar+1}, beat ${target.beat+1}`:`Complete bars inserted before measure ${target.bar+1}`}</p>
      <p>Phrases fill a rest or empty suffix in one voice. Complete bars insert globally; other tracks receive empty bars. Unsupported musical contexts are rejected before editing.</p>
      {source.tracks.map((track,sourceTrack)=><fieldset key={sourceTrack}><legend>Copied track {sourceTrack+1}: {track.name||'Untitled'}</legend>
        <label>Destination track for copied track {sourceTrack+1}<select value={mappings[sourceTrack]?.track??''} disabled={source.kind==='phrase'} onChange={event=>{const destination=event.target.value;setMappings(value=>value.map((mapping,index)=>index===sourceTrack?{...mapping,track:destination}:mapping));}}><option value="">Choose a track</option>{score.tracks.map((track,index)=><option key={index} value={index}>Track {index+1}: {track.name||'Untitled'}</option>)}</select></label>
        {track.voices.map((_,sourceStaff)=><label key={sourceStaff}>Destination staff for copied track {sourceTrack+1}, staff {sourceStaff+1}<select value={mappings[sourceTrack]?.staffMap[sourceStaff]??''} disabled={source.kind==='phrase'} onChange={event=>{const staff=event.target.value;setMappings(value=>value.map((mapping,index)=>index===sourceTrack?{...mapping,staffMap:mapping.staffMap.map((value,index)=>index===sourceStaff?staff:value)}:mapping));}}><option value="">Choose a staff</option>{score.tracks[numeric(mappings[sourceTrack]?.track??'')]?.staves.map((_,index)=><option key={index} value={index}>Staff {index+1}</option>)}</select></label>)}
      </fieldset>)}
      <label>Paste repetitions<input type="number" min={1} max={1000} step={1} value={count} onChange={event=>setCount(event.target.value)}/></label>
      <fieldset><legend>Paste special</legend>{filterLabels.map(([key,label])=><label className="check" key={key}><input type="checkbox" checked={filters[key]} disabled={source.mode==='singleTrack'&&(key==='masterAutomations'||key==='sections')} onChange={event=>{const enabled=event.target.checked;setFilters(value=>({...value,[key]:enabled}));}}/>{label}</label>)}</fieldset>
    </>:!payload.error&&<p>The musical clipboard is empty.</p>}
    <button type="button" disabled={!source} onClick={paste}>Paste music</button>
    {visibleError&&<p role="alert">{visibleError}</p>}
  </fieldset></details>;
}
