import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { DocumentTab } from './types';
import { useI18n } from '../i18n';

export interface DocumentTabsProps {
  tabs:readonly DocumentTab[];activeId:string;disabled:boolean;
  onActivate:(id:string)=>void;onClose:(id:string)=>void;
}

export function DocumentTabs({tabs,activeId,disabled,onActivate,onClose}:DocumentTabsProps){
  const { t } = useI18n();
  const [focusedId,setFocusedId]=useState(activeId);
  const row=useRef<HTMLDivElement>(null);
  const buttons=useRef(new Map<string,HTMLButtonElement>());
  const previous=useRef({activeId,ids:tabs.map(tab=>tab.id)});
  const focusWithin=useRef(false);
  const focusId=tabs.some(tab=>tab.id===focusedId)?focusedId:activeId;

  useLayoutEffect(()=>{
    const changed=previous.current.activeId!==activeId;
    const removed=previous.current.ids.some(id=>!tabs.some(tab=>tab.id===id));
    if(changed||removed){
      setFocusedId(activeId);
      if(focusWithin.current&&!disabled)buttons.current.get(activeId)?.focus();
    }
    if(changed||removed||previous.current.ids.length===0){
      buttons.current.get(activeId)?.scrollIntoView?.({block:'nearest',inline:'nearest'});
    }
    previous.current={activeId,ids:tabs.map(tab=>tab.id)};
  },[activeId,tabs,disabled]);

  function navigate(event:KeyboardEvent<HTMLButtonElement>,index:number){
    if(disabled)return;
    const next=event.key==='ArrowRight'?(index+1)%tabs.length:
      event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:
      event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
    if(next===null)return;
    event.preventDefault();buttons.current.get(tabs[next].id)?.focus();
  }

  return <div ref={row} className="document-tabs" role="tablist" aria-label={t('workspace.open_scores')} aria-orientation="horizontal" aria-busy={disabled}
    onFocusCapture={()=>{focusWithin.current=true;}}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))focusWithin.current=false;}}>
    {tabs.map((tab,index)=>{
      const title=tab.title.trim()?tab.title:t('workspace.untitled');
      const label=t('workspace.tab_label', { current: index + 1, total: tabs.length, title });
      const id=encodeURIComponent(tab.id),description=`${tab.path??t('workspace.unsaved_score')}${tab.dirty?`; ${t('workspace.unsaved_changes')}`:''}${tab.locked?`; ${t('workspace.finalized')}`:''}`;
      return <div className="document-tab-item" role="presentation" key={tab.id} data-active={tab.id===activeId}>
        <button ref={node=>{if(node)buttons.current.set(tab.id,node);else buttons.current.delete(tab.id);}}
          id={`document-tab-${id}`} role="tab" type="button" aria-label={label}
          aria-selected={tab.id===activeId} aria-controls={`document-panel-${id}`} aria-describedby={`document-description-${id}`}
          tabIndex={focusId===tab.id?0:-1} disabled={disabled} title={tab.path??t('workspace.unsaved_score')}
          onFocus={event=>{setFocusedId(tab.id);event.currentTarget.scrollIntoView?.({block:'nearest',inline:'nearest'});}}
          onKeyDown={event=>navigate(event,index)} onClick={()=>{if(!disabled)onActivate(tab.id);}}>
          <span className="document-tab-title">{title}</span>{tab.locked&&<svg className="document-tab-lock" role="img" aria-label={t('workspace.finalized')} viewBox="0 0 16 16" width="11" height="11"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7h10v7H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>}{tab.dirty&&<span className="document-tab-dirty" aria-hidden="true"/>}
        </button>
        <button className="document-tab-close" type="button" aria-label={t('workspace.close_tab', { label })} disabled={disabled}
          onClick={()=>{if(!disabled)onClose(tab.id);}}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        <span id={`document-description-${id}`} hidden>{description}</span>
      </div>;
    })}
  </div>;
}
