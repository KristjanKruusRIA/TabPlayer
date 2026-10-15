import { model } from '@coderline/alphatab';
import type { BackingSettings } from '../edit-types';
import { isGpMixAutomation,trackMixAutomations } from '../interchange/automation';
import { integer } from './common';
import { allNotes,detachNote } from './links';
import type { BarIndexMap,MeasureCommand } from './measures-types';

function exact(command:object,keys:string[]) {
  if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).length!==keys.length||keys.some(key=>!Object.hasOwn(command,key)))throw new Error('Invalid measure transform fields.');
}
export function planMeasureMap(barCount:number,command:MeasureCommand):BarIndexMap {
  if(!integer(barCount,1,0xffffffff))throw new Error('A score must contain existing measures.');
  if(command.type==='insertMeasures') {
    exact(command,['type','beforeBar','count']);
    if(!integer(command.beforeBar,0,barCount)||!integer(command.count,1,1000)||barCount+command.count>0xffffffff)throw new Error('Insert 1 to 1000 measures at an existing measure or the end.');
    return {oldToNew:Array.from({length:barCount},(_,bar)=>bar<command.beforeBar?bar:bar+command.count),inserted:Array.from({length:command.count},(_,offset)=>command.beforeBar+offset)};
  }
  if(command.type==='removeMeasures') {
    exact(command,['type','firstBar','lastBar']);
    if(!integer(command.firstBar,0,barCount-1)||!integer(command.lastBar,command.firstBar,barCount-1))throw new Error('Choose an existing inclusive measure range.');
    const count=command.lastBar-command.firstBar+1;if(count===barCount)throw new Error('Keep at least one measure.');
    return {oldToNew:Array.from({length:barCount},(_,bar)=>bar<command.firstBar?bar:bar<=command.lastBar?null:bar-count),inserted:[]};
  }
  throw new Error('Unknown measure transform.');
}

export function mapBackingMeasures(backing:Pick<BackingSettings,'anchors'>|null|undefined,map:BarIndexMap):void {
  if(!backing)return;
  const anchors=backing.anchors.flatMap(anchor=>{
    if(!integer(anchor.bar,0,map.oldToNew.length-1))throw new Error('Backing anchor must refer to an existing measure.');
    const bar=map.oldToNew[anchor.bar];return bar===null?[]:[{...anchor,bar}];
  });
  backing.anchors=anchors;
}

function validateAlignment(score:model.Score) {
  for(const track of score.tracks)for(const staff of track.staves) {
    if(staff.bars.length!==score.masterBars.length||staff.bars.some(bar=>!bar.voices.length))throw new Error('All staff measures and voices must be aligned before a global transform.');
  }
}
function validateExpandedLinks(score:model.Score,map:BarIndexMap) {
  for(const note of allNotes(score))for(const [kind,destination]of [['tie',note.tieDestination],['hammer/pull',note.hammerPullDestination],['slide',note.slideOutType===model.SlideOutType.Shift||note.slideOutType===model.SlideOutType.Legato?note.slideTarget:null]] as const) {
    if(!destination)continue;
    const from=note.beat.voice.bar.index,to=destination.beat.voice.bar.index,oldDistance=to-from,newDistance=map.oldToNew[to]!-map.oldToNew[from]!;
    if(newDistance<=oldDistance)continue;
    // 1.8.4 findTieOrigin includes a three-bar lookback. Its forward hammer/
    // slide reconstruction drops links across even one new blank bar during
    // GP import, despite the completed static chain supporting three bars.
    if(kind!=='tie'||newDistance>3)throw new Error(`This insertion expands a ${kind} link beyond current GP reopen compatibility. Ties support at most three bars; forward hammer/pull and linked slide gaps need explicit link repair.`);
  }
}
function validateSimiles(score:model.Score,map:BarIndexMap) {
  const sameDistance=(first:number,second:number,distance:number)=>first>=0&&map.oldToNew[first]!==null&&map.oldToNew[second]!==null&&map.oldToNew[second]! - map.oldToNew[first]!==distance;
  for(const track of score.tracks)for(const staff of track.staves)for(let index=0;index<staff.bars.length;index++) {
    const bar=staff.bars[index];if(map.oldToNew[index]===null)continue;
    if(bar.simileMark===model.SimileMark.Simple) {
      if(index===0||map.oldToNew[index-1]===null||sameDistance(index-1,index,1))throw new Error('This transform changes a retained simile source.');
    }else if(bar.simileMark===model.SimileMark.FirstOfDouble) {
      if(index<2||staff.bars[index+1]?.simileMark!==model.SimileMark.SecondOfDouble||map.oldToNew[index+1]===null||map.oldToNew[index-2]===null||map.oldToNew[index-1]===null||sameDistance(index,index+1,1)||sameDistance(index-2,index,2)||sameDistance(index-1,index+1,2))throw new Error('This transform splits a double simile or changes its sources.');
    }else if(bar.simileMark===model.SimileMark.SecondOfDouble) {
      if(staff.bars[index-1]?.simileMark!==model.SimileMark.FirstOfDouble||map.oldToNew[index-1]===null)throw new Error('This transform splits a double simile.');
    }
  }
}
function validateRemovalContext(score:model.Score,map:BarIndexMap) {
  // The public grouping also contains ordinary bars after a repeat closes. The
  // protected interval ends at its final closing plus any trailing ending bars.
  const projection=new model.Score();
  for(const master of score.masterBars){const copy=new model.MasterBar();copy.isRepeatStart=master.isRepeatStart;copy.repeatCount=master.repeatCount;copy.alternateEndings=master.alternateEndings;projection.addMasterBar(copy);}
  const groups=new Set(projection.masterBars.map(bar=>bar.repeatGroup));
  for(const group of groups) {
    if(!group.isOpened&&!group.closings.length&&!group.masterBars.some(bar=>bar.alternateEndings))continue;
    const start=group.opening!.index;let end=group.closings.at(-1)?.index??group.masterBars.at(-1)!.index;
    while(end+1<projection.masterBars.length&&projection.masterBars[end+1].alternateEndings)end++;
    const members=map.oldToNew.slice(start,end+1);
    if(members.some(bar=>bar===null)&&members.some(bar=>bar!==null))throw new Error('Remove the complete repeat group and its alternate endings.');
  }
  let removed=false,retained=false;
  score.masterBars.forEach((bar,index)=>{if(bar.directions?.size){if(map.oldToNew[index]===null)removed=true;else retained=true;}});
  if(removed&&retained)throw new Error('This removal changes surviving direction context. Remove the complete direction context together.');
}

function blankMaster(context:model.MasterBar) {
  const master=new model.MasterBar();
  master.timeSignatureNumerator=context.timeSignatureNumerator;master.timeSignatureDenominator=context.timeSignatureDenominator;
  master.timeSignatureCommon=context.timeSignatureCommon;master.isFreeTime=context.isFreeTime;master.tripletFeel=context.tripletFeel;
  if(context.beamingRules){master.beamingRules=new model.BeamingRules();for(const [unit,groups]of context.beamingRules.groups)master.beamingRules.groups.set(unit,[...groups]);}
  return master;
}
function blankBar(context:model.Bar,master:model.MasterBar) {
  const bar=new model.Bar();bar.clef=context.clef;bar.clefOttava=context.clefOttava;bar.keySignature=context.keySignature;bar.keySignatureType=context.keySignatureType;
  for(let index=0;index<context.voices.length;index++) {
    const voice=new model.Voice();bar.addVoice(voice);
    const rests=index===0&&!master.isFreeTime?master.timeSignatureNumerator:1;
    for(let rest=0;rest<rests;rest++){const beat=new model.Beat();beat.duration=master.timeSignatureDenominator;beat.isEmpty=index!==0||master.isFreeTime;voice.addBeat(beat);}
  }
  return bar;
}
type Point={bar:number;position:number;automation:model.Automation};
const cloneAutomation=(automation:model.Automation)=>Object.assign(new model.Automation(),automation,{ratioPosition:0});
const processedVoice=(voice:model.Voice)=>!voice.isEmpty||(voice.bar.isEmpty&&voice.index===0);
function suffixTempo(score:model.Score,first:number,last:number):(()=>void)|undefined {
  const suffix=score.masterBars[last+1];if(!suffix||suffix.tempoAutomations.some(automation=>automation.ratioPosition===0))return;
  let previous:model.Automation|undefined,previousBar=-1;
  for(let bar=0;bar<=last;bar++)for(const automation of [...score.masterBars[bar].tempoAutomations].sort((a,b)=>a.ratioPosition-b.ratioPosition)){previous=automation;previousBar=bar;}
  if(previousBar>=first||first===0) {
    const inherited=previous?cloneAutomation(previous):model.Automation.buildTempoAutomation(false,0,score.tempo,2);
    return ()=>suffix.tempoAutomations.unshift(inherited);
  }
}
function trackPoints(track:model.Track):Point[] {
  const points:Point[]=trackMixAutomations(track).map(({bar,automation})=>({bar,position:automation.ratioPosition,automation}));
  for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices) {
    if(!processedVoice(voice))continue;
    for(const beat of voice.beats)for(const automation of beat.automations)if(!isGpMixAutomation(automation)&&(automation.type===model.AutomationType.Instrument||(automation.type===model.AutomationType.Bank&&!automation.syncPointValue)))points.push({bar:bar.index,position:beat.playbackStart,automation});
  }
  return points.sort((a,b)=>a.bar-b.bar||a.position-b.position);
}
function suffixTrackState(track:model.Track,first:number,last:number):Array<()=>void> {
  const changes:Array<()=>void>=[],points=trackPoints(track),suffix=last+1,bars=track.staves.flatMap(staff=>staff.bars[suffix]?[staff.bars[suffix]]:[]);if(!bars.length)return changes;
  const storage=bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats))[0];
  // alphaTab skips inactive voices except voice zero of a wholly empty bar.
  // Program/bank events need an actually visited beat at the exact boundary;
  // GP mix events are extracted separately and only need a storage carrier.
  const boundary=bars.flatMap(bar=>bar.voices.filter(processedVoice).flatMap(voice=>voice.beats)).find(beat=>beat.playbackStart===0);
  for(const type of [model.AutomationType.Instrument,model.AutomationType.Bank,model.AutomationType.Volume,model.AutomationType.Balance]) {
    const family=points.filter(point=>point.automation.type===type);
    const previous=family.filter(point=>point.bar<suffix).at(-1);
    if(previous&&previous.bar>=first&&!isGpMixAutomation(previous.automation)&&bars.some(bar=>bar.voices.filter(processedVoice).some(voice=>voice.beats.some(beat=>beat.playbackStart<0&&beat.notes.length))))throw new Error('Cannot preserve a program or bank change before the sounding grace notes at this measure boundary.');
    if(family.some(point=>point.bar===suffix&&point.position===0))continue;
    if(previous&&previous.bar>=first){
      const carrier=isGpMixAutomation(previous.automation)?storage:boundary;
      if(!carrier)throw new Error('Cannot preserve a program or bank change at this measure boundary: no processed beat starts at tick zero.');
      const inherited=cloneAutomation(previous.automation);changes.push(()=>carrier.automations.unshift(inherited));
    }
  }
  for(const staff of track.staves) {
    const destination=staff.bars[suffix];if(!destination||destination.sustainPedals.some(pedal=>pedal.ratioPosition===0&&pedal.pedalType!==model.SustainPedalMarkerType.Hold))continue;
    let previous:model.SustainPedalMarker|undefined,previousBar=-1;
    for(let bar=0;bar<=last;bar++)for(const pedal of [...staff.bars[bar].sustainPedals].sort((a,b)=>a.ratioPosition-b.ratioPosition))if(pedal.pedalType!==model.SustainPedalMarkerType.Hold){previous=pedal;previousBar=bar;}
    if(previous&&previousBar>=first){const inherited=Object.assign(new model.SustainPedalMarker(),{pedalType:previous.pedalType,ratioPosition:0,bar:destination});changes.push(()=>destination.sustainPedals.unshift(inherited));}
  }
  return changes;
}
function relink(score:model.Score) {
  score.masterBars.forEach((master,index)=>{master.index=index;master.score=score;master.previousMasterBar=score.masterBars[index-1]??null;master.nextMasterBar=score.masterBars[index+1]??null;master.start=index?score.masterBars[index-1].start+(score.masterBars[index-1].isAnacrusis?0:score.masterBars[index-1].calculateDuration()):0;});
  for(const track of score.tracks)for(const staff of track.staves)staff.bars.forEach((bar,index)=>{bar.index=index;bar.staff=staff;bar.previousBar=staff.bars[index-1]??null;bar.nextBar=staff.bars[index+1]??null;});
  score.rebuildRepeatGroups();
}

export function applyMeasureEdit(score:model.Score,command:MeasureCommand):boolean {
  if(command.type!=='insertMeasures'&&command.type!=='removeMeasures')return false;
  const map=planMeasureMap(score.masterBars.length,command);validateAlignment(score);validateSimiles(score,map);
  if(command.type==='insertMeasures') {
    validateExpandedLinks(score,map);
    const contextIndex=Math.max(0,command.beforeBar-1),context=score.masterBars[contextIndex];
    if(!integer(context.timeSignatureNumerator,1)||![1,2,4,8,16,32,64,128,256].includes(context.timeSignatureDenominator))throw new Error('Insert measures after a valid meter.');
    const masters=map.inserted.map(()=>blankMaster(context));
    const staves=score.tracks.flatMap(track=>track.staves.map(staff=>({staff,bars:masters.map(master=>blankBar(staff.bars[contextIndex],master))})));
    if(command.beforeBar===0){const initial=[...context.tempoAutomations].filter(automation=>automation.ratioPosition===0).at(-1);masters[0].tempoAutomations=[initial?cloneAutomation(initial):model.Automation.buildTempoAutomation(false,0,score.tempo,2)];}
    score.masterBars.splice(command.beforeBar,0,...masters);for(const {staff,bars}of staves)staff.bars.splice(command.beforeBar,0,...bars);
  }else {
    validateRemovalContext(score,map);
    const {firstBar,lastBar}=command,count=lastBar-firstBar+1,tempo=suffixTempo(score,firstBar,lastBar),changes=score.tracks.flatMap(track=>suffixTrackState(track,firstBar,lastBar));
    const notes=allNotes(score),removed=new Set(notes.filter(note=>note.beat.voice.bar.index>=firstBar&&note.beat.voice.bar.index<=lastBar));
    for(const note of removed)detachNote(note);
    for(const note of notes)if(note.bendOrigin&&removed.has(note.bendOrigin)){note.bendOrigin=null;note.isContinuedBend=false;}
    tempo?.();for(const change of changes)change();score.masterBars.splice(firstBar,count);
    for(const track of score.tracks)for(const staff of track.staves)staff.bars.splice(firstBar,count);
  }
  for(const track of score.tracks)track.lineBreaks=new Set([...(track.lineBreaks??[])].flatMap(bar=>map.oldToNew[bar]===null||map.oldToNew[bar]===undefined?[]:[map.oldToNew[bar]!]));
  relink(score);return true;
}
