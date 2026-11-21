import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChannelMix, EditCommand, EffectBlock, PickupPosition, TrackSound } from '../edit-types';
import type { AssetCandidate } from '../project';
import { useI18n } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { BusyFieldset } from '../ui/BusyFieldset';
import { CommitSelect } from '../ui/CommitSelect';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import { AmpGlyph } from '../shell/glyphs';
import { SoundPanel } from './SoundPanel';
import { PluginPanel } from './PluginPanel';
import { PickupOptions, SoundSourceOptions } from './SoundSourceOptions';
import { useSoundbankStatus } from './soundbank-store';
import { useSoundEditing } from './useSoundEditing';
import { availablePickupsForVoice, presetIds, soundPreset, localizedBlockName, localizedPresetName } from './sound-model';
import type { NativePlaybackController } from './NativePlaybackController';
import { statusLabelKey, type PluginStatus } from './plugin-host';

type Props = { trackId: string; program?: number; percussion?: boolean; sound?: TrackSound; onEdit: (edit: EditCommand, asset?: AssetCandidate) => void | Promise<void>; playback?: NativePlaybackController | null; busy?: boolean; shown?: boolean; documentId?: string; status?: PluginStatus; onAllowConsent?: () => void | Promise<unknown>; onRetrySlot?: () => void | Promise<unknown>; mix?: ChannelMix; usedDrumSounds?: readonly number[];
  /** Opens the Plug-in dialog, as the Sound menu's Plug-in… does; `onRequestHandled` tells the app it has been taken. */
  request?: 'plugin' | null; onRequestHandled?: () => void };

/**
 * The Sounds section of the Track tab as one row of choices and a strip: the sound source and preset (each one undoable change),
 * a chip for every pedal that is switched on, and a button for the sound editor. The editor, with every pedal, the sound library,
 * copy and paste and the output device, opens in a dialog and is the same `SoundPanel` the inspector used to show inline. The track's plug-in slot,
 * with the drum map of a drum instrument, is a separate, smaller Plug-in dialog (`PluginPanel`); only one of the two is open at a time.
 */
export function SoundSummary(props: Props) {
  const { lang, t } = useI18n();
  const { trackId, program = 0, sound, onEdit, playback, busy = false, shown = true, percussion = false, status } = props;
  const soundbankStatus = useSoundbankStatus();
  const editing = useSoundEditing({ trackId, sound, onEdit, playback, busy, shown });
  const { current, order, first, save, setVoice, setPickup } = editing;
  const pickups = availablePickupsForVoice(current.voiceId, program, percussion, current.drumKit, soundbankStatus);
  const [open, setOpen] = useState<{ kind: 'sound'; block?: EffectBlock } | { kind: 'plugin' } | null>(null);
  const { request, onRequestHandled } = props;
  useEffect(() => { if (request === 'plugin') { setOpen({ kind: 'plugin' }); onRequestHandled?.(); } }, [request]);
  const slot = current.plugin;
  const pluginState = slot ? [slot.name, ...(status && status !== 'ready' ? [t(statusLabelKey(status))] : []), ...(slot.active ? [] : [t('plugin.bypassed')])].join(' · ') : t('sound_summary.plugin_none');
  const active = order.filter(block => first.effects[block].enabled);
  return <div className="sound-summary">
    <BusyFieldset busy={busy} className="sound-choices">
      <label>{t('sound.sound_source')}<CommitSelect value={current.voiceId ?? ''} target={trackId} busy={busy} {...busySelect(busy)} onCommit={chosen => (busy ? false : setVoice(chosen || null))}><SoundSourceOptions percussion={percussion} program={program} drumKit={current.drumKit} voiceId={current.voiceId} status={soundbankStatus}/></CommitSelect></label>
      {pickups.length > 1 && <label>{t('sound.pickup')}<CommitSelect value={current.pickup ?? ''} target={trackId} busy={busy} {...busySelect(busy)} onCommit={chosen => (busy ? false : setPickup((chosen || undefined) as PickupPosition | undefined))}><PickupOptions pickups={pickups}/></CommitSelect></label>}
      <label>{t('sound.sound_preset')}<CommitSelect value={current.presetId} target={trackId} busy={busy} {...busySelect(busy)} onCommit={chosen => (busy ? false : save(soundPreset(chosen as TrackSound['presetId'], current.voiceId)))}>{presetIds.map(id => <option value={id} key={id}>{localizedPresetName(id, lang)}</option>)}</CommitSelect></label>
    </BusyFieldset>
    <div className="sound-plugin-row">
      <span className="sound-plugin-row-label">{t('sound_summary.plugin_label')}</span>
      <span className="sound-plugin-row-state" title={pluginState}>{pluginState}</span>
      <button type="button" aria-haspopup="dialog" {...busyGuard({ className: 'sound-plugin-open', onClick: () => setOpen({ kind: 'plugin' }) })}>{t('sound_summary.plugin_open')}</button>
    </div>
    <ul className="effect-strip" aria-label={t('sound_summary.strip')}>
      {active.length === 0 && <li className="effect-strip-empty">{t('sound_summary.no_effects')}</li>}
      {active.map(block => <li key={block}><button type="button" aria-haspopup="dialog" title={t('sound_summary.edit_effect', { name: localizedBlockName(block, lang) })} aria-label={t('sound_summary.edit_effect', { name: localizedBlockName(block, lang) })} {...busyGuard({ className: 'effect-chip', onClick: () => setOpen({ kind: 'sound', block }) })}>{localizedBlockName(block, lang)}</button></li>)}
    </ul>
    <button type="button" aria-haspopup="dialog" {...busyGuard({ className: 'sound-editor-open', onClick: () => setOpen({ kind: 'sound' }) })}><AmpGlyph />{t('sound_summary.open_editor')}</button>
    {open?.kind === 'sound' && createPortal(<Dialog key="sound" title={t('sound_summary.dialog_title')} className="sound-dialog" onClose={() => setOpen(null)} dismissOnBackdrop>
      <SoundPanel {...props} openBlock={open.block} onOpenPlugin={() => setOpen({ kind: 'plugin' })} shown />
    </Dialog>, document.body)}
    {open?.kind === 'plugin' && createPortal(<Dialog key="plugin" title={t('plugin.dialog_title')} className="plugin-dialog" onClose={() => setOpen(null)} dismissOnBackdrop>
      <PluginPanel {...props} />
    </Dialog>, document.body)}
  </div>;
}
