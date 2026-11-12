import type { model } from '@coderline/alphatab';

type Source={imported:boolean|null;displayed:boolean;explicit:boolean|null};
const scoreSources=new WeakMap<model.Score,boolean|null>();
const masterSources=new WeakMap<model.MasterBar,Source>();
const eligible=(master:model.MasterBar)=>
  (master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4)||
  (master.timeSignatureNumerator===2&&master.timeSignatureDenominator===2);

export function initializeTimeSignatureSource(score:model.Score,imported:boolean|null):void {
  scoreSources.set(score,imported);
  for(const master of score.masterBars) {
    if(imported!==null&&eligible(master))master.timeSignatureCommon=imported;
    masterSources.set(master,{imported,displayed:master.timeSignatureCommon,explicit:null});
  }
}

export function setTimeSignatureIntent(master:model.MasterBar,value:boolean):void {
  const source=masterSources.get(master);
  if(source)masterSources.set(master,{...source,explicit:value});
}

export function copyMasterTimeSignatureSource(source:model.MasterBar,destination:model.MasterBar):void {
  const marker=masterSources.get(source);
  if(marker)masterSources.set(destination,{...marker});
  else masterSources.delete(destination);
}

export function copyTimeSignatureSources(source:model.Score,destination:model.Score):void {
  if(scoreSources.has(source))scoreSources.set(destination,scoreSources.get(source)!);
  else scoreSources.delete(destination);
  destination.masterBars.forEach((master,index)=>{
    const original=source.masterBars[index];
    if(original)copyMasterTimeSignatureSource(original,master);
    else masterSources.delete(master);
  });
}

/**
 * What a Guitar Pro export does about common/cut time. The file holds one choice for the whole score. Each eligible bar
 * (4/4 or 2/2) has an intent: the choice it made explicitly, or the source file's, which is null when the source left
 * the option absent. `differing` and `inherited` are the indices of master bars, so a warning and the writer agree.
 *  - unchanged from the source, or no eligible bar: nothing is written (`changed` false);
 *  - otherwise the choice made by more explicit bars is written, a tie going to numeric (false);
 *  - the bars whose explicit choice is the other one `differ`; bars with no choice of their own are `inherited` and now follow it;
 *  - a majority equal to the source's own choice writes nothing, but its minority still `differs`.
 */
export interface TimeSignatureExportPlan {changed:boolean;value:boolean|null;differing:number[];inherited:number[]}
export function planTimeSignatureExport(score:model.Score):TimeSignatureExportPlan {
  const imported=scoreSources.get(score),hasSource=scoreSources.has(score);
  const bars:{index:number;intent:boolean|null}[]=[];
  score.masterBars.forEach((master,index)=>{
    if(!eligible(master))return;
    const source=masterSources.get(master);
    bars.push({index,intent:!hasSource||!source||source.explicit!==null||master.timeSignatureCommon!==source.displayed?master.timeSignatureCommon:source.imported});
  });
  if(!bars.length||(hasSource&&bars.every(bar=>bar.intent===imported)))return {changed:false,value:null,differing:[],inherited:[]};
  const common=bars.filter(bar=>bar.intent===true).length,numeric=bars.filter(bar=>bar.intent===false).length,value=common>numeric;
  const differing=bars.filter(bar=>bar.intent!==null&&bar.intent!==value).map(bar=>bar.index),inherited=bars.filter(bar=>bar.intent===null).map(bar=>bar.index);
  const changed=!(hasSource&&imported===value);
  return {changed,value:changed?value:null,differing,inherited};
}
export function getTimeSignatureExportIntent(score:model.Score):{changed:boolean;value:boolean|null} {
  const {changed,value}=planTimeSignatureExport(score);return {changed,value};
}
