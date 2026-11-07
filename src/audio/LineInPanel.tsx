import { useState,useSyncExternalStore } from 'react';
import './line-in-panel.css';
import { useI18n } from '../i18n';
import { factoryCategories,factorySounds } from './factory-sounds';
import { nativeLineIn,type LineInBridge,type LineInInput,type LineInSettings } from './line-in';
import { readLineInPreferences,saveLineInPreferences,soundForChoice,type LineInPreferences } from './line-in-preferences';
import { lineInSession,type LineInSession } from './line-in-session';
import { soundLibrary,subscribeSoundLibrary } from './sound-library';
import { localizedPresetName,presetIds } from './sound-model';

export interface LineInPanelProps {
  /** Lists the inputs; the session does the rest. */
  bridge?:Pick<LineInBridge,'inputs'>;
  session?:LineInSession;
  /** Where the sound and level are kept; tests pass their own. */
  preferences?:{read:()=>LineInPreferences;save:(value:LineInPreferences)=>void};
}
const stored={read:()=>readLineInPreferences(),save:(value:LineInPreferences)=>saveLineInPreferences(value)};
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const METER_FLOOR=-60;

/** What is sent for these preferences: the chosen sound as it is now, or the remembered one when its source is gone. */
const settingsOf=(value:LineInPreferences):LineInSettings=>({sound:soundForChoice(value.choice)??value.sound,level:value.level,monitor:true});

/**
 * Plays an audio input, such as a guitar on an interface, through its own sound and level while the score plays.
 * The sound and level stay the same whatever track or score is selected. Monitoring carries on while the Practice
 * tools are closed and when another document is opened, so the player can play along; it ends on Stop and when the
 * app closes, and the Practice button shows while it is on.
 */
export function LineInPanel({bridge=nativeLineIn,session=lineInSession(),preferences=stored}:LineInPanelProps):React.JSX.Element {
  const {t,lang}=useI18n(),library=useSyncExternalStore(subscribeSoundLibrary,soundLibrary,soundLibrary);
  const live=useSyncExternalStore(session.subscribe,session.get,session.get);
  const [settings,setSettings]=useState(preferences.read),[inputs,setInputs]=useState<LineInInput[]|null>(null),[listError,setListError]=useState('');
  const percent=new Intl.NumberFormat(lang,{style:'percent',maximumFractionDigits:0}),ms=new Intl.NumberFormat(lang,{maximumFractionDigits:0}),db=new Intl.NumberFormat(lang,{maximumFractionDigits:0});
  const change=(next:LineInPreferences)=>{
    setSettings(next);preferences.save(next);
    // Sent while stopped too, so a change made while a start is on its way is not lost.
    void session.update(settingsOf(next));
  };
  const loadInputs=()=>{bridge.inputs().then(list=>{setInputs(list);setListError('');}).catch(reason=>{setInputs(current=>current??[]);setListError(message(reason));});};
  // Stop also ends a start that is still on its way, such as one waiting on a slow device.
  const active=live.running||live.pending;
  const toggle=()=>{void (active?session.stop():session.start(settings.inputId,settingsOf(settings)));};
  const chooseInput=(inputId:string)=>{
    const next={...settings,inputId};setSettings(next);preferences.save(next);
    // Move monitoring to the new input, with the choice just made.
    if(active)void session.start(inputId,settingsOf(next));
  };
  const chooseSound=(choice:string)=>{const sound=soundForChoice(choice);if(sound)change({...settings,choice,sound});};
  const status=live.running?live.status:null,level=status?Math.max(METER_FLOOR,Math.min(0,status.inputLevel)):METER_FLOOR;
  const knownChoice=soundForChoice(settings.choice)!==null;
  const problemKey={failed:'line_in.failed',stopped:'line_in.stopped',set_failed:'line_in.set_failed'} as const;
  const problem=live.problem?t(problemKey[live.problem.kind],{error:live.problem.detail}):listError?t('line_in.inputs_failed',{error:listError}):'';
  return <details onToggle={event=>{if((event.currentTarget as HTMLDetailsElement).open)loadInputs();}}><summary>{t('line_in.title')}</summary>
    <div className="line-in">
      <label>{t('line_in.input')}<select value={settings.inputId} onChange={event=>chooseInput(event.target.value)}>
        <option value="">{t('line_in.input_default')}</option>
        {inputs?.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
        {settings.inputId&&!inputs?.some(entry=>entry.id===settings.inputId)&&<option value={settings.inputId}>{inputs===null?t('line_in.input_saved'):t('line_in.input_missing')}</option>}
      </select></label>
      <label>{t('line_in.sound')}<select value={knownChoice?settings.choice:''} onChange={event=>chooseSound(event.target.value)}>
        {!knownChoice&&<option value="" disabled>{t('line_in.sound_kept')}</option>}
        <optgroup label={t('sound.factory_presets_group')}>{presetIds.map(id=><option key={id} value={`preset:${id}`}>{localizedPresetName(id,lang)}</option>)}</optgroup>
        {factoryCategories.map(category=><optgroup key={category} label={t('sound.category_sounds_group',{category})}>{factorySounds.filter(item=>item.category===category).map(item=><option key={item.id} value={`factory:${item.id}`}>{item.name}</option>)}</optgroup>)}
        {library.length>0&&<optgroup label={t('sound.my_sounds')}>{library.map(item=><option key={item.name} value={`saved:${item.name}`}>{item.name}</option>)}</optgroup>}
      </select></label>
      <label>{t('line_in.level')}<input type="range" min={0} max={1} step={0.01} value={settings.level} aria-valuetext={percent.format(settings.level)} onChange={event=>change({...settings,level:Number(event.target.value)})}/><output>{percent.format(settings.level)}</output></label>
      <button type="button" onClick={toggle}>{active?t('line_in.stop'):t('line_in.start')}</button>
      {live.running&&<div className="line-in-status">
        <meter min={METER_FLOOR} max={0} high={-6} optimum={-18} value={level} aria-label={t('line_in.input_level')} aria-valuetext={t('line_in.level_dbfs',{db:db.format(level)})}/>
        {status?.latencyMs!=null&&<span className="muted">{t('line_in.latency',{ms:ms.format(status.latencyMs)})}</span>}
      </div>}
      <p className="muted">{t('line_in.headphones')}</p>
      {problem&&<p role="alert">{problem}</p>}
    </div>
  </details>;
}

/** Whether the Line-In is on, for the Practice button's badge. */
export function useLineInRunning(session:LineInSession=lineInSession()):boolean {
  return useSyncExternalStore(session.subscribe,()=>session.get().running,()=>session.get().running);
}
