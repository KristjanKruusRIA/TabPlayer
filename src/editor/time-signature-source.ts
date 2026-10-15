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

export function getTimeSignatureExportIntent(score:model.Score):{changed:boolean;value:boolean|null} {
  const imported=scoreSources.get(score),hasSource=scoreSources.has(score);
  const intents=score.masterBars.filter(eligible).map(master=>{
    const source=masterSources.get(master);
    if(!hasSource||!source||source.explicit!==null||master.timeSignatureCommon!==source.displayed) {
      return master.timeSignatureCommon;
    }
    return source.imported;
  });
  if(!intents.length||(hasSource&&intents.every(intent=>intent===imported)))return {changed:false,value:null};
  if(intents.includes(null)) {
    throw new Error('GP export cannot resolve inherited common/cut choices for every selected measure. Set each selected 4/4 or 2/2 measure explicitly before exporting changed choices.');
  }
  if(intents.some(intent=>intent!==intents[0])) {
    throw new Error('GP export cannot represent mixed common/cut and numeric measure choices. Export a uniform measure range or use consistent choices.');
  }
  return {changed:true,value:intents[0]};
}
