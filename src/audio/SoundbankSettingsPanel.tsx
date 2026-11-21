import { useState } from 'react';
import { useI18n } from '../i18n';
import { busyGuard } from '../ui/useBusyGuard';
import {
  configureSoundbanks,
  pickSoundbankFolder,
  refreshSoundbankStatus,
  useSoundbankStatus,
} from './soundbank-store';

export interface SoundbankSettingsPanelProps {
  /** Renders directly as body content (e.g. inside a dialog) instead of a View-menu disclosure. */
  embedded?: boolean;
  /** Optional callback triggered after a soundbank configuration change settles. */
  onConfigured?: () => void;
}

export function SoundbankSettingsPanel({
  embedded = false,
  onConfigured,
}: SoundbankSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const status = useSoundbankStatus();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const runConfigure = async (enabled: boolean, path: string | null) => {
    setBusy(true);
    setLocalError(null);
    try {
      await configureSoundbanks(enabled, path);
      onConfigured?.();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleChooseFolder = async () => {
    if (busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      const selected = await pickSoundbankFolder();
      if (selected) {
        await configureSoundbanks(true, selected);
        onConfigured?.();
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      await refreshSoundbankStatus();
      onConfigured?.();
    } finally {
      setBusy(false);
    }
  };

  const statusText = !status.enabled
    ? t('soundbanks.status_disabled')
    : status.available
      ? t('soundbanks.status_active', {
          count: status.setCount,
          version: status.version ?? '—',
        })
      : t('soundbanks.status_not_found');

  const pathDisplay =
    status.resolvedPath ??
    status.configuredPath ??
    status.detectedDefaultPath ??
    t('soundbanks.path_default_none');

  const body = (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={status.enabled}
          aria-disabled={busy || undefined}
          onChange={e => {
            if (!busy) void runConfigure(e.target.checked, status.configuredPath);
          }}
        />
        {t('soundbanks.enable')}
      </label>
      <p className="hint" role="status">
        {statusText}
      </p>
      {(localError ?? status.error) && (
        <p role="alert">{t('soundbanks.status_error', { error: localError ?? status.error ?? '' })}</p>
      )}
      <div className="soundbank-path-row">
        <span className="hint">{t('soundbanks.path_label')}: </span>
        <code className="soundbank-path-value" title={pathDisplay}>
          {pathDisplay}
        </code>
      </div>
      <div className="soundbank-actions">
        <button
          type="button"
          {...busyGuard({ busy, onClick: () => void handleChooseFolder() })}
        >
          {t('soundbanks.choose_folder')}
        </button>
        {status.configuredPath !== null && (
          <button
            type="button"
            {...busyGuard({
              busy,
              onClick: () => void runConfigure(status.enabled, null),
            })}
          >
            {t('soundbanks.use_default')}
          </button>
        )}
        <button
          type="button"
          {...busyGuard({ busy, onClick: () => void handleRefresh() })}
        >
          {t('soundbanks.refresh')}
        </button>
      </div>
      <p className="hint">{t('soundbanks.hint')}</p>
    </>
  );

  if (embedded) {
    return (
      <section className="soundbank-settings-panel" aria-label={t('soundbanks.title')}>
        {body}
      </section>
    );
  }

  return (
    <details className="input-preferences soundbank-settings-panel" data-menu-keep="">
      <summary>{t('soundbanks.title')}</summary>
      {body}
    </details>
  );
}
