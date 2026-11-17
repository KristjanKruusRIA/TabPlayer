import { useEffect,useId,useState } from 'react';
import type { EngravingCommand,PageLayout } from './types';
import { validatePageLayout } from './page';
import { defaultHeaderFooter,scoreFieldNames,type HeaderFooter } from './header-footer';
import { Segmented,busyGuard,busyRegion } from '../ui';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';

interface PageLayoutPanelProps {value:PageLayout;busy:boolean;onEdit:(command:Extract<EngravingCommand,{type:'setPageLayout'}>)=>void}
const draftOf=(value:PageLayout)=>({widthMm:String(value.widthMm),heightMm:String(value.heightMm),top:String(value.marginsMm.top),right:String(value.marginsMm.right),bottom:String(value.marginsMm.bottom),left:String(value.marginsMm.left),scale:String(value.scale*100),profile:value.profile,headerFooter:structuredClone(value.headerFooter??defaultHeaderFooter())});
const number=(value:string)=>value.trim()?Number(value):NaN;
const presets=[['A3',297,420],['A4',210,297],['A5',148,210],['Letter',215.9,279.4],['Legal',215.9,355.6]] as const;
const profiles=[{value:'document' as const,key:'page_layout.profile_document' as const},{value:'ScoreTab' as const,key:'export.staves_score_tab' as const},{value:'Score' as const,key:'export.staves_score' as const},{value:'Tab' as const,key:'export.staves_tab' as const}] as const;
const pages=['first','other'] as const,bands=['header','footer'] as const,slots=['left','center','right'] as const;
const bandKeys:Record<typeof pages[number],Record<typeof bands[number],MessageKey>>={first:{header:'page_layout.first_header',footer:'page_layout.first_footer'},other:{header:'page_layout.other_header',footer:'page_layout.other_footer'}};
const slotKeys:Record<typeof slots[number],MessageKey>={left:'page_layout.slot_left',center:'page_layout.slot_center',right:'page_layout.slot_right'};
const marginKeys:Record<'top'|'right'|'bottom'|'left',MessageKey>={top:'page_layout.margin_top',right:'page_layout.margin_right',bottom:'page_layout.margin_bottom',left:'page_layout.margin_left'};
/** The validator words its header and footer errors with these English slot names, so the field that failed is found by them. */
const errorNames:Record<typeof pages[number],string>={first:'first page',other:'other pages'};
const fieldList=[...scoreFieldNames,'PAGE','PAGES'].map(name=>`%${name}%`).join(' ');

export function PageLayoutPanel({value,busy,onEdit}:PageLayoutPanelProps) {
  const { t } = useI18n();
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
  return <details><summary>{t('page_layout.summary')}</summary><fieldset {...busyRegion(busy)}>
    <div className="actions">{presets.map(([name,width,height])=><button type="button" key={name} onClick={()=>setDraft({...draft,widthMm:String(width),heightMm:String(height)})}>{name}</button>)}</div>
    <div className="pair">
      <label>{t('page_layout.width')}<input type="number" min={20} max={1000} step="any" value={draft.widthMm} onChange={e=>setDraft({...draft,widthMm:e.target.value})}/></label>
      <label>{t('page_layout.height')}<input type="number" min={20} max={1000} step="any" value={draft.heightMm} onChange={e=>setDraft({...draft,heightMm:e.target.value})}/></label>
    </div>
    <button type="button" onClick={()=>setDraft({...draft,widthMm:draft.heightMm,heightMm:draft.widthMm})}>{t('page_layout.swap_orientation')}</button>
    <fieldset><legend>{t('page_layout.margins')}</legend>{([['top','right'],['bottom','left']] as const).map((sides,index)=><div className="pair" key={index}>{sides.map(side=><label key={side}>{t(marginKeys[side])}<input type="number" min={0} step="any" value={draft[side]} onChange={e=>setDraft({...draft,[side]:e.target.value})}/></label>)}</div>)}</fieldset>
    <label>{t('page_layout.scale')}<input type="number" min={25} max={300} step="any" value={draft.scale} onChange={e=>setDraft({...draft,scale:e.target.value})}/></label>
    <div className="tp-field"><span className="tp-field-label" aria-hidden="true">{t('page_layout.pdf_notation')}</span><Segmented label={t('page_layout.pdf_notation')} value={draft.profile} disabled={busy} options={profiles.map(({value,key})=>({value,label:t(key)}))} onChange={profile=>setDraft({...draft,profile})}/></div>
    <fieldset><legend>{t('page_layout.header_footer')}</legend>
      <p className="muted" id={`${fieldHelp}`}>{t('page_layout.fields',{fields:fieldList})}</p>
      {pages.map(page=>bands.map(band=><fieldset key={`${page}/${band}`}><legend>{t(bandKeys[page][band])}</legend><div className="pair">{slots.map(slot=><label key={slot}>{t(slotKeys[slot])}<input aria-label={t('page_layout.slot_aria',{band:t(bandKeys[page][band]),slot:t(slotKeys[slot]).toLocaleLowerCase()})} aria-describedby={fieldHelp} aria-invalid={error.toLowerCase().startsWith(`${errorNames[page]} ${band} ${slot}:`)||undefined} value={draft.headerFooter[page][band][slot]} onChange={e=>setText(page,band,slot,e.target.value)}/></label>)}</div></fieldset>))}
      <button type="button" onClick={()=>setDraft({...draft,headerFooter:defaultHeaderFooter()})}>{t('page_layout.default_header_footer')}</button>
    </fieldset>
  </fieldset>
    <button type="button" {...busyGuard({busy,onClick:apply})}>{t('page_layout.apply')}</button>
    {error&&<p role="alert">{error}</p>}
  </details>;
}
