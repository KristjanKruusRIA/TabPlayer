import { useEffect, useId, useState } from 'react';
import { resolveVisibleTracks, type TrackView } from './view';
import { formatZoomPercent,isPhysicalPageLayout,resolveScoreDisplay,type ScoreDisplayPreferences } from './screen-view';

export function TrackDisplayControls({ids,names,selected,view,zoom,disabled,onView,onZoom,display,onDisplay,actualZoom,fitLimited=false,pageError=null}:{
  ids:readonly string[];names:readonly string[];selected:number;view:TrackView;zoom:number;disabled:boolean;
  onView:(view:TrackView)=>void;onZoom:(zoom:number)=>void;
  display?:ScoreDisplayPreferences;onDisplay?:(display:ScoreDisplayPreferences)=>void;actualZoom?:number;fitLimited?:boolean;pageError?:string|null;
}) {
  const visible=resolveVisibleTracks(ids,selected,view),[zoomDraft,setZoomDraft]=useState(String(zoom));
  const current=resolveScoreDisplay(display),physical=isPhysicalPageLayout(current.layout),pageFitAvailable=physical&&!pageError,fitHelp=useId();
  useEffect(()=>setZoomDraft(String(zoom)),[zoom]);
  return <fieldset disabled={disabled} aria-label="Score display"><div className="pair">
    <label><span className="score-tools-caption">Display mode</span><select title="Display mode" className="score-layout-select" value={current.layout} onChange={e=>{
      if(disabled)return;
      onDisplay?.(resolveScoreDisplay({...current,layout:e.target.value}));
    }}><option value="verticalPage">Vertical page</option><option value="horizontalPage">Horizontal page</option><option value="grid">Grid</option><option value="parchment">Parchment</option><option value="verticalScreen">Vertical screen</option><option value="horizontalScreen">Horizontal screen</option></select></label>
    <label><span className="score-tools-caption">Displayed tracks</span><select title="Displayed tracks" value={view.kind} onChange={e=>{
      if(disabled)return;
      const kind=e.target.value;
      if(kind==='custom')onView({kind,trackIds:visible.map(index=>ids[index])});
      else if(kind==='selected'||kind==='all')onView({kind});
    }}><option value="selected">Selected track</option><option value="all">All tracks</option><option value="custom">Chosen tracks</option></select></label>
    <label><span className="score-tools-caption">Zoom (%)</span><input title="Zoom (%)" type="number" min={25} max={300} step="any" value={zoomDraft} onBlur={()=>setZoomDraft(String(zoom))} onChange={e=>{
      if(disabled)return;
      const draft=e.target.value,value=Number(draft);setZoomDraft(draft);
      if(draft.trim()&&Number.isFinite(value)&&value>=25&&value<=300)onZoom(value);
    }}/></label>
    <div className="score-fit-controls">
      <button type="button" aria-pressed={current.zoomMode==='fitWidth'} onClick={()=>{if(!disabled)onDisplay?.({...current,zoomMode:'fitWidth'});}}>Fit width</button>
      <button type="button" disabled={!pageFitAvailable} aria-pressed={pageFitAvailable&&current.zoomMode==='fitPage'} aria-describedby={!pageFitAvailable?fitHelp:undefined} onClick={()=>{if(!disabled&&pageFitAvailable)onDisplay?.({...current,zoomMode:'fitPage'});}}>Fit page</button>
    </div>
    {current.zoomMode!=='manual'&&actualZoom!==undefined&&<output className="score-actual-zoom" aria-label="Actual zoom">Actual zoom: {formatZoomPercent(actualZoom)}%</output>}
  </div><details><summary>Visible tracks</summary><div className="track-list">{ids.map((id,index)=>{
    const shown=visible.includes(index),name=names[index]||`Track ${index+1}`;
    return <label className="check" key={id}><input type="checkbox" aria-label={`Show track ${index+1}: ${name}`} checked={shown} disabled={disabled||shown&&visible.length===1} onChange={e=>{
      if(disabled||shown&&visible.length===1)return;
      onView({kind:'custom',trackIds:ids.filter((_,i)=>i===index?e.target.checked:visible.includes(i))});
    }}/>{name}</label>;
  })}</div></details>{!physical&&<p className="muted score-fit-help" id={fitHelp}>Fit page is available in page layouts.</p>}
  {pageError&&<p className="score-fit-help" id={physical?fitHelp:undefined} role="alert">{pageError}</p>}
  {current.zoomMode!=='manual'&&fitLimited&&!pageError&&actualZoom!==undefined&&<p className="muted score-fit-help" role="status">Fit is limited to {formatZoomPercent(actualZoom)}%. Scroll to view the full score.</p>}
  {ids.length>0&&!visible.includes(selected)&&<p className="muted" role="status">{names[selected]||`Track ${selected+1}`} is hidden in score.</p>}</fieldset>;
}
