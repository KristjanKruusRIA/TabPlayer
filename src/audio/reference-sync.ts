import type {BackingSettings} from '../edit-types';
import type {BackingTimeline} from './backing-waveform-types';
import type {ReferenceEndpoint,ReferenceLocation,ReferenceSyncTiming} from './reference-sync-types';
import type {PlaybackPlan} from './types';

export function referenceSyncTiming(_backing:BackingSettings,_locations:readonly ReferenceLocation[],_durationMs?:number):ReferenceSyncTiming|null {
  throw new Error('Reference synchronization timing is not implemented.');
}
export function referenceSourceMs(_timing:ReferenceSyncTiming,_tick:number):number {
  throw new Error('Reference synchronization projection is not implemented.');
}
export function applyReferenceSyncPlan(_authored:PlaybackPlan,_backing:BackingSettings|null):PlaybackPlan {
  throw new Error('Reference synchronization plan is not implemented.');
}
export function referenceTimingKey(_backing:BackingSettings|null):string|null {
  throw new Error('Reference synchronization identity is not implemented.');
}
export function initializeReferenceSync(_backing:BackingSettings,_authored:BackingTimeline,_durationMs:number):BackingSettings {
  throw new Error('Reference synchronization initialization is not implemented.');
}
export function disableReferenceSync(_backing:BackingSettings):BackingSettings {
  throw new Error('Reference synchronization removal is not implemented.');
}
export function moveReferenceEndpoint(_backing:BackingSettings,_endpoint:ReferenceEndpoint,_sourceMs:number,_locations:readonly ReferenceLocation[],_durationMs:number):BackingSettings {
  throw new Error('Reference synchronization endpoint editing is not implemented.');
}
export function adjustReferenceSyncBounds(_backing:BackingSettings,_previous:ReferenceSyncTiming,_locations:readonly ReferenceLocation[]):BackingSettings {
  throw new Error('Reference synchronization route adjustment is not implemented.');
}
