import { useRef, useState } from 'react';
import { parseTyped, useRange } from './useRange';
import './ui.css';

export interface ControlProps {
  /** The visible name; the accessible name too unless `ariaLabel` gives a fuller one. */
  label:string;ariaLabel?:string;
  value:number;min:number;max:number;step:number;defaultValue?:number;
  /** Appended to the readout and to the spoken value, such as ` dB`. */
  unit?:string;format?:(value:number)=>string;disabled?:boolean;
  /** Receives the final value of a gesture; one call is one undoable change. */
  onCommit:(value:number)=>void|Promise<unknown>;
  /** Follows a gesture as it goes, for display only. */
  onInput?:(value:number)=>void;
}
export interface KnobProps extends ControlProps {
  /** `amp` is the dark knob on a tungsten faceplate; `pedal` the pale one on a dark face. */
  tone?:'pedal'|'amp';
  /** Draws the value arc from the middle of the range, for controls that are flat at the centre. */
  bipolar?:boolean;className?:string;
}
const decimalsOf=(step:number)=>{const text=String(step);return text.includes('.')?text.length-text.indexOf('.')-1:0;};
/** The readout text for `value`: signed when the range crosses zero. */
export function formatValue(value:number,{min,step,unit='',format}:{min:number;step:number;unit?:string;format?:(value:number)=>string}):string {
  const text=format?format(value):`${min<0&&value>0?'+':value<0?'−':''}${Math.abs(value).toFixed(decimalsOf(step))}`;
  return `${text}${unit}`;
}
const sweep=270,start=-135;
const point=(angle:number,radius:number)=>{const radians=(angle-90)*Math.PI/180;return [32+radius*Math.cos(radians),32+radius*Math.sin(radians)] as const;};
const arc=(from:number,to:number,radius:number)=>{
  if(Math.abs(to-from)<.01)return '';
  const [x1,y1]=point(from,radius),[x2,y2]=point(to,radius);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${radius} ${radius} 0 ${Math.abs(to-from)>180?1:0} ${to>from?1:0} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

/** A rotary control drawn in SVG. Drag it vertically, use the arrow keys or the wheel while it has focus, double-click to
 * reset it, or click its readout to type a value. */
export function Knob({label,ariaLabel,value,min,max,step,defaultValue,unit,format,disabled=false,onCommit,onInput,tone='pedal',bipolar=false,className}:KnobProps) {
  const range=useRange({value,min,max,step,defaultValue,disabled,onCommit,onInput});
  const {shown,handlers}=range;
  const dial=useRef<HTMLDivElement>(null),[editing,setEditing]=useState(false),[typed,setTyped]=useState(''),field=useRef<HTMLInputElement>(null),closing=useRef(false);
  const t=(shown-min)/(max-min),angle=start+sweep*t,zero=bipolar?start+sweep*((0-min)/(max-min)):start;
  const text=formatValue(shown,{min,step,unit,format});
  const beginTyping=()=>{if(disabled)return;closing.current=false;setTyped(formatValue(shown,{min,step}));setEditing(true);};
  const finishTyping=(accept:boolean)=>{
    if(closing.current)return;closing.current=true;
    setEditing(false);
    const number=accept?parseTyped(typed):null;
    if(number!==null)range.commit(number);
    dial.current?.focus({preventScroll:true});
  };
  return <div className={`tp-knob ${className??''}`} data-tone={tone} data-disabled={disabled||undefined}>
    <div ref={el=>{dial.current=el;range.wheelRef.current=el;}} className="tp-knob-dial" role="slider" tabIndex={disabled?-1:0} aria-label={ariaLabel??label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={shown} aria-valuetext={text} aria-disabled={disabled||undefined}
      onPointerDown={handlers.onPointerDown} onPointerMove={handlers.onPointerMove} onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel} onDoubleClick={handlers.onDoubleClick} onBlur={range.flushWheel}
      onKeyDown={event=>{if(handlers.key(event)){event.stopPropagation();return;}if(event.key==='Enter'&&!disabled){event.preventDefault();event.stopPropagation();beginTyping();}}}>
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <path className="tp-knob-track" d={arc(start,start+sweep,27)}/>
        <path className="tp-knob-arc" d={arc(zero,angle,27)}/>
        <circle className="tp-knob-body" cx="32" cy="32" r="20"/>
        <circle className="tp-knob-cap" cx="32" cy="32" r="14"/>
        <line className="tp-knob-pointer" x1="32" y1="14.5" x2="32" y2="24" transform={`rotate(${angle} 32 32)`}/>
      </svg>
    </div>
    <span className="tp-knob-label">{label}</span>
    {editing
      ?<input ref={el=>{field.current=el;el?.select();}} className="tp-knob-field" inputMode="decimal" autoFocus aria-label={`${ariaLabel??label} value`} value={typed} onChange={event=>setTyped(event.target.value)} onBlur={()=>finishTyping(true)}
          onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();finishTyping(true);}else if(event.key==='Escape'){event.preventDefault();finishTyping(false);}}}/>
      :<span className="tp-knob-readout" onClick={beginTyping} title={disabled?undefined:'Click to type a value'}>{text}</span>}
  </div>;
}
