import { useI18n } from '../i18n';
import { useRef, useState } from 'react';
import { factoryCategories, factorySounds } from '../audio/factory-sounds';
import { presetIds, presetName } from '../audio/sound-model';
import type { TrackSound } from '../edit-types';
import type { SoundEditing } from '../audio/useSoundEditing';
import { Dialog, Segmented, busyGuard } from '../ui';

type Scope='all'|'factory'|'mine';
interface Row {key:string;/** Previewed as `kind:id`. */value:string;name:string;note:string;group:string;apply:()=>void;saved:boolean}

/** Factory sounds by category and the player's own, with a search. Click or Enter applies a row, Space or Hear plays it
 * without recording anything, and Escape cancels a preview. */
export function SoundBrowser({editing}:{editing:SoundEditing}) {
  const { t } = useI18n();
  const {busy,previewer,previewChoice,showingPreview,library,entry,confirming,name,setName}=editing;
  const [query,setQuery]=useState(''),[scope,setScope]=useState<Scope>('all'),[rover,setRover]=useState('');
  const list=useRef<HTMLDivElement>(null),nameField=useRef<HTMLInputElement>(null);
  const applied=(label:string)=>(ok:boolean)=>{if(ok)editing.setStatus(`Applied ${label}.`);};
  const rows:Row[]=[
    ...presetIds.map<Row>(id=>({key:`preset:${id}`,value:`preset:${id}`,name:presetName(id),note:id==='gm'?'No effects':'Preset',group:'Factory presets',saved:false,apply:()=>void editing.applyPreset(id as TrackSound['presetId']).then(applied(presetName(id)))})),
    ...factoryCategories.flatMap(category=>factorySounds.filter(item=>item.category===category).map<Row>(item=>({key:`factory:${item.id}`,value:`factory:${item.id}`,name:item.name,note:item.description,group:category,saved:false,apply:()=>editing.applyFactoryId(item.id)}))),
    ...library.map<Row>(item=>({key:`saved:${item.name}`,value:`saved:${item.name}`,name:item.name,note:'Saved',group:'My sounds',saved:true,apply:()=>{editing.setChosen(item.name);editing.applySaved(item.name);}})),
  ];
  const needle=query.trim().toLocaleLowerCase();
  const shown=rows.filter(row=>(scope==='all'||(scope==='mine')===row.saved)&&(!needle||`${row.name} ${row.note} ${row.group}`.toLocaleLowerCase().includes(needle)));
  const groups=[...new Set(shown.map(row=>row.group))];
  const stop=shown.some(row=>row.key===rover)?rover:shown[0]?.key;
  const mains=()=>[...list.current?.querySelectorAll<HTMLButtonElement>('button[data-row-main]')??[]];
  const hear=(row:Row,origin:HTMLElement)=>editing.choosePreview(showingPreview&&previewChoice===row.value?'':row.value,origin);
  return <aside className="rig-browser" aria-label={t('rig.sound_browser')} onKeyDown={editing.escapePreview}>
    <div className="rig-browser-head">
      <input className="rig-search" type="search" aria-label={t('rig.search_sounds')} placeholder={t('rig.search_sounds')} value={query} onChange={event=>setQuery(event.target.value)}/>
      <Segmented label={t('rig.show_sounds')} value={scope} onChange={setScope} options={[{value:'all',label:t('rig.scope_all')},{value:'factory',label:t('rig.scope_factory')},{value:'mine',label:t('rig.scope_mine')}]}/>
    </div>
    <div className="rig-browser-list" ref={list} onKeyDown={event=>{
      if(event.key!=='ArrowDown'&&event.key!=='ArrowUp'&&event.key!=='Home'&&event.key!=='End')return;
      const buttons=mains(),at=buttons.indexOf(document.activeElement as HTMLButtonElement);if(at<0)return;
      event.preventDefault();
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,at+(event.key==='ArrowDown'?1:-1)))]?.focus();
    }}>
      {shown.length===0&&<p className="rig-note">{rows.every(row=>!row.saved)&&scope==='mine'?t('rig.no_saved_sounds'):t('rig.no_sounds_match')}</p>}
      {groups.map(group=><section key={group} aria-label={group} className="rig-browser-group">
        <h3>{group}</h3>
        <ul>{shown.filter(row=>row.group===group).map(row=><li key={row.key} className="rig-row" data-previewing={showingPreview&&previewChoice===row.value||undefined}>
          <button type="button" data-row-main aria-label={t('rig.apply_sound',{name:row.name})} tabIndex={row.key===stop?0:-1} onFocus={()=>setRover(row.key)} {...busyGuard({busy,className:'rig-row-main',onClick:row.apply,onKeyDown:event=>{if(event.key===' '&&previewer){event.preventDefault();hear(row,event.currentTarget);}},onKeyUp:event=>{if(event.key===' ')event.preventDefault();}})}>

            <span className="rig-row-name">{row.name}</span><span className="rig-row-note">{row.note}</span>
          </button>
          {previewer&&<button type="button" aria-label={t('rig.hear_sound',{name:row.name})} aria-pressed={showingPreview&&previewChoice===row.value} tabIndex={-1} {...busyGuard({busy,className:'rig-hear',onClick:event=>hear(row,event.currentTarget)})}>{t('rig.hear')}</button>}
          {row.saved&&<span className="rig-row-actions">
            <button type="button" aria-label={t('rig.rename_saved_sound_named',{name:row.name})} {...busyGuard({busy,className:'rig-link',onClick:()=>{editing.setChosen(row.name);setName(row.name);nameField.current?.focus();}})}>{t('action.rename')}</button>
            <button type="button" aria-label={t('rig.delete_saved_sound_named',{name:row.name})} {...busyGuard({busy,className:'rig-link',onClick:()=>{editing.setChosen(row.name);editing.setConfirming(true);}})}>{t('action.delete')}</button>
          </span>}
        </li>)}</ul>
      </section>)}
    </div>
    <div className="rig-browser-save">
      <div className="rig-browser-save-row">
        <input className="rig-text" ref={nameField} aria-label={t('rig.saved_sound_name')} placeholder={t('rig.name_this_sound')} value={name} maxLength={60} aria-disabled={busy||undefined} readOnly={busy} onChange={event=>{if(!busy)setName(event.target.value);}}/>
        <button type="button" {...busyGuard({busy,unavailable:!name.trim(),className:'rig-button',onClick:editing.saveNamed})}>{t('rig.save_sound')}</button>
      </div>
      {entry&&<button type="button" {...busyGuard({busy,unavailable:!name.trim(),className:'rig-button',onClick:editing.renameChosen})}>{t('rig.rename_saved_sound')}</button>}
    </div>
    {confirming&&entry&&<Dialog title={`Delete “${entry.name}”?`} onClose={editing.closeConfirm} actions={<><button type="button" data-autofocus onClick={editing.closeConfirm}>Cancel</button><button type="button" className="tp-danger" onClick={editing.deleteChosen}>{t('action.delete')}</button></>}>
      <p>{t('rig.delete_sound_prompt',{name:entry.name})}</p>
    </Dialog>}
  </aside>;
}
