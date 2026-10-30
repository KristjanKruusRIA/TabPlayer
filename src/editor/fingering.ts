import { model } from '@coderline/alphatab';
import { fretExists } from './banjo-drone';
import type { FingeringPlacement,FingeringRequest } from './range-types';
export type { FingeringPlacement,FingeringRequest } from './range-types';

interface Assignment {cost:number;placements:FingeringPlacement[]}
const integer=(value:number,min:number,max:number)=>Number.isInteger(value)&&value>=min&&value<=max;
function earlier(a:FingeringPlacement[],b:FingeringPlacement[]) {
  for(let i=0;i<a.length;i++)if(a[i].string!==b[i].string)return a[i].string<b[i].string;
  for(let i=0;i<a.length;i++)if(a[i].fret!==b[i].fret)return a[i].fret<b[i].fret;
  return false;
}

export function planFingering(staff:model.Staff,requests:FingeringRequest[],maxFret:number):FingeringPlacement[] {
  const strings=staff.tuning.length;
  if(staff.isPercussion||!integer(strings,1,12)||staff.tuning.some(pitch=>!integer(pitch,0,127))||!Number.isSafeInteger(staff.capo)||!Number.isSafeInteger(staff.transpositionPitch))throw new Error('Choose a tuned melodic staff with one to twelve strings.');
  if(!integer(maxFret,1,127))throw new Error('Maximum fret must be an integer from 1 to 127.');
  if(requests.length>strings)throw new Error('No playable fingering: more notes than strings.');
  const seen=new Set<model.Note>();
  // Only the detached hierarchy is written; pitch getters read the destination staff.
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();bar.staff=staff;voice.bar=bar;beat.voice=voice;
  const candidates=requests.map(request=>{
    const {note,pitch,preferredString,fixedString}=request;
    if(!(note instanceof model.Note)||seen.has(note)||!integer(pitch,0,127)||(preferredString!==null&&!integer(preferredString,1,Number.MAX_SAFE_INTEGER)))throw new Error('Invalid fingering request.');
    seen.add(note);
    if(fixedString!==null&&(!integer(fixedString,1,strings)||fixedString!==note.string||!integer(note.fret,0,127)))throw new Error('A fixed string must preserve the original note placement.');
    const candidate=new model.Note();candidate.beat=beat;candidate.harmonicType=note.harmonicType;candidate.harmonicValue=note.harmonicValue;
    const choices:FingeringPlacement[]=[];
    for(let string=1;string<=strings;string++){
      if(fixedString!==null&&string!==fixedString)continue;
      candidate.string=string;
      const first=fixedString===null?0:note.fret,last=fixedString===null?maxFret:note.fret;
      for(let fret=first;fret<=last;fret++){
        candidate.fret=fret;
        if(fretExists(staff,string,fret)&&integer(candidate.realValueWithoutHarmonic,0,127)&&candidate.realValue===pitch)choices.push({note,string,fret});
      }
    }
    if(choices.length===0)throw new Error('No playable fingering preserves the requested pitch.');
    return choices;
  });
  let best:Assignment|undefined;
  for(let center=0;center<=maxFret;center++){
    let states=new Map<number,Assignment>([[0,{cost:0,placements:[]}]]);
    for(let i=0;i<candidates.length;i++){
      // Several natural-harmonic frets can produce the same output on one string.
      const perString=new Map<number,{placement:FingeringPlacement;cost:number}>();
      // An out-of-range source preference differs by a constant on every valid string.
      const preferred=requests[i].preferredString===null?null:Math.min(requests[i].preferredString!,strings);
      for(const placement of candidates[i]){
        const cost=10*Math.abs(placement.fret-center)+(preferred===null?0:Math.abs(placement.string-preferred)),current=perString.get(placement.string);
        if(!current||cost<current.cost||(cost===current.cost&&placement.fret<current.placement.fret))perString.set(placement.string,{placement,cost});
      }
      const next=new Map<number,Assignment>();
      for(const [mask,state] of states)for(const {placement,cost} of perString.values()){
        const bit=1<<(placement.string-1);if(mask&bit)continue;
        const newMask=mask|bit,total=state.cost+cost,placements=[...state.placements,placement],current=next.get(newMask);
        if(!current||total<current.cost||(total===current.cost&&earlier(placements,current.placements)))next.set(newMask,{cost:total,placements});
      }
      states=next;
      if(states.size===0)break;
    }
    let atCenter:Assignment|undefined;
    for(const state of states.values())if(!atCenter||state.cost<atCenter.cost||(state.cost===atCenter.cost&&earlier(state.placements,atCenter.placements)))atCenter=state;
    // Ascending centers retain the lower center when objective values tie.
    if(atCenter&&(!best||atCenter.cost<best.cost))best=atCenter;
  }
  if(!best)throw new Error('No playable fingering can assign one note per string.');
  return best.placements;
}
