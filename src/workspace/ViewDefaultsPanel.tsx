import { useId,useState } from 'react';
import { isPhysicalPageLayout,type ScoreDisplayPreferences,type ScoreLayoutMode,type ScoreZoomMode } from '../engraving/screen-view';
import type { TrackView } from '../engraving/view';
import { standardViewDefaults,validViewZoom,viewDefaultsFrom,type ViewDefaults } from './view-defaults';
import { Segmented } from '../ui/Segmented';
import { useI18n } from '../i18n';

/** Edits the view scores start in when they are opened or created; the open score keeps its current view. */
export function ViewDefaultsPanel({current,load,onSave}:{current:{zoom:number;trackView:TrackView;scoreDisplay?:ScoreDisplayPreferences};load:()=>ViewDefaults;onSave:(defaults:ViewDefaults)=>boolean}) {
  const { t } = useI18n();
  const layoutOptions:ReadonlyArray<{value:ScoreLayoutMode;label:string}>=[
    {value:'verticalPage',label:t('view_defaults.layout_vertical_page')},
    {value:'horizontalPage',label:t('view_defaults.layout_horizontal_page')},
    {value:'grid',label:t('view_defaults.layout_grid')},
    {value:'parchment',label:t('view_defaults.layout_parchment')},
    {value:'verticalScreen',label:t('view_defaults.layout_vertical_screen')},
    {value:'horizontalScreen',label:t('view_defaults.layout_horizontal_screen')},
  ];
  const trackOptions=[
    {value:'selected',label:t('view_defaults.tracks_selected')},
    {value:'all',label:t('view_defaults.tracks_all')},
  ] as const;

  const [draft,setDraft]=useState(load),[zoomText,setZoomText]=useState(()=>String(draft.zoom)),[status,setStatus]=useState(''),zoomError=useId(),fitHelp=useId();
  const zoom=Number(zoomText),valid=zoomText.trim()!==''&&validViewZoom(zoom),pages=isPhysicalPageLayout(draft.layout);
  const replace=(next:ViewDefaults)=>{setDraft(next);setZoomText(String(next.zoom));setStatus('');};
  const change=(next:Partial<ViewDefaults>)=>{setDraft(old=>{const value={...old,...next};return value.zoomMode==='fitPage'&&!isPhysicalPageLayout(value.layout)?{...value,zoomMode:'fitWidth'}:value;});setStatus('');};
  return <details><summary>{t('view_defaults.summary')}</summary>
    <p className="muted">{t('view_defaults.hint')}</p>
    <div className="tp-field">
      <span className="tp-field-label" aria-hidden="true">{t('view_defaults.layout_label')}</span>
      <Segmented label={t('view_defaults.layout_label')} value={draft.layout} options={layoutOptions} onChange={layout=>change({layout})}/>
    </div>
    <label>{t('view_defaults.zoom_mode_label')}<select value={draft.zoomMode} aria-describedby={pages?undefined:fitHelp} onChange={event=>change({zoomMode:event.target.value as ScoreZoomMode})}><option value="manual">{t('view_defaults.zoom_mode_manual')}</option><option value="fitWidth">{t('view_defaults.zoom_mode_fit_width')}</option><option value="fitPage" disabled={!pages}>{t('view_defaults.zoom_mode_fit_page')}</option></select></label>
    {!pages&&<p className="muted" id={fitHelp}>{t('view_defaults.fit_page_help')}</p>}
    <label>{t('view_defaults.zoom_percent_label')}<input type="number" min={25} max={300} step="any" value={zoomText} aria-invalid={!valid} aria-describedby={valid?undefined:zoomError} onChange={event=>{setZoomText(event.target.value);change({zoomMode:'manual'});}}/></label>
    {!valid&&<p className="muted" id={zoomError}>{t('view_defaults.zoom_range_error')}</p>}
    <div className="tp-field">
      <span className="tp-field-label" aria-hidden="true">{t('view_defaults.tracks_label')}</span>
      <Segmented label={t('view_defaults.tracks_label')} value={draft.tracks} options={trackOptions} onChange={tracks=>change({tracks})}/>
    </div>
    <div className="pair">
      <button type="button" onClick={()=>replace(viewDefaultsFrom(current))}>{t('view_defaults.use_current')}</button>
      <button type="button" onClick={()=>replace(standardViewDefaults)}>{t('view_defaults.reset_standard')}</button>
    </div>
    <button type="button" disabled={!valid} onClick={()=>setStatus(onSave({...draft,zoom})?t('view_defaults.save_success'):t('view_defaults.save_unpersisted'))}>{t('view_defaults.save_btn')}</button>
    <p role="status" className="muted">{status}</p>
  </details>;
}
