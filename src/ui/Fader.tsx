import { useRef } from 'react';
import { formatValue } from './Knob';
import type { ControlProps } from './Knob';
import { useRange, useTypedValue } from './useRange';
import './ui.css';

export interface FaderProps extends ControlProps {
  /** Marks the middle of the range, for controls that are flat at the centre. */
  bipolar?:boolean;className?:string;
}
const thumb=14;
/** A vertical slider with the same contract as Knob: drag, arrows, the wheel while focused, double-click to reset. */
export function Fader({label,ariaLabel,value,min,max,step,defaultValue,unit,format,disabled=false,onCommit,onInput,onInputEnd,bipolar=false,className}:FaderProps) {
  const track=useRef<HTMLDivElement>(null),thumbEl=useRef<HTMLSpanElement>(null);
  const trackHeight=()=>Math.max(1,(track.current?.getBoundingClientRect().height||120)-thumb);
  const range=useRange({value,min,max,step,defaultValue,disabled,onCommit,onInput,onInputEnd,travel:trackHeight});
  const {shown,handlers}=range;
  const t=(shown-min)/(max-min),text=formatValue(shown,{min,step,unit,format});
  const typing=useTypedValue({text:()=>formatValue(shown,{min,step}),commit:number=>range.commit(number),done:()=>track.current?.focus({preventScroll:true})});
  const down=(event:React.PointerEvent<HTMLDivElement>)=>{
    // A press on the bare track jumps the thumb there and carries on as a drag.
    const rect=track.current?.getBoundingClientRect();
    const onThumb=event.target instanceof Node&&thumbEl.current?.contains(event.target);
    if(!onThumb&&rect&&rect.height>thumb){const fraction=1-(event.clientY-rect.top-thumb/2)/(rect.height-thumb);handlers.onPointerDown(event,min+Math.min(1,Math.max(0,fraction))*(max-min));}
    else handlers.onPointerDown(event);
  };
  return <div className={`tp-fader ${className??''}`} data-disabled={disabled||undefined}>
    {typing.editing
      ?<input ref={typing.input} className="tp-fader-field" inputMode="decimal" aria-label={`${ariaLabel??label} value`} value={typing.typed} onChange={event=>typing.setTyped(event.target.value)} onBlur={()=>typing.finish(true,false)}
          onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();typing.finish(true);}else if(event.key==='Escape'){event.preventDefault();typing.finish(false);}}}/>
      :<span className="tp-fader-readout" onClick={()=>{if(!disabled)typing.begin();}} title={disabled?undefined:'Click to type a value'}>{text}</span>}
    <div ref={el=>{track.current=el;range.wheelRef.current=el;}} className="tp-fader-track" role="slider" aria-orientation="vertical" tabIndex={disabled?-1:0} aria-label={ariaLabel??label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={shown} aria-valuetext={text} aria-disabled={disabled||undefined}
      onPointerDown={down} onPointerMove={handlers.onPointerMove} onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel} onDoubleClick={handlers.onDoubleClick} onLostPointerCapture={handlers.onLostPointerCapture} onBlur={handlers.onBlur}
      onKeyDown={event=>{if(handlers.key(event)){event.stopPropagation();return;}if(event.key==='Enter'&&!disabled){event.preventDefault();event.stopPropagation();typing.begin();}}}>
      <span className="tp-fader-rail" aria-hidden="true"/>
      {bipolar&&<span className="tp-fader-zero" aria-hidden="true" style={{bottom:`calc(${(0-min)/(max-min)} * (100% - ${thumb}px) + ${thumb/2}px)`}}/>}
      <span ref={thumbEl} className="tp-fader-thumb" aria-hidden="true" style={{bottom:`calc(${t} * (100% - ${thumb}px))`}}/>
    </div>
    <span className="tp-fader-label">{label}</span>
  </div>;
}
