import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { applyNoteTechniques, applyBeatTechniques, applyNoteLink } from './techniques';
import { applyStructureEdit } from './structure';
import { applyNotationEdit } from './notation';
import { applySongEdit } from './song';
import { applyDirectionEdit } from './directions';
import { applyPitchEdit } from './pitch';
import { applyNonTabEdit } from './non-tab';
export function applyAdvancedEdit(score:model.Score,command:EditCommand,editIndex:number):boolean {
  if(command.type==='setNoteTechniques'){applyNoteTechniques(score,{target:command.target,string:command.string},command.patch);return true;}
  if(command.type==='setBeatTechniques'){applyBeatTechniques(score,command.target,command.patch);return true;}
  if(command.type==='setNoteLink'){applyNoteLink(score,command.from,command.to,command.kind);return true;}
  return applySongEdit(score,command)||applyDirectionEdit(score,command)||applyPitchEdit(score,command)||applyNonTabEdit(score,command)||applyStructureEdit(score,command,editIndex)||applyNotationEdit(score,command,editIndex);
}
