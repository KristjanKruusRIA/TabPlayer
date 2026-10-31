import type { MouseEvent } from 'react';
import type { SoundEditing } from './useSoundEditing';
import { busyGuard } from '../ui';

/** The track's lock against sound automations in the score. It stays focusable while an edit is pending: `busyGuard` refuses the change and marks the box `aria-disabled` rather than disabling it. */
export function SoundLock({editing,className}:{editing:Pick<SoundEditing,'current'|'busy'|'setLocked'>;className?:string}) {
  const {current,busy,setLocked}=editing,locked=!!current.locked;
  const guard=busyGuard<HTMLInputElement>({busy});
  // A refused click must also leave the box as it was: cancelling a controlled checkbox's click does not always put the box back.
  const refuse=(event:MouseEvent<HTMLInputElement>)=>{guard.onClick(event);if(busy){const box=event.currentTarget;queueMicrotask(()=>{box.checked=locked;});}};
  return <label className={className}><input type="checkbox" aria-label="Lock sound against automations" checked={locked} onChange={event=>{if(!busy)void setLocked(event.target.checked);}} {...guard} onClick={refuse}/><span>Lock sound against automations</span></label>;
}
