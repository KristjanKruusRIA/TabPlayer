import { formatPitch } from '../tuning';
import { busyGuard } from '../ui/useBusyGuard';

/** Hear a tuning draft: one button per string (string 1 is the highest, as typed) and one that strums them all. */
export function AuditionButtons({pitches,onAudition,disabled=false,busy=false,label}:{pitches:readonly number[];onAudition:(pitches:number[],strum:boolean)=>void;disabled?:boolean;busy?:boolean;label?:string}) {
  return <div className="tuning-audition" role="group" aria-label={label?`Hear ${label}`:'Hear the tuning'}>
    {pitches.map((pitch,index)=><button key={index} type="button" aria-label={`Play string ${index+1} (${formatPitch(pitch)})`} {...busyGuard({busy,disabled,className:'tuning-audition-string',onClick:()=>onAudition([pitch],false)})}>{formatPitch(pitch)}</button>)}
    <button type="button" aria-label="Play tuning" {...busyGuard({busy,disabled:disabled||pitches.length>12,className:'tuning-audition-all',onClick:()=>onAudition([...pitches],true)})}>Play tuning</button>
  </div>;
}
