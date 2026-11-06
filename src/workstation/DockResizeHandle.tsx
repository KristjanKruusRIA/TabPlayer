import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n';

const step=16;

/** The bottom dock's top edge: drag it, or use the arrow keys, Home and End, to set the dock's height; double-click or
 * Escape returns it to the automatic height. The height is view state, not an edit. */
export function DockResizeHandle({height,min,max,onHeight,onReset}:{height:number;min:number;max:number;onHeight:(height:number)=>void;onReset:()=>void}) {
  const { t } = useI18n();
  const drag=useRef<{y:number;height:number}|null>(null);
  const clamp=(value:number)=>Math.round(Math.min(max,Math.max(min,value)));
  const down=(event:PointerEvent<HTMLDivElement>)=>{if(event.button!==0)return;event.preventDefault();drag.current={y:event.clientY,height};event.currentTarget.setPointerCapture?.(event.pointerId);};
  const move=(event:PointerEvent<HTMLDivElement>)=>{const start=drag.current;if(start)onHeight(clamp(start.height-(event.clientY-start.y)));};
  const up=(event:PointerEvent<HTMLDivElement>)=>{drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId);};
  const key=(event:KeyboardEvent<HTMLDivElement>)=>{
    const next=event.key==='ArrowUp'?height+step:event.key==='ArrowDown'?height-step:event.key==='Home'?min:event.key==='End'?max:null;
    if(event.key==='Escape'){event.preventDefault();onReset();return;}
    if(next===null)return;
    event.preventDefault();onHeight(clamp(next));
  };
  return <div className="dock-resize" role="separator" aria-orientation="horizontal" tabIndex={0} aria-label={t('dock.resize')} title={t('dock.resize_hint')}
    aria-valuenow={Math.round(height)} aria-valuemin={min} aria-valuemax={max} aria-valuetext={t('dock.height_px',{height:Math.round(height)})}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={onReset} onKeyDown={key}/>;
}
