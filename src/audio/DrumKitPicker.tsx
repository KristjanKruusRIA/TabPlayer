import { useI18n } from '../i18n';
import { busySelect } from '../ui';
import { drumKitFor, drumKits, kitDifferences, sharedSounds } from '../editor/drum-kits';
import type { SoundEditing } from './useSoundEditing';

/** The drum kit of a drum track, shared by the inspector's Sound task and the rig. Only kits the sound bank really carries are offered; a choice is
 * `editing.setDrumKit`, one undoable `setTrackSound` edit. The select stays focusable while busy (`busySelect`). */
export function DrumKitPicker({editing,className,onOpenPlugin}:{editing:SoundEditing;className?:string;/** Offered beside the note about a plug-in instrument: opens the Plug-in dialog. */onOpenPlugin?:()=>void}) {
  const { t } = useI18n();
  const {current,busy}=editing,kit=drumKitFor(current.drumKit);
  const note=kit.changes.length?t('rig.kit_changes',{kit:kit.label,changes:kitDifferences(kit).join(', ')}):t('rig.kit_standard_reference');
  return <section className={className} aria-label={t('rig.drum_kit_settings')}>
    <label><span className="drum-kit-label">{t('rig.drum_kit')}</span><select title={note} value={kit.program} {...busySelect(busy)} onChange={e=>{void editing.setDrumKit(Number(e.target.value));}}>{drumKits.map(option=><option key={option.program} value={option.program}>{option.label}</option>)}</select></label>
    <p className="muted">{note}</p>
    {current.plugin?.kind==='instrument'&&<p className="muted">{t('plugin.kit_note')}{onOpenPlugin&&<> <button type="button" aria-haspopup="dialog" className="sound-plugin-link-open" onClick={onOpenPlugin}>{t('sound_summary.plugin_open')}</button></>}</p>}
    <details onKeyDown={event=>{if(event.key==='Escape'&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary title={t('rig.which_hits_differ')}>{t('rig.which_hits_differ')}</summary>
      <div className="drum-kit-table"><p className="muted">{t('rig.kit_help_keys')}</p>
      <ul>{drumKits.filter(option=>option.changes.length).map(option=><li key={option.program}><strong>{option.label}</strong>: {kitDifferences(option).join(', ')}</li>)}</ul>
      <p className="muted">{t('rig.kit_help_shared')}</p>
      <ul>{sharedSounds().map(group=><li key={group.key}>{group.labels.join(' = ')}</li>)}</ul></div>
    </details>
  </section>;
}
