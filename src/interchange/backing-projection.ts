import {model,Settings} from '@coderline/alphatab';
import type {BackingSettings,DocumentSettings} from '../edit-types';
import type {ExportSelection} from '../export/types';
import {selectScore} from '../export/selection';
import {scoreFromJson} from '../model-clone';
import {captureNoteLinks,restoreNoteLinks} from '../editor/links';
import {copyGpInterchangeSource} from './gp';
import {buildPlaybackPlan,validateBackingAnchors} from '../audio/plan';
import {scoreTickToAudioMs} from '../audio/backing-timeline';
import {referenceSourceMs,referenceSyncTiming} from '../audio/reference-sync';
import type {ReferenceLocation} from '../audio/reference-sync-types';

export interface GpBackingProjectionInput {
  score:model.Score;settings:DocumentSettings;bytes:Uint8Array|null;selection:ExportSelection;backing:boolean;
}
function clearBacking(score:model.Score):void {
  score.backingTrack=undefined;
  for(const bar of score.masterBars)bar.syncPoints=undefined;
}
function detached(score:model.Score):model.Score {
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());
  restoreNoteLinks(copy,captureNoteLinks(score));copyGpInterchangeSource(score,copy);clearBacking(copy);return copy;
}
function identitySelection(score:model.Score,selection:ExportSelection):boolean {
  return (!selection.range||selection.range.first===0&&selection.range.last===score.masterBars.length-1)
    &&selection.tracks.length===score.tracks.length&&selection.tracks.every((track,index)=>track===index)
    &&Object.entries(selection.staves??{}).every(([track,staves])=>staves.length===score.tracks[Number(track)].staves.length&&staves.every((staff,index)=>staff===index));
}
function routeTranslation(original:readonly ReferenceLocation[],selected:readonly ReferenceLocation[],first:number):number {
  if(!selected.length)throw new Error('Include backing audio requires performed music.');
  const candidates:number[]=[];
  for(let start=0;start+selected.length<=original.length;start++){
    const delta=original[start].startTick-selected[0].startTick;
    if(selected.every((item,index)=>{
      const old=original[start+index];
      return old.bar===item.bar+first&&old.startTick===item.startTick+delta&&old.endTick===item.endTick+delta;
    }))candidates.push(delta);
  }
  if(candidates.length!==1)throw new Error(candidates.length?'Include backing audio is ambiguous across repeated passes. Choose a larger measure range or clear Include backing audio.':'The selected route changes performed timing or joins separated audio windows. Choose an unchanged continuous measure range or clear Include backing audio.');
  return candidates[0];
}
function hasLeadIn(route:readonly ReferenceLocation[]):boolean {
  return route.some((item,index)=>item.startTick>(index?route[index-1].endTick:0));
}
function projection(score:model.Score,backing:BackingSettings,selection:ExportSelection):{score:model.Score;points:model.FlatSyncPoint[]} {
  // Original embedded sync objects must not change the authored route or clock.
  const original=detached(score),authored=buildPlaybackPlan(original,0);
  validateBackingAnchors(original,backing);
  const reference=backing.referenceSync?referenceSyncTiming(backing,authored.occurrences):null;
  const sourceAt=(tick:number)=>reference?referenceSourceMs(reference,tick):scoreTickToAudioMs(authored,backing,tick);
  const sourceTicks=[...authored.tempos.map(item=>item.tick),...backing.anchors.map(anchor=>{
    const location=authored.occurrences.find(item=>item.bar===anchor.bar&&item.occurrence===anchor.occurrence)!;
    return location.startTick+(location.endTick-location.startTick)*anchor.ratio;
  }),...(reference?.segments.flatMap(segment=>[segment.startTick,segment.endTick])??[])];
  // Capture the complete source function before written selection changes repeats.
  const selected=selectScore(original,selection);clearBacking(selected);
  const performed=buildPlaybackPlan(selected,0),delta=routeTranslation(authored.occurrences,performed.occurrences,selection.range?.first??0);
  if(!identitySelection(score,selection)&&(hasLeadIn(authored.occurrences)||hasLeadIn(performed.occurrences)))throw new Error('Include backing audio for a grace lead-in requires the full original selection. Clear Include backing audio to export this excerpt.');
  const entry=performed.occurrences[0].startTick,exit=performed.occurrences.at(-1)!.endTick;
  const ticks=[...new Set([entry,exit,...sourceTicks.map(tick=>tick-delta),...performed.tempos.map(tempo=>tempo.tick)].filter(tick=>tick>=entry&&tick<=exit))].sort((a,b)=>a-b);
  const points=ticks.map(tick=>{
    const location=tick===exit?performed.occurrences.at(-1)!:performed.occurrences.find(item=>tick>=item.startTick&&tick<item.endTick);
    if(!location)throw new Error('Backing synchronization falls outside the selected measure bodies.');
    return {barIndex:location.bar,barOccurence:location.occurrence,barPosition:(tick-location.startTick)/(location.endTick-location.startTick),millisecondOffset:sourceAt(tick+delta)};
  });
  const padding=points.find(point=>point.barIndex===0&&point.barOccurence===0&&point.barPosition===0)?.millisecondOffset??0;
  if(!Number.isFinite(padding)||Math.abs(padding/1000*44100)>2147483647)throw new Error('Backing frame padding exceeds the GP signed 32-bit range.');
  let previousFrame=-Infinity;
  for(const [index,point]of points.entries()){
    const frames=Math.floor((point.millisecondOffset-padding)/1000*44100+.5);
    if(!Number.isFinite(point.millisecondOffset)||!Number.isSafeInteger(frames)||frames<=previousFrame||index>0&&point.millisecondOffset<=points[index-1].millisecondOffset)throw new Error('Backing source times or frame offsets are not representable in GP.');
    previousFrame=frames;
  }
  return {score:selected,points};
}
export function projectGpDocument(input:GpBackingProjectionInput):model.Score {
  const backing=input.settings.backing;
  if(!input.backing||!backing){const selected=selectScore(detached(input.score),input.selection);clearBacking(selected);return selected;}
  const asset=input.bytes??(backing.assetId==='embedded'?input.score.backingTrack?.rawAudioFile:null);
  if(!asset?.length)throw new Error('Current backing audio bytes are required for GP export.');
  const result=projection(input.score,backing,input.selection);
  result.score.applyFlatSyncPoints(result.points);result.score.backingTrack=new model.BackingTrack();result.score.backingTrack.rawAudioFile=asset.slice();return result.score;
}
export function gpBackingSelectionIssue(score:model.Score,backing:BackingSettings|null,selection:ExportSelection):string|null {
  if(!backing)return null;
  try{projection(score,backing,selection);return null;}catch(error){return error instanceof Error?error.message:String(error);}
}
