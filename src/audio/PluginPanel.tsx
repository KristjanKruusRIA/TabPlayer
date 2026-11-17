import type { ChannelMix, EditCommand, TrackSound } from '../edit-types';
import type { AssetCandidate } from '../project';
import { useI18n } from '../i18n';
import { DrumMapPanel } from './DrumMapPanel';
import { PluginSlotPanel } from './PluginSlotPanel';
import { makePluginStateCandidate, type PluginStatus } from './plugin-host';
import type { NativePlaybackController } from './NativePlaybackController';
import { useSoundEditing } from './useSoundEditing';
import './sound-panel.css';

type Props = { trackId: string; percussion?: boolean; sound?: TrackSound; onEdit: (edit: EditCommand, asset?: AssetCandidate) => void | Promise<void>; playback?: NativePlaybackController | null; busy?: boolean; documentId?: string; status?: PluginStatus; onAllowConsent?: () => void | Promise<unknown>; onRetrySlot?: () => void | Promise<unknown>;
  /** The track's mix, whose drum map the instrument slot's map row edits. */
  mix?: ChannelMix; /** The standard drum sounds the track's notes play. */ usedDrumSounds?: readonly number[] };

/**
 * The body of the Plug-in dialog: the track's VST3 plug-in slot and nothing else, plus (because it configures what is sent to the plug-in)
 * the drum map when a drum track holds an instrument. A choice is one `setTrackSound` edit, as it was inside the sound editor.
 */
export function PluginPanel({ trackId, sound, onEdit, playback, busy = false, percussion = false, documentId, status, onAllowConsent, onRetrySlot, mix, usedDrumSounds = [] }: Props) {
  const { t } = useI18n();
  const editing = useSoundEditing({ trackId, sound, onEdit, playback, busy, shown: true });
  const { current } = editing;
  return <section className="sound-panel plugin-panel" aria-label={t('plugin.dialog_title')}>
    <PluginSlotPanel
      trackId={trackId}
      slot={current.plugin}
      status={status}
      busy={busy}
      documentId={documentId}
      percussion={percussion}
      onChange={(nextSlot, assetToken) => {
        const next = { ...current };
        if (nextSlot) next.plugin = nextSlot;
        else delete next.plugin;
        if (assetToken && nextSlot) void onEdit({ type: 'setTrackSound', trackId, sound: next }, makePluginStateCandidate(nextSlot.state, assetToken));
        else void editing.save(next);
      }}
      onAllow={onAllowConsent}
      onRetry={onRetrySlot}
    />
    {percussion && current.plugin?.kind === 'instrument' && <DrumMapPanel trackId={trackId} mix={mix} used={usedDrumSounds} busy={busy} onEdit={onEdit} />}
  </section>;
}
