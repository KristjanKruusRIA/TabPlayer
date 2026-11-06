/** The sizes the user dragged the inspector and bottom dock to. null means the automatic size for the window.
 * These are view preferences kept for the user, not part of a score, so they never record an edit. */
export interface PanelSizes {inspector:number|null;dock:number|null}
export const automaticPanelSizes:PanelSizes=Object.freeze({inspector:null,dock:null});

const key='tabplayer.panelSizes';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
/** Anything outside a plausible pixel range reads as automatic; the shell clamps a kept size to the current window. */
const size=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=32&&value<=4096?Math.round(value):null;
function repair(value:unknown):PanelSizes {
  if(!value||typeof value!=='object'||Array.isArray(value))return {...automaticPanelSizes};
  const record=value as Record<string,unknown>;
  return {inspector:size(record.inspector),dock:size(record.dock)};
}
/** The sizes saved in this run; they still apply when storage refuses them. */
let session:PanelSizes|null=null;
export function readPanelSizes(storage:PreferenceStorage|undefined=browserStorage()):PanelSizes {
  if(session)return {...session};
  try{return repair(JSON.parse(storage?.getItem(key)??'null'));}catch{return {...automaticPanelSizes};}
}
/** Returns false when storage refuses the write. */
export function writePanelSizes(sizes:PanelSizes,storage:PreferenceStorage|undefined=browserStorage()):boolean {
  session=repair(sizes);
  try{if(!storage)return false;storage.setItem(key,JSON.stringify(session));return true;}catch{return false;}
}
/** Test isolation only: forgets the sizes saved in this run. */
export const forgetSessionPanelSizes=()=>{session=null;};
