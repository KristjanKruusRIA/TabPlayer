import { formatPitch } from '../tuning';

/** Hear a tuning draft: one button per string (string 1 is the highest, as typed) and one that strums them all. */
export function AuditionButtons({pitches,onAudition,disabled=false,label}:{pitches:readonly number[];onAudition:(pitches:number[],strum:boolean)=>void;disabled?:boolean;label?:string}) {
  return <div className="tuning-audition" role="group" aria-label={label?`Hear ${label}`:'Hear the tuning'}>
    {pitches.map((pitch,index)=><button key={index} type="button" className="tuning-audition-string" disabled={disabled} aria-label={`Play string ${index+1} (${formatPitch(pitch)})`} onClick={()=>onAudition([pitch],false)}>{formatPitch(pitch)}</button>)}
    <button type="button" className="tuning-audition-all" disabled={disabled||pitches.length>12} aria-label="Play tuning" onClick={()=>onAudition([...pitches],true)}>Play tuning</button>
  </div>;
}
