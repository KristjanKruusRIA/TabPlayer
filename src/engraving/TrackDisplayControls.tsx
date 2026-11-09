import { useEffect, useId, useState } from 'react';
import { useI18n } from '../i18n';
import { resolveVisibleTracks, type TrackView } from './view';
import { formatZoomPercent,isPhysicalPageLayout,resolveScoreDisplay,type ScoreDisplayPreferences } from './screen-view';

export function TrackDisplayControls({ids,names,selected,view,zoom,disabled,onView,onZoom,display,onDisplay,actualZoom,fitLimited=false,pageError=null}:{
  ids:readonly string[];names:readonly string[];selected:number;view:TrackView;zoom:number;disabled:boolean;
  onView:(view:TrackView)=>void;onZoom:(zoom:number)=>void;
  display?:ScoreDisplayPreferences;onDisplay?:(display:ScoreDisplayPreferences)=>void;actualZoom?:number;fitLimited?:boolean;pageError?:string|null;
}) {
  const { t } = useI18n();
  const visible=resolveVisibleTracks(ids,selected,view),[zoomDraft,setZoomDraft]=useState(String(zoom));
  const current=resolveScoreDisplay(display),physical=isPhysicalPageLayout(current.layout),pageFitAvailable=physical&&!pageError,fitHelp=useId();
  useEffect(()=>setZoomDraft(String(zoom)),[zoom]);
  return <fieldset disabled={disabled} aria-label={t('track_display.toolbar_aria')}><div className="pair">
    <label><span className="score-tools-caption">{t('track_display.display_mode')}</span><select title={t('track_display.display_mode')} className="score-layout-select" value={current.layout} onChange={e=>{
      if(disabled)return;
      onDisplay?.(resolveScoreDisplay({...current,layout:e.target.value}));
    }}>
      <option value="verticalPage">{t('track_display.layout_vertical_page')}</option>
      <option value="horizontalPage">{t('track_display.layout_horizontal_page')}</option>
      <option value="grid">{t('track_display.layout_grid')}</option>
      <option value="parchment">{t('track_display.layout_parchment')}</option>
      <option value="verticalScreen">{t('track_display.layout_vertical_screen')}</option>
      <option value="horizontalScreen">{t('track_display.layout_horizontal_screen')}</option>
    </select></label>
    <label><span className="score-tools-caption">{t('track_display.displayed_tracks')}</span><select title={t('track_display.displayed_tracks')} value={view.kind} onChange={e=>{
      if(disabled)return;
      const kind=e.target.value;
      if(kind==='custom')onView({kind,trackIds:visible.map(index=>ids[index])});
      else if(kind==='selected'||kind==='all')onView({kind});
    }}>
      <option value="selected">{t('track_display.tracks_selected')}</option>
      <option value="all">{t('track_display.tracks_all')}</option>
      <option value="custom">{t('track_display.tracks_custom')}</option>
    </select></label>
    <label><span className="score-tools-caption">{t('track_display.zoom_label')}</span><input title={t('track_display.zoom_label')} type="number" min={25} max={300} step="any" value={zoomDraft} onBlur={()=>setZoomDraft(String(zoom))} onChange={e=>{
      if(disabled)return;
      const draft=e.target.value,value=Number(draft);setZoomDraft(draft);
      if(draft.trim()&&Number.isFinite(value)&&value>=25&&value<=300)onZoom(value);
    }}/></label>
    <div className="score-fit-controls">
      <button type="button" aria-pressed={current.zoomMode==='fitWidth'} onClick={()=>{if(!disabled)onDisplay?.({...current,zoomMode:'fitWidth'});}}>{t('track_display.fit_width')}</button>
      <button type="button" disabled={!pageFitAvailable} aria-pressed={pageFitAvailable&&current.zoomMode==='fitPage'} aria-describedby={!pageFitAvailable?fitHelp:undefined} onClick={()=>{if(!disabled&&pageFitAvailable)onDisplay?.({...current,zoomMode:'fitPage'});}}>{t('track_display.fit_page')}</button>
    </div>
    {current.zoomMode!=='manual'&&actualZoom!==undefined&&<output className="score-actual-zoom" aria-label={t('track_display.actual_zoom_aria')}>{t('track_display.actual_zoom_text',{zoom:formatZoomPercent(actualZoom)})}</output>}
  </div><details><summary>{t('track_display.visible_tracks_summary')}</summary><div className="track-list">{ids.map((id,index)=>{
    const shown=visible.includes(index),name=names[index]||t('track_display.track_fallback',{index:index+1});
    return <label className="check" key={id}><input type="checkbox" aria-label={t('track_display.show_track_aria',{index:index+1,name})} checked={shown} disabled={disabled||shown&&visible.length===1} onChange={e=>{
      if(disabled||shown&&visible.length===1)return;
      onView({kind:'custom',trackIds:ids.filter((_,i)=>i===index?e.target.checked:visible.includes(i))});
    }}/>{name}</label>;
  })}</div></details>{!physical&&<p className="muted score-fit-help" id={fitHelp}>{t('track_display.fit_page_help')}</p>}
  {pageError&&<p className="score-fit-help" id={physical?fitHelp:undefined} role="alert">{pageError}</p>}
  {current.zoomMode!=='manual'&&fitLimited&&!pageError&&actualZoom!==undefined&&<p className="muted score-fit-help" role="status">{t('track_display.fit_limited_status',{zoom:formatZoomPercent(actualZoom)})}</p>}
  {ids.length>0&&!visible.includes(selected)&&<p className="muted" role="status">{t('track_display.track_hidden_status',{name:names[selected]||t('track_display.track_fallback',{index:selected+1})})}</p>}</fieldset>;
}
