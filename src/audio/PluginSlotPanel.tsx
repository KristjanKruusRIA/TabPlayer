import { useEffect, useRef, useState } from 'react';
import type { PluginSlot } from '../edit-types';
import { useI18n } from '../i18n';
import { BusyFieldset, busyGuard } from '../ui';
import {
  localizePluginError,
  noticeMessageKey,
  pluginCancelAsset,
  pluginChoose,
  pluginConsentGrant,
  onPluginEditorClosed,
  pluginEditorOpen,
  pluginEditorSave,
  pluginLibrary,
  pluginRetry,
  replacedByAdd,
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
  /** May return a promise; a rejection is shown here. */
  onAllow?: () => void | Promise<unknown>;
  onRetry?: () => void | Promise<unknown>;
}

/** The library holds at most this many plug-ins (`MAX_ENTRIES` in `plugins/library.rs`). */
const LIBRARY_LIMIT = 256;

/** Reads a trim field: nothing for an empty or non-numeric field (which reverts), else the value held to -12..12 dB. */
function parseTrim(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.max(-12, Math.min(12, value)) : null;
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
  const [replacedNotes, setReplacedNotes] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);

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
        // The first list must not wipe an error an action has shown meanwhile.
        if (alive) setEntries(items);
      })
      .catch(err => {
        if (alive) setError(localizePluginError(err, t));
      });
    return () => {
      alive = false;
    };
  };

  useEffect(() => {
    return refreshLibrary();
  }, []);

  const handleAdd = () => {
    if (entries.length >= LIBRARY_LIMIT) {
      setError(t('plugin.error.too_many'));
      return;
    }
    const before = entries;
    pluginLibrary
      .add()
      .then(result => {
        if (result) {
          setEntries(result);
          setError(null);
          setReplacedNotes(
            replacedByAdd(before, result).map(entry =>
              t('plugin.replaced_by_add', {
                name: entry.name,
                previous: entry.previousBundle ?? '',
                bundle: entry.bundle,
              })
            )
          );
        }
      })
      .catch(err => {
        setError(localizePluginError(err, t));
      });
  };

  const removeFromLibrary = (classId: string) => {
    pluginLibrary
      .remove(classId)
      .then(() => {
        setEntries(prev => prev.filter(e => e.classId !== classId));
        setError(null);
      })
      .catch(err => {
        setError(localizePluginError(err, t));
      });
  };

  const handleRemove = () => {
    if (slot) removeFromLibrary(slot.classId);
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

  const commitTrim = (
    field: 'inputDb' | 'outputDb',
    text: string,
    committed: { current: number },
    revert: (text: string) => void,
  ) => {
    if (!slot) return;
    const value = parseTrim(text);
    if (value === null) {
      revert(String(committed.current));
      return;
    }
    if (value !== committed.current) {
      committed.current = value;
      onChange({ ...slot, [field]: value });
    }
  };
  const commitInputTrim = () => commitTrim('inputDb', inputVal, lastCommittedInput, setInputVal);
  const commitOutputTrim = () => commitTrim('outputDb', outputVal, lastCommittedOutput, setOutputVal);

  // A blur that arrives while busy is refused, so a trim typed then is committed when busy ends.
  const pendingTrims = useRef({ commitInputTrim, commitOutputTrim });
  pendingTrims.current = { commitInputTrim, commitOutputTrim };
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      pendingTrims.current.commitInputTrim();
      pendingTrims.current.commitOutputTrim();
    }
    wasBusy.current = busy;
  }, [busy]);

  // The editor counts as open from a successful open until the native side reports it closed.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    onPluginEditorClosed(payload => {
      if (payload.trackId === trackId && payload.documentId === documentId) setEditorOpen(false);
    }).then(
      fn => {
        if (alive) unlisten = fn;
        else fn();
      },
      () => {}
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [trackId, documentId]);

  const handleEditorOpen = () => {
    if (!slot) return;
    const title = t('plugin.editor_title', { name: slot.name });
    pluginEditorOpen(documentId, trackId, title, slot.classId).then(
      () => {
        setError(null);
        setEditorOpen(true);
      },
      err => {
        setError(localizePluginError(err, t));
      }
    );
  };

  const handleEditorSave = () => {
    if (!slot) return;
    pluginEditorSave(documentId, trackId).then(
      result => {
        // Nothing came back, or the same state came back: nothing changed, so nothing is recorded. A staged state is
        // dropped, or it stays until the document closes (final review L1).
        if (!result) return;
        if (result.state === slot.state) {
          void pluginCancelAsset(documentId, result.assetToken).catch(() => {});
          return;
        }
        setError(null);
        onChange({ ...slot, state: result.state }, result.assetToken);
      },
      err => {
        setError(localizePluginError(err, t));
      }
    );
  };

  const report = (action: () => void | Promise<unknown>) => {
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

  const handleAllowConsent = () => {
    if (onAllow) report(onAllow);
    else if (documentId) {
      pluginConsentGrant(documentId).catch(err => {
        setError(localizePluginError(err, t));
      });
    }
  };

  const handleRetrySlot = () => {
    if (onRetry) report(onRetry);
    else if (documentId) {
      pluginRetry(documentId, trackId).catch(err => {
        setError(localizePluginError(err, t));
      });
    }
  };

  const currentEntry = slot ? entries.find(e => e.classId === slot.classId) : undefined;
  const showNotice = status && status !== 'ready' && status !== 'loading';

  return (
    <details className="sound-plugin-slot" open>
      <summary>
        <span className="sound-plugin-name">{t('plugin.slot_label')}</span>
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
              {slot && !entries.some(e => e.classId === slot.classId) && (
                <option value={slot.classId}>
                  {slot.name}
                  {slot.vendor ? ` (${slot.vendor})` : ''}
                </option>
              )}
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
                {editorOpen && (
                  <button
                    type="button"
                    {...busyGuard({ busy, onClick: handleEditorSave })}
                  >
                    {t('plugin.save')}
                  </button>
                )}
                <p className="muted plugin-focus-hint">{t('plugin.editor_focus_hint')}</p>
              </div>
            </>
          )}

          {status && (
            <div className="plugin-status-line">
              <div role="status">
                <span className="plugin-status-badge">{t(statusLabelKey(status))}</span>
                {showNotice && (
                  <div className="plugin-status-notice">
                    <p>{t(noticeMessageKey(status), { name: slot?.name ?? '' })}</p>
                  </div>
                )}
              </div>
              {showNotice && status === 'needsConsent' && (
                <button
                  type="button"
                  {...busyGuard({ busy, onClick: handleAllowConsent })}
                >
                  {t('plugin.allow')}
                </button>
              )}
              {showNotice &&
                (status === 'crashed' ||
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

          {entries.length > 0 && (
            <details className="plugin-library-manage">
              <summary>{t('plugin.manage_library')}</summary>
              <ul>
                {entries.map(entry => (
                  <li key={entry.classId}>
                    <span>
                      {entry.name}
                      {entry.vendor ? ` (${entry.vendor})` : ''}
                    </span>
                    <button
                      type="button"
                      {...busyGuard({ busy, onClick: () => removeFromLibrary(entry.classId) })}
                    >
                      {t('plugin.remove_named', { name: entry.name })}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {replacedNotes.map(note => (
            <p key={note} role="alert" className="error">
              {note}
            </p>
          ))}

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
