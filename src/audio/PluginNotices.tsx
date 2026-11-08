import { useI18n } from '../i18n';
import { noticeMessageKey, type TrackPluginStatus } from './plugin-host';
import './sound-panel.css';

export interface PluginNoticesProps {
  statuses?: TrackPluginStatus[];
  trackNames?: Record<string, string>;
  onAllow?: () => void;
  onRetry?: (trackId: string) => void;
  className?: string;
}

/**
 * Notices for plug-ins that cannot run or have fallen back to built-in tone, with actions for consent and retry.
 */
export function PluginNotices({
  statuses,
  trackNames,
  onAllow,
  onRetry,
  className = 'plugin-notices',
}: PluginNoticesProps) {
  const { t } = useI18n();
  const warningStatuses = statuses?.filter(s => s.status !== 'ready' && s.status !== 'loading') ?? [];
  if (!warningStatuses.length) return null;

  return (
    <div className={className}>
      {warningStatuses.map(item => {
        const track = trackNames?.[item.trackId];
        const text = t(noticeMessageKey(item.status), { name: item.name });
        const fullText = track ? `${track}: ${text}` : text;
        const canRetry =
          (item.status === 'crashed' ||
            item.status === 'hung' ||
            item.status === 'underrun' ||
            item.status === 'nonFinite') &&
          onRetry;
        const canAllow = item.status === 'needsConsent' && onAllow;

        return (
          <div key={`${item.trackId}:${item.classId}:${item.status}`} className="plugin-notice-item" role="status">
            <p className="sound-ir-notice">{fullText}</p>
            {canAllow && (
              <button type="button" className="plugin-notice-action" onClick={onAllow}>
                {t('plugin.allow')}
              </button>
            )}
            {canRetry && (
              <button type="button" className="plugin-notice-action" onClick={() => onRetry(item.trackId)}>
                {t('plugin.try_again')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
