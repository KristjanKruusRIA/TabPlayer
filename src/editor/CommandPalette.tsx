import { useEffect,useId,useMemo,useRef,useState } from 'react';
import { searchCommands,type PaletteAction,type PaletteContext } from './command-palette';
import { FINALIZED_MESSAGE } from '../project';
import { Dialog } from '../ui/Dialog';

/**
 * A searchable action list: type a command and its argument, or an expression such as ff, 3/4 or Am7, choose with
 * the arrow keys and run with Enter. Commands show their keyboard shortcuts.
 */
export function CommandPalette({context,busy,onRun,onClose}:{context:PaletteContext;busy:boolean;onRun:(action:PaletteAction)=>void;onClose:()=>void}) {
  const [query,setQuery]=useState(''),[active,setActive]=useState(0),input=useRef<HTMLInputElement>(null),list=useId();
  const matches=useMemo(()=>searchCommands(query,context).map(match=>context.locked&&match.action&&(match.action.kind==='edit'||match.action.kind==='app'&&(match.action.name==='undo'||match.action.name==='redo'))?{...match,action:undefined,error:FINALIZED_MESSAGE}:match),[query,context]),current=matches[Math.min(active,matches.length-1)];
  useEffect(()=>{if(current)document.getElementById(`${list}-${current.id}`)?.scrollIntoView?.({block:'nearest'});},[current,list]);
  // Closing first returns focus, so a dialog the command opens keeps the focus it takes.
  const run=(index:number)=>{const match=matches[index];if(!match?.action||busy)return;onClose();onRun(match.action);};
  return <Dialog title="Commands" onClose={onClose} className="command-palette" backdropClassName="command-palette-backdrop" onMouseDown={event=>{if(event.target!==input.current){event.preventDefault();input.current?.focus();}}}>
    <div className="command-palette-inner" onKeyDown={event=>{
      if(event.key==='Tab'){event.preventDefault();event.stopPropagation();input.current?.focus();}
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(matches.length)setActive(index=>(Math.min(index,matches.length-1)+(event.key==='ArrowDown'?1:matches.length-1))%matches.length);}
      else if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();run(Math.min(active,matches.length-1));}
    }}>
      <input ref={input} data-autofocus role="combobox" aria-label="Command" aria-expanded={matches.length>0} aria-controls={list} aria-autocomplete="list"
        aria-activedescendant={current?`${list}-${current.id}`:undefined} placeholder="Type a command or expression, such as measure 12, ff, 3/4 or Am7" value={query}
        onChange={event=>{setQuery(event.target.value);setActive(0);}}/>
      <ul id={list} role="listbox" aria-label="Matching commands" hidden={!matches.length}>{matches.map((match,index)=><li key={match.id} id={`${list}-${match.id}`} role="option" aria-keyshortcuts={match.keys?.replace(/Ctrl/g,'Control').replace(/Cmd/g,'Meta')} aria-selected={match===current} aria-disabled={!match.action||busy}
        className={match===current?'active':undefined} onMouseDown={event=>event.preventDefault()} onClick={()=>run(index)}>
        <span>{match.title}</span>{match.error?<span className="muted"> — {match.error}</span>:match.hint&&<span className="muted"> — {match.hint}</span>}{match.keys&&<> <kbd>{match.keys}</kbd></>}
      </li>)}</ul>
      <p role="status" className="muted">{busy?'Wait for the current operation to finish.':matches.length?'':'No command or expression matches. Try measure 12, fret 5, ff, 3/4, Eb major, [Chorus] or Am7.'}</p>
    </div>
  </Dialog>;
}
