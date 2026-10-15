import { useEffect, useState } from 'react';
import { resolveVisibleTracks, type TrackView } from './view';

export function TrackDisplayControls({ids,names,selected,view,zoom,disabled,onView,onZoom}:{
  ids:readonly string[];names:readonly string[];selected:number;view:TrackView;zoom:number;disabled:boolean;
  onView:(view:TrackView)=>void;onZoom:(zoom:number)=>void;
}) {
  const visible=resolveVisibleTracks(ids,selected,view),[zoomDraft,setZoomDraft]=useState(String(zoom));
  useEffect(()=>setZoomDraft(String(zoom)),[zoom]);
  return <fieldset disabled={disabled} aria-label="Score display"><div className="pair">
    <label>Displayed tracks<select value={view.kind} onChange={e=>{
      if(disabled)return;
      const kind=e.target.value;
      if(kind==='custom')onView({kind,trackIds:visible.map(index=>ids[index])});
      else if(kind==='selected'||kind==='all')onView({kind});
    }}><option value="selected">Selected track</option><option value="all">All tracks</option><option value="custom">Chosen tracks</option></select></label>
    <label>Zoom (%)<input type="number" min={25} max={300} step="any" value={zoomDraft} onBlur={()=>setZoomDraft(String(zoom))} onChange={e=>{
      if(disabled)return;
      const draft=e.target.value,value=Number(draft);setZoomDraft(draft);
      if(draft.trim()&&Number.isFinite(value)&&value>=25&&value<=300)onZoom(value);
    }}/></label>
  </div><details><summary>Visible tracks</summary><div className="track-list">{ids.map((id,index)=>{
    const shown=visible.includes(index),name=names[index]||`Track ${index+1}`;
    return <label className="check" key={id}><input type="checkbox" aria-label={`Show track ${index+1}: ${name}`} checked={shown} disabled={disabled||shown&&visible.length===1} onChange={e=>{
      if(disabled||shown&&visible.length===1)return;
      onView({kind:'custom',trackIds:ids.filter((_,i)=>i===index?e.target.checked:visible.includes(i))});
    }}/>{name}</label>;
  })}</div></details>{ids.length>0&&!visible.includes(selected)&&<p className="muted" role="status">{names[selected]||`Track ${selected+1}`} is hidden in score.</p>}</fieldset>;
}
