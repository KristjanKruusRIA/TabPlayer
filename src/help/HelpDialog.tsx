import { useEffect,useId,useRef,useState,type KeyboardEvent } from 'react';
import { helpTopics,updateStatus,type HelpTopicId } from './help-topics';

/** The help viewer: a topic list and the chosen topic, opened on the topic for what had focus. */
export function HelpDialog({initial,onClose}:{initial:HelpTopicId;onClose:()=>void}) {
  const [topic,setTopic]=useState<HelpTopicId>(initial),[checked,setChecked]=useState<string|null>(null);
  const form=useRef<HTMLDivElement>(null),heading=useId(),list=useId(),title=useId();
  useEffect(()=>{form.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();},[]);
  const current=helpTopics.find(entry=>entry.id===topic)!;
  const trap=(event:KeyboardEvent)=>{
    const items=[...form.current?.querySelectorAll<HTMLElement>('button')??[]];if(!items.length)return;
    const index=items.indexOf(document.activeElement as HTMLElement),next=event.shiftKey?(index<=0?items.length-1:index-1):(index<0||index===items.length-1?0:index+1);
    event.preventDefault();items[next].focus();
  };
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div ref={form} role="dialog" aria-modal="true" aria-labelledby={heading} className="help-dialog"
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}else if(event.key==='Tab')trap(event);}}>
      <header><h2 id={heading}>TabPlayer help</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="help-layout">
        <nav aria-labelledby={list}><h3 id={list}>Topics</h3><ul>{helpTopics.map(entry=><li key={entry.id}>
          <button type="button" aria-current={entry.id===topic?'true':undefined} onClick={()=>{setTopic(entry.id);setChecked(null);}}>{entry.title}</button>
        </li>)}</ul></nav>
        <article aria-labelledby={title}>
          <h3 id={title}>{current.title}</h3>
          {current.paragraphs.map(text=><p key={text}>{text}</p>)}
          {topic==='about'&&<><button type="button" onClick={()=>setChecked(updateStatus())}>Check for updates</button>
            <p role="status">{checked??''}</p></>}
        </article>
      </div>
    </div>
  </div>;
}
