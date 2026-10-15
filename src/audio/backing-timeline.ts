import type {BackingSettings} from '../edit-types';
import type {BackingGridLine,BackingScoreSelection,BackingTimeline} from './backing-waveform-types';

type BackingMapSettings=Pick<BackingSettings,'offsetMs'|'anchors'>;
export function scoreTimeToAudioMs(_timeline:BackingTimeline,_backing:BackingMapSettings,_scoreTimeMs:number):number {
  throw new Error('Backing timeline projection is not implemented.');
}
export function scoreTickToAudioMs(_timeline:BackingTimeline,_backing:BackingMapSettings,_tick:number):number {
  throw new Error('Backing timeline projection is not implemented.');
}
export function projectBackingGrid(_timeline:BackingTimeline,_backing:BackingMapSettings,_startMs:number,_endMs:number):BackingGridLine[] {
  throw new Error('Backing timeline projection is not implemented.');
}
export function projectBackingSelection(_timeline:BackingTimeline,_backing:BackingMapSettings,_selection:BackingScoreSelection):{points:number[];spans:{startMs:number;endMs:number}[]} {
  throw new Error('Backing timeline projection is not implemented.');
}
export function moveBackingAnchor(_backing:BackingSettings,_index:number,_sourceMs:number,_timeline:BackingTimeline,_durationMs:number):BackingSettings {
  throw new Error('Backing timeline projection is not implemented.');
}
