import { useId,useState } from 'react';
import { isPhysicalPageLayout,type ScoreDisplayPreferences,type ScoreLayoutMode,type ScoreZoomMode } from '../engraving/screen-view';
import type { TrackView } from '../engraving/view';
import { standardViewDefaults,validViewZoom,viewDefaultsFrom,type ViewDefaults } from './view-defaults';
import { Segmented } from '../ui/Segmented';

const layoutOptions:ReadonlyArray<{value:ScoreLayoutMode;label:string}>=[
  {value:'verticalPage',label:'Vertical page'},
  {value:'horizontalPage',label:'Horizontal page'},
  {value:'grid',label:'Grid'},
  {value:'parchment',label:'Parchment'},
  {value:'verticalScreen',label:'Vertical screen'},
  {value:'horizontalScreen',label:'Horizontal screen'},
];
const trackOptions=[
  {value:'selected',label:'Selected track'},
  {value:'all',label:'All tracks'},
] as const;

/** Edits the view scores start in when they are opened or created; the open score keeps its current view. */
export function ViewDefaultsPanel({current,load,onSave}:{current:{zoom:number;trackView:TrackView;scoreDisplay?:ScoreDisplayPreferences};load:()=>ViewDefaults;onSave:(defaults:ViewDefaults)=>boolean}) {
  const [draft,setDraft]=useState(load),[zoomText,setZoomText]=useState(()=>String(draft.zoom)),[status,setStatus]=useState(''),zoomError=useId(),fitHelp=useId();
  const zoom=Number(zoomText),valid=zoomText.trim()!==''&&validViewZoom(zoom),pages=isPhysicalPageLayout(draft.layout);
  const replace=(next:ViewDefaults)=>{setDraft(next);setZoomText(String(next.zoom));setStatus('');};
  const change=(next:Partial<ViewDefaults>)=>{setDraft(old=>{const value={...old,...next};return value.zoomMode==='fitPage'&&!isPhysicalPageLayout(value.layout)?{...value,zoomMode:'fitWidth'}:value;});setStatus('');};
  return <details><summary>Default view</summary>
    <p className="muted">Scores opened or created from now on start in this view. Scores already open keep theirs.</p>
    <div className="tp-field">
      <span className="tp-field-label" aria-hidden="true">Default layout</span>
      <Segmented label="Default layout" value={draft.layout} options={layoutOptions} onChange={layout=>change({layout})}/>
    </div>
    <label>Default zoom mode<select value={draft.zoomMode} aria-describedby={pages?undefined:fitHelp} onChange={event=>change({zoomMode:event.target.value as ScoreZoomMode})}><option value="manual">Manual</option><option value="fitWidth">Fit width</option><option value="fitPage" disabled={!pages}>Fit page</option></select></label>
    {!pages&&<p className="muted" id={fitHelp}>Fit page is available in page layouts.</p>}
    <label>Default zoom (%)<input type="number" min={25} max={300} step="any" value={zoomText} aria-invalid={!valid} aria-describedby={valid?undefined:zoomError} onChange={event=>{setZoomText(event.target.value);change({zoomMode:'manual'});}}/></label>
    {!valid&&<p className="muted" id={zoomError}>Zoom must be 25–300%.</p>}
    <div className="tp-field">
      <span className="tp-field-label" aria-hidden="true">Default tracks</span>
      <Segmented label="Default tracks" value={draft.tracks} options={trackOptions} onChange={tracks=>change({tracks})}/>
    </div>
    <div className="pair">
      <button type="button" onClick={()=>replace(viewDefaultsFrom(current))}>Use current view</button>
      <button type="button" onClick={()=>replace(standardViewDefaults)}>Reset to standard view</button>
    </div>
    <button type="button" disabled={!valid} onClick={()=>setStatus(onSave({...draft,zoom})?'Saved. Scores opened or created from now on start in this view.':'This default view could not be stored, so it lasts only until TabPlayer closes.')}>Save default view</button>
    <p role="status" className="muted">{status}</p>
  </details>;
}
