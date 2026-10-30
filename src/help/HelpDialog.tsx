import { useId,useState } from 'react';
import { helpTopics,updateStatus,type HelpTopicId } from './help-topics';
import { Dialog } from '../ui/Dialog';

/** The help viewer: a topic list and the chosen topic, opened on the topic for what had focus. */
export function HelpDialog({initial,onClose}:{initial:HelpTopicId;onClose:()=>void}) {
  const [topic,setTopic]=useState<HelpTopicId>(initial),[checked,setChecked]=useState<string|null>(null);
  const list=useId(),title=useId();
  const current=helpTopics.find(entry=>entry.id===topic)!;
  return <Dialog title="TabPlayer help" onClose={onClose} className="help-dialog">
    <div className="help-layout">
      <nav aria-labelledby={list}><h3 id={list}>Topics</h3><ul>{helpTopics.map(entry=><li key={entry.id}>
        <button type="button" data-autofocus={entry.id===topic||undefined} aria-current={entry.id===topic?'true':undefined} onClick={()=>{setTopic(entry.id);setChecked(null);}}>{entry.title}</button>
      </li>)}</ul></nav>
      <article aria-labelledby={title}>
        <h3 id={title}>{current.title}</h3>
        {current.paragraphs.map(text=><p key={text}>{text}</p>)}
        {topic==='about'&&<><button type="button" onClick={()=>setChecked(updateStatus())}>Check for updates</button>
          <p role="status">{checked??''}</p></>}
      </article>
    </div>
  </Dialog>;
}
