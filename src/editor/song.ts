import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';

export const metadataFields=['subTitle','album','words','music','copyright','tab','notices','instructions'] as const;

export function applySongEdit(score:model.Score,edit:EditCommand):boolean {
  if(edit.type!=='setScoreMetadata')return false;
  const fields=edit.fields;
  if(!fields||Object.keys(fields).length!==metadataFields.length||metadataFields.some(key=>typeof fields[key]!=='string'))throw new Error('Invalid score metadata.');
  for(const key of metadataFields)score[key]=fields[key];
  return true;
}
