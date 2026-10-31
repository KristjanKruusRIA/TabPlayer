import { useI18n } from '../i18n';
import { useEffect,useState } from 'react';
import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { GestureCommand,GesturePatch } from './gestures-types';
import { EnumInput } from './controls';
import { IndexInput } from './IndexInput';
import { sustainPedalAt,type SustainPedal } from './sustain-pedal';

export interface GesturePanelProps {score:model.Score;target:BeatTarget;busy:boolean;onEdit:(command:GestureCommand)=>void}
type Draft=Omit<Required<GesturePatch>,'barre'|'stem'>&{barreFret:number;barreShape:number;stem:NonNullable<GesturePatch['stem']>|'preserve'};
function values(beat:model.Beat|undefined):Draft {
  return {tap:beat?.tap??false,slap:beat?.slap??false,pop:beat?.pop??false,deadSlapped:beat?.deadSlapped??false,slashed:beat?.slashed??false,showTimer:beat?.showTimer??false,golpe:beat?.golpe??0,rasgueado:beat?.rasgueado??0,fade:beat?.fade??0,vibrato:beat?.vibrato??0,beamingMode:beat?.beamingMode??0,wahPedal:beat?.wahPedal??0,barreFret:beat?.barreFret||1,barreShape:beat?.barreShape??0,stem:beat?.invertBeamDirection&&beat.preferredBeamDirection!==null?'preserve':beat?.invertBeamDirection?'inverted':beat?.preferredBeamDirection===0?'up':beat?.preferredBeamDirection===1?'down':'auto'};
}
export function GesturePanel({score,target,busy,onEdit}:GesturePanelProps) {
  const { t } = useI18n();
  const staff=score.tracks[target.track]?.staves[target.staff],beat=staff?.bars[target.bar]?.voices[target.voice]?.beats[target.beat],stringed=!!staff?.tuning.length&&!staff.isPercussion;
  const [draft,setDraft]=useState(()=>values(beat)),[endBar,setEndBar]=useState(target.bar+1),[endBeat,setEndBeat]=useState(target.beat+1),[ottava,setOttava]=useState<number>(beat?.ottava??2),[crescendo,setCrescendo]=useState<number>(beat?.crescendo??0),[targetDynamics,setTargetDynamics]=useState(6),[fermataType,setFermataType]=useState(beat?.fermata?String(beat.fermata.type):'none'),[fermataLength,setFermataLength]=useState(String(beat?.fermata?.length??1));
  useEffect(()=>{setDraft(values(beat));setEndBar(target.bar+1);setEndBeat(target.beat+1);setOttava(beat?.ottava??2);setCrescendo(beat?.crescendo??0);setTargetDynamics(6);setFermataType(beat?.fermata?String(beat.fermata.type):'none');setFermataLength(String(beat?.fermata?.length??1));},[score,beat,target.track,target.staff,target.bar,target.voice,target.beat]);
  const marked=beat?sustainPedalAt(beat):'none',[pedal,setPedal]=useState<SustainPedal>(marked);useEffect(()=>setPedal(marked),[marked,beat]);
  const baseline=values(beat),patch:GesturePatch={};
  for(const key of ['tap','slap','pop','deadSlapped','slashed','showTimer','golpe','rasgueado','fade','vibrato','beamingMode','wahPedal'] as const)if(draft[key]!==baseline[key])Object.assign(patch,{[key]:draft[key]});
  if(draft.stem!==baseline.stem&&draft.stem!=='preserve')patch.stem=draft.stem;
  if(draft.barreShape!==baseline.barreShape||(draft.barreShape!==0&&draft.barreFret!==baseline.barreFret))patch.barre=draft.barreShape?{fret:draft.barreFret,shape:draft.barreShape}:null;
  const update=<K extends keyof Draft>(key:K,value:Draft[K])=>setDraft(old=>({...old,[key]:value}));
  const choice=(label:string,key:'golpe'|'rasgueado'|'fade'|'vibrato'|'beamingMode'|'wahPedal',enumeration:object,guitar=false)=><label>{label}<select value={draft[key]} onChange={e=>update(key,Number(e.target.value))}>{Object.entries(enumeration).filter(([,value])=>typeof value==='number').map(([name,value])=><option key={name} value={value as number} disabled={guitar&&!stringed&&value!==0}>{name.replace(/([a-z])([A-Z])/g,'$1 $2')}</option>)}</select></label>;
  const end={...target,bar:endBar-1,beat:endBeat-1},length=Number(fermataLength),disabled=busy||!beat||beat.isEmpty;
  return <details><summary>{t('editor.beat_notation')}</summary>
    <fieldset disabled={disabled}><div className="technique-grid">{([
      [t('editor.tap'),'tap',true],[t('editor.slap'),'slap',true],[t('editor.pop'),'pop',true],[t('editor.dead_slap'),'deadSlapped',true],[t('editor.slash_notation'),'slashed',false],[t('editor.show_timer'),'showTimer',false],
    ] as const).map(([label,key,guitar])=><label className="check" key={key}><input type="checkbox" checked={draft[key]} disabled={guitar&&!stringed&&!draft[key]} onChange={e=>update(key,e.target.checked)}/>{label}</label>)}</div>
      <div className="pair">{choice(t('editor.golpe'),'golpe',model.GolpeType,true)}{choice(t('editor.rasgueado'),'rasgueado',model.Rasgueado,true)}</div>
      <div className="pair">{choice(t('editor.fade'),'fade',model.FadeType)}{choice(t('editor.beat_vibrato'),'vibrato',model.VibratoType)}</div>
      <div className="pair">{choice(t('editor.wah_pedal'),'wahPedal',model.WahPedal,true)}</div>
      <div className="pair"><label>{t('editor.stem_direction')}<select value={draft.stem} onChange={e=>update('stem',e.target.value as Draft['stem'])}>{draft.stem==='preserve'&&<option value="preserve">{t('editor.stem_preserve')}</option>}<option value="auto">{t('editor.stem_auto')}</option><option value="inverted">{t('editor.stem_inverted')}</option><option value="up">{t('editor.stem_up')}</option><option value="down">{t('editor.stem_down')}</option></select></label>{choice(t('editor.beaming'),'beamingMode',model.BeatBeamingMode)}</div>
      <div className="pair"><label>{t('editor.barre_shape')}<select value={draft.barreShape} onChange={e=>update('barreShape',Number(e.target.value))}><option value={0}>{t('editor.barre_none')}</option><option value={1} disabled={!stringed}>{t('editor.barre_full')}</option><option value={2} disabled={!stringed}>{t('editor.barre_half')}</option></select></label><IndexInput label={t('editor.barre_fret')} min={1} max={127} value={draft.barreFret} disabled={!stringed||draft.barreShape===0} onValue={fret=>update('barreFret',fret)}/></div>
      <button disabled={!Object.keys(patch).length} onClick={()=>onEdit({type:'setBeatGestures',target,patch})}>{t('editor.apply_beat_gestures')}</button>
    </fieldset>
    <fieldset disabled={disabled}><h3>{t('editor.same_voice_range')}</h3><p className="muted">{t('editor.range_starts_at', { bar: target.bar+1, beat: target.beat+1 })}</p>
      <div className="pair"><IndexInput label={t('editor.range_end_measure')} min={1} max={staff?.bars.length??1} value={endBar} onValue={value=>{setEndBar(value);setEndBeat(1);}}/><IndexInput label={t('editor.range_end_beat')} min={1} max={staff?.bars[endBar-1]?.voices[target.voice]?.beats.length??1} value={endBeat} onValue={setEndBeat}/></div>
      <EnumInput label={t('editor.octave_region')} value={ottava} enumeration={{'15ma':0,'8va':1,Regular:2,'8vb':3,'15mb':4}} onValue={setOttava}/><button onClick={()=>onEdit({type:'setOttava',from:target,to:end,ottava})}>{t('editor.apply_octave_region')}</button>
      <div className="pair"><EnumInput label={t('editor.hairpin')} value={crescendo} enumeration={model.CrescendoType} onValue={setCrescendo}/><EnumInput label={t('editor.target_dynamics')} value={targetDynamics} disabled={crescendo===0} enumeration={model.DynamicValue} onValue={setTargetDynamics}/></div>
      <button onClick={()=>onEdit({type:'setCrescendo',from:target,to:end,crescendo,targetDynamics:crescendo===0?null:targetDynamics})}>{t('editor.apply_hairpin')}</button>
    </fieldset>
    <fieldset disabled={disabled||beat?.graceType!==model.GraceType.None}><h3>{t('editor.global_fermata')}</h3><p className="muted">{t('editor.global_fermata_hint')}</p><div className="pair"><label>{t('editor.global_fermata')}<select value={fermataType} onChange={e=>setFermataType(e.target.value)}><option value="none">{t('editor.fermata_none')}</option><option value="0">{t('editor.fermata_short')}</option><option value="1">{t('editor.fermata_medium')}</option><option value="2">{t('editor.fermata_long')}</option></select></label><label>{t('editor.stored_length')}<input type="number" min={0} step="any" disabled={fermataType==='none'} value={fermataLength} onChange={e=>setFermataLength(e.target.value)}/></label></div>
      <button disabled={fermataType!=='none'&&(!fermataLength.trim()||!Number.isFinite(length)||length<0)} onClick={()=>onEdit({type:'setFermata',target,fermata:fermataType==='none'?null:{type:Number(fermataType),length}})}>{t('editor.apply_global_fermata')}</button>
    </fieldset>
    <fieldset disabled={busy||!beat||beat.graceType!==model.GraceType.None}><h3>{t('editor.sustain_pedal')}</h3><p className="muted">{t('editor.sustain_pedal_hint')}</p>
      <label>{t('editor.sustain_pedal')}<select value={pedal} onChange={e=>setPedal(e.target.value as SustainPedal)}><option value="none">{t('editor.pedal_none')}</option><option value="down">{t('editor.pedal_down')}</option><option value="up">{t('editor.pedal_up')}</option></select></label>
      <button disabled={pedal===marked} onClick={()=>onEdit({type:'setSustainPedal',target,pedal})}>{t('editor.apply_sustain_pedal')}</button>
    </fieldset>
  </details>;
}
