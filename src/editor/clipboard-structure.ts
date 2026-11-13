import { model } from '@coderline/alphatab';

const D=model.Direction;
type Kind='Fine'|'Segno'|'SegnoSegno'|'Coda'|'DoubleCoda';
const targets=new Map<model.Direction,Kind>([[D.TargetFine,'Fine'],[D.TargetSegno,'Segno'],[D.TargetSegnoSegno,'SegnoSegno'],[D.TargetCoda,'Coda'],[D.TargetDoubleCoda,'DoubleCoda']]);
/** What each jump needs on the same score: a segno-like origin at or before it, and further targets anywhere. */
const needs=new Map<model.Direction,{origin?:Kind;also:Kind[]}>([
  [D.JumpDaCapo,{also:[]}],[D.JumpDaCapoAlCoda,{also:['Coda']}],[D.JumpDaCapoAlDoubleCoda,{also:['DoubleCoda']}],[D.JumpDaCapoAlFine,{also:['Fine']}],
  [D.JumpDalSegno,{origin:'Segno',also:[]}],[D.JumpDalSegnoAlCoda,{origin:'Segno',also:['Coda']}],[D.JumpDalSegnoAlDoubleCoda,{origin:'Segno',also:['DoubleCoda']}],[D.JumpDalSegnoAlFine,{origin:'Segno',also:['Fine']}],
  [D.JumpDalSegnoSegno,{origin:'SegnoSegno',also:[]}],[D.JumpDalSegnoSegnoAlCoda,{origin:'SegnoSegno',also:['Coda']}],[D.JumpDalSegnoSegnoAlDoubleCoda,{origin:'SegnoSegno',also:['DoubleCoda']}],[D.JumpDalSegnoSegnoAlFine,{origin:'SegnoSegno',also:['Fine']}],
  [D.JumpDaCoda,{also:['Coda']}],[D.JumpDaDoubleCoda,{also:['DoubleCoda']}]
]);

/** The target kinds (Fine, Segno, Coda...) a run of measures defines. */
export function directionTargets(masters:model.MasterBar[]):Set<Kind> {
  const found=new Set<Kind>();for(const master of masters)for(const direction of master.directions??[]){const kind=targets.get(direction);if(kind)found.add(kind);}return found;
}
/** A reason the measures' navigation marks cannot stand alone, or null when every jump finds its targets inside them. */
export function directionProblem(masters:model.MasterBar[]):string|null {
  const seen=new Map<Kind,number>(),all=directionTargets(masters);
  masters.forEach((master,index)=>{for(const direction of master.directions??[]){const kind=targets.get(direction);if(kind&&!seen.has(kind))seen.set(kind,index);}});
  for(const [index,master] of masters.entries())for(const direction of master.directions??[]){
    const rule=needs.get(direction);if(!rule)continue;
    if(rule.origin&&!((seen.get(rule.origin)??Infinity)<=index))return `Copy the ${rule.origin} this navigation direction jumps back to, or leave the direction out.`;
    for(const kind of rule.also)if(!all.has(kind))return `Copy the ${kind} this navigation direction needs, or leave the direction out.`;
  }
  return null;
}
/** Refuse a paste that would give the destination a second Fine, Segno or Coda, or repeat a copied target. */
export function directionPasteProblem(destination:model.MasterBar[],pasted:model.MasterBar[],count:number):string|null {
  const kinds=directionTargets(pasted);if(!kinds.size)return null;
  if(count>1)return `A paste of ${[...kinds].join(', ')} can repeat only once: paste one copy at a time.`;
  const existing=directionTargets(destination);
  for(const kind of kinds)if(existing.has(kind))return `The destination already has a ${kind} target; a second one would make its jumps ambiguous.`;
  return null;
}
