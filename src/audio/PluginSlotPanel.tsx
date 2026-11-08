import { useEffect, useRef, useState } from 'react';
import type { PluginSlot } from '../edit-types';
import { useI18n } from '../i18n';
import { BusyFieldset, busyGuard } from '../ui';
import {
  localizePluginError,
  noticeMessageKey,
  pluginChoose,
  pluginConsentGrant,
  pluginEditorOpen,
  pluginLibrary,
  pluginRetry,
  statusLabelKey,
  type PluginLibraryEntry,
  type PluginStatus,
} from './plugin-host';
import './sound-panel.css';

export interface PluginSlotPanelProps {
  trackId: string;
  slot?: PluginSlot;
  status?: PluginStatus;
  busy?: boolean;
  documentId?: string;
  onChange: (slot: PluginSlot | undefined, assetToken?: string) => void;
  onAllow?: () => void;
  onRetry?: () => void;
}

/**
 * The plug-in slot in the sound panel: chooses a VST3 effect from the library,
 * tweaks trims and active state, opens the editor, and displays fallback notices.
 */
export function PluginSlotPanel({
  trackId,
  slot,
  status,
  busy = false,
  documentId = '',
  onChange,
  onAllow,
  onRetry,
}: PluginSlotPanelProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<PluginLibraryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Local state for trims while typing before committing on blur or Enter
  const [inputVal, setInputVal] = useState<string>(() => String(slot?.inputDb ?? 0));
  const [outputVal, setOutputVal] = useState<string>(() => String(slot?.outputDb ?? 0));
  const lastCommittedInput = useRef<number>(slot?.inputDb ?? 0);
  const lastCommittedOutput = useRef<number>(slot?.outputDb ?? 0);

  useEffect(() => {
    lastCommittedInput.current = slot?.inputDb ?? 0;
    lastCommittedOutput.current = slot?.outputDb ?? 0;
    setInputVal(String(slot?.inputDb ?? 0));
    setOutputVal(String(slot?.outputDb ?? 0));
  }, [slot?.inputDb, slot?.outputDb]);

  const refreshLibrary = () => {
    let alive = true;
    pluginLibrary
      .list()
      .then(items => {
        if (alive) {
          setEntries(items);
          setError(null);
        }
      })
      .catch(err => {
        if (alive) {
          const str = String(err?.message ?? err);
          if (!str.includes("reading 'invoke'") && !str.includes('__TAURI_INTERNALS__')) {
            setError(localizePluginError(err, t));
          }
        }
      });
    return () => {
      alive = false;
    };
  };

  useEffect(() => {
    return refreshLibrary();
  }, []);

  const handleAdd = () => {
    pluginLibrary
      .add()
      .then(result => {
        if (result) {
          setEntries(result);
          setError(null);
        }
      })
      .catch(err => {
        setError(localizePluginError(err, t));
      });
  };

  const handleRemove = () => {
    if (!slot) return;
    pluginLibrary
      .remove(slot.classId)
      .then(() => {
        setEntries(prev => prev.filter(e => e.classId !== slot.classId));
        setError(null);
      })
      .catch(err => {
        setError(localizePluginError(err, t));
      });
  };

  const handleSelect = (classId: string) => {
    if (classId === (slot?.classId ?? '')) return;
    if (!classId) {
      onChange(undefined);
      return;
    }
    pluginChoose(documentId, trackId, classId)
      .then(res => {
        onChange(res.slot, res.assetToken);
        setError(null);
      })
      .catch(err => {
        setError(localizePluginError(err, t));
      });
  };

  const handleActiveToggle = (active: boolean) => {
    if (!slot || slot.active === active) return;
    onChange({ ...slot, active });
  };

  const commitInputTrim = () => {
    if (!slot) return;
    const val = Number(inputVal);
    if (!Number.isFinite(val)) {
      setInputVal(String(lastCommittedInput.current));
      return;
    }
    const clamped = Math.max(-12, Math.min(12, val));
    if (clamped !== lastCommittedInput.current) {
      lastCommittedInput.current = clamped;
      onChange({ ...slot, inputDb: clamped });
    }
  };

  const commitOutputTrim = () => {
    if (!slot) return;
    const val = Number(outputVal);
    if (!Number.isFinite(val)) {
      setOutputVal(String(lastCommittedOutput.current));
      return;
    }
    const clamped = Math.max(-12, Math.min(12, val));
    if (clamped !== lastCommittedOutput.current) {
      lastCommittedOutput.current = clamped;
      onChange({ ...slot, outputDb: clamped });
    }
  };

  const handleEditorOpen = () => {
    if (!slot) return;
    const title = t('plugin.editor_title', { name: slot.name });
    pluginEditorOpen(documentId, trackId, title).catch(err => {
      setError(localizePluginError(err, t));
    });
  };

  const handleAllowConsent = () => {
    if (onAllow) onAllow();
    else if (documentId) {
      pluginConsentGrant(documentId).catch(err => {
        setError(localizePluginError(err, t));
      });
    }
  };

  const handleRetrySlot = () => {
    if (onRetry) onRetry();
    else if (documentId) {
      pluginRetry(documentId, trackId).catch(err => {
        setError(localizePluginError(err, t));
      });
    }
  };

  const currentEntry = slot ? entries.find(e => e.classId === slot.classId) : undefined;
  const showNotice = status && status !== 'ready' && status !== 'loading';

  return (
    <details className="sound-block sound-plugin-block" open>
      <summary>
        <span className="sound-block-name">{t('plugin.slot_label')}</span>
        <span className="sound-block-state">
          {slot ? (slot.active ? t('plugin.active') : t('plugin.bypassed')) : t('plugin.builtin_tone')}
        </span>
      </summary>
      <BusyFieldset busy={busy}>
        <div className="plugin-slot-controls">
          <label>
            {t('plugin.slot_label')}
            <select
              aria-label={t('plugin.slot_label')}
              value={slot?.classId ?? ''}
              onChange={e => handleSelect(e.target.value)}
            >
              <option value="">{t('plugin.builtin_tone')}</option>
              {entries.map(entry => (
                <option key={entry.classId} value={entry.classId}>
                  {entry.name}
                  {entry.vendor ? ` (${entry.vendor})` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="plugin-library-actions">
            <button
              type="button"
              {...busyGuard({ busy, onClick: handleAdd })}
            >
              {t('plugin.add_plugin')}
            </button>
            {slot && (
              <button
                type="button"
                {...busyGuard({ busy, onClick: handleRemove })}
              >
                {t('plugin.remove_plugin')}
              </button>
            )}
          </div>

          {currentEntry?.previousBundle && (
            <p className="plugin-moved-note muted">
              {t('plugin.moved_note', { bundle: currentEntry.bundle })}
            </p>
          )}

          {slot && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  aria-label={t('plugin.active')}
                  checked={slot.active}
                  onChange={e => handleActiveToggle(e.target.checked)}
                />
                {t('plugin.active')}
              </label>

              <label>
                {t('plugin.input_trim')}
                <input
                  type="number"
                  aria-label={t('plugin.input_trim')}
                  min={-12}
                  max={12}
                  step={0.1}
                  value={inputVal}
                  onChange={e => setInputVal(e.target.value)}
                  onBlur={commitInputTrim}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      commitInputTrim();
                    }
                  }}
                />
              </label>

              <label>
                {t('plugin.output_trim')}
                <input
                  type="number"
                  aria-label={t('plugin.output_trim')}
                  min={-12}
                  max={12}
                  step={0.1}
                  value={outputVal}
                  onChange={e => setOutputVal(e.target.value)}
                  onBlur={commitOutputTrim}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      commitOutputTrim();
                    }
                  }}
                />
              </label>

              <div className="plugin-editor-row">
                <button
                  type="button"
                  {...busyGuard({ busy, onClick: handleEditorOpen })}
                >
                  {t('plugin.edit')}
                </button>
                <p className="muted plugin-focus-hint">{t('plugin.editor_focus_hint')}</p>
              </div>
            </>
          )}

          {status && (
            <div className="plugin-status-line" role="status">
              <span className="plugin-status-badge">{t(statusLabelKey(status))}</span>
              {showNotice && (
                <div className="plugin-status-notice">
                  <p>{t(noticeMessageKey(status), { name: slot?.name ?? '' })}</p>
                  {status === 'needsConsent' && (
                    <button
                      type="button"
                      {...busyGuard({ busy, onClick: handleAllowConsent })}
                    >
                      {t('plugin.allow')}
                    </button>
                  )}
                  {(status === 'crashed' ||
                    status === 'hung' ||
                    status === 'underrun' ||
                    status === 'nonFinite') && (
                    <button
                      type="button"
                      {...busyGuard({ busy, onClick: handleRetrySlot })}
                    >
                      {t('plugin.try_again')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      </BusyFieldset>
    </details>
  );
}
