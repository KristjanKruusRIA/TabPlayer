import { model } from '@coderline/alphatab';
import { setTimeSignatureIntent } from './time-signature-source';
import type { BarGestureCommand } from './gestures-types';
import { integer,staffAt } from './common';

function fields(value:object,keys:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid bar gesture fields.');
}
function masterAt(score:model.Score,index:number) {
  if(!integer(index)||!score.masterBars[index])throw new Error('Select an existing measure.');return score.masterBars[index];
}
function barAt(score:model.Score,track:number,staff:number,index:number) {
  const part=staffAt(score,track,staff);masterAt(score,index);
  if(!part.bars[index])throw new Error('Select an existing staff measure.');return part.bars[index];
}
function matchingDuration(a:model.Bar,b:model.Bar) {
  const first=a.masterBar,second=b.masterBar;
  if(first.timeSignatureNumerator!==second.timeSignatureNumerator||first.timeSignatureDenominator!==second.timeSignatureDenominator||first.calculateDuration()!==second.calculateDuration())throw new Error('Simile source and destination must have matching meter and duration.');
}
function pair(bar:model.Bar):model.Bar[] {
  if(bar.simileMark===model.SimileMark.FirstOfDouble) {
    if(!bar.nextBar||bar.nextBar.simileMark!==model.SimileMark.SecondOfDouble)throw new Error('Cannot edit an orphan simile pair.');
    return [bar,bar.nextBar];
  }
  if(bar.simileMark===model.SimileMark.SecondOfDouble) {
    if(!bar.previousBar||bar.previousBar.simileMark!==model.SimileMark.FirstOfDouble)throw new Error('Cannot edit an orphan simile pair.');
    return [bar.previousBar,bar];
  }
  return [bar];
}

export function applyBarGestureEdit(score:model.Score,command:BarGestureCommand):boolean {
  switch(command.type) {
    case 'setBarGestures': {
      fields(command,['type','track','staff','bar','clefOttava']);
      const bar=barAt(score,command.track,command.staff,command.bar);
      if(!integer(command.clefOttava,0,4))throw new Error('Invalid octave clef.');
      bar.clefOttava=command.clefOttava;return true;
    }
    case 'setMasterBarGestures': {
      fields(command,['type','bar','commonTime','doubleBar','tripletFeel','beaming']);
      const master=masterAt(score,command.bar);
      if(typeof command.commonTime!=='boolean'||typeof command.doubleBar!=='boolean'||!integer(command.tripletFeel,0,6))throw new Error('Invalid measure gesture.');
      if(command.commonTime&&!((master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4)||(master.timeSignatureNumerator===2&&master.timeSignatureDenominator===2)))throw new Error('Common or cut time requires 4/4 or 2/2.');
      let rules:model.BeamingRules|undefined;
      if(command.beaming!==null) {
        fields(command.beaming,['unit','groups']);
        const {unit,groups}=command.beaming,total=master.timeSignatureNumerator*unit/master.timeSignatureDenominator;
        if(![8,16,32].includes(unit)||!Array.isArray(groups)||!groups.length||groups.some(value=>!integer(value,1))||!Number.isSafeInteger(total)||groups.reduce((sum,value)=>sum+value,0)!==total)throw new Error('Beaming groups must fill the measure in eighths, sixteenths or thirty-seconds.');
        rules=new model.BeamingRules();rules.groups.set(unit,[...groups]);
      }
      master.timeSignatureCommon=command.commonTime;master.isDoubleBar=command.doubleBar;master.tripletFeel=command.tripletFeel;master.beamingRules=rules;setTimeSignatureIntent(master,command.commonTime);return true;
    }
    case 'setSimile': {
      fields(command,['type','track','staff','bar','kind']);
      const bar=barAt(score,command.track,command.staff,command.bar);
      if(!['none','single','double'].includes(command.kind))throw new Error('Invalid simile kind.');
      const clear=new Set(pair(bar));
      if(command.kind==='single') {
        if(!bar.previousBar)throw new Error('A single simile requires a previous measure.');
        pair(bar.previousBar);matchingDuration(bar.previousBar,bar);
      }else if(command.kind==='double') {
        const previous=bar.previousBar,source=previous?.previousBar,next=bar.nextBar;
        if(!source||!previous||!next)throw new Error('A double simile requires two preceding measures and a following measure.');
        pair(source);pair(previous);for(const member of pair(next))clear.add(member);
        matchingDuration(source,bar);matchingDuration(previous,next);
      }
      for(const member of clear)member.simileMark=model.SimileMark.None;
      if(command.kind==='single')bar.simileMark=model.SimileMark.Simple;
      else if(command.kind==='double'){bar.simileMark=model.SimileMark.FirstOfDouble;bar.nextBar!.simileMark=model.SimileMark.SecondOfDouble;}
      return true;
    }
    default:return false;
  }
}
