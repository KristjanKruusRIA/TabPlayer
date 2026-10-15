import { useEffect,useState } from 'react';
import type { EngravingCommand,PageLayout } from './types';
import { validatePageLayout } from './page';

interface PageLayoutPanelProps {value:PageLayout;busy:boolean;onEdit:(command:Extract<EngravingCommand,{type:'setPageLayout'}>)=>void}
const draftOf=(value:PageLayout)=>({widthMm:String(value.widthMm),heightMm:String(value.heightMm),top:String(value.marginsMm.top),right:String(value.marginsMm.right),bottom:String(value.marginsMm.bottom),left:String(value.marginsMm.left),scale:String(value.scale*100),profile:value.profile});
const number=(value:string)=>value.trim()?Number(value):NaN;
const presets=[['A3',297,420],['A4',210,297],['A5',148,210],['Letter',215.9,279.4],['Legal',215.9,355.6]] as const;

export function PageLayoutPanel({value,busy,onEdit}:PageLayoutPanelProps) {
  const [draft,setDraft]=useState(()=>draftOf(value)),[error,setError]=useState('');
  const appliedKey=JSON.stringify([value.widthMm,value.heightMm,value.marginsMm.top,value.marginsMm.right,value.marginsMm.bottom,value.marginsMm.left,value.scale,value.profile]);
  useEffect(()=>{setDraft(draftOf(value));setError('');},[appliedKey]);
  const apply=()=>{
    if(busy)return;
    const layout:PageLayout={widthMm:number(draft.widthMm),heightMm:number(draft.heightMm),marginsMm:{top:number(draft.top),right:number(draft.right),bottom:number(draft.bottom),left:number(draft.left)},scale:number(draft.scale)/100,profile:draft.profile};
    try{validatePageLayout(layout);setError('');onEdit({type:'setPageLayout',layout});}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  };
  return <details><summary>Page layout</summary><fieldset disabled={busy}>
    <div className="actions">{presets.map(([name,width,height])=><button type="button" key={name} onClick={()=>setDraft({...draft,widthMm:String(width),heightMm:String(height)})}>{name}</button>)}</div>
    <div className="pair">
      <label>Width (mm)<input type="number" min={20} max={1000} step="any" value={draft.widthMm} onChange={e=>setDraft({...draft,widthMm:e.target.value})}/></label>
      <label>Height (mm)<input type="number" min={20} max={1000} step="any" value={draft.heightMm} onChange={e=>setDraft({...draft,heightMm:e.target.value})}/></label>
    </div>
    <button type="button" onClick={()=>setDraft({...draft,widthMm:draft.heightMm,heightMm:draft.widthMm})}>Swap orientation</button>
    <fieldset><legend>Margins</legend>{([['top','right'],['bottom','left']] as const).map((sides,index)=><div className="pair" key={index}>{sides.map(side=><label key={side}>{side[0].toUpperCase()+side.slice(1)} margin (mm)<input type="number" min={0} step="any" value={draft[side]} onChange={e=>setDraft({...draft,[side]:e.target.value})}/></label>)}</div>)}</fieldset>
    <label>Scale (%)<input type="number" min={25} max={300} step="any" value={draft.scale} onChange={e=>setDraft({...draft,scale:e.target.value})}/></label>
    <label>PDF notation<select value={draft.profile} onChange={e=>setDraft({...draft,profile:e.target.value as PageLayout['profile']})}>
      <option value="document">Document notation</option><option value="ScoreTab">Score and tab</option><option value="Score">Score</option><option value="Tab">Tab</option>
    </select></label>
    <button type="button" onClick={apply}>Apply page layout</button>
    {error&&<p role="alert">{error}</p>}
  </fieldset></details>;
}
