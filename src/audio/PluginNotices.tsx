import { useState } from 'react';
import { useI18n } from '../i18n';
import { localizePluginError, noticeMessageKey, type MovedPlugin, type TrackPluginStatus } from './plugin-host';
import './sound-panel.css';

export interface PluginNoticesProps {
  statuses?: TrackPluginStatus[];
  /** Plug-ins that now load from another file than before, for every track that uses one. */
  moved?: MovedPlugin[];
  trackNames?: Record<string, string>;
  /** May return a promise; a rejection is shown here instead of being dropped. */
  onAllow?: () => void | Promise<unknown>;
  onRetry?: (trackId: string) => void | Promise<unknown>;
  className?: string;
}

const retryable = (status: string) => status === 'crashed' || status === 'hung' || status === 'underrun' || status === 'nonFinite';

/**
 * Notices for plug-ins that cannot run or have fallen back to built-in tone, with actions for consent and retry.
 * All the text sits in one live region and the buttons outside it, so several notices make one announcement.
 */
export function PluginNotices({
  statuses,
  moved,
  trackNames,
  onAllow,
  onRetry,
  className = 'plugin-notices',
}: PluginNoticesProps) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const warningStatuses = statuses?.filter(s => s.status !== 'ready' && s.status !== 'loading') ?? [];
  const movedList = moved ?? [];
  if (!warningStatuses.length && !movedList.length) return null;

  const run = (action: () => void | Promise<unknown>) => {
    setError(null);
    try {
      const result = action();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(undefined, err => setError(localizePluginError(err, t)));
      }
    } catch (err) {
      setError(localizePluginError(err, t));
    }
  };
  const withTrack = (trackId: string, text: string) => {
    const track = trackNames?.[trackId];
    return track ? `${track}: ${text}` : text;
  };
  const wantsConsent = Boolean(onAllow) && warningStatuses.some(item => item.status === 'needsConsent');
  const retries = onRetry ? warningStatuses.filter(item => retryable(item.status)) : [];

  return (
    <div className={className}>
      <div role="status">
        {warningStatuses.map(item => (
          <div key={`${item.trackId}:${item.classId}:${item.status}`} className="plugin-notice-item">
            <p className="sound-ir-notice">{withTrack(item.trackId, t(noticeMessageKey(item.status), { name: item.name }))}</p>
          </div>
        ))}
        {movedList.map(item => (
          <div key={`moved:${item.trackId}:${item.bundle}`} className="plugin-notice-item">
            <p className="sound-ir-notice">
              {withTrack(item.trackId, t('plugin.moved_warning', { name: item.name, bundle: item.bundle, previous: item.previousBundle }))}
            </p>
          </div>
        ))}
      </div>
      {(wantsConsent || retries.length > 0) && (
        <div className="plugin-notice-actions">
          {wantsConsent && (
            <button type="button" className="plugin-notice-action" onClick={() => run(() => onAllow!())}>
              {t('plugin.allow')}
            </button>
          )}
          {retries.map(item => (
            <button
              key={`retry:${item.trackId}`}
              type="button"
              className="plugin-notice-action"
              aria-label={`${t('plugin.try_again')}: ${trackNames?.[item.trackId] ?? item.name}`}
              onClick={() => run(() => onRetry!(item.trackId))}
            >
              {t('plugin.try_again')}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
