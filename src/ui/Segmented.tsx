import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import './ui.css';

export interface SegmentedOption<T extends string|number> {value:T;label:ReactNode;/** Spoken name when `label` is not text. */ariaLabel?:string;disabled?:boolean;style?:CSSProperties}
export interface SegmentedProps<T extends string|number> {
  /** Names the group. */
  label:string;value:T;options:readonly SegmentedOption<T>[];onChange:(value:T)=>void;disabled?:boolean;className?:string;
}
/** One choice from two to six, all in view. A radio group: the chosen option is the tab stop, the arrow keys move to the
 * neighbour and choose it, and Home and End go to the ends. */
export function Segmented<T extends string|number>({label,value,options,onChange,disabled=false,className}:SegmentedProps<T>) {
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);
  const usable=(index:number)=>!disabled&&!options[index].disabled;
  const checked=options.findIndex(option=>option.value===value);
  const stop=checked>=0&&usable(checked)?checked:options.findIndex((_,index)=>usable(index));
  const go=(from:number,step:number)=>{
    for(let index=from+step;index>=0&&index<options.length;index+=step)if(usable(index)){buttons.current[index]?.focus();onChange(options[index].value);return;}
  };
  return <div className={`tp-segmented ${className??''}`} role="radiogroup" aria-label={label} aria-disabled={disabled||undefined}>
    {options.map((option,index)=><button key={String(option.value)} className="tp-seg-option" ref={el=>{buttons.current[index]=el;}} type="button" role="radio" aria-checked={option.value===value} aria-label={option.ariaLabel} tabIndex={index===stop?0:-1} disabled={!usable(index)} style={option.style}
      onClick={()=>{if(option.value!==value)onChange(option.value);}}
      onKeyDown={event=>{
        const key=event.key;
        if(key==='ArrowRight'||key==='ArrowDown'){event.preventDefault();event.stopPropagation();go(index,1);}
        else if(key==='ArrowLeft'||key==='ArrowUp'){event.preventDefault();event.stopPropagation();go(index,-1);}
        else if(key==='Home'){event.preventDefault();event.stopPropagation();go(-1,1);}
        else if(key==='End'){event.preventDefault();event.stopPropagation();go(options.length,-1);}
      }}>{option.label}</button>)}
  </div>;
}
