import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChannelMix, EditCommand, EffectBlock, TrackSound } from '../edit-types';
import type { AssetCandidate } from '../project';
import { useI18n } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { BusyFieldset } from '../ui/BusyFieldset';
import { CommitSelect } from '../ui/CommitSelect';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import { AmpGlyph } from '../shell/glyphs';
import { SoundPanel } from './SoundPanel';
import { useSoundEditing } from './useSoundEditing';
import { playsRecordedKit, sourceChoices, presetIds, soundPreset, localizedBlockName, localizedPresetName, voiceNames } from './sound-model';
import type { NativePlaybackController } from './NativePlaybackController';
import { statusLabelKey, type PluginStatus } from './plugin-host';

type Props = { trackId: string; percussion?: boolean; sound?: TrackSound; onEdit: (edit: EditCommand, asset?: AssetCandidate) => void | Promise<void>; playback?: NativePlaybackController | null; busy?: boolean; shown?: boolean; documentId?: string; status?: PluginStatus; onAllowConsent?: () => void | Promise<unknown>; onRetrySlot?: () => void | Promise<unknown>; mix?: ChannelMix; usedDrumSounds?: readonly number[];
  /** Opens the sound dialog on the plug-in slot, as the Sound menu's VST3 plug-in… does; `onRequestHandled` tells the app it has been taken. */
  request?: 'plugin' | null; onRequestHandled?: () => void };

/**
 * The Sounds section of the Track tab as one row of choices and a strip: the sound source and preset (each one undoable change),
 * a chip for every pedal that is switched on, and a button for the sound editor. The editor, with every pedal, the sound library,
 * copy and paste, the plug-in slot and the output device, opens in a dialog and is the same `SoundPanel` the inspector used to show inline.
 */
export function SoundSummary(props: Props) {
  const { lang, t } = useI18n();
  const { trackId, sound, onEdit, playback, busy = false, shown = true, percussion = false, status } = props;
  const editing = useSoundEditing({ trackId, sound, onEdit, playback, busy, shown });
  const { current, order, first, save } = editing;
  const [open, setOpen] = useState<{ block?: EffectBlock; plugin?: boolean } | null>(null);
  const { request, onRequestHandled } = props;
  useEffect(() => { if (request === 'plugin') { setOpen({ plugin: true }); onRequestHandled?.(); } }, [request]);
  const slot = current.plugin;
  const pluginState = slot ? [slot.name, ...(status && status !== 'ready' ? [t(statusLabelKey(status))] : []), ...(slot.active ? [] : [t('plugin.bypassed')])].join(' · ') : t('sound_summary.plugin_none');
  const active = order.filter(block => first.effects[block].enabled);
  return <div className="sound-summary">
    <BusyFieldset busy={busy} className="sound-choices">
      <label>{t('sound.sound_source')}<CommitSelect value={current.voiceId ?? ''} target={trackId} busy={busy} {...busySelect(busy)} onCommit={chosen => (busy ? false : save({ ...current, voiceId: chosen || null }))}>{/* A drum track's automatic choice is the recorded kit (unless its kit is Room, Jazz or Brush), so the option says so. */}<option value="">{t(playsRecordedKit(0, percussion, current.drumKit) ? 'sound.recorded_drum_kit' : 'sound.automatic_instrument')}</option>{sourceChoices(percussion, current.voiceId).map(id => <option key={id} value={id}>{percussion && id === 'gm' ? t('sound.general_midi_drums') : voiceNames[id]}</option>)}</CommitSelect></label>
      <label>{t('sound.sound_preset')}<CommitSelect value={current.presetId} target={trackId} busy={busy} {...busySelect(busy)} onCommit={chosen => (busy ? false : save(soundPreset(chosen as TrackSound['presetId'], current.voiceId)))}>{presetIds.map(id => <option value={id} key={id}>{localizedPresetName(id, lang)}</option>)}</CommitSelect></label>
    </BusyFieldset>
    <div className="sound-plugin-row">
      <span className="sound-plugin-row-label">{t('sound_summary.plugin_label')}</span>
      <span className="sound-plugin-row-state" title={pluginState}>{pluginState}</span>
      <button type="button" aria-haspopup="dialog" {...busyGuard({ className: 'sound-plugin-open', onClick: () => setOpen({ plugin: true }) })}>{t('sound_summary.plugin_open')}</button>
    </div>
    <ul className="effect-strip" aria-label={t('sound_summary.strip')}>
      {active.length === 0 && <li className="effect-strip-empty">{t('sound_summary.no_effects')}</li>}
      {active.map(block => <li key={block}><button type="button" aria-haspopup="dialog" title={t('sound_summary.edit_effect', { name: localizedBlockName(block, lang) })} aria-label={t('sound_summary.edit_effect', { name: localizedBlockName(block, lang) })} {...busyGuard({ className: 'effect-chip', onClick: () => setOpen({ block }) })}>{localizedBlockName(block, lang)}</button></li>)}
    </ul>
    <button type="button" aria-haspopup="dialog" {...busyGuard({ className: 'sound-editor-open', onClick: () => setOpen({}) })}><AmpGlyph />{t('sound_summary.open_editor')}</button>
    {open && createPortal(<Dialog title={t('sound_summary.dialog_title')} className="sound-dialog" onClose={() => setOpen(null)} dismissOnBackdrop>
      <SoundPanel {...props} openBlock={open.block} openPlugin={open.plugin} shown />
    </Dialog>, document.body)}
  </div>;
}
