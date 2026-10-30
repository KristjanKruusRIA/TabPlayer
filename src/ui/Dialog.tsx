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
const focusable='button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href],[tabindex]:not([tabindex="-1"])';
/** The frame every modal shares: a titled panel over a dimmed backdrop that holds focus, closes on Escape and puts focus back where it was. */
export function Dialog({title,onClose,children,actions,className,backdropClassName,dismissOnBackdrop=false,closeDisabled=false,closeLabel='Close',ariaDescribedBy,busy=false,onMouseDown,onSubmit,ref}:DialogProps) {
  const titleId=useId(),backdrop=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
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
        if(closeDisabled)return;
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
    const recoverFocus=()=>{
      if(!panel.current)return;
      if(document.activeElement===document.body||(document.activeElement&&!panel.current.contains(document.activeElement))){
        const target=panel.current.querySelector<HTMLElement>('[data-autofocus]')??panel.current.querySelector<HTMLElement>(focusable);
        (target??panel.current)?.focus({preventScroll:true});
      }
    };
    const handleFocusOut=()=>{queueMicrotask(recoverFocus);};
    document.addEventListener('keydown',handleKeyDown,true);
    document.addEventListener('focusout',handleFocusOut);

    return()=>{
      for(const el of inertElements)el.removeAttribute('inert');
      document.removeEventListener('keydown',handleKeyDown,true);
      document.removeEventListener('focusout',handleFocusOut);
      if(before?.isConnected)before.focus({preventScroll:true});
    };
  },[closeDisabled]);
  return <div ref={backdrop} className={`tp-dialog-backdrop ${backdropClassName??''}`} onMouseDown={event=>{if(dismissOnBackdrop&&event.target===event.currentTarget)close.current();}}>
    <div ref={node=>{panel.current=node;if(typeof ref==='function')ref(node);else if(ref)(ref as React.MutableRefObject<HTMLDivElement|null>).current=node;}} className={`tp-dialog ${className??''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={ariaDescribedBy} aria-busy={busy||undefined} tabIndex={-1} onMouseDown={onMouseDown}>
      <header className="tp-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="tp-dialog-close" aria-label={closeLabel} disabled={closeDisabled} onClick={onClose}>×</button></header>
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
