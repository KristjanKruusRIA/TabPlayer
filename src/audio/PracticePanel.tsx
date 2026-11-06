import { useEffect,useId,useState } from 'react';
import { CLICK_SOUNDS,clickSoundOf,type ClickSound,type PracticeSettings } from './practice-types';
import { useI18n } from '../i18n';
import { validatePractice } from './practice';

export interface PracticePanelProps {settings:PracticeSettings;busy:boolean;hasBacking:boolean;onChange:(settings:PracticeSettings)=>void}
type TempoDraft=
  |{kind:'relative';ratio:string}
  |{kind:'fixed';bpm:string}
  |{kind:'progressive';start:string;end:string;step:string;repetitions:string};
interface Draft {tempo:TempoDraft;enabled:boolean;volume:string;visual:boolean;sound:ClickSound;bars:string;betweenLoops:boolean}

function draftFor(settings:PracticeSettings):Draft {
  const tempo=settings.tempo;
  return {tempo:tempo.kind==='relative'?{kind:'relative',ratio:String(tempo.ratio*100)}:tempo.kind==='fixed'?{kind:'fixed',bpm:String(tempo.bpm)}:{kind:'progressive',start:String(tempo.start*100),end:String(tempo.end*100),step:String(tempo.step*100),repetitions:String(tempo.repetitions)},enabled:settings.metronome.enabled,volume:String(settings.metronome.volume*100),visual:settings.metronome.visual,sound:clickSoundOf(settings.metronome),bars:String(settings.countIn.bars),betweenLoops:settings.countIn.betweenLoops};
}
const numeric=(value:string)=>value.trim()?Number(value):NaN;
const percentage=(value:string,accepted?:number)=>accepted!==undefined&&value===String(accepted*100)?accepted:numeric(value)/100;

export function PracticePanel({settings,busy,hasBacking,onChange}:PracticePanelProps):React.JSX.Element {
  const tempo=settings.tempo,accepted=draftFor(settings),acceptedKey=JSON.stringify([tempo.kind,tempo.kind==='relative'?[tempo.ratio]:tempo.kind==='fixed'?[tempo.bpm]:[tempo.start,tempo.end,tempo.step,tempo.repetitions],settings.metronome.enabled,settings.metronome.volume,settings.metronome.visual,clickSoundOf(settings.metronome),settings.countIn.bars,settings.countIn.betweenLoops]),backingReason=useId(),{t}=useI18n();
  const [draft,setDraft]=useState(accepted),[error,setError]=useState('');
  useEffect(()=>{setDraft(accepted);setError('');},[acceptedKey]);
  const changeTempo=(kind:TempoDraft['kind'])=>setDraft(value=>({...value,tempo:kind==='relative'?{kind,ratio:'100'}:kind==='fixed'?{kind,bpm:'120'}:{kind,start:'50',end:'100',step:'10',repetitions:'1'}}));
  const apply=()=>{
    if(busy)return;
    const tempo=draft.tempo;
    const source=settings.tempo;
    const value:PracticeSettings={tempo:tempo.kind==='relative'?{kind:tempo.kind,ratio:percentage(tempo.ratio,source.kind==='relative'?source.ratio:undefined)}:tempo.kind==='fixed'?{kind:tempo.kind,bpm:numeric(tempo.bpm)}:{kind:tempo.kind,start:percentage(tempo.start,source.kind==='progressive'?source.start:undefined),end:percentage(tempo.end,source.kind==='progressive'?source.end:undefined),step:percentage(tempo.step,source.kind==='progressive'?source.step:undefined),repetitions:numeric(tempo.repetitions)},metronome:{enabled:draft.enabled,volume:percentage(draft.volume,settings.metronome.volume),visual:draft.visual,sound:draft.sound},countIn:{bars:numeric(draft.bars),betweenLoops:draft.betweenLoops}};
    try {validatePractice(value,hasBacking);setError('');onChange(value);}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  };
  return <details><summary>Practice settings</summary><fieldset disabled={busy}>
    <label>Tempo mode<select value={draft.tempo.kind} aria-describedby={hasBacking?backingReason:undefined} onChange={event=>changeTempo(event.target.value as TempoDraft['kind'])}><option value="relative">Relative</option><option value="fixed" disabled={hasBacking}>Fixed</option><option value="progressive">Progressive</option></select></label>
    {hasBacking&&<p id={backingReason}>Fixed tempo is unavailable while a backing track is present.</p>}
    {draft.tempo.kind==='relative'&&<label>Relative speed (%)<input type="number" min={10} max={300} step="any" value={draft.tempo.ratio} onChange={event=>{const ratio=event.target.value;setDraft(value=>({...value,tempo:{kind:'relative',ratio}}));}}/></label>}
    {draft.tempo.kind==='fixed'&&<label>Fixed tempo (BPM)<input type="number" min={10} max={300} step="any" value={draft.tempo.bpm} onChange={event=>{const bpm=event.target.value;setDraft(value=>({...value,tempo:{kind:'fixed',bpm}}));}}/></label>}
    {draft.tempo.kind==='progressive'&&<>
      <div className="pair"><label>Starting speed (%)<input type="number" min={10} max={300} step="any" value={draft.tempo.start} onChange={event=>{const start=event.target.value;setDraft(value=>({...value,tempo:{...(value.tempo as Extract<TempoDraft,{kind:'progressive'}>),start}}));}}/></label><label>Finishing speed (%)<input type="number" min={10} max={300} step="any" value={draft.tempo.end} onChange={event=>{const end=event.target.value;setDraft(value=>({...value,tempo:{...(value.tempo as Extract<TempoDraft,{kind:'progressive'}>),end}}));}}/></label></div>
      <div className="pair"><label>Increment (percentage points)<input type="number" min={0} max={290} step="any" value={draft.tempo.step} onChange={event=>{const step=event.target.value;setDraft(value=>({...value,tempo:{...(value.tempo as Extract<TempoDraft,{kind:'progressive'}>),step}}));}}/></label><label>Repetitions per speed<input type="number" min={1} max={100} step={1} value={draft.tempo.repetitions} onChange={event=>{const repetitions=event.target.value;setDraft(value=>({...value,tempo:{...(value.tempo as Extract<TempoDraft,{kind:'progressive'}>),repetitions}}));}}/></label></div>
    </>}
    <label className="check"><input type="checkbox" checked={draft.enabled} onChange={event=>{const enabled=event.target.checked;setDraft(value=>({...value,enabled}));}}/>Metronome</label>
    <label>Metronome volume (%)<input type="number" min={0} max={100} step="any" value={draft.volume} onChange={event=>{const volume=event.target.value;setDraft(value=>({...value,volume}));}}/></label>
    <label>{t('practice.metronome_sound')}<select value={draft.sound} onChange={event=>{const sound=event.target.value as ClickSound;setDraft(value=>({...value,sound}));}}>{CLICK_SOUNDS.map(sound=><option key={sound} value={sound}>{t(`practice.metronome_sound.${sound}`)}</option>)}</select></label>
    <label className="check"><input type="checkbox" checked={draft.visual} onChange={event=>{const visual=event.target.checked;setDraft(value=>({...value,visual}));}}/>Visual metronome</label>
    <label>Count-in bars<input type="number" min={0} max={16} step={1} value={draft.bars} onChange={event=>{const bars=event.target.value;setDraft(value=>({...value,bars}));}}/></label>
    <label className="check"><input type="checkbox" checked={draft.betweenLoops} onChange={event=>{const betweenLoops=event.target.checked;setDraft(value=>({...value,betweenLoops}));}}/>Count in between loops</label>
    <button type="button" onClick={apply}>Apply practice settings</button>
    {error&&<p role="alert">{error}</p>}
  </fieldset></details>;
}
