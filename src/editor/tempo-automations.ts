import type {model} from '@coderline/alphatab';
import type {RatioTempoPoint} from './tempo-types';

export function applyTempoAutomations(_score:model.Score,_points:readonly RatioTempoPoint[]):void {
  throw new Error('Score tempo replacement is not implemented.');
}
