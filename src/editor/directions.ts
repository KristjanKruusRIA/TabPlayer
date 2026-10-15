import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { enumValue, integer } from './common';

export function applyDirectionEdit(score:model.Score,edit:EditCommand):boolean {
  if(edit.type!=='setDirections')return false;
  const master=score.masterBars[edit.bar];
  if(!integer(edit.bar)||!master)throw new Error('Select an existing measure for directions.');
  if(!Array.isArray(edit.directions))throw new Error('Invalid directions.');
  for(const direction of edit.directions)enumValue(direction,model.Direction,'direction');
  master.directions=edit.directions.length?new Set(edit.directions):null;
  return true;
}
