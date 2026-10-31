import { useEffect,useId,useState } from 'react';
import type { EngravingCommand,PageLayout } from './types';
import { validatePageLayout } from './page';
import { defaultHeaderFooter,scoreFieldNames,type HeaderFooter } from './header-footer';
import { Segmented,busyGuard,busyRegion } from '../ui';

interface PageLayoutPanelProps {value:PageLayout;busy:boolean;onEdit:(command:Extract<EngravingCommand,{type:'setPageLayout'}>)=>void}
const draftOf=(value:PageLayout)=>({widthMm:String(value.widthMm),heightMm:String(value.heightMm),top:String(value.marginsMm.top),right:String(value.marginsMm.right),bottom:String(value.marginsMm.bottom),left:String(value.marginsMm.left),scale:String(value.scale*100),profile:value.profile,headerFooter:structuredClone(value.headerFooter??defaultHeaderFooter())});
const number=(value:string)=>value.trim()?Number(value):NaN;
const presets=[['A3',297,420],['A4',210,297],['A5',148,210],['Letter',215.9,279.4],['Legal',215.9,355.6]] as const;
const profiles=[{value:'document' as const,label:'Document notation'},{value:'ScoreTab' as const,label:'Score and tab'},{value:'Score' as const,label:'Score'},{value:'Tab' as const,label:'Tab'}] as const;
const pages=[['first','First page'],['other','Other pages']] as const,bands=['header','footer'] as const,slots=['left','center','right'] as const;
const fieldList=[...scoreFieldNames,'PAGE','PAGES'].map(name=>`%${name}%`).join(' ');

export function PageLayoutPanel({value,busy,onEdit}:PageLayoutPanelProps) {
  const [draft,setDraft]=useState(()=>draftOf(value)),[error,setError]=useState(''),fieldHelp=useId();
  const appliedKey=JSON.stringify([value.widthMm,value.heightMm,value.marginsMm.top,value.marginsMm.right,value.marginsMm.bottom,value.marginsMm.left,value.scale,value.profile,value.headerFooter??null]);
  useEffect(()=>{setDraft(draftOf(value));setError('');},[appliedKey]);
  const setText=(page:keyof HeaderFooter,band:typeof bands[number],slot:typeof slots[number],text:string)=>{
    const headerFooter=structuredClone(draft.headerFooter);headerFooter[page][band][slot]=text;setDraft({...draft,headerFooter});
  };
  const apply=()=>{
    if(busy)return;
    const layout:PageLayout={widthMm:number(draft.widthMm),heightMm:number(draft.heightMm),marginsMm:{top:number(draft.top),right:number(draft.right),bottom:number(draft.bottom),left:number(draft.left)},scale:number(draft.scale)/100,profile:draft.profile};
    // The established header and footer stay implicit so unchanged documents keep their saved shape.
    if(JSON.stringify(draft.headerFooter)!==JSON.stringify(defaultHeaderFooter()))layout.headerFooter=structuredClone(draft.headerFooter);
    try{validatePageLayout(layout);setError('');onEdit({type:'setPageLayout',layout});}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  };
  return <details><summary>Page layout</summary><fieldset {...busyRegion(busy)}>
    <div className="actions">{presets.map(([name,width,height])=><button type="button" key={name} onClick={()=>setDraft({...draft,widthMm:String(width),heightMm:String(height)})}>{name}</button>)}</div>
    <div className="pair">
      <label>Width (mm)<input type="number" min={20} max={1000} step="any" value={draft.widthMm} onChange={e=>setDraft({...draft,widthMm:e.target.value})}/></label>
      <label>Height (mm)<input type="number" min={20} max={1000} step="any" value={draft.heightMm} onChange={e=>setDraft({...draft,heightMm:e.target.value})}/></label>
    </div>
    <button type="button" onClick={()=>setDraft({...draft,widthMm:draft.heightMm,heightMm:draft.widthMm})}>Swap orientation</button>
    <fieldset><legend>Margins</legend>{([['top','right'],['bottom','left']] as const).map((sides,index)=><div className="pair" key={index}>{sides.map(side=><label key={side}>{side[0].toUpperCase()+side.slice(1)} margin (mm)<input type="number" min={0} step="any" value={draft[side]} onChange={e=>setDraft({...draft,[side]:e.target.value})}/></label>)}</div>)}</fieldset>
    <label>Scale (%)<input type="number" min={25} max={300} step="any" value={draft.scale} onChange={e=>setDraft({...draft,scale:e.target.value})}/></label>
    <div className="tp-field"><span className="tp-field-label" aria-hidden="true">PDF notation</span><Segmented label="PDF notation" value={draft.profile} disabled={busy} options={profiles} onChange={profile=>setDraft({...draft,profile})}/></div>
    <fieldset><legend>Header and footer</legend>
      <p className="muted" id={`${fieldHelp}`}>Fields: {fieldList}. Use %% for a percent sign.</p>
      {pages.map(([page,pageName])=>bands.map(band=><fieldset key={`${page}/${band}`}><legend>{`${pageName} ${band}`}</legend><div className="pair">{slots.map(slot=><label key={slot}>{slot[0].toUpperCase()+slot.slice(1)}<input aria-label={`${pageName} ${band} ${slot}`} aria-describedby={fieldHelp} aria-invalid={error.startsWith(`${pageName} ${band} ${slot}:`)||undefined} value={draft.headerFooter[page][band][slot]} onChange={e=>setText(page,band,slot,e.target.value)}/></label>)}</div></fieldset>))}
      <button type="button" onClick={()=>setDraft({...draft,headerFooter:defaultHeaderFooter()})}>Default header and footer</button>
    </fieldset>
  </fieldset>
    <button type="button" {...busyGuard({busy,onClick:apply})}>Apply page layout</button>
    {error&&<p role="alert">{error}</p>}
  </details>;
}
