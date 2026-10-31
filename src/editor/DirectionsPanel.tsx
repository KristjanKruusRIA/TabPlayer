import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';

const directions=[
  [0,'Fine'],[1,'Segno'],[2,'Double Segno'],[3,'Coda'],[4,'Double Coda'],
  [5,'D.C.'],[6,'D.C. al Coda'],[7,'D.C. al Double Coda'],[8,'D.C. al Fine'],
  [9,'D.S.'],[10,'D.S. al Coda'],[11,'D.S. al Double Coda'],[12,'D.S. al Fine'],
  [13,'D.S.S.'],[14,'D.S.S. al Coda'],[15,'D.S.S. al Double Coda'],[16,'D.S.S. al Fine'],[17,'To Coda'],[18,'To Double Coda'],
] as const;

export function DirectionsPanel({score,target,busy,onEdit}:{score:model.Score;target:BeatTarget;busy:boolean;onEdit:(edit:EditCommand)=>void}) {
  const { t } = useI18n();
  const master=score.masterBars[target.bar],read=()=>[...master?.directions??[]];
  const [selected,setSelected]=useState<number[]>(read);
  useEffect(()=>{setSelected(read());},[score,master]);
  return <details><summary>{t('editor.directions')}</summary><fieldset disabled={busy||!master}>
    <p className="muted">{t('editor.directions_apply_hint', { bar: target.bar+1 })}</p>
    <div className="technique-grid">{directions.map(([value,label])=><label className="check" key={value}><input type="checkbox" checked={selected.includes(value)} onChange={e=>setSelected(e.target.checked?[...selected,value]:selected.filter(direction=>direction!==value))}/>{label}</label>)}</div>
    <button onClick={()=>onEdit({type:'setDirections',bar:target.bar,directions:[...selected].sort((a,b)=>a-b)})}>{t('editor.apply_directions')}</button>
  </fieldset></details>;
}
