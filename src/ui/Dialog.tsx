import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import './ui.css';

export interface DialogProps {
  title:string;
  /** Called by Escape, the backdrop and the close button. */
  onClose:()=>void;
  children?:ReactNode;
  /** Buttons for the foot, right-aligned; the first control marked `data-autofocus` in the dialog takes focus when it opens, else the first control. */
  actions?:ReactNode;
  className?:string;
}
const focusable='button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href],[tabindex]:not([tabindex="-1"])';
/** The frame every modal shares: a titled panel over a dimmed backdrop that holds focus, closes on Escape and puts focus back where it was. */
export function Dialog({title,onClose,children,actions,className}:DialogProps) {
  const titleId=useId(),panel=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const before=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const target=panel.current?.querySelector<HTMLElement>('[data-autofocus]')??panel.current?.querySelector<HTMLElement>(focusable);
    (target??panel.current)?.focus();
    return()=>{if(before?.isConnected)before.focus();};
  },[]);
  return <div className="tp-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close.current();}}>
    <div ref={panel} className={`tp-dialog ${className??''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();return;}
        if(event.key!=='Tab')return;
        const items=[...panel.current!.querySelectorAll<HTMLElement>(focusable)];if(!items.length){event.preventDefault();return;}
        const first=items[0],last=items[items.length-1];
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }}>
      <header className="tp-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="tp-dialog-close" aria-label="Close" onClick={onClose}>×</button></header>
      <div className="tp-dialog-body">{children}</div>
      {actions&&<footer className="tp-dialog-foot">{actions}</footer>}
    </div>
  </div>;
}
