import {useI18n, type MessageKey} from '../i18n';
import {useEffect,useId,useRef,useState} from 'react';
import type {BackingFilter,BackingSettings,EditCommand} from '../edit-types';
import './backing-processing.css';
import {backingProcessingKey,defaultBackingProcessing} from './backing-processing';

type Field='semitones'|'cents';
type Session={field?:Field;value:string;settings:BackingSettings;release:()=>void;pending:boolean;current:boolean};
const limits={semitones:12,cents:100};
const integer=(value:string,field:Field)=>/^[+-]?\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Math.abs(Number(value))<=limits[field]?Number(value):NaN;
const filterKeys: Record<BackingFilter, MessageKey> = {
  none: 'processing.filter_none',
  bassEnhance: 'processing.filter_bass_enhance',
  bassAttenuation: 'processing.filter_bass_attenuation',
  mediumEnhance: 'processing.filter_medium_enhance',
  mediumAttenuation: 'processing.filter_medium_attenuation',
  highEnhance: 'processing.filter_high_enhance',
  highAttenuation: 'processing.filter_high_attenuation',
};
const filterTypes: BackingFilter[] = ['none','bassEnhance','bassAttenuation','mediumEnhance','mediumAttenuation','highEnhance','highAttenuation'];

export function BackingProcessingControls({settings,busy,visible,beginOperation,onEdit,keyShift=0}:{settings:BackingSettings;busy:boolean;keyShift?:number;visible:boolean;beginOperation:()=>()=>void;onEdit:(edit:EditCommand)=>void|Promise<void>}) {
  const {t,lang}=useI18n();
  const session=useRef<Session|null>(null),mounted=useRef(true),[,refresh]=useState(0),[error,setError]=useState<string|null>(null),guidance=useId(),helper=useId(),invalidGuidance=useId();
  const processing=settings.processing??defaultBackingProcessing(),own=session.current;
  const invalidField=own?.current&&own.field&&!Number.isFinite(integer(own.value,own.field))?own.field:null;
  const redraw=()=>{if(mounted.current)refresh(n=>n+1);};
  const finish=(value:Session)=>{value.release();if(session.current===value)session.current=null;redraw();};
  const cancel=()=>{const value=session.current;if(!value)return;value.current=false;if(!value.pending)finish(value);else redraw();};
  useEffect(()=>{if(!visible||session.current?.settings!==settings){cancel();setError(null);}},[settings,visible]);
  useEffect(()=>{mounted.current=true;const blur=()=>{cancel();setError(null);};window.addEventListener('blur',blur);return()=>{mounted.current=false;window.removeEventListener('blur',blur);cancel();};},[]);
  const start=(field?:Field,value='')=>{const next:Session={field,value,settings,release:beginOperation(),pending:false,current:true};session.current=next;setError(null);redraw();return next;};
  const commit=async(value:Session,backing:BackingSettings)=>{
    if(value.pending||!value.current)return;
    if(backingProcessingKey(backing.processing)===backingProcessingKey(value.settings.processing)){finish(value);return;}
    value.pending=true;redraw();
    try{await onEdit({type:'setBacking',backing});}catch(reason){if(mounted.current&&value.current)setError(String(reason));}finally{finish(value);}
  };
  const update=(field:Field,value:string)=>{
    if(!visible||session.current?.pending||session.current&&session.current.field!==field||!session.current&&busy)return;
    if(!session.current&&value===String(processing[field]))return;
    const current=session.current??start(field,value);current.value=value;redraw();
  };
  const field=(name:Field)=>{
    const active=own?.field===name&&own.current,value=active?own.value:String(processing[name]),number=integer(value,name);
    return <label>{name==='semitones'?t('processing.semitones'):t('processing.cents')}<input type="text" inputMode="numeric" role="spinbutton" value={value} aria-valuemin={-limits[name]} aria-valuemax={limits[name]} aria-valuenow={Number.isFinite(number)?number:undefined} aria-invalid={!Number.isFinite(number)||undefined} aria-describedby={`${guidance} ${helper}${invalidField===name?` ${invalidGuidance}`:''}`} disabled={!visible||(busy||!!own)&&!active} onFocus={e=>e.currentTarget.select()} onChange={e=>update(name,e.target.value)} onBlur={()=>{if(!session.current?.pending)cancel();}} onKeyDown={e=>{
      e.stopPropagation();
      if(e.key==='Escape'){e.preventDefault();if(!session.current?.pending)cancel();}
      else if(e.key==='Enter'){e.preventDefault();const current=session.current;if(current?.field===name&&Number.isFinite(number))void commit(current,{...current.settings,processing:{...(current.settings.processing??defaultBackingProcessing()),[name]:number}});}
      else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();if(Number.isFinite(number))update(name,String(Math.max(-limits[name],Math.min(limits[name],number+(e.key==='ArrowUp'?1:-1)*(e.shiftKey?10:1)))));}
    }}/></label>;
  };
  const disabled=!visible||busy||!!own;
  return <details className="backing-processing" open onToggle={e=>{if(!e.currentTarget.open){cancel();setError(null);}}} onKeyUp={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}><summary>{t('processing.title')}<button disabled={disabled||backingProcessingKey(processing)===backingProcessingKey(null)} onClick={e=>{e.preventDefault();e.stopPropagation();if(disabled)return;const value=start();void commit(value,{...value.settings,processing:null});}}>{t('processing.reset')}</button></summary><fieldset>
    <div className="pair">{field('semitones')}{field('cents')}</div>
    {invalidField&&<p className="muted processing-invalid" id={invalidGuidance}>{t('processing.invalid_range',{field:t(invalidField==='semitones'?'processing.semitones':'processing.cents'),min:-limits[invalidField],max:limits[invalidField]})}</p>}
    <label>{t('processing.filter_label')}<select disabled={disabled} value={processing.filter} onChange={e=>{const filter=e.target.value as BackingFilter;if(disabled||filter===processing.filter)return;const value=start();void commit(value,{...value.settings,processing:{...(value.settings.processing??defaultBackingProcessing()),filter}});}}>{filterTypes.map(f=><option key={f} value={f}>{t(filterKeys[f])}</option>)}</select></label>
    <p className="muted" id={helper}>{t('processing.helper')}</p><p className="muted" id={guidance}>{t('processing.guidance')}</p>{keyShift!==0&&<p className="muted">{t('backing.key_shift_added',{value:new Intl.NumberFormat(lang,{signDisplay:'exceptZero'}).format(keyShift)})}</p>}{error&&<p role="alert">{error}</p>}
  </fieldset></details>;
}
