import { useI18n } from '../i18n';
import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {KeyboardEvent,PointerEvent} from 'react';
import type {BackingSettings} from '../edit-types';
import type {BackingGridLine,BackingWaveform as WaveformData,BackingWaveformProps} from './backing-waveform-types';
import {moveBackingAnchor,projectBackingGrid,projectBackingSelection,scoreTimeToAudioMs} from './backing-timeline';
import {useBackingWaveform} from './useBackingWaveform';
import {referenceSyncTiming} from './reference-sync';
import type {ReferenceEndpoint} from './reference-sync-types';
import './backing-waveform.css';

const zooms=[1,2,4,8,16];
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const milliseconds=(value:number)=>`${value.toLocaleString(undefined,{maximumFractionDigits:2})} ms`;
const pointName=(bar:number,occurrence:number)=>`Measure ${bar+1}, occurrence ${occurrence+1}`;
type Chosen={kind:'anchor';index:number}|{kind:'grid';line:BackingGridLine}|{kind:'endpoint';endpoint:ReferenceEndpoint};
type EndpointGesture={endpoint:ReferenceEndpoint;sourceMs:number;key?:string;delta:number;pointer?:{id:number;startX:number;width:number}};
type Transaction={signature:string;document:BackingWaveformProps['document'];settings:BackingSettings;timeline:NonNullable<BackingWaveformProps['timeline']>;index:number;candidate:BackingSettings;invalid:boolean;phase:'preview'|'commit';release:()=>void;pointer?:{id:number;startX:number;sourceMs:number;width:number};key?:string;keyDelta?:number};

const Peaks=memo(function Peaks({data}:{data:WaveformData}) {
  const { t } = useI18n();
  const paths=useMemo(()=>Array.from({length:data.channels},(_,channel)=>data.peaks.map((peak,index)=>{
    const center=data.channels===1?61:channel===0?43:79,scale=data.channels===1?31:15,x=index/data.bucketCount*1000;
    return `M${x} ${center-peak.max[channel]*scale}L${x} ${center-peak.min[channel]*scale}H${(index+1)/data.bucketCount*1000}`;
  }).join('')),[data]);
  return <svg className="backing-waveform-peaks" viewBox="0 20 1000 80" preserveAspectRatio="none" role="img" aria-label={t('waveform.peaks_aria')}>{paths.map((d,channel)=><path key={channel} data-waveform-channel={channel} d={d}/>)}</svg>;
});

export function BackingWaveform(props:BackingWaveformProps) {
  const { t } = useI18n();
  const query=useBackingWaveform(props),data=query.data,viewport=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null);
  const [zoomIndex,setZoomIndex]=useState(0),[width,setWidth]=useState(1),[scroll,setScroll]=useState(0),[chosen,setChosen]=useState<Chosen|null>(null);
  const [preview,setPreview]=useState<BackingSettings|null>(null),[editing,setEditing]=useState(false),[error,setError]=useState<string|null>(null);
  const active=useRef<Transaction|null>(null),latest=useRef(props),mounted=useRef(true);latest.current=props;
  const endpointGesture=useRef<EndpointGesture|null>(null);
  const sourceIdentity=props.source?.kind==='asset'?['asset',props.source.assetId]:props.source?.kind==='embedded'?['embedded',props.source.sourceKey,props.source.sha256]:null;
  const identity=JSON.stringify([props.bridge.owner,props.document.documentId,sourceIdentity]);
  const signature=JSON.stringify([identity,props.document.revision,props.settings,props.timeline?.generation]);
  const currentSignature=useRef(signature);currentSignature.current=signature;
  const duration=data?.durationMs??0,zoom=zooms[zoomIndex],contentWidth=width*zoom;
  const timeline=useMemo(()=>props.timeline,[props.timeline?.generation,props.timeline?.durationTick,props.timeline?.tempos,props.timeline?.occurrences]);
  const selection=useMemo(()=>props.selection,[JSON.stringify(props.selection)]);
  const committedMap=useMemo(()=>props.settings??props.effectiveBacking,[JSON.stringify(props.settings??props.effectiveBacking)]);
  const reference=props.reference,map=reference?.edit.preview??preview??committedMap;
  const editable=props.source?.kind==='asset'&&props.settings?.assetId===props.source.assetId;
  const canEdit=!!(editable&&data&&props.timeline&&props.enabled&&!props.busy&&!editing&&!reference?.edit.active);
  const referenceTiming=useMemo(()=>{
    if(!reference?.timing)return null;
    if(!reference.edit.preview&&!preview)return reference.timing;
    try{return map&&timeline?referenceSyncTiming(map as BackingSettings,timeline.occurrences,duration):reference.timing;}catch{return reference.timing;}
  },[reference?.timing,reference?.edit.preview,preview,map,timeline,duration]);
  const start=duration*scroll/contentWidth,end=Math.min(duration,start+duration/zoom);
  const projected=useMemo(()=>{
    if(!timeline||!map||!data)return {grid:[],selection:{points:[],spans:[]},error:null};
    try{return {grid:projectBackingGrid(timeline,map,start,end),selection:projectBackingSelection(timeline,map,selection),error:null};}
    catch(reason){return {grid:[],selection:{points:[],spans:[]},error:message(reason)};}
  },[timeline,map,selection,data,start,end]);
  const playhead=useMemo(()=>{
    if(!timeline||!committedMap||!data||props.scoreTimeMs===null)return null;
    try{const ms=scoreTimeToAudioMs(timeline,committedMap,props.scoreTimeMs);return Number.isFinite(ms)&&ms>=0&&ms<=duration?ms:null;}catch{return null;}
  },[timeline,committedMap,data,props.scoreTimeMs,duration]);
  const selectionLabels=useMemo(()=>{
    const at=(tick:number,end=false)=>timeline?.occurrences.find(occurrence=>end?tick>occurrence.startTick&&tick<=occurrence.endTick:tick>=occurrence.startTick&&tick<occurrence.endTick);
    const name=(location:{bar:number;occurrence:number}|null|undefined)=>location?`M${location.bar+1} · ${location.occurrence+1}`:'';
    return {
      points:selection.points.map(point=>name(point.anchor??at(point.tick))),
      spans:selection.spans.map(span=>{const first=name(at(span.startTick)),last=name(at(span.endTick,true));return first===last?first:`${first} – ${last}`;}),
    };
  },[timeline,selection]);
  const ticks=useMemo(()=>{
    if(!duration)return [];
    const target=duration/Math.max(1,contentWidth/88),base=10**Math.floor(Math.log10(target));
    const step=([1,2,5,10].find(value=>value*base>=target)??10)*base,result=[];
    const precision=Math.max(0,Math.min(6,Math.ceil(-Math.log10(step/1000)))),rounding=10**precision;
    for(let ms=Math.ceil(start/step)*step;ms<=end;ms+=step){
      const seconds=Math.round(ms/1000*rounding)/rounding;
      result.push({ms,label:`${Math.floor(seconds/60)}:${(seconds%60).toFixed(precision).padStart(precision?precision+3:2,'0')}`});
    }
    return result;
  },[duration,contentWidth,start,end]);

  const clear=(transaction:Transaction,update=true)=>{
    if(active.current===transaction)active.current=null;
    transaction.release();
    if(update&&mounted.current){setPreview(null);setEditing(false);}
  };
  const cancel=(update=true)=>{const transaction=active.current;if(transaction)clear(transaction,update);};
  const isCurrent=(transaction:Transaction)=>props.enabled&&currentSignature.current===transaction.signature&&latest.current.isCurrent(transaction.document,transaction.settings);
  useEffect(()=>{
    mounted.current=true;
    const blur=()=>{if(active.current?.phase==='preview')cancel();};window.addEventListener('blur',blur);
    return ()=>{window.removeEventListener('blur',blur);mounted.current=false;cancel(false);};
  },[]);
  useEffect(()=>{const transaction=active.current;if(transaction?.phase==='preview'&&!isCurrent(transaction))cancel();});
  useEffect(()=>{setChosen(null);setError(null);},[signature]);
  useEffect(()=>{
    if(!reference?.edit.active||reference.edit.active.surface!=='waveform')endpointGesture.current=null;
    if(!props.enabled&&reference?.edit.active?.surface==='waveform')reference.edit.cancel();
  });
  useEffect(()=>()=>{if(latest.current.reference?.edit.active?.surface==='waveform')latest.current.reference.edit.cancel();},[]);
  useEffect(()=>{setChosen(null);setError(null);setZoomIndex(0);setScroll(0);if(viewport.current)viewport.current.scrollLeft=0;},[identity]);
  useLayoutEffect(()=>{
    const element=viewport.current;if(!element)return;
    const measure=(value:number)=>setWidth(Math.max(1,value));measure(element.getBoundingClientRect().width);
    const observer=new ResizeObserver(entries=>{if(entries[0])measure(entries[0].contentRect.width);});observer.observe(element);return ()=>observer.disconnect();
  },[query.kind]);
  useLayoutEffect(()=>{const element=viewport.current;if(element){const next=Math.max(0,Math.min(element.scrollLeft,contentWidth-width));element.scrollLeft=next;setScroll(next);}},[contentWidth,width]);

  const begin=(index:number):Transaction|null=>{
    if(!canEdit||!props.settings||!props.timeline)return null;
    setError(null);
    try{
      const settings=structuredClone(props.settings),document={...props.document};
      if(!props.isCurrent(document,settings))throw new Error('Backing audio changed. Select the sync point again.');
      const end=props.beginOperation();let released=false;
      const transaction:Transaction={signature,document,settings,timeline:props.timeline,index,candidate:settings,invalid:false,phase:'preview',release:()=>{if(!released){released=true;end();}}};
      active.current=transaction;setEditing(true);return transaction;
    }catch(reason){setError(message(reason));return null;}
  };
  const update=(transaction:Transaction,sourceMs:number)=>{
    if(!isCurrent(transaction)){cancel();return;}
    try{
      const originalMs=transaction.settings.anchors[transaction.index].audioMs-transaction.settings.offsetMs;
      transaction.candidate=sourceMs===originalMs?transaction.settings:moveBackingAnchor(transaction.settings,transaction.index,sourceMs,transaction.timeline,duration);
      transaction.invalid=false;setPreview(transaction.candidate);setError(null);
    }
    catch(reason){transaction.invalid=true;setError(message(reason));}
  };
  const commit=(transaction:Transaction)=>{
    if(active.current!==transaction||transaction.phase!=='preview')return;
    if(!isCurrent(transaction)||transaction.invalid||JSON.stringify(transaction.candidate)===JSON.stringify(transaction.settings)){clear(transaction);return;}
    transaction.phase='commit';
    let operation:Promise<void>;
    try{operation=latest.current.onEdit({type:'setBacking',backing:transaction.candidate});}
    catch(reason){if(mounted.current)setError(message(reason));clear(transaction);return;}
    void Promise.resolve(operation).catch(reason=>{if(mounted.current&&currentSignature.current===transaction.signature)setError(message(reason));}).finally(()=>{clear(transaction);});
  };
  const pointerDown=(event:PointerEvent<HTMLDivElement>,index:number)=>{
    event.stopPropagation();event.preventDefault();if(event.button!==0)return;
    event.currentTarget.focus();setChosen({kind:'anchor',index});
    const transaction=begin(index);if(!transaction)return;
    transaction.pointer={id:event.pointerId,startX:event.clientX,sourceMs:transaction.settings.anchors[index].audioMs-transaction.settings.offsetMs,width:Math.max(1,content.current?.getBoundingClientRect().width??contentWidth)};
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch(reason){setError(message(reason));clear(transaction);}
  };
  const pointerMove=(event:PointerEvent<HTMLDivElement>)=>{
    const transaction=active.current,pointer=transaction?.pointer;if(!transaction||!pointer||transaction.phase!=='preview'||pointer.id!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();update(transaction,pointer.sourceMs+(event.clientX-pointer.startX)*duration/pointer.width);
  };
  const pointerUp=(event:PointerEvent<HTMLDivElement>)=>{
    const transaction=active.current,pointer=transaction?.pointer;if(!transaction||!pointer||transaction.phase!=='preview'||pointer.id!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();update(transaction,pointer.sourceMs+(event.clientX-pointer.startX)*duration/pointer.width);commit(transaction);
    try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{/* Capture may already have ended. */}
  };
  const keyDown=(event:KeyboardEvent<HTMLDivElement>,index:number)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(active.current?.phase==='preview')cancel();return;}
    if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
    event.preventDefault();event.stopPropagation();
    if(event.currentTarget!==document.activeElement)return;
    const transaction=active.current??begin(index);if(!transaction||transaction.phase!=='preview'||transaction.pointer||transaction.index!==index)return;
    setChosen({kind:'anchor',index});transaction.key=event.key;
    transaction.keyDelta=(transaction.keyDelta??0)+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?10:1);
    update(transaction,transaction.settings.anchors[index].audioMs-transaction.settings.offsetMs+transaction.keyDelta);
  };
  const keyUp=(event:KeyboardEvent<HTMLDivElement>)=>{
    const transaction=active.current;if(transaction?.key===event.key){event.preventDefault();event.stopPropagation();commit(transaction);}
  };
  const endpointDisabled=(endpoint:ReferenceEndpoint)=>!editable||!props.enabled||editing||!!active.current||((props.busy||!!reference?.edit.active)&&!(reference?.edit.active?.endpoint===endpoint&&reference.edit.active.surface==='waveform'));
  const selectEndpoint=(endpoint:ReferenceEndpoint)=>{setChosen({kind:'endpoint',endpoint});setError(null);};
  const cancelEndpoint=()=>{endpointGesture.current=null;reference?.edit.cancel();};
  const beginEndpoint=(endpoint:ReferenceEndpoint)=>{
    if(!reference||!referenceTiming||endpointDisabled(endpoint)||!reference.edit.begin(endpoint,'waveform'))return null;
    const gesture:EndpointGesture={endpoint,sourceMs:endpoint==='entry'?referenceTiming.entrySourceMs:referenceTiming.exitSourceMs,delta:0};
    endpointGesture.current=gesture;selectEndpoint(endpoint);return gesture;
  };
  const endpointPointerDown=(event:PointerEvent<HTMLDivElement>,endpoint:ReferenceEndpoint)=>{
    event.preventDefault();event.stopPropagation();if(event.button!==0)return;event.currentTarget.focus();
    const gesture=beginEndpoint(endpoint);if(!gesture)return;
    gesture.pointer={id:event.pointerId,startX:event.clientX,width:Math.max(1,content.current?.getBoundingClientRect().width??contentWidth)};
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{cancelEndpoint();}
  };
  const endpointPointerMove=(event:PointerEvent<HTMLDivElement>,finish=false)=>{
    const gesture=endpointGesture.current,pointer=gesture?.pointer;if(!gesture||!pointer||pointer.id!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();reference?.edit.update(gesture.sourceMs+(event.clientX-pointer.startX)*duration/pointer.width);
    if(finish){endpointGesture.current=null;reference?.edit.commit();try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{/* Capture may already have ended. */}}
  };
  const endpointKeyDown=(event:KeyboardEvent<HTMLDivElement>,endpoint:ReferenceEndpoint)=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();cancelEndpoint();return;}
    if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();
    if(event.currentTarget!==document.activeElement||endpointDisabled(endpoint))return;
    const gesture=endpointGesture.current??beginEndpoint(endpoint);if(!gesture||gesture.endpoint!==endpoint||gesture.pointer)return;
    gesture.key=event.key;gesture.delta+=(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?10:1);reference?.edit.update(gesture.sourceMs+gesture.delta);
  };
  const endpointKeyUp=(event:KeyboardEvent<HTMLDivElement>)=>{
    event.stopPropagation();if(endpointGesture.current?.key!==event.key)return;event.preventDefault();endpointGesture.current=null;reference?.edit.commit();
  };
  const add=()=>{
    if(chosen?.kind!=='grid'||!props.settings||!props.timeline)return;
    const transaction=begin(-1);if(!transaction)return;
    try{
      const line=chosen.line,current=projectBackingGrid(transaction.timeline,transaction.settings,0,duration).find(item=>item.key===line.key);
      if(!current)throw new Error('The selected score beat is no longer available.');
      const candidate={...transaction.settings,anchors:[...transaction.settings.anchors,{bar:current.bar,occurrence:current.occurrence,ratio:current.ratio,audioMs:current.audioMs+transaction.settings.offsetMs}]};
      transaction.candidate=moveBackingAnchor(candidate,candidate.anchors.length-1,current.audioMs,transaction.timeline,duration);commit(transaction);
    }catch(reason){setError(message(reason));clear(transaction);}
  };
  const remove=()=>{
    if(chosen?.kind!=='anchor'||!props.settings?.anchors[chosen.index])return;
    const transaction=begin(chosen.index);if(!transaction)return;
    transaction.candidate={...transaction.settings,anchors:transaction.settings.anchors.filter((_,index)=>index!==chosen.index)};commit(transaction);setChosen(null);
  };
  const selectedAnchor=chosen?.kind==='anchor'?map?.anchors[chosen.index]:null,selectedGrid=chosen?.kind==='grid'?chosen.line:null;
  const selected=selectedAnchor??selectedGrid,selectedMs=selectedAnchor&&map?selectedAnchor.audioMs-map.offsetMs:selectedGrid?.audioMs;
  const selectedEndpoint=chosen?.kind==='endpoint'&&referenceTiming?chosen.endpoint:null;
  const shownError=reference?.edit.error??error??projected.error;
  return <section className="backing-waveform" aria-label={t('waveform.section_aria')} onKeyDown={event=>{if(event.key==='Escape'&&active.current?.phase==='preview'){event.preventDefault();cancel();}event.stopPropagation();}} onKeyUp={event=>event.stopPropagation()}>
    <div className="backing-waveform-toolbar">
      <strong className="backing-waveform-filename" title={props.filename}>{props.filename.split(/[\\/]/).at(-1)||t('dock.backing_audio_default')}</strong>
      <button aria-label={t('waveform.zoom_out')} disabled={!data||editing||zoomIndex===0} onClick={()=>setZoomIndex(value=>value-1)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"/></svg></button>
      <output aria-label={t('waveform.zoom_output_aria')}>{zoom*100}%</output>
      <button aria-label={t('waveform.zoom_in')} disabled={!data||editing||zoomIndex===zooms.length-1} onClick={()=>setZoomIndex(value=>value+1)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M8 3v10"/></svg></button>
      <button disabled={!data||editing} onClick={()=>{setZoomIndex(0);setScroll(0);if(viewport.current)viewport.current.scrollLeft=0;}}>{t('waveform.fit')}</button>
      {referenceTiming&&<span className="backing-waveform-mode">{t('waveform.score_follows_audio')}</span>}
      {props.source?.kind==='embedded'&&<span className="backing-waveform-readonly">{t('waveform.embedded_readonly')}</span>}
    </div>
    {query.kind==='none'&&<p className="backing-waveform-state">{props.source?t('waveform.show_to_load'):t('waveform.score_only')}</p>}
    {query.kind==='loading'&&<p className="backing-waveform-state" role="status">{t('waveform.loading')}</p>}
    {query.kind==='error'&&<div className="backing-waveform-state"><p role="alert">{query.error}</p><button onClick={query.retry}>{t('action.retry')}</button></div>}
    {data&&<div className="backing-waveform-viewport" ref={viewport} role="region" aria-label={t('waveform.timeline_aria')} tabIndex={0} onScroll={event=>{const element=event.currentTarget,next=Math.max(0,Math.min(element.scrollLeft,contentWidth-width));element.scrollLeft=next;setScroll(next);}}>
      <div ref={content} className={`backing-waveform-content${referenceTiming?' reference':''}`} style={{width:`${contentWidth}px`}}>
        {ticks.map(tick=><span key={tick.ms} className="backing-waveform-time" style={{left:`${tick.ms/duration*100}%`}}>{tick.label}</span>)}
        {referenceTiming&&<>
          <div className="backing-waveform-excluded" style={{left:0,width:`${referenceTiming.entrySourceMs/duration*100}%`}}/>
          <div className="backing-waveform-excluded" style={{left:`${referenceTiming.exitSourceMs/duration*100}%`,right:0}}/>
          {referenceTiming.segments.map((segment,index)=>{
            const left=Math.max(start,segment.startSourceMs),right=Math.min(end,segment.endSourceMs),pixels=(right-left)/duration*contentWidth;
            return pixels>=90?<span key={index} className="backing-waveform-tempo" style={{left:`${left/duration*100}%`,width:`${(right-left)/duration*100}%`}}>{segment.bpm.toLocaleString(undefined,{maximumFractionDigits:2})} BPM</span>:null;
          })}
        </>}
        {projected.selection.spans.map((span,index)=><div key={index} className="backing-waveform-selection-span" aria-label={`${t('waveform.selection_span_aria',{index:index+1})}${selectionLabels.spans[index]?` · ${selectionLabels.spans[index]}`:''}`} style={{left:`${span.startMs/duration*100}%`,width:`${(span.endMs-span.startMs)/duration*100}%`}}>{selectionLabels.spans[index]&&<span className="backing-waveform-selection-label">{selectionLabels.spans[index]}</span>}</div>)}
        {projected.grid.map(line=><button key={line.key} className={`backing-waveform-grid ${line.kind}`} aria-label={`${pointName(line.bar,line.occurrence)}, position ${line.ratio.toFixed(2)}`} title={`${pointName(line.bar,line.occurrence)}, position ${line.ratio.toFixed(2)} · ${milliseconds(line.audioMs)}`} aria-pressed={chosen?.kind==='grid'&&chosen.line.key===line.key} disabled={editing} style={{left:`${line.audioMs/duration*100}%`}} onClick={()=>{setChosen({kind:'grid',line});setError(null);}}>{line.kind==='bar'&&<span>M{line.bar+1} · {line.occurrence+1}</span>}</button>)}
        <Peaks data={data}/>
        {projected.selection.points.map((ms,index)=><div key={index} className="backing-waveform-selection-point" aria-label={`${t('waveform.selection_point_aria',{index:index+1})}${selectionLabels.points[index]?` · ${selectionLabels.points[index]}`:''}`} title={selectionLabels.points[index]} style={{left:`${ms/duration*100}%`}}/>)}
        {props.timeline&&map?.anchors.map((anchor,index)=>{
          const ms=anchor.audioMs-map.offsetMs;if(ms<0||ms>duration)return null;
          const disabled=!props.enabled||!!reference?.edit.active||((props.busy||editing)&&!(active.current?.index===index&&active.current.phase==='preview'));
          return editable?<div key={index} role="slider" tabIndex={disabled?-1:0} className="backing-waveform-handle" aria-label={t('waveform.anchor_aria',{index:index+1,bar:anchor.bar+1,occurrence:anchor.occurrence+1})} aria-valuemin={map.referenceSync?0:Math.max(0,-map.offsetMs)} aria-valuemax={duration} aria-valuenow={ms} aria-valuetext={t('waveform.anchor_valuetext',{bar:anchor.bar+1,occurrence:anchor.occurrence+1,ratio:anchor.ratio.toFixed(2),ms:milliseconds(ms)})} aria-disabled={disabled} data-selected={chosen?.kind==='anchor'&&chosen.index===index} data-edge={ms===0?'start':ms===duration?'end':undefined} style={{left:`${ms/duration*100}%`}} onClick={()=>{if(!disabled)setChosen({kind:'anchor',index});}} onPointerDown={event=>{if(!disabled)pointerDown(event,index);}} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={event=>{event.stopPropagation();if(active.current?.phase==='preview')cancel();}} onLostPointerCapture={()=>{if(active.current?.phase==='preview')cancel();}} onKeyDown={event=>keyDown(event,index)} onKeyUp={keyUp} onBlur={()=>{if(active.current?.phase==='preview')cancel();}}><span>{index+1}</span></div>:<div key={index} className="backing-waveform-original-anchor" title={`${pointName(anchor.bar,anchor.occurrence)} · ${milliseconds(ms)}`} style={{left:`${ms/duration*100}%`}}/>;
        })}
        {referenceTiming&&(['entry','exit'] as const).map(endpoint=>{
          const ms=endpoint==='entry'?referenceTiming.entrySourceMs:referenceTiming.exitSourceMs,disabled=endpointDisabled(endpoint),name=endpoint==='entry'?t('waveform.entry'):t('waveform.exit');
          return <div key={endpoint} role={editable?'slider':undefined} tabIndex={editable&&!disabled?0:undefined} className={`backing-waveform-handle backing-waveform-endpoint ${endpoint}`} aria-label={t('waveform.endpoint_bracket_aria',{name})} aria-valuemin={editable?0:undefined} aria-valuemax={editable?duration:undefined} aria-valuenow={editable?ms:undefined} aria-valuetext={editable?t('waveform.endpoint_valuetext',{name,ms:milliseconds(ms)}):undefined} aria-disabled={editable?disabled:undefined} data-selected={chosen?.kind==='endpoint'&&chosen.endpoint===endpoint} data-edge={ms===0?'start':ms===duration?'end':undefined} style={{left:`${ms/duration*100}%`}} onFocus={()=>selectEndpoint(endpoint)} onClick={()=>selectEndpoint(endpoint)} onPointerDown={event=>{if(!disabled)endpointPointerDown(event,endpoint);}} onPointerMove={event=>endpointPointerMove(event)} onPointerUp={event=>endpointPointerMove(event,true)} onPointerCancel={event=>{event.stopPropagation();cancelEndpoint();}} onLostPointerCapture={()=>{if(endpointGesture.current?.pointer)cancelEndpoint();}} onKeyDown={event=>endpointKeyDown(event,endpoint)} onKeyUp={endpointKeyUp} onBlur={()=>{if(endpointGesture.current)cancelEndpoint();}}><span>{name}</span></div>;
        })}
        {playhead!==null&&<div className="backing-waveform-playhead" aria-label={t('waveform.playhead_aria')} style={{left:`${playhead/duration*100}%`}}/>}
      </div>
    </div>}
    <div className="backing-waveform-footer">
      <div className="backing-waveform-readout" aria-live="polite">{shownError?<span role="alert">{shownError}</span>:data&&!props.timeline?<span>{t('waveform.preparing_timing')}</span>:selectedEndpoint&&referenceTiming?<span>{t('waveform.endpoint_valuetext',{name:selectedEndpoint==='entry'?t('waveform.entry'):t('waveform.exit'),ms:milliseconds(selectedEndpoint==='entry'?referenceTiming.entrySourceMs:referenceTiming.exitSourceMs)})}</span>:selected&&selectedMs!==undefined?<span>{chosen?.kind==='anchor'?t('waveform.selected_sync_point'):t('waveform.selected_score_beat')} · {pointName(selected.bar,selected.occurrence)} · {t('waveform.position')} {selected.ratio.toFixed(2)} · {t('waveform.source')} {milliseconds(selectedMs)}</span>:<span>{t('waveform.instructions')}</span>}</div>
      <button disabled={!canEdit||chosen?.kind!=='grid'} onClick={add}>{t('waveform.add_sync_point')}</button><button disabled={!canEdit||chosen?.kind!=='anchor'} onClick={remove}>{t('waveform.delete_sync_point')}</button>
    </div>
  </section>;
}
