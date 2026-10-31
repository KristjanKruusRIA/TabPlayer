import {model,Settings} from '@coderline/alphatab';
import type {BackingSettings,SyncAnchor} from '../edit-types';
import {applyTempoAutomations} from '../editor/tempo-automations';
import type {RatioTempoPoint} from '../editor/tempo-types';
import {displayedBpm,quarterUnit,tempoUnitOf} from '../editor/tempo-unit';
import {captureNoteLinks,restoreNoteLinks} from '../editor/links';
import {scoreFromJson} from '../model-clone';
import {buildPlaybackPlan,validatePlaybackPlan} from './plan';
import {initializeReferenceSync,referenceSyncTiming} from './reference-sync';
import type {ReferenceLocation,ReferenceSyncTiming} from './reference-sync-types';
import type {PlanTempo,PlaybackPlan} from './types';

const timeTolerance=1e-7,bpmTolerance=1e-9;
function finite(value:number):number {
  if(!Number.isFinite(value))throw new Error('Tempo conversion timing must be finite.');
  return value;
}
function clock(tempos:readonly PlanTempo[]) {
  return (tick:number)=>{
    let seconds=0,previous=0,bpm=tempos[0].bpm;
    for(const tempo of tempos) {
      if(tempo.tick>tick)break;
      seconds=finite(seconds+(tempo.tick-previous)*60/(960*bpm));previous=tempo.tick;bpm=tempo.bpm;
    }
    return finite((seconds+(tick-previous)*60/(960*bpm))*1000);
  };
}
function locationAt(locations:readonly ReferenceLocation[],tick:number):ReferenceLocation {
  const location=locations.find(value=>value.startTick<=tick&&tick<value.endTick);
  if(!location)throw new Error('Tempo breakpoint is outside performed score music.');
  return location;
}
function anchorTick(anchor:SyncAnchor,locations:readonly ReferenceLocation[]):number {
  const location=locations.find(value=>value.bar===anchor.bar&&value.occurrence===anchor.occurrence);
  if(!location)throw new Error('Tempo point refers to missing performed score music.');
  return location.startTick+(location.endTick-location.startTick)*anchor.ratio;
}

export function syncPointsFromScore(authored:PlaybackPlan,backing:BackingSettings,mode:'replace'|'add',durationMs:number):BackingSettings {
  validatePlaybackPlan(authored);
  if(mode!=='replace'&&mode!=='add')throw new Error('Choose replace or add for score tempo conversion.');
  const base=backing.referenceSync?backing:initializeReferenceSync(backing,authored,durationMs);
  const timing=referenceSyncTiming(base,authored.occurrences,durationMs);
  if(!timing)throw new Error('Reference synchronization requires performed score music.');
  const timeAt=clock(authored.tempos),entryTime=timeAt(timing.entryTick);
  const sourceAt=(tick:number)=>finite(timing.entrySourceMs+timeAt(tick)-entryTime);
  const generated:SyncAnchor[]=authored.tempos.filter(tempo=>tempo.tick>timing.entryTick&&tempo.tick<timing.exitTick).map(tempo=>{
    const location=locationAt(authored.occurrences,tempo.tick);
    return {bar:location.bar,occurrence:location.occurrence,ratio:(tempo.tick-location.startTick)/(location.endTick-location.startTick),audioMs:finite(sourceAt(tempo.tick)+base.offsetMs)};
  });
  const exitAudioMs=finite(sourceAt(timing.exitTick)+base.offsetMs);
  const anchors=mode==='replace'?generated:base.anchors.map(anchor=>({...anchor}));
  if(mode==='add') {
    if(Math.abs(exitAudioMs-base.referenceSync!.exitAudioMs)>timeTolerance)throw new Error('Authored score exit disagrees with the existing reference exit.');
    for(const anchor of generated) {
      const tick=anchorTick(anchor,authored.occurrences),old=anchors.find(value=>anchorTick(value,authored.occurrences)===tick);
      if(old) {
        if(Math.abs(old.audioMs-anchor.audioMs)>timeTolerance)throw new Error('An existing sync point disagrees with the authored score time.');
      } else anchors.push(anchor);
    }
  }
  anchors.sort((a,b)=>anchorTick(a,authored.occurrences)-anchorTick(b,authored.occurrences));
  const candidate:BackingSettings={...base,mix:{...base.mix},anchors,referenceSync:mode==='add'?{...base.referenceSync!}:{entryAudioMs:base.referenceSync!.entryAudioMs,exitAudioMs}};
  referenceSyncTiming(candidate,authored.occurrences,durationMs);
  return candidate;
}

export function scoreTemposFromSync(score:model.Score,timing:ReferenceSyncTiming,locations:readonly ReferenceLocation[]):RatioTempoPoint[] {
  const invalid=()=>new Error('Invalid performed reference tempo timing.');
  if(!locations.length||!timing.segments.length||timing.entryTick!==locations[0].startTick||timing.exitTick!==locations[locations.length-1].endTick||!Number.isFinite(timing.entrySourceMs)||timing.entrySourceMs<0||!Number.isFinite(timing.exitSourceMs)||timing.exitSourceMs<=timing.entrySourceMs)throw invalid();
  let endTick=timing.entryTick,endSourceMs=timing.entrySourceMs;
  for(const segment of timing.segments) {
    const rate=60000/(960*segment.bpm);
    if(segment.startTick!==endTick||segment.startSourceMs!==endSourceMs||!Number.isFinite(segment.endTick)||segment.endTick<=segment.startTick||!Number.isFinite(segment.endSourceMs)||segment.endSourceMs<=segment.startSourceMs||!Number.isFinite(segment.bpm)||segment.bpm<=0||!Number.isFinite(rate)||rate<=0||Math.abs((segment.endTick-segment.startTick)*rate-(segment.endSourceMs-segment.startSourceMs))>timeTolerance)throw invalid();
    endTick=segment.endTick;endSourceMs=segment.endSourceMs;
  }
  if(endTick!==timing.exitTick||endSourceMs!==timing.exitSourceMs)throw invalid();
  const target=timing.segments.map(segment=>({tick:segment.startTick,bpm:segment.bpm}));
  target[0]={tick:0,bpm:target[0].bpm};
  const bpmAt=(tempos:readonly PlanTempo[],tick:number)=>{
    let bpm=tempos[0].bpm;
    for(const tempo of tempos){if(tempo.tick>tick)break;bpm=tempo.bpm;}
    return bpm;
  };
  type Pass={occurrence:number;points:{ratio:number;bpm:number}[]};
  const bars=new Map<number,Pass[]>(),counts=new Map<number,number>();let previousEnd=0;
  for(const location of locations) {
    if(!Number.isInteger(location.bar)||!score.masterBars[location.bar]||location.occurrence!==(counts.get(location.bar)??0)||!Number.isFinite(location.startTick)||location.startTick<previousEnd||!Number.isFinite(location.endTick)||location.endTick<=location.startTick)throw invalid();
    const points=[{ratio:0,bpm:bpmAt(target,location.startTick)},...target.filter(tempo=>tempo.tick>location.startTick&&tempo.tick<location.endTick).map(tempo=>({ratio:(tempo.tick-location.startTick)/(location.endTick-location.startTick),bpm:tempo.bpm}))];
    const passes=bars.get(location.bar)??[];passes.push({occurrence:location.occurrence,points});bars.set(location.bar,passes);
    counts.set(location.bar,location.occurrence+1);previousEnd=location.endTick;
  }
  const points:RatioTempoPoint[]=[];
  for(const [bar,passes] of bars) {
    const ratios=[...new Set(passes.flatMap(pass=>pass.points.map(point=>point.ratio)).concat(1))].sort((a,b)=>a-b);
    let previousBpm:number|undefined;
    for(const ratio of ratios.slice(0,-1)) {
      const values=passes.map(pass=>{let bpm=pass.points[0].bpm;for(const point of pass.points){if(point.ratio>ratio)break;bpm=point.bpm;}return bpm;});
      const conflict=values.findIndex(value=>Math.abs(value-values[0])>bpmTolerance);
      if(conflict>=0)throw new Error(`Written bar ${bar+1} has incompatible tempos on pass ${passes[conflict].occurrence+1} at ratio ${ratio}.`);
      if(previousBpm===undefined||Math.abs(previousBpm-values[0])>bpmTolerance){points.push({bar,ratio,bpm:values[0],linear:false});previousBpm=values[0];}
    }
  }
  if(!bars.has(0))points.push({bar:0,ratio:0,bpm:target[0].bpm,linear:false});
  points.sort((a,b)=>a.bar-b.bar||a.ratio-b.ratio);
  // A point that lands on a tempo the score already writes in another unit keeps that unit and counts in it.
  for(const point of points) {
    const old=score.masterBars[point.bar].tempoAutomations.find(value=>value.ratioPosition===point.ratio);
    if(old&&tempoUnitOf(old)!==quarterUnit&&Math.abs(old.value-point.bpm)<=bpmTolerance){point.unit=tempoUnitOf(old);point.bpm=displayedBpm(old);}
  }
  const candidate=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());
  restoreNoteLinks(candidate,captureNoteLinks(score));applyTempoAutomations(candidate,points);
  const regenerated=buildPlaybackPlan(candidate,0);
  if(regenerated.occurrences.length!==locations.length||regenerated.occurrences.some((value,index)=>{const expected=locations[index];return value.bar!==expected.bar||value.occurrence!==expected.occurrence||value.startTick!==expected.startTick||value.endTick!==expected.endTick;}))throw new Error('Converted score cannot reproduce the captured performed route.');
  const ticks=[...new Set([0,timing.exitTick,...target.map(tempo=>tempo.tick),...regenerated.tempos.filter(tempo=>tempo.tick<timing.exitTick).map(tempo=>tempo.tick)])].sort((a,b)=>a-b);
  const wantedTime=clock(target),actualTime=clock(regenerated.tempos);
  for(const tick of ticks) {
    if((tick<timing.exitTick&&Math.abs(bpmAt(target,tick)-bpmAt(regenerated.tempos,tick))>bpmTolerance)||Math.abs(wantedTime(tick)-actualTime(tick))>timeTolerance)throw new Error('Converted score cannot reproduce the reference tempo function.');
  }
  return points;
}
