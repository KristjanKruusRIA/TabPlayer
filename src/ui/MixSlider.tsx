import { useEffect, useRef, useState } from 'react';
import { snapToStep } from './useRange';

export interface MixSliderProps {
  label:string;/** With a name here the range sits in a `track-channel-range` label that also shows the value as it moves. */visible?:string;
  value:number;min:number;max:number;step:number;format:(value:number)=>string;className?:string;title?:string;
  /** No player, so nothing to change; the only case that sets the `disabled` attribute. */
  disabled?:boolean;
  /** The app is busy: a change cannot begin, but a drag under way carries on to its release, and the control keeps its focus. */
  busy?:boolean;
  /** Receives the final value of a gesture (the release of a drag, one key step); one call is one undoable change. */
  onCommit:(value:number)=>Promise<unknown>|void;
  /** Follows a drag as it goes, for hearing it; never records an edit. */
  onInput?:(value:number)=>void;
  /** The end of a gesture that called `onInput`: `committed` is true when `onCommit` was called for it. */
  onInputEnd?:(committed:boolean)=>void;
}
const defaultThumb=16,thumbGrab=6;

/** A native horizontal range with the contract of `Knob` and `Fader`: it follows the pointer or keys on a draft of its own, calls `onInput`
 * as it moves, and calls `onCommit` once when the gesture ends, so one drag is one undoable change and ending where it began records nothing.
 * A mouse drag is followed on the window from the press to the release, so it does not depend on pointer capture, which a webview can drop
 * without a word (a native range then stops following after the first move). Busy refuses a new change only (`aria-disabled`); it never sets
 * `disabled` and never ends a drag, so a drag is not lost to work starting during it. A value that was sent stays shown until it settles. */
export function MixSlider({label,visible,value,min,max,step,format,className,title,disabled=false,busy=false,onCommit,onInput,onInputEnd}:MixSliderProps):React.JSX.Element {
  const [draft,setDraftState]=useState<number|null>(null);
  const draftRef=useRef<number|null>(null),sent=useRef<number|null>(null);
  const setDraft=(next:number|null|((current:number|null)=>number|null))=>{draftRef.current=typeof next==='function'?next(draftRef.current):next;setDraftState(draftRef.current);};
  const latest=useRef({busy,disabled,onCommit,onInput,onInputEnd,value,min,max,step});latest.current={busy,disabled,onCommit,onInput,onInputEnd,value,min,max,step};
  const pointer=useRef<{id:number;stop:()=>void}|null>(null);
  const shown=draft??value;
  const finish=()=>{
    const now=latest.current,current=draftRef.current;
    if(current===null||current===sent.current)return;
    if(current===now.value){setDraft(null);now.onInputEnd?.(false);return;}
    // The value being sent stays shown until the host has taken it; a change made meanwhile is a gesture of its own.
    sent.current=current;
    let result:Promise<unknown>|void=undefined;
    try{result=now.onCommit(current);}catch{ /* The host reports its own refusals. */ }
    now.onInputEnd?.(true);
    void Promise.resolve(result).catch(()=>{}).finally(()=>{if(sent.current===current)sent.current=null;setDraft(held=>held===current?null:held);});
  };
  const cancel=()=>{
    pointer.current?.stop();pointer.current=null;
    if(draftRef.current===null||draftRef.current===sent.current)return;
    setDraft(null);latest.current.onInputEnd?.(false);
  };
  const change=(next:number)=>{setDraft(next);latest.current.onInput?.(next);};
  // A control that goes away mid-gesture ends it where it stands: nothing is recorded.
  useEffect(()=>()=>{pointer.current?.stop();if(draftRef.current!==null&&draftRef.current!==sent.current)latest.current.onInputEnd?.(false);},[]);
  const input=<input type="range" className={className} min={min} max={max} step={step} value={shown} aria-label={label} aria-valuetext={format(shown)} title={title}
    disabled={disabled||undefined} aria-disabled={busy||undefined}
    onChange={event=>{
      // A change that begins while busy is refused (the controlled value puts the thumb back); one under way carries on.
      if(latest.current.busy&&draftRef.current===null)return;
      change(Number(event.target.value));
    }}
    onPointerDown={event=>{
      const target=event.currentTarget,rect=target.getBoundingClientRect(),now=latest.current;
      // Without a measurable box (or for touch and pen) the native range does the dragging and `onChange` follows it.
      if(event.pointerType!=='mouse'||event.button!==0||!rect.width||now.disabled||now.busy)return;
      event.preventDefault();target.focus({preventScroll:true});
      // The thumb's width decides how far it travels; a stylesheet that restyles it says so in `--mix-thumb` (the default native thumb is 16 px).
      const thumb=parseFloat(getComputedStyle(target).getPropertyValue('--mix-thumb'))||defaultThumb,travel=Math.max(1,rect.width-thumb);
      const range=now.max-now.min,centreOf=(at:number)=>rect.left+thumb/2+(Math.min(now.max,Math.max(now.min,at))-now.min)/range*travel;
      const shownNow=draftRef.current??now.value,offset=event.clientX-centreOf(shownNow);
      // A press on the thumb grabs it where it is, and changes nothing until the pointer moves; a press on the bare track jumps the thumb under the pointer.
      const grab=Math.abs(offset)<=Math.max(thumb/2,thumbGrab)?offset:0;
      const at=(clientX:number)=>snapToStep(now.min+Math.min(1,Math.max(0,(clientX-grab-rect.left-thumb/2)/travel))*range,now.min,now.max,now.step);
      pointer.current?.stop();
      const move=(moved:PointerEvent)=>{
        if(moved.pointerId!==event.pointerId)return;
        if(moved.buttons===0){cancel();return;}
        const next=at(moved.clientX);if(next!==(draftRef.current??latest.current.value))change(next);
      };
      const up=(upped:PointerEvent)=>{if(upped.pointerId!==event.pointerId)return;pointer.current?.stop();pointer.current=null;finish();};
      const lost=(cancelled:PointerEvent)=>{if(cancelled.pointerId===event.pointerId)cancel();};
      // A press somewhere else while this one is held, and the window losing focus, end it without a record, as they do for Knob and Fader.
      const elsewhere=(pressed:PointerEvent)=>{if(pressed.target instanceof Node&&!target.contains(pressed.target))cancel();};
      const blurred=()=>cancel();
      window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',lost,true);window.addEventListener('pointerdown',elsewhere,true);window.addEventListener('blur',blurred);
      pointer.current={id:event.pointerId,stop:()=>{window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',lost,true);window.removeEventListener('pointerdown',elsewhere,true);window.removeEventListener('blur',blurred);}};
      if(!grab){const first=at(event.clientX);if(first!==(draftRef.current??now.value))change(first);}
    }}
    onPointerUp={()=>{if(!pointer.current)finish();}}
    // While a mouse drag is under way the pointer decides: a key release must not commit it, and an arrow key must not move the range under it. Escape cancels and is consumed.
    onKeyUp={event=>{if(pointer.current||event.key==='Escape')return;finish();}}
    onKeyDown={event=>{
      if(event.key==='Escape'&&(pointer.current||draftRef.current!==null)){event.preventDefault();event.stopPropagation();cancel();return;}
      if(pointer.current)event.preventDefault();
    }}
    onBlur={()=>{if(!pointer.current)finish();}}/>;
  return visible===undefined?input:<label className="track-channel-range">{visible} <output>{format(shown)}</output>{input}</label>;
}
