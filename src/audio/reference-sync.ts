import type {BackingSettings} from '../edit-types';
import type {BackingTimeline} from './backing-waveform-types';
import type {ReferenceEndpoint,ReferenceLocation,ReferenceSyncTiming} from './reference-sync-types';
import type {PlaybackPlan} from './types';
import {scoreTickToAudioMs} from './backing-timeline';

const SOURCE_TOLERANCE_MS=1e-7;
function finite(value:number):number {
  if(!Number.isFinite(value))throw new Error('Reference synchronization timing must be finite.');
  return value;
}
function positive(value:number):number {
  if(finite(value)<=0)throw new Error('Reference synchronization intervals must be positive.');
  return value;
}
function index(value:number):boolean {return Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;}
function routeLocations(locations:readonly ReferenceLocation[]):Map<string,ReferenceLocation> {
  if(!locations.length)throw new Error('Reference synchronization requires performed music.');
  const counts=new Map<number,number>(),resolved=new Map<string,ReferenceLocation>();let previousEnd=0;
  for(const location of locations) {
    const {bar,occurrence,startTick,endTick}=location;
    if(!index(bar)||!index(occurrence)||occurrence!==(counts.get(bar)??0)||finite(startTick)<previousEnd)throw new Error('Invalid reference performed route.');
    positive(endTick-startTick);finite(endTick);counts.set(bar,occurrence+1);previousEnd=endTick;
    resolved.set(`${bar}:${occurrence}`,location);
  }
  return resolved;
}
function anchorTick(anchor:BackingSettings['anchors'][number],locations:Map<string,ReferenceLocation>):number {
  if(!index(anchor.bar)||!index(anchor.occurrence)||finite(anchor.ratio)<0||anchor.ratio>1)throw new Error('Invalid reference synchronization anchor.');
  const location=locations.get(`${anchor.bar}:${anchor.occurrence}`);
  if(!location)throw new Error('Backing anchor refers to missing score music.');
  return finite(location.startTick+(location.endTick-location.startTick)*anchor.ratio);
}
function segmentIndex(timing:ReferenceSyncTiming,tick:number):number {
  finite(tick);let low=0,high=timing.segments.length;
  while(low<high){const middle=(low+high)>>>1;if(timing.segments[middle].startTick<=tick)low=middle+1;else high=middle;}
  if(!timing.segments.length)throw new Error('Reference synchronization requires timing segments.');
  return Math.max(0,low-1);
}
function segmentElapsedMs(segment:ReferenceSyncTiming['segments'][number],ticks:number):number {
  const deltaTick=positive(segment.endTick-segment.startTick),deltaMs=positive(segment.endSourceMs-segment.startSourceMs),rate=deltaMs/deltaTick;
  return finite(Number.isFinite(rate)?ticks*rate:(ticks/deltaTick)*deltaMs);
}
function timingClock(timing:ReferenceSyncTiming):(tick:number)=>number {
  let elapsedMs=segmentElapsedMs(timing.segments[0],timing.entryTick);
  const starts=timing.segments.map(segment=>{const startMs=elapsedMs;elapsedMs=finite(elapsedMs+(segment.endSourceMs-segment.startSourceMs));return startMs;});
  return tick=>{const i=segmentIndex(timing,tick),segment=timing.segments[i];return finite(starts[i]+segmentElapsedMs(segment,tick-segment.startTick));};
}
export function referenceSyncTiming(backing:BackingSettings,locations:readonly ReferenceLocation[],durationMs?:number):ReferenceSyncTiming|null {
  const bounds=backing.referenceSync;if(!bounds)return null;
  const resolved=routeLocations(locations),entryTick=locations[0].startTick,exitTick=locations[locations.length-1].endTick;
  finite(backing.offsetMs);
  const entrySourceMs=finite(finite(bounds.entryAudioMs)-backing.offsetMs),exitSourceMs=finite(finite(bounds.exitAudioMs)-backing.offsetMs);
  if(entrySourceMs<0)throw new Error('Reference entry must stay within source audio.');
  positive(exitSourceMs-entrySourceMs);
  if(durationMs!==undefined&&(finite(durationMs)<0||exitSourceMs>durationMs))throw new Error('Reference exit must stay within source audio.');
  const interiors=backing.anchors.map(anchor=>{
    const tick=anchorTick(anchor,resolved),sourceMs=finite(finite(anchor.audioMs)-backing.offsetMs);
    if(tick<=entryTick||tick>=exitTick||sourceMs<=entrySourceMs||sourceMs>=exitSourceMs)throw new Error('Reference anchors must lie inside the synchronization endpoints.');
    return {tick,sourceMs};
  }).sort((a,b)=>a.tick-b.tick);
  const points=[{tick:entryTick,sourceMs:entrySourceMs},...interiors,{tick:exitTick,sourceMs:exitSourceMs}];
  let elapsedMs=0;
  const segments=points.slice(1).map((point,i)=>{
    const previous=points[i],deltaTick=positive(point.tick-previous.tick),deltaSourceMs=positive(point.sourceMs-previous.sourceMs);
    const bpm=positive(deltaTick/deltaSourceMs*62.5),rate=positive(60/(960*bpm));positive(1/rate);
    if(i===0)elapsedMs=segmentElapsedMs({startTick:previous.tick,endTick:point.tick,startSourceMs:previous.sourceMs,endSourceMs:point.sourceMs,bpm},entryTick);
    const endMs=finite(elapsedMs+deltaSourceMs);positive(endMs-elapsedMs);elapsedMs=endMs;
    return {startTick:previous.tick,endTick:point.tick,startSourceMs:previous.sourceMs,endSourceMs:point.sourceMs,bpm};
  });
  const timing={entryTick,exitTick,entrySourceMs,exitSourceMs,segments},timeAt=timingClock(timing);
  for(const location of locations)positive(timeAt(location.endTick)-timeAt(location.startTick));
  return timing;
}
export function referenceSourceMs(timing:ReferenceSyncTiming,tick:number):number {
  const segment=timing.segments[segmentIndex(timing,tick)];
  if(tick===segment.endTick)return segment.endSourceMs;
  return finite(segment.startSourceMs+segmentElapsedMs(segment,tick-segment.startTick));
}
export function applyReferenceSyncPlan(authored:PlaybackPlan,backing:BackingSettings|null):PlaybackPlan {
  if(!backing?.referenceSync)return authored;
  const timing=referenceSyncTiming(backing,authored.occurrences)!;
  if(finite(authored.durationTick)<timing.exitTick)throw new Error('Reference music exceeds the playback plan.');
  const timeAt=timingClock(timing);
  const effective=structuredClone(authored);
  effective.tempos=timing.segments.map((segment,i)=>({tick:i===0?0:segment.startTick,bpm:segment.bpm}));
  effective.playbackEndTick=timing.exitTick;effective.durationMs=positive(timeAt(authored.durationTick));
  effective.occurrences=effective.occurrences.map(occurrence=>({...occurrence,startMs:timeAt(occurrence.startTick),endMs:timeAt(occurrence.endTick)}));
  return effective;
}
export function referenceTimingKey(backing:BackingSettings|null):string|null {
  if(!backing?.referenceSync)return null;
  const anchors=backing.anchors.map(a=>[a.bar,a.occurrence,a.ratio,a.audioMs]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3]);
  return JSON.stringify([backing.assetId,backing.offsetMs,anchors,[backing.referenceSync.entryAudioMs,backing.referenceSync.exitAudioMs]]);
}
export function initializeReferenceSync(backing:BackingSettings,authored:BackingTimeline,durationMs:number):BackingSettings {
  positive(durationMs);const resolved=routeLocations(authored.occurrences),candidate=structuredClone(backing);
  if(backing.referenceSync){referenceSyncTiming(candidate,authored.occurrences,durationMs);return candidate;}
  const entryTick=authored.occurrences[0].startTick,exitTick=authored.occurrences[authored.occurrences.length-1].endTick;
  let entrySourceMs=scoreTickToAudioMs(authored,backing,entryTick),exitSourceMs=scoreTickToAudioMs(authored,backing,exitTick);
  if(!(entrySourceMs>=0&&entrySourceMs<exitSourceMs&&exitSourceMs<=durationMs)){entrySourceMs=0;exitSourceMs=durationMs;}
  candidate.referenceSync={entryAudioMs:finite(entrySourceMs+backing.offsetMs),exitAudioMs:finite(exitSourceMs+backing.offsetMs)};
  candidate.anchors=candidate.anchors.filter(anchor=>{
    const tick=anchorTick(anchor,resolved);
    if(tick!==entryTick&&tick!==exitTick)return true;
    const endpoint=tick===entryTick?'entryAudioMs':'exitAudioMs',source=tick===entryTick?entrySourceMs:exitSourceMs;
    if(finite(anchor.audioMs-backing.offsetMs)!==source)throw new Error('Backing endpoint anchor conflicts with the reference bracket.');
    candidate.referenceSync![endpoint]=anchor.audioMs;return false;
  });
  referenceSyncTiming(candidate,authored.occurrences,durationMs);return candidate;
}
export function disableReferenceSync(backing:BackingSettings):BackingSettings {
  const candidate=structuredClone(backing);delete candidate.referenceSync;
  const delta=backing.anchors.reduce((minimum,anchor)=>Math.max(minimum,-finite(anchor.audioMs)),0);
  if(delta>0){
    candidate.offsetMs=finite(backing.offsetMs+delta);
    candidate.anchors=candidate.anchors.map(anchor=>({...anchor,audioMs:finite(anchor.audioMs+delta)}));
    candidate.anchors.forEach((anchor,i)=>{
      const original=finite(backing.anchors[i].audioMs-backing.offsetMs),rebased=finite(anchor.audioMs-candidate.offsetMs);
      if(Math.abs(rebased-original)>SOURCE_TOLERANCE_MS)throw new Error('Reference synchronization cannot be removed without changing source positions.');
    });
  }
  return candidate;
}
export function moveReferenceEndpoint(backing:BackingSettings,endpoint:ReferenceEndpoint,sourceMs:number,locations:readonly ReferenceLocation[],durationMs:number):BackingSettings {
  if(!backing.referenceSync)throw new Error('Reference synchronization is not enabled.');
  finite(sourceMs);const candidate=structuredClone(backing),key=endpoint==='entry'?'entryAudioMs':'exitAudioMs';
  if(sourceMs!==backing.referenceSync[key]-backing.offsetMs)candidate.referenceSync![key]=finite(sourceMs+backing.offsetMs);
  if(Math.abs(finite(candidate.referenceSync![key]-backing.offsetMs)-sourceMs)>SOURCE_TOLERANCE_MS)throw new Error('Reference endpoint cannot represent the requested source position.');
  referenceSyncTiming(candidate,locations,durationMs);return candidate;
}
export function adjustReferenceSyncBounds(backing:BackingSettings,previous:ReferenceSyncTiming,locations:readonly ReferenceLocation[]):BackingSettings {
  if(!backing.referenceSync)throw new Error('Reference synchronization is not enabled.');
  routeLocations(locations);
  const deltaExtent=finite((locations[locations.length-1].endTick-locations[0].startTick)-(previous.exitTick-previous.entryTick));
  const candidate=structuredClone(backing);
  let growthMs=0;
  if(deltaExtent!==0){
    const final=previous.segments[previous.segments.length-1];
    growthMs=finite(deltaExtent/(final.endTick-final.startTick)*(final.endSourceMs-final.startSourceMs));
    candidate.referenceSync!.exitAudioMs=finite(backing.referenceSync.exitAudioMs+growthMs);
  }
  const timing=referenceSyncTiming(candidate,locations)!;
  if(Math.abs((timing.exitSourceMs-previous.exitSourceMs)-growthMs)>SOURCE_TOLERANCE_MS)throw new Error('Reference synchronization growth cannot preserve the source timing.');
  return candidate;
}
