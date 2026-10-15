import type {model} from '@coderline/alphatab';
import type {BackingSettings,DocumentSettings} from '../edit-types';
import type {ExportSelection} from '../export/types';

export interface GpBackingProjectionInput {
  score:model.Score;settings:DocumentSettings;bytes:Uint8Array|null;selection:ExportSelection;backing:boolean;
}
export function projectGpDocument(_input:GpBackingProjectionInput):model.Score {
  throw new Error('Current-backing GP projection is not implemented.');
}
export function gpBackingSelectionIssue(_score:model.Score,_backing:BackingSettings|null,_selection:ExportSelection):string|null {
  throw new Error('GP backing selection validation is not implemented.');
}
