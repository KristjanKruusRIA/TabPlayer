import { useId, useRef, useState } from 'react';
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
  /** The end of a gesture that called `onInput`; see `useRange`. */
  onInputEnd?:(committed:boolean)=>void;
}
export interface KnobProps extends ControlProps {
  /** `amp` is the dark knob on a tungsten faceplate; `pedal` the pale one on a dark face. */
  tone?:'pedal'|'amp';
  /** Draws the value arc from the middle of the range, for controls that are flat at the centre. */
  bipolar?:boolean;className?:string;
  /** Tick marks around the dial with labels at some of them, for hardware faceplates. `t` runs from 0 at the minimum to 1 at the maximum. */
  scale?:{ticks:number;labels:readonly {t:number;text:string}[]};
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
export function Knob({label,ariaLabel,value,min,max,step,defaultValue,unit,format,disabled=false,onCommit,onInput,onInputEnd,tone='pedal',bipolar=false,className,scale}:KnobProps) {
  const gid=useId().replace(/[^a-zA-Z0-9]/g,'_');
  const range=useRange({value,min,max,step,defaultValue,disabled,onCommit,onInput,onInputEnd});
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
        {tone==='amp'
          ?<>
            <defs>
              <radialGradient id={`${gid}c`} cx=".36" cy=".3" r=".85"><stop offset="0" stopColor="#f6e3b0"/><stop offset=".45" stopColor="#b58638"/><stop offset="1" stopColor="#4d3210"/></radialGradient>
              <radialGradient id={`${gid}b`} cx=".4" cy=".34" r=".9"><stop offset="0" stopColor="#4a3a24"/><stop offset="1" stopColor="#0d0804"/></radialGradient>
              <filter id={`${gid}s`} x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.4" floodColor="#000" floodOpacity=".65"/></filter>
            </defs>
            {scale&&Array.from({length:scale.ticks+1},(_,i)=>{const a=start+sweep*i/scale.ticks,[x1,y1]=point(a,25.5),[x2,y2]=point(a,i%5===0?30.5:28.5);return <line key={i} className="tp-knob-tick" x1={x1} y1={y1} x2={x2} y2={y2}/>;})}
            {scale?.labels.map(label=>{const [x,y]=point(start+sweep*label.t,36.5);return <text key={label.text+label.t} className="tp-knob-num" x={x} y={y} textAnchor="middle" dominantBaseline="central">{label.text}</text>;})}
            <g filter={`url(#${gid}s)`}><circle cx="32" cy="32" r="21" fill={`url(#${gid}b)`} stroke="#050302" strokeWidth="1"/>
              <circle className="tp-knob-knurl" cx="32" cy="32" r="19.6"/>
              <circle cx="32" cy="32" r="15.5" fill={`url(#${gid}c)`} stroke="rgb(0 0 0 / .55)" strokeWidth=".8"/><circle cx="32" cy="32" r="11" fill="none" stroke="rgb(0 0 0 / .22)" strokeWidth=".8"/></g>
            <line className="tp-knob-pointer" x1="32" y1="19" x2="32" y2="27.5" transform={`rotate(${angle} 32 32)`}/>
          </>
          :<>
            <path className="tp-knob-track" d={arc(start,start+sweep,27)}/>
            <path className="tp-knob-arc" d={arc(zero,angle,27)}/>
            <circle className="tp-knob-body" cx="32" cy="32" r="20"/>
            <circle className="tp-knob-cap" cx="32" cy="32" r="14"/>
            <line className="tp-knob-pointer" x1="32" y1="14.5" x2="32" y2="24" transform={`rotate(${angle} 32 32)`}/>
          </>}
      </svg>
    </div>
    <span className="tp-knob-label">{label}</span>
    {editing
      ?<input ref={el=>{field.current=el;el?.select();}} className="tp-knob-field" inputMode="decimal" autoFocus aria-label={`${ariaLabel??label} value`} value={typed} onChange={event=>setTyped(event.target.value)} onBlur={()=>finishTyping(true)}
          onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();finishTyping(true);}else if(event.key==='Escape'){event.preventDefault();finishTyping(false);}}}/>
      :<span className="tp-knob-readout" onClick={beginTyping} title={disabled?undefined:'Click to type a value'}>{text}</span>}
  </div>;
}
