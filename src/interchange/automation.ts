import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';

export interface PerformedBar {bar:number;startTick:number;endTick:number}
export interface GpControllerEvent {track:number;tick:number;channel:number;controller:7|10;value:number}
type MixPoint={bar:number;automation:model.Automation};
const preparedPoints=new WeakMap<model.Score,Map<number,MixPoint[]>>();

/** Call after other model preparation; then assign channels, generate, and extract points. */
export function prepareGpMidiScore(score:model.Score,settings:Settings):model.Score {
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
  restoreNoteLinks(copy,captureNoteLinks(score));
  preparedPoints.set(copy,new Map(score.tracks.map(track=>[track.index,trackMixAutomations(track).map(({bar,automation})=>({bar,automation:Object.assign(new model.Automation(),automation)}))])));
  for(const track of copy.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)beat.automations=beat.automations.filter(automation=>!isGpMixAutomation(automation));
  return copy;
}
/** Exact breakpoints, rounded to the nearest MIDI tick/value. Linear ramps remain unsupported. */
export function gpControllerEvents(score:model.Score,bars:readonly PerformedBar[]):GpControllerEvent[] {
  const result:GpControllerEvent[]=[],points=preparedPoints.get(score)??new Map(score.tracks.map(track=>[track.index,trackMixAutomations(track)]));
  const append=(track:model.Track,tick:number,controller:7|10,value:number)=>{
    for(const channel of new Set([track.playbackInfo.primaryChannel,track.playbackInfo.secondaryChannel]))result.push({track:track.index,tick:Math.round(tick),channel,controller,value:Math.max(0,Math.min(127,Math.round(value*8)))});
  };
  for(let i=0;i<bars.length;i++){
    const occurrence=bars[i];
    for(const track of score.tracks){
      const stream=points.get(track.index)??[],inBar=stream.filter(point=>point.bar===occurrence.bar);
      if(i>0&&occurrence.bar<=bars[i-1].bar){
        for(const [type,controller,initial]of [[model.AutomationType.Volume,7,track.playbackInfo.volume],[model.AutomationType.Balance,10,track.playbackInfo.balance]] as const){
          if(!stream.some(point=>point.automation.type===type)||inBar.some(point=>point.automation.type===type&&point.automation.ratioPosition===0))continue;
          let value=initial;for(const point of stream)if(point.bar<occurrence.bar&&point.automation.type===type)value=point.automation.value;
          append(track,occurrence.startTick,controller,value);
        }
      }
      for(const {automation}of inBar)append(track,occurrence.startTick+(occurrence.endTick-occurrence.startTick)*automation.ratioPosition,automation.type===model.AutomationType.Volume?7:10,automation.value);
    }
  }
  return result.sort((a,b)=>a.tick-b.tick);
}

export const isGpMixAutomation=(automation:model.Automation)=>automation.type===model.AutomationType.Volume||automation.type===model.AutomationType.Balance;

/** One track-wide stream; identical mirrored staff/voice events have one owner. */
export function trackMixAutomations(track:model.Track):{bar:number;automation:model.Automation}[] {
  const result:{bar:number;automation:model.Automation}[]=[],owners=new Map<string,string>();
  for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const automation of beat.automations){
    if(!isGpMixAutomation(automation))continue;
    const lane=`${staff.index}/${voice.index}`,key=JSON.stringify([bar.index,automation.type,automation.ratioPosition,automation.value,automation.isLinear,automation.isVisible,automation.text]);
    const owner=owners.get(key);if(owner!==undefined&&owner!==lane)continue;
    owners.set(key,lane);result.push({bar:bar.index,automation});
  }
  return result.sort((a,b)=>a.bar-b.bar||a.automation.ratioPosition-b.automation.ratioPosition);
}
