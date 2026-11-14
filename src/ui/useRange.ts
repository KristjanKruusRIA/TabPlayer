import { useEffect, useRef, useState } from 'react';
import type React from 'react';

export interface RangeOptions {
  value:number;min:number;max:number;step:number;
  /** The value a double-click returns to; without one, double-click does nothing. */
  defaultValue?:number;disabled?:boolean;
  /** The app is busy: a gesture cannot begin (press, key, wheel, double-click), but one already under way is never cancelled, so a drag is not lost to work that starts during it. Unlike `disabled`, it leaves the control focusable. */
  busy?:boolean;
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

/** Typed entry for a control's readout: it opens with its text selected once, takes Enter or a click away as an accepted
 * value and Escape as none. Shared by Knob and Fader so they take typed values the same way. */
export function useTypedValue({text,commit,done}:{text:()=>string;commit:(value:number)=>void;done:()=>void}) {
  const [editing,setEditing]=useState(false),[typed,setTyped]=useState(''),input=useRef<HTMLInputElement>(null),closing=useRef(false);
  // Selected when it opens, not on every render: typing replaces the selection once and then adds to what is typed.
  useEffect(()=>{if(editing){input.current?.focus();input.current?.select();}},[editing]);
  const begin=()=>{closing.current=false;setTyped(text());setEditing(true);};
  const finish=(accept:boolean,returnFocus=true)=>{
    if(closing.current)return;closing.current=true;setEditing(false);
    const number=accept?parseTyped(typed):null;if(number!==null)commit(number);
    if(returnFocus)done();
  };
  return {editing,typed,setTyped,begin,finish,input};
}

/** The behaviour a Knob and a Fader share. A drag, or a run of wheel ticks, changes the shown value as it goes but reports one
 * committed value, so a host records one undo step for the whole gesture; each arrow press is its own change.
 *
 * A pointer gesture ends without an edit whenever it loses its pointer: pointer capture lost before the button came up, the
 * control or the window losing focus, a mouse move with no button held, Escape, or the control going away (as when the host
 * shows another track or block). Only a release with the pointer still held commits. A release that never moved the value
 * records nothing, even where the stored value is off the control's steps. */
export function useRange(options:RangeOptions) {
  const {value,min,max,step,defaultValue,disabled,busy=false}=options;
  const refusing=disabled||busy;
  const latest=useRef(options);latest.current=options;
  const [draft,setDraft]=useState<number|null>(null);
  // The committed value stays shown until the host has taken it, so the control does not flash back.
  const [held,setHeld]=useState<{sent:number;from:number}|null>(null);
  const shown=draft??(held&&held.from===value?held.sent:value);
  const shownRef=useRef(shown);shownRef.current=shown;
  const drag=useRef<{y:number;start:number;pointer:number;element:HTMLElement;stop:()=>void}|null>(null);
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
  const finish=(next:number|null)=>{const sent=next===null?false:commit(next);if(next===null){setDraft(null);lastDraft.current=null;}latest.current.onInputEnd?.(sent);};
  const clearWheel=()=>{const state=wheel.current;if(state.timer)clearTimeout(state.timer);state.timer=null;state.pending=null;};
  /** Puts the control back and ends the gesture without recording it. */
  const cancelGesture=()=>{drag.current?.stop();drag.current=null;lastDraft.current=null;setDraft(null);clearWheel();latest.current.onInputEnd?.(false);};
  const active=()=>drag.current!==null||wheel.current.pending!==null;
  const flushWheel=()=>{const state=wheel.current;if(state.timer)clearTimeout(state.timer);state.timer=null;if(state.pending!==null){const pending=state.pending;state.pending=null;finish(pending);}};
  const preview=(next:number)=>{const target=snap(next);lastDraft.current=target;setDraft(target);latest.current.onInput?.(target);return target;};
  // Everything that reads props runs through the latest render's functions, so a control reused for another field is never stale.
  type Moving={pointerId:number;clientY:number;buttons:number;pointerType:string;shiftKey:boolean};
  const move=(event:Moving)=>{
    const state=drag.current;if(!state||state.pointer!==event.pointerId)return;
    // The control it began on is gone (a block change replaced it): the gesture ends where it stands, recording nothing.
    if(!state.element.isConnected){cancelGesture();return;}
    if(latest.current.disabled){cancelGesture();return;}
    // A mouse move with no button held means the release happened where this control could not see it.
    if(event.pointerType==='mouse'&&event.buttons===0){cancelGesture();return;}
    const travel=Math.max(40,latest.current.travel?.()??160),fine=event.shiftKey?.2:1;
    preview(state.start+(state.y-event.clientY)/travel*(latest.current.max-latest.current.min)*fine);
  };
  const up=(event:{pointerId:number})=>{
    const state=drag.current;if(!state||state.pointer!==event.pointerId)return;
    if(!state.element.isConnected){cancelGesture();return;}
    state.stop();drag.current=null;try{state.element.releasePointerCapture?.(event.pointerId);}catch{ /* Already released. */ }
    if(latest.current.disabled){lastDraft.current=null;setDraft(null);latest.current.onInputEnd?.(false);return;}
    // Only a gesture that moved the value records; a press and release in place does not.
    finish(lastDraft.current);
  };
  const api=useRef({preview,flushWheel,cancelGesture,active,move,up});api.current={preview,flushWheel,cancelGesture,active,move,up};

  useEffect(()=>{
    // The window losing focus ends a gesture, and so does the control going away: nothing is recorded for either.
    const lost=()=>{if(api.current.active())api.current.cancelGesture();};
    window.addEventListener('blur',lost);
    return()=>{window.removeEventListener('blur',lost);lost();drag.current?.stop();const state=wheel.current;if(state.timer)clearTimeout(state.timer);};
  },[]);

  // The same control shown for another field (its range changed under the pointer) ends its gesture too: the release must not record onto the new field.
  useEffect(()=>{if(api.current.active())api.current.cancelGesture();},[min,max,step]);

  // A control that becomes unavailable (as when the host turns busy) ends its gesture where it stands: the value goes back and nothing is recorded.
  useEffect(()=>{if(disabled&&api.current.active())api.current.cancelGesture();},[disabled]);

  const handlers={
    /** `from` starts the gesture at a value other than the shown one, as a click on a fader's track does. */
    onPointerDown(event:React.PointerEvent<HTMLElement>,from?:number){
      if(refusing||event.button!==0)return;
      flushWheel();
      // The pointer is also followed on the window: pointer capture can be dropped without a word (it is, for mouse events the webview
      // is given from outside), and a drag must still follow the pointer and end at its release, not hang waiting for events the control never gets.
      const onWindowMove=(moved:PointerEvent)=>api.current.move(moved),onWindowUp=(upped:PointerEvent)=>api.current.up(upped),onWindowCancel=(cancelled:PointerEvent)=>{if(drag.current?.pointer===cancelled.pointerId)api.current.cancelGesture();};
      // A press somewhere else while this one is held (another button, or a press the control never saw released) ends it without a record.
      const onWindowDown=(pressed:PointerEvent)=>{if(drag.current&&pressed.target instanceof Node&&!drag.current.element.contains(pressed.target))api.current.cancelGesture();};
      window.addEventListener('pointermove',onWindowMove,true);window.addEventListener('pointerup',onWindowUp,true);window.addEventListener('pointercancel',onWindowCancel,true);window.addEventListener('pointerdown',onWindowDown,true);
      const stop=()=>{window.removeEventListener('pointermove',onWindowMove,true);window.removeEventListener('pointerup',onWindowUp,true);window.removeEventListener('pointercancel',onWindowCancel,true);window.removeEventListener('pointerdown',onWindowDown,true);};
      drag.current?.stop();
      drag.current={y:event.clientY,start:from===undefined?shownRef.current:snap(from),pointer:event.pointerId,element:event.currentTarget,stop};
      if(from!==undefined)preview(from);
      try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{ /* A pointer that has already gone cannot be captured. */ }
      event.currentTarget.focus({preventScroll:true});event.preventDefault();
    },
    /** Moves and the release are followed on the window while a gesture is under way (see onPointerDown), so these two only keep the controls' wiring. */
    onPointerMove(_event:React.PointerEvent<HTMLElement>){},
    onPointerUp(_event:React.PointerEvent<HTMLElement>){},
    onPointerCancel(event:React.PointerEvent<HTMLElement>){
      if(drag.current?.pointer!==event.pointerId)return;cancelGesture();
    },
    /** Capture is released after the button comes up; capture lost earlier ends nothing (see onPointerDown). */
    onLostPointerCapture(){ /* Not an end: capture can be dropped while the button is still down; the window carries on following the pointer (see onPointerDown). */ },
    /** The control losing focus ends a drag in progress, and settles a wheel run. */
    onBlur(){if(drag.current)cancelGesture();else flushWheel();},
    onDoubleClick(){if(refusing||defaultValue===undefined)return;flushWheel();commit(defaultValue);},
    /** Arrow keys step, Page keys take ten steps, Home and End go to the ends. Returns whether the key was used. */
    key(event:React.KeyboardEvent):boolean{
      // Escape during a drag or a wheel run puts the control back and ends the gesture without recording it.
      if(event.key==='Escape'&&active()){event.preventDefault();cancelGesture();return true;}
      if(refusing||event.altKey||event.ctrlKey||event.metaKey)return false;
      const big=event.shiftKey?10:1;let next:number;
      switch(event.key){
        case 'ArrowUp':case 'ArrowRight':next=shownRef.current+step*big;break;
        case 'ArrowDown':case 'ArrowLeft':next=shownRef.current-step*big;break;
        case 'PageUp':next=shownRef.current+step*10;break;
        case 'PageDown':next=shownRef.current-step*10;break;
        case 'Home':next=min;break;case 'End':next=max;break;
        default:return false;
      }
      event.preventDefault();
      // While a drag is held the pointer decides; a key then would be a second edit for the one gesture.
      if(drag.current)return true;
      flushWheel();
      const target=snap(next);if(target!==shownRef.current)commit(target);
      return true;
    },
  };
  /** Attaches the wheel to `element`, which must be focused to be turned, so scrolling past a control never changes it. */
  const wheelRef=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const element=wheelRef.current;if(!element)return;
    const onWheel=(event:WheelEvent)=>{
      const now=latest.current;
      if(now.disabled||now.busy||document.activeElement!==element||!event.deltaY||drag.current)return;
      event.preventDefault();
      const state=wheel.current,base=state.pending??shownRef.current,direction=event.deltaY<0?1:-1;
      state.pending=api.current.preview(base+direction*now.step);
      if(state.timer)clearTimeout(state.timer);state.timer=setTimeout(()=>api.current.flushWheel(),wheelIdleMs);
    };
    element.addEventListener('wheel',onWheel,{passive:false});return()=>element.removeEventListener('wheel',onWheel);
  },[]);
  return {shown,dragging:draft!==null,handlers,wheelRef,commit,flushWheel,snap,refusing};
}
