import { useEffect, useRef, useState } from 'react';
import type React from 'react';

export interface RangeOptions {
  value:number;min:number;max:number;step:number;
  /** The value a double-click returns to; without one, double-click does nothing. */
  defaultValue?:number;disabled?:boolean;
  /** Called once per gesture with the final value: at the end of a drag, on a key press, after the wheel settles, or when a typed value is accepted. */
  onCommit:(value:number)=>void|Promise<unknown>;
  /** Called with each value while a gesture is under way, for readouts that follow it. Never record an edit from here. */
  onInput?:(value:number)=>void;
  /** Called when a gesture that called `onInput` is over: `committed` is true when `onCommit` was called for it, false when it was cancelled or ended where it began. */
  onInputEnd?:(committed:boolean)=>void;
  /** Pointer travel, in pixels, that covers the whole range. */
  travel?:()=>number;
}
const decimals=(step:number)=>{const text=String(step);return text.includes('.')?text.length-text.indexOf('.')-1:0;};
/** `value` held to the range and to whole steps from the minimum. */
export function snapToStep(value:number,min:number,max:number,step:number):number {
  const snapped=min+Math.round((value-min)/step)*step;
  return Math.min(max,Math.max(min,Number(snapped.toFixed(Math.max(decimals(step),decimals(min))))));
}
/** A number read from what the player typed, ignoring units and the typographic minus; null when none is there. */
export function parseTyped(text:string):number|null {
  const cleaned=text.replace(/−/g,'-').replace(',','.').match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i);
  if(!cleaned)return null;const number=Number(cleaned[0]);return Number.isFinite(number)?number:null;
}
const wheelIdleMs=300;

/** The behaviour a Knob and a Fader share. A drag, the wheel or a run of arrow presses change the shown value as they
 * go but report one committed value, so a host records one undo step for the whole gesture. */
export function useRange(options:RangeOptions) {
  const {value,min,max,step,defaultValue,disabled,onCommit,onInput}=options;
  const latest=useRef(options);latest.current=options;
  const [draft,setDraft]=useState<number|null>(null);
  // The committed value stays shown until the host has taken it, so the control does not flash back.
  const [held,setHeld]=useState<{sent:number;from:number}|null>(null);
  const shown=draft??(held&&held.from===value?held.sent:value);
  const shownRef=useRef(shown);shownRef.current=shown;
  const drag=useRef<{y:number;start:number;pointer:number}|null>(null);
  const wheel=useRef<{timer:ReturnType<typeof setTimeout>|null;pending:number|null}>({timer:null,pending:null});
  const lastDraft=useRef<number|null>(null);
  const snap=(candidate:number)=>snapToStep(candidate,min,max,step);

  const commit=(next:number):boolean=>{
    const target=snap(next);setDraft(null);lastDraft.current=null;
    if(target===latest.current.value){setHeld(null);return false;}
    setHeld({sent:target,from:latest.current.value});
    const result=latest.current.onCommit(target);
    if(result&&typeof (result as Promise<unknown>).then==='function')void Promise.resolve(result).then(()=>setHeld(null),()=>setHeld(null));
    else setHeld(null);
    return true;
  };
  /** Ends a gesture: commits `next`, or just reports the end when there is nothing to record. */
  const finish=(next:number)=>{const sent=commit(next);latest.current.onInputEnd?.(sent);};
  const cancelGesture=()=>{drag.current=null;lastDraft.current=null;setDraft(null);const state=wheel.current;if(state.timer)clearTimeout(state.timer);state.timer=null;state.pending=null;latest.current.onInput?.(latest.current.value);latest.current.onInputEnd?.(false);};
  const flushWheel=()=>{const state=wheel.current;if(state.timer)clearTimeout(state.timer);state.timer=null;if(state.pending!==null){const pending=state.pending;state.pending=null;finish(pending);}};
  useEffect(()=>()=>{const state=wheel.current;if(state.timer)clearTimeout(state.timer);},[]);

  const preview=(next:number)=>{const target=snap(next);lastDraft.current=target;setDraft(target);latest.current.onInput?.(target);return target;};
  const handlers={
    /** `from` starts the gesture at a value other than the shown one, as a click on a fader's track does. */
    onPointerDown(event:React.PointerEvent<HTMLElement>,from?:number){
      if(disabled||event.button!==0)return;
      flushWheel();
      drag.current={y:event.clientY,start:from===undefined?shownRef.current:snap(from),pointer:event.pointerId};
      if(from!==undefined)preview(from);
      try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{ /* A pointer that has already gone cannot be captured. */ }
      event.currentTarget.focus({preventScroll:true});event.preventDefault();
    },
    onPointerMove(event:React.PointerEvent<HTMLElement>){
      const state=drag.current;if(!state||state.pointer!==event.pointerId)return;
      const travel=Math.max(40,options.travel?.()??160),fine=event.shiftKey?.2:1;
      preview(state.start+(state.y-event.clientY)/travel*(max-min)*fine);
    },
    onPointerUp(event:React.PointerEvent<HTMLElement>){
      const state=drag.current;if(!state||state.pointer!==event.pointerId)return;
      drag.current=null;try{event.currentTarget.releasePointerCapture?.(event.pointerId);}catch{ /* Already released. */ }
      finish(lastDraft.current??shownRef.current);
    },
    onPointerCancel(event:React.PointerEvent<HTMLElement>){
      if(drag.current?.pointer!==event.pointerId)return;cancelGesture();
    },
    onDoubleClick(){if(disabled||defaultValue===undefined)return;flushWheel();commit(defaultValue);},
    /** Arrow keys step, Page keys take ten steps, Home and End go to the ends. Returns whether the key was used. */
    key(event:React.KeyboardEvent):boolean{
      // Escape during a drag or a wheel run puts the control back and ends the gesture without recording it.
      if(event.key==='Escape'&&(drag.current||wheel.current.pending!==null)){event.preventDefault();cancelGesture();return true;}
      if(disabled||event.altKey||event.ctrlKey||event.metaKey)return false;
      const big=event.shiftKey?10:1;let next:number;
      switch(event.key){
        case 'ArrowUp':case 'ArrowRight':next=shownRef.current+step*big;break;
        case 'ArrowDown':case 'ArrowLeft':next=shownRef.current-step*big;break;
        case 'PageUp':next=shownRef.current+step*10;break;
        case 'PageDown':next=shownRef.current-step*10;break;
        case 'Home':next=min;break;case 'End':next=max;break;
        default:return false;
      }
      event.preventDefault();flushWheel();
      const target=snap(next);if(target!==shownRef.current)commit(target);
      return true;
    },
  };
  /** Attaches the wheel to `element`, which must be focused to be turned, so scrolling past a control never changes it. */
  const wheelRef=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const element=wheelRef.current;if(!element)return;
    const onWheel=(event:WheelEvent)=>{
      if(latest.current.disabled||document.activeElement!==element||!event.deltaY)return;
      event.preventDefault();
      const state=wheel.current,base=state.pending??shownRef.current,direction=event.deltaY<0?1:-1;
      state.pending=preview(base+direction*latest.current.step);
      if(state.timer)clearTimeout(state.timer);state.timer=setTimeout(flushWheel,wheelIdleMs);
    };
    element.addEventListener('wheel',onWheel,{passive:false});return()=>element.removeEventListener('wheel',onWheel);
  // The handlers read everything through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  return {shown,dragging:draft!==null,handlers,wheelRef,commit,flushWheel,snap};
}
