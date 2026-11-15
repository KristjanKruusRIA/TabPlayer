import { useI18n } from '../i18n';
import { busyGuard } from '../ui/useBusyGuard';
import { CogGlyph, PlayGlyph } from '../shell/glyphs';

/** The one-row tuning control: a button showing the notes, which opens the Tuning dialog, and a button that plays them. */
export function TuningRow({ label, editKey = 'track_settings.tuning_edit', notes, title, unavailable = false, busy = false, locked = false, onOpen, onPlay, playDisabled = false }: {
  label: string;
  /** The catalog key of the button's name, which says what is being edited. */
  editKey?: 'track_settings.tuning_edit' | 'track_settings.new_track_tuning_edit';
  /** The tuning as note names, high to low. */
  notes: string;
  title?: string;
  /** No tuning to edit (percussion, no strings). */
  unavailable?: boolean;
  busy?: boolean;
  locked?: boolean;
  onOpen: () => void;
  /** Without it there is no play button. */
  onPlay?: () => void;
  playDisabled?: boolean;
}) {
  const { t } = useI18n();
  return <div className="track-tuning-row">
    <span className="track-tuning-label">{label}</span>
    <button type="button" aria-haspopup="dialog" title={title ?? notes} aria-label={unavailable ? t('track_settings.tuning_none') : t(editKey, { notes })} {...busyGuard({ busy, disabled: locked || unavailable, className: 'track-tuning-button', onClick: onOpen })}><CogGlyph /><span className="track-tuning-notes">{unavailable ? '—' : notes}</span></button>
    {onPlay && <button type="button" title={t('track_settings.play_tuning')} aria-label={t('track_settings.play_tuning')} {...busyGuard({ disabled: unavailable || playDisabled, className: 'track-tuning-play', onClick: onPlay })}><PlayGlyph /></button>}
  </div>;
}
