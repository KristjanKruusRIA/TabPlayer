import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { busyGuard } from './useBusyGuard';
import './ui.css';

export interface DialogProps {
  title:string;
  /** Called by Escape, the backdrop and the close button. */
  onClose:()=>void;
  children?:ReactNode;
  /** Buttons for the foot, right-aligned; the first control marked `data-autofocus` in the dialog takes focus when it opens, else the first control. */
  actions?:ReactNode;
  className?:string;
  backdropClassName?:string;
  dismissOnBackdrop?:boolean;
  closeDisabled?:boolean;
  closeLabel?:string;
  ariaDescribedBy?:string;
  busy?:boolean;
  onMouseDown?:(event:React.MouseEvent<HTMLDivElement>)=>void;
  onSubmit?:(event:React.FormEvent<HTMLFormElement>)=>void;
  ref?:React.Ref<HTMLDivElement>;
}
// aria-disabled controls stay in the trap: they refuse to act but keep focus.
const focusable='button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[href],[tabindex]:not([tabindex="-1"])';
/** The frame every modal shares: a titled panel over a dimmed backdrop that holds focus, closes on Escape and puts focus back where it was. */
export function Dialog({title,onClose,children,actions,className,backdropClassName,dismissOnBackdrop=false,closeDisabled=false,closeLabel='Close',ariaDescribedBy,busy=false,onMouseDown,onSubmit,ref}:DialogProps) {
  const titleId=useId(),backdrop=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),close=useRef(onClose),locked=useRef(closeDisabled);close.current=onClose;locked.current=closeDisabled;
  useEffect(()=>{
    const before=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const target=panel.current?.querySelector<HTMLElement>('[data-autofocus]')??panel.current?.querySelector<HTMLElement>(focusable);
    (target??panel.current)?.focus({preventScroll:true});

    const inertElements:HTMLElement[]=[];
    let curr:HTMLElement|null=backdrop.current;
    while(curr&&curr!==document.body){
      const parent=curr.parentElement;
      if(parent){
        for(const child of parent.children){
          if(child instanceof HTMLElement&&child!==curr&&!child.contains(curr)&&!child.hasAttribute('inert')){
            child.setAttribute('inert','');
            inertElements.push(child);
          }
        }
      }
      curr=parent;
    }

    const handleKeyDown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){
        if(locked.current)return;
        event.preventDefault();event.stopPropagation();close.current();return;
      }
      if(event.key!=='Tab')return;
      const items=panel.current?[...panel.current.querySelectorAll<HTMLElement>(focusable)]:[];
      if(!items.length){event.preventDefault();return;}
      const first=items[0],last=items[items.length-1];
      const active=document.activeElement;
      if(!panel.current||!panel.current.contains(active)||active===document.body){
        event.preventDefault();
        if(event.shiftKey)last.focus({preventScroll:true});
        else first.focus({preventScroll:true});
        return;
      }
      if(event.shiftKey&&(active===first||active===panel.current)){
        event.preventDefault();last.focus({preventScroll:true});
      }else if(!event.shiftKey&&active===last){
        event.preventDefault();first.focus({preventScroll:true});
      }
    };
    // Only a real loss counts: focus that has moved to another element is left alone.
    let recovery:number|undefined;
    const recoverFocus=()=>{
      recovery=undefined;
      if(!panel.current||panel.current.closest('[inert]'))return;
      if(!document.activeElement||document.activeElement===document.body){
        const target=panel.current.querySelector<HTMLElement>('[data-autofocus]')??panel.current.querySelector<HTMLElement>(focusable);
        (target??panel.current)?.focus({preventScroll:true});
      }
    };
    const handleFocusOut=()=>{if(recovery===undefined)recovery=window.setTimeout(recoverFocus,0);};
    document.addEventListener('keydown',handleKeyDown,true);
    document.addEventListener('focusout',handleFocusOut);

    return()=>{
      for(const el of inertElements)el.removeAttribute('inert');
      document.removeEventListener('keydown',handleKeyDown,true);
      document.removeEventListener('focusout',handleFocusOut);
      if(recovery!==undefined)window.clearTimeout(recovery);
      if(before?.isConnected)before.focus({preventScroll:true});
    };
  },[]);
  return <div ref={backdrop} className={`tp-dialog-backdrop ${backdropClassName??''}`} onMouseDown={event=>{if(dismissOnBackdrop&&!locked.current&&event.target===event.currentTarget)close.current();}}>
    <div ref={node=>{panel.current=node;if(typeof ref==='function')ref(node);else if(ref)(ref as React.MutableRefObject<HTMLDivElement|null>).current=node;}} className={`tp-dialog ${className??''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={ariaDescribedBy} aria-busy={busy||undefined} tabIndex={-1} onMouseDown={onMouseDown}>
      <header className="tp-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" aria-label={closeLabel} {...busyGuard({busy:closeDisabled,className:'tp-dialog-close',onClick:()=>close.current()})}>×</button></header>
      {onSubmit?<form className="tp-dialog-form" onSubmit={onSubmit}>
        <div className="tp-dialog-body">{children}</div>
        {actions&&<footer className="tp-dialog-foot">{actions}</footer>}
      </form>:<>
        <div className="tp-dialog-body">{children}</div>
        {actions&&<footer className="tp-dialog-foot">{actions}</footer>}
      </>}
    </div>
  </div>;
}
