import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { BusyFieldset, busyGuard } from '../ui';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { audioErrorKey } from './audio-errors';
import type { AudioDeviceInfo, AudioDiagnostics } from './bridge';
import type { NativePlaybackController } from './NativePlaybackController';
import { diagnosticsFollowUpMs } from './useSoundEditing';
import './audio-output-settings-panel.css';

const noSubscribe = () => () => {};
const noState = () => null;

export interface AudioOutputSettingsPanelProps {
  playback?: NativePlaybackController | null;
  busy?: boolean;
}

/** Global audio output selector, diagnostics readout, and test-tone trigger shown in Preferences. */
export function AudioOutputSettingsPanel({
  playback,
  busy = false,
}: AudioOutputSettingsPanelProps): React.JSX.Element | null {
  const { t } = useI18n();
  const outputId = useId();
  const playbackState = useSyncExternalStore(
    playback?.subscribe ?? noSubscribe,
    playback?.getState ?? noState,
  );
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<AudioDiagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<MessageKey | null>(null);
  const [testToneMessage, setTestToneMessage] = useState<MessageKey | null>(null);
  const diagnosticsRequest = useRef(0);
  const alive = useRef(true);
  const followUp = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (followUp.current) {
        clearTimeout(followUp.current);
        followUp.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (playback && typeof playback.devices === 'function') {
      void playback
        .devices()
        .then(items => {
          if (mounted) setDevices(items);
        })
        .catch(e => {
          if (mounted) setError(String(e));
        });
    }
    return () => {
      mounted = false;
    };
  }, [playback]);

  /** Asks for the readout; only the newest request may answer, so a slow earlier one never overwrites it. */
  const refreshDiagnostics = useCallback(() => {
    if (!playback || typeof playback.diagnostics !== 'function') return;
    const request = ++diagnosticsRequest.current;
    const isCurrent = () => alive.current && request === diagnosticsRequest.current;
    void playback
      .diagnostics()
      .then(d => {
        if (isCurrent()) {
          setDiagnostics(d);
          setDiagnosticsError(null);
        }
      })
      .catch(e => {
        if (isCurrent()) {
          setDiagnostics(null);
          setDiagnosticsError(audioErrorKey(e));
        }
      });
  }, [playback]);

  useEffect(() => {
    refreshDiagnostics();
    return () => {
      diagnosticsRequest.current++;
    };
  }, [refreshDiagnostics, playbackState?.ready]);

  const isPlaying = playbackState?.playing ?? false;
  useEffect(() => {
    if (!isPlaying) setTestToneMessage(null);
  }, [isPlaying]);

  const isReady = playbackState?.ready ?? false;
  useEffect(() => {
    setTestToneMessage(null);
  }, [isReady]);

  // Changing the system output means leaving the app, so read again when the window regains focus.
  useEffect(() => {
    if (!playback) return;
    window.addEventListener('focus', refreshDiagnostics);
    return () => window.removeEventListener('focus', refreshDiagnostics);
  }, [playback, refreshDiagnostics]);

  const testTone = useCallback(() => {
    if (!playback || typeof playback.testTone !== 'function') return;
    setTestToneMessage(null);
    void playback
      .testTone()
      .then(() => {
        if (alive.current) refreshDiagnostics();
      })
      .catch(e => {
        if (alive.current) setTestToneMessage(audioErrorKey(e));
      });
  }, [playback, refreshDiagnostics]);

  /** The readout follows the switch once it has completed, and once more after the first audio callback settles. */
  const selectOutput = (id: string) => {
    if (!playback || typeof playback.selectDevice !== 'function') return;
    void Promise.resolve(playback.selectDevice(id || null)).then(() => {
      if (!alive.current) return;
      refreshDiagnostics();
      if (followUp.current) clearTimeout(followUp.current);
      followUp.current = setTimeout(() => {
        followUp.current = null;
        if (alive.current) refreshDiagnostics();
      }, diagnosticsFollowUpMs);
    });
  };

  if (!playback) return null;

  const selectedDeviceId = typeof playback.deviceId === 'function' ? playback.deviceId() ?? '' : '';

  return (
    <BusyFieldset busy={busy} className="input-preferences audio-output-panel">
      <legend>{t('audio.audio_output')}</legend>
      <div className="audio-output-row">
        <select
          id={outputId}
          aria-label={t('audio.audio_output')}
          value={selectedDeviceId}
          onChange={e => selectOutput(e.target.value)}
        >
          <option value="">{t('audio.system_default')}</option>
          {devices.map(device => (
            <option key={device.id} value={device.id}>
              {device.name ?? t('audio.unknown_device')}
            </option>
          ))}
        </select>
        <button type="button" {...busyGuard({ busy, onClick: testTone })}>
          {t('audio.test_tone')}
        </button>
      </div>
      <div className="sound-diagnostics" role="group" aria-label={t('audio.diagnostics_label')}>
        <div className="sound-diag-item">
          <span className="sound-diag-label">{t('audio.current_device')}:</span>{' '}
          <span className="sound-diag-value">{diagnostics?.deviceName ?? t('audio.unknown')}</span>
        </div>
        <div className="sound-diag-item">
          <span className="sound-diag-label">{t('audio.sample_rate')}:</span>{' '}
          <span className="sound-diag-value">
            {diagnostics?.sampleRate ? `${diagnostics.sampleRate} Hz` : t('audio.unknown')}
          </span>
        </div>
        <div className="sound-diag-item">
          <span className="sound-diag-label">{t('audio.buffer_size')}:</span>{' '}
          <span className="sound-diag-value">
            {diagnostics?.bufferSize != null
              ? t('audio.frames', { count: diagnostics.bufferSize })
              : t('audio.unknown')}
          </span>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {playbackState?.error && playbackState.error !== error && (
        <p role="alert">{playbackState.error}</p>
      )}
      {diagnosticsError && (
        <p role="alert" className="sound-diagnostics-error">
          {t(diagnosticsError)}
        </p>
      )}
      {testToneMessage && (
        <p role="alert" className="sound-test-tone-message">
          {t(testToneMessage)}
        </p>
      )}
    </BusyFieldset>
  );
}
