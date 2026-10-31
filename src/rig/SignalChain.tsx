import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { chainOrder } from '../document-settings';
import type { EffectBlock } from '../edit-types';
import { blockNames, parameters } from '../audio/sound-model';
import type { Board, SoundEditing } from '../audio/useSoundEditing';
import { BlockIcon } from './art';
import { blockLook, sameRef } from './blocks';
import type { BlockRef } from './blocks';

const keyOf=(ref:BlockRef)=>`${ref.second?'second':'first'}:${ref.block}`;
interface Entry {ref:BlockRef;board:Board;index:number}
interface Drag {block:EffectBlock;startX:number;dx:number;over:number;moved:boolean;pointer:number}

/** All blocks in the order the signal passes through them, with the second pedalboard after them when it has pedals on.
 * Click chooses a block; Space switches it on or off; the arrow keys move between blocks and Alt with an arrow moves the
 * block along the chain, as does dragging it. */
export function SignalChain({editing,selected,onSelect,disabled}:{editing:SoundEditing;selected:BlockRef;onSelect:(ref:BlockRef)=>void;disabled:boolean}) {
  const { t } = useI18n();
  const {first,second,order,place,fx,movedBlock}=editing;
  const entries:Entry[]=order.map((block,index)=>({ref:{block,second:false},board:first,index}));
  const secondBlocks=second?chainOrder(second.effects).filter(block=>second.effects[block].enabled):[];
  if(second)secondBlocks.forEach((block,index)=>entries.push({ref:{block,second:true},board:second,index}));
  const buttons=useRef(new Map<string,HTMLButtonElement>()),strip=useRef<HTMLDivElement>(null);
  const [rover,setRover]=useState(keyOf(selected));
  const [drag,setDrag]=useState<Drag|null>(null),dragRef=useRef<Drag|null>(null),swallowClick=useRef(false);
  const stop=entries.some(entry=>keyOf(entry.ref)===rover)?rover:keyOf(selected);
  const toggle=(entry:Entry)=>{if(!disabled)fx(entry.board,entry.ref.block,'enabled',!entry.board.effects[entry.ref.block].enabled);};
  const focusAt=(index:number)=>{const entry=entries[Math.max(0,Math.min(entries.length-1,index))];buttons.current.get(keyOf(entry.ref))?.focus();};
  // A moved block's tab loses focus as its element moves; it comes back once the new order shows.
  useEffect(()=>{
    const pending=movedBlock.current;if(!pending||order.join()===pending.from)return;movedBlock.current=null;
    buttons.current.get(keyOf({block:pending.block,second:false}))?.focus();
  });
  // The chosen block stays in view along a scrolling strip.
  const selectedKey=keyOf(selected);
  useEffect(()=>{buttons.current.get(selectedKey)?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[selectedKey]);

  const dropIndex=(clientX:number)=>{
    let over=0;
    order.forEach((block,index)=>{const rect=buttons.current.get(keyOf({block,second:false}))?.getBoundingClientRect();if(rect&&clientX>rect.left+rect.width/2)over=index;});
    return over;
  };
  const down=(event:React.PointerEvent<HTMLButtonElement>,entry:Entry)=>{
    if(disabled||entry.ref.second||event.button!==0)return;
    dragRef.current={block:entry.ref.block,startX:event.clientX,dx:0,over:entry.index,moved:false,pointer:event.pointerId};
  };
  const move=(event:React.PointerEvent<HTMLButtonElement>)=>{
    const state=dragRef.current;if(!state||state.pointer!==event.pointerId)return;
    const dx=event.clientX-state.startX;
    if(!state.moved&&Math.abs(dx)<6)return;
    if(!state.moved){try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{ /* The pointer may already be gone. */ }}
    dragRef.current={...state,dx,moved:true,over:dropIndex(event.clientX)};setDrag(dragRef.current);
  };
  const up=(event:React.PointerEvent<HTMLButtonElement>)=>{
    const state=dragRef.current;if(!state||state.pointer!==event.pointerId)return;
    dragRef.current=null;setDrag(null);
    if(state.moved){swallowClick.current=true;setTimeout(()=>{swallowClick.current=false;});place(state.block,state.over);}
  };
  const cancel=()=>{dragRef.current=null;setDrag(null);};

  const item=(entry:Entry)=>{
    const {ref,board}=entry,{block}=ref,key=keyOf(ref),on=board.effects[block].enabled,look=blockLook[block],name=board.name(blockNames[block]);
    const dragging=drag?.moved&&!ref.second&&drag.block===block,target=drag?.moved&&!ref.second&&drag.over===entry.index&&drag.block!==block;
    return <div key={key} className="rig-chain-item" role="presentation" data-selected={sameRef(ref,selected)||undefined} data-on={on} data-dragging={dragging||undefined} data-drop={target||undefined} style={{'--pedal':look.color,transform:dragging?`translateX(${drag!.dx}px)`:undefined} as React.CSSProperties}>
      <button ref={el=>{if(el)buttons.current.set(key,el);else buttons.current.delete(key);}} type="button" role="tab" className="rig-chain-tab" aria-selected={sameRef(ref,selected)} aria-label={`${name}, ${on?t('rig.enabled'):t('rig.bypassed')}`} tabIndex={key===stop?0:-1}
        onFocus={()=>setRover(key)}
        onClick={()=>{if(swallowClick.current)return;onSelect(ref);}}
        onPointerDown={event=>down(event,entry)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
        onKeyDown={event=>{
          const at=entries.findIndex(candidate=>sameRef(candidate.ref,ref));
          if(event.altKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
            event.preventDefault();event.stopPropagation();
            if(!disabled&&!ref.second)place(block,entry.index+(event.key==='ArrowRight'?1:-1));
          }else if(event.key==='ArrowRight'){event.preventDefault();focusAt(at+1);}
          else if(event.key==='ArrowLeft'){event.preventDefault();focusAt(at-1);}
          else if(event.key==='Home'){event.preventDefault();focusAt(0);}
          else if(event.key==='End'){event.preventDefault();focusAt(entries.length-1);}
          else if(event.key===' '&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();toggle(entry);}
        }}
        onKeyUp={event=>{if(event.key===' ')event.preventDefault();}}>
        <BlockIcon block={block} on={on} knobs={parameters[block].length}/>
        <span className="rig-chain-name" aria-hidden="true"><span className="rig-name-full">{blockNames[block]}</span><span className="rig-name-short">{look.short}</span></span>
      </button>
      {/* The footswitch is a pointer shortcut for Space on the tab and the switch on the stage, so it is left out of the tab order and the accessibility tree. */}
      {(look.kind==='pedal'||look.kind==='eq'||look.kind==='wah')&&<span className="rig-chain-switch" aria-hidden="true" onClick={()=>toggle(entry)}/>}
    </div>;
  };
  const firstEntries=entries.filter(entry=>!entry.ref.second),secondEntries=entries.filter(entry=>entry.ref.second);
  return <div className="rig-chain" ref={strip}>
    <span className="rig-chain-end" aria-hidden="true">{t('rig.chain_in')}</span>
    <div className="rig-chain-track" role="tablist" aria-label={t('rig.signal_chain')} aria-orientation="horizontal">
      <span className="rig-chain-wire" aria-hidden="true"/>
      {firstEntries.map(item)}
      {secondEntries.length>0&&<span className="rig-chain-then" role="presentation" aria-hidden="true">{t('rig.second_board')}</span>}
      {secondEntries.map(item)}
    </div>
    <span className="rig-chain-end" aria-hidden="true">{t('rig.chain_out')}</span>
  </div>;
}
