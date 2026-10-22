import { isPhysicalPageLayout,repairScoreDisplay,type ScoreDisplayPreferences,type ScoreLayoutMode,type ScoreZoomMode } from '../engraving/screen-view';
import type { TrackView } from '../engraving/view';
import type { DocumentViewState } from './types';

/** How a score first appears when it has no view of its own yet, like GP8's general display preferences. */
export interface ViewDefaults {layout:ScoreLayoutMode;zoomMode:ScoreZoomMode;zoom:number;tracks:'selected'|'all'}
export const standardViewDefaults:ViewDefaults=Object.freeze({layout:'parchment',zoomMode:'manual',zoom:100,tracks:'selected'});
export const validViewZoom=(zoom:number)=>Number.isFinite(zoom)&&zoom>=25&&zoom<=300;

const key='tabplayer.viewDefaults';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
/** Keeps each valid field; a fit-page zoom on a screen layout becomes fit-width, as the score view does. */
function repair(value:unknown):ViewDefaults {
  if(!value||typeof value!=='object'||Array.isArray(value))return {...standardViewDefaults};
  const record=value as Record<string,unknown>;
  const layout=repairScoreDisplay({layout:record.layout,zoomMode:'manual'})?.layout??standardViewDefaults.layout;
  const zoomMode=repairScoreDisplay({layout,zoomMode:record.zoomMode})?.zoomMode??standardViewDefaults.zoomMode;
  return {layout,zoomMode,zoom:typeof record.zoom==='number'&&validViewZoom(record.zoom)?record.zoom:standardViewDefaults.zoom,tracks:record.tracks==='all'?'all':'selected'};
}
export function readViewDefaults(storage:PreferenceStorage|undefined=browserStorage()):ViewDefaults {
  try{return repair(JSON.parse(storage?.getItem(key)??'null'));}catch{return {...standardViewDefaults};}
}
/** The defaults saved in this run; they still apply when storage refuses them. */
let session:ViewDefaults|null=null;
export const currentViewDefaults=():ViewDefaults=>session??readViewDefaults();
/** Test isolation only: forgets the defaults saved in this run. */
export const forgetSessionViewDefaults=()=>{session=null;};
/** Returns false when storage refuses the write. */
export function writeViewDefaults(defaults:ViewDefaults,storage:PreferenceStorage|undefined=browserStorage()):boolean {
  session=repair(defaults);
  try{if(!storage)return false;storage.setItem(key,JSON.stringify(session));return true;}catch{return false;}
}
/** A custom track list names one score's tracks, so it is saved as the selected-track view. */
export function viewDefaultsFrom(view:{zoom:number;trackView:TrackView;scoreDisplay?:ScoreDisplayPreferences}):ViewDefaults {
  const display=repairScoreDisplay(view.scoreDisplay)??{layout:standardViewDefaults.layout,zoomMode:standardViewDefaults.zoomMode};
  return repair({...display,zoom:view.zoom,tracks:view.trackView.kind==='all'?'all':'selected'});
}
export function defaultDocumentView(defaults:ViewDefaults):DocumentViewState {
  const standard=defaults.layout===standardViewDefaults.layout&&defaults.zoomMode===standardViewDefaults.zoomMode;
  return {target:{track:0,staff:0,bar:0,voice:0,beat:0},selectedString:6,selectedNoteIndex:null,zoom:defaults.zoom,trackView:{kind:defaults.tracks},instrumentVisible:false,
    ...(standard?{}:{scoreDisplay:{layout:defaults.layout,zoomMode:defaults.zoomMode==='fitPage'&&!isPhysicalPageLayout(defaults.layout)?'fitWidth':defaults.zoomMode}})};
}
