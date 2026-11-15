import type { model } from '@coderline/alphatab';
import { editCopyInPlace,scoreLineage,undoCopyInPlace } from '../engine';
import { sameData } from '../same-data';
import { mapProjection,type EngravingProjection } from './projection';
import type { EngravingOverrides } from './types';

/** What a projection was made from, kept so that the next one can follow it. */
export interface ProjectionBasis {source:model.Score;ids:readonly string[];value:EngravingOverrides;projection:EngravingProjection}

/**
 * The projection of `source` made from the projection of the score it was edited from, or null when that cannot be done.
 * A score edited in place records the edit and the track it changed; the rendered copy takes the same edit, in place, and its
 * maps are built again. This is the projection `projectEngraving` gives (a test compares them), without serializing the whole score.
 * On a refusal the basis is no longer usable (its copy may be half edited), so the caller makes a whole new projection.
 */
/** The projection already made for a score from a basis, so that React running the same render twice (or a render that was thrown away) edits the rendered copy once. */
const followed=new WeakMap<model.Score,{basis:model.Score;ids:readonly string[];value:EngravingOverrides;projection:EngravingProjection}>();
export function followProjection(basis:ProjectionBasis,source:model.Score,ids:readonly string[],value:EngravingOverrides):EngravingProjection|null {
  const known=followed.get(source);
  if(known&&known.basis===basis.source&&sameData(ids,known.ids)&&(value===known.value||sameData(value,known.value)))return known.projection;
  // Several edits can have passed since the basis (React may draw once for two); each is taken in turn, oldest first.
  const edits:ReturnType<typeof scoreLineage>[]=[];
  for(let at:model.Score|undefined=source;at!==basis.source;){
    const step=scoreLineage(at);if(!step||edits.length>=8)return null;
    edits.unshift(step);at=step.previous;
  }
  if(!edits.length||!sameData(ids,basis.ids)||!(value===basis.value||sameData(value,basis.value)))return null;
  try {
    let score=basis.projection.score;
    for(const step of edits){
      // An edit taken back in place is taken back on the copy the same way; a copy that cannot is made again.
      const next=step!.edit?editCopyInPlace(score,step!.edit):undoCopyInPlace(score);
      if(!next)return null;
      score=next;
    }
    const projection={...mapProjection(source,score,ids,value),score,bracketMode:basis.projection.bracketMode};
    followed.set(source,{basis:basis.source,ids,value,projection});
    return projection;
  } catch {return null;}
}
