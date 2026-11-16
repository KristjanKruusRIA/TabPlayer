import { useState } from 'react';
import type { EditCommand, EffectBlock, TrackSound } from '../edit-types';
import type { AssetCandidate } from '../project';
import { useI18n } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { BusyFieldset } from '../ui/BusyFieldset';
import { CommitSelect } from '../ui/CommitSelect';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import { AmpGlyph } from '../shell/glyphs';
import { SoundPanel } from './SoundPanel';
import { useSoundEditing } from './useSoundEditing';
import { presetIds, soundPreset, localizedBlockName, localizedPresetName, voiceNames } from './sound-model';
import type { NativePlaybackController } from './NativePlaybackController';
import type { PluginStatus } from './plugin-host';

type Props = { trackId: string; percussion?: boolean; sound?: TrackSound; onEdit: (edit: EditCommand, asset?: AssetCandidate) => void | Promise<void>; playback?: NativePlaybackController | null; busy?: boolean; shown?: boolean; documentId?: string; status?: PluginStatus; onAllowConsent?: () => void | Promise<unknown>; onRetrySlot?: () => void | Promise<unknown> };

/**
 * The Sounds section of the Track tab as one row of choices and a strip: the sound source and preset (each one undoable change),
 * a chip for every pedal that is switched on, and a button for the sound editor. The editor, with every pedal, the sound library,
 * copy and paste, the plug-in slot and the output device, opens in a dialog and is the same `SoundPanel` the inspector used to show inline.
 */
export function SoundSummary(props: Props) {
  const { lang, t } = useI18n();
  const { trackId, sound, onEdit, playback, busy = false, shown = true } = props;
  const editing = useSoundEditing({ trackId, sound, onEdit, playback, busy, shown });
  const { current, order, first, save } = editing;
  const [open, setOpen] = useState<{ block?: EffectBlock } | null>(null);
  const active = order.filter(block => first.effects[block].enabled);
  return <div className="sound-summary">
    <BusyFieldset busy={busy} className="sound-choices">
      <label>{t('sound.sound_source')}<CommitSelect value={current.voiceId ?? ''} {...busySelect(busy)} onCommit={chosen => { if (!busy) void save({ ...current, voiceId: chosen || null }); }}><option value="">{t('sound.automatic_instrument')}</option>{(['gm', 'green-guitar', 'black-guitar', 'darkblack-bass', 'babyblue-bass'] as const).map(id => <option key={id} value={id}>{voiceNames[id]}</option>)}</CommitSelect></label>
      <label>{t('sound.sound_preset')}<CommitSelect value={current.presetId} {...busySelect(busy)} onCommit={chosen => { if (!busy) void save(soundPreset(chosen as TrackSound['presetId'], current.voiceId)); }}>{presetIds.map(id => <option value={id} key={id}>{localizedPresetName(id, lang)}</option>)}</CommitSelect></label>
    </BusyFieldset>
    <ul className="effect-strip" aria-label={t('sound_summary.strip')}>
      {active.length === 0 && <li className="effect-strip-empty">{t('sound_summary.no_effects')}</li>}
      {active.map(block => <li key={block}><button type="button" aria-haspopup="dialog" title={t('sound_summary.edit_effect', { name: localizedBlockName(block, lang) })} aria-label={t('sound_summary.edit_effect', { name: localizedBlockName(block, lang) })} {...busyGuard({ className: 'effect-chip', onClick: () => setOpen({ block }) })}>{localizedBlockName(block, lang)}</button></li>)}
    </ul>
    <button type="button" aria-haspopup="dialog" {...busyGuard({ className: 'sound-editor-open', onClick: () => setOpen({}) })}><AmpGlyph />{t('sound_summary.open_editor')}</button>
    {open && <Dialog title={t('sound_summary.dialog_title')} className="sound-dialog" onClose={() => setOpen(null)} dismissOnBackdrop>
      <SoundPanel {...props} openBlock={open.block} shown />
    </Dialog>}
  </div>;
}
