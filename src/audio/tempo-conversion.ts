import type {model} from '@coderline/alphatab';
import type {BackingSettings} from '../edit-types';
import type {RatioTempoPoint} from '../editor/tempo-types';
import type {ReferenceLocation,ReferenceSyncTiming} from './reference-sync-types';
import type {PlaybackPlan} from './types';

export function syncPointsFromScore(_authored:PlaybackPlan,_backing:BackingSettings,_mode:'replace'|'add',_durationMs:number):BackingSettings {
  throw new Error('Score-to-sync conversion is not implemented.');
}
export function scoreTemposFromSync(_score:model.Score,_timing:ReferenceSyncTiming,_locations:readonly ReferenceLocation[]):RatioTempoPoint[] {
  throw new Error('Sync-to-score conversion is not implemented.');
}
