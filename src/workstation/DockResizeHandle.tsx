import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n';

const step=16;

/** A pane edge the user drags, or moves with the arrow keys, Home and End; double-click or Escape returns the pane to its
 * automatic size. The pane grows as the edge moves away from it: up for the bottom dock, left for the right-hand inspector.
 * The size is view state, not an edit. */
export function ResizeHandle({axis,className,size,min,max,onSize,onReset,label,hint,valueText}:{axis:'x'|'y';className:string;size:number;min:number;max:number;onSize:(size:number)=>void;onReset:()=>void;label:string;hint:string;valueText:string}) {
  const drag=useRef<{at:number;size:number}|null>(null);
  const clamp=(value:number)=>Math.round(Math.min(max,Math.max(min,value)));
  const at=(event:PointerEvent<HTMLDivElement>)=>axis==='x'?event.clientX:event.clientY;
  const down=(event:PointerEvent<HTMLDivElement>)=>{if(event.button!==0)return;event.preventDefault();drag.current={at:at(event),size};event.currentTarget.setPointerCapture?.(event.pointerId);};
  const move=(event:PointerEvent<HTMLDivElement>)=>{const start=drag.current;if(start)onSize(clamp(start.size-(at(event)-start.at)));};
  const up=(event:PointerEvent<HTMLDivElement>)=>{drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId);};
  const grow=axis==='x'?'ArrowLeft':'ArrowUp',shrink=axis==='x'?'ArrowRight':'ArrowDown';
  const key=(event:KeyboardEvent<HTMLDivElement>)=>{
    const next=event.key===grow?size+step:event.key===shrink?size-step:event.key==='Home'?min:event.key==='End'?max:null;
    if(event.key==='Escape'){event.preventDefault();onReset();return;}
    if(next===null)return;
    event.preventDefault();onSize(clamp(next));
  };
  // The separator's orientation is the line it draws: the dock's top edge is horizontal, the inspector's side edge vertical.
  return <div className={className} role="separator" aria-orientation={axis==='x'?'vertical':'horizontal'} tabIndex={0} aria-label={label} title={hint}
    aria-valuenow={Math.round(size)} aria-valuemin={min} aria-valuemax={max} aria-valuetext={valueText}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={onReset} onKeyDown={key}/>;
}

/** The bottom dock's top edge. */
export function DockResizeHandle({height,min,max,onHeight,onReset}:{height:number;min:number;max:number;onHeight:(height:number)=>void;onReset:()=>void}) {
  const { t } = useI18n();
  return <ResizeHandle axis="y" className="dock-resize" size={height} min={min} max={max} onSize={onHeight} onReset={onReset}
    label={t('dock.resize')} hint={t('dock.resize_hint')} valueText={t('dock.height_px',{height:Math.round(height)})}/>;
}

/** The inspector's left edge. */
export function InspectorResizeHandle({width,min,max,onWidth,onReset}:{width:number;min:number;max:number;onWidth:(width:number)=>void;onReset:()=>void}) {
  const { t } = useI18n();
  return <ResizeHandle axis="x" className="inspector-resize" size={width} min={min} max={max} onSize={onWidth} onReset={onReset}
    label={t('inspector.resize')} hint={t('inspector.resize_hint')} valueText={t('inspector.width_px',{width:Math.round(width)})}/>;
}
