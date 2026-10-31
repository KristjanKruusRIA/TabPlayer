import type { MouseEvent } from 'react';
import { busyGuard } from '../ui';

/** The "Keep pitch" box. It sits outside the busy fieldset and uses `busyGuard`, so a focused box keeps focus when an edit is pending: it refuses the change and shows `aria-disabled` instead of `disabled`. */
export function KeepPitchBox({label,checked,busy,onChange}:{label:string;checked:boolean;busy:boolean;onChange:(checked:boolean)=>void}) {
  const guard=busyGuard<HTMLInputElement>({busy});
  // A refused click must leave the box as it was: cancelling a controlled checkbox's click does not always put it back.
  const refuse=(event:MouseEvent<HTMLInputElement>)=>{guard.onClick(event);if(busy){const box=event.currentTarget;queueMicrotask(()=>{box.checked=checked;});}};
  return <label className="check"><input type="checkbox" checked={checked} onChange={event=>{if(!busy)onChange(event.target.checked);}} {...guard} onClick={refuse}/>{label}</label>;
}
