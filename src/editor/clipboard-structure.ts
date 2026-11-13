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

const isJump=(direction:model.Direction)=>needs.has(direction);
/** True when any measure carries a jump (D.C., D.S., To Coda and their variants). */
export function hasJump(masters:model.MasterBar[]):boolean {return masters.some(master=>[...master.directions??[]].some(isJump));}
/** Why bars cannot be inserted before `bar`: that would separate alternate endings from their repeat, or cut into one. */
export function alternateEndingProblem(masters:model.MasterBar[],bar:number):string|null {
  const here=masters[bar],before=masters[bar-1];
  if(!here?.alternateEndings||!before||!(before.alternateEndings||before.repeatCount))return null;
  return before.alternateEndings===here.alternateEndings&&!before.repeatCount?'Paste before or after the whole alternate ending, not inside it.':'Paste before the repeat, not between its alternate endings.';
}
/** The target kinds (Fine, Segno, Coda...) a run of measures defines. */
export function directionTargets(masters:model.MasterBar[]):Set<Kind> {
  const found=new Set<Kind>();for(const master of masters)for(const direction of master.directions??[]){const kind=targets.get(direction);if(kind)found.add(kind);}return found;
}
/** A reason the measures' navigation marks cannot stand alone, or null when every jump finds its targets inside them. */
export function directionProblem(masters:model.MasterBar[]):string|null {
  const at=new Map<Kind,number[]>();
  masters.forEach((master,index)=>{for(const direction of master.directions??[]){const kind=targets.get(direction);if(kind)at.set(kind,[...at.get(kind)??[],index]);}});
  for(const [index,master] of masters.entries())for(const direction of master.directions??[]){
    const rule=needs.get(direction);if(!rule)continue;
    const origin=rule.origin?at.get(rule.origin)?.[0]:undefined;
    if(rule.origin&&!(origin!==undefined&&origin<=index))return `Copy the ${rule.origin} this navigation direction jumps back to, at or before the direction, or leave the direction out.`;
    for(const kind of rule.also){
      const places=at.get(kind);
      if(!places)return `Copy the ${kind} this navigation direction needs, or leave the direction out.`;
      if(kind==='Fine'){
        // Written music puts the Fine before the jump: the player goes back, plays on and stops there.
        const reachable=places.filter(place=>place<=index);
        if(!reachable.length)return 'Put the Fine at or before the navigation direction that uses it, or leave the direction out.';
        if(origin!==undefined&&!reachable.some(place=>place>=origin))return `Put the Fine after its ${rule.origin}, or leave the direction out.`;
      }else if(!(places[places.length-1]>index))return `Put the ${kind} after the navigation direction that uses it, or leave the direction out.`;
    }
  }
  return null;
}
/** Refuse a paste that would give the destination a second Fine, Segno or Coda, or repeat a copied target. */
export function directionPasteProblem(destination:model.MasterBar[],pasted:model.MasterBar[],count:number):string|null {
  if(hasJump(pasted)){
    if(count>1)return 'A paste of navigation jumps can repeat only once: paste one copy at a time.';
    if(hasJump(destination))return 'The destination already has a navigation jump; a second one would make the playback order ambiguous.';
  }
  const kinds=directionTargets(pasted);if(!kinds.size)return null;
  if(count>1)return `A paste of ${[...kinds].join(', ')} can repeat only once: paste one copy at a time.`;
  const existing=directionTargets(destination);
  for(const kind of kinds)if(existing.has(kind))return `The destination already has a ${kind} target; a second one would make its jumps ambiguous.`;
  return null;
}
