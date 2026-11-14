import './fretlight-panel.css';
import { useEffect } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import type { InstrumentFocus } from '../instruments/focus';
import { useInstrumentFocus } from '../instruments/use-instrument-focus';
import { announceInstrumentFocus, writeInstrumentViewPreferences } from '../instruments/view-preferences';
import { busyGuard } from '../ui/useBusyGuard';
import { fretlightSession, nativeFretlight, useFretlightState, type FretlightBridge } from './fretlight-session';

export interface FretlightPanelProps {
  bridge?: FretlightBridge;
  /** The selected track's string count, 0 for a percussion staff, null before one is known. Only six strings are sent. */
  trackStrings: number | null;
}
const FOCUS_LABELS: ReadonlyArray<readonly [InstrumentFocus, MessageKey]> = [
  ['playing', 'instruments.focus_playing'], ['beat', 'instruments.focus_beat'], ['bar', 'instruments.focus_bar'], ['next', 'instruments.focus_next'],
];

/** The native side words a refusal with a code before the English text, so the page can say it in the player's language. */
function connectError(message: string, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  const code = /^(not_found|open_pending|open_timeout|worker_stuck|name_mismatch):/.exec(message)?.[1];
  if (code === 'name_mismatch') {
    // The names of devices that had the Fretlight ids and were not opened, as the native side lists them.
    const names = message.slice('name_mismatch: '.length).split(' | ').map(name => `“${name.trim() || t('fretlight.unnamed')}”`).join(', ');
    return t('fretlight.name_mismatch', { names });
  }
  if (code === 'worker_stuck') return t('fretlight.worker_stuck');
  if (code === 'not_found') return t('fretlight.not_found');
  if (code === 'open_pending') return t('fretlight.open_pending');
  if (code === 'open_timeout') return t('fretlight.open_timeout');
  return t('fretlight.failed', { error: message.replace(/^[a-z_]+: /, '') });
}

/**
 * Lights the notes of the selected track on a wired Fretlight guitar (THE-77). Experimental: never tried on a real guitar.
 * Nothing is looked for or opened until Connect is pressed, never at launch and never because the section was opened. The
 * session lives outside the panel, so the lights follow the score while the View menu is closed.
 */
export function FretlightPanel({ bridge = nativeFretlight, trackStrings }: FretlightPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const session = fretlightSession(bridge), state = useFretlightState(session), focus = useInstrumentFocus();
  // Attaching only listens for notices and asks what the native side holds; it lists and opens nothing.
  useEffect(() => { void session.attach(); }, [session]);
  const connected = state.phase === 'connected', connecting = state.phase === 'connecting';
  const notSixStrings = (trackStrings !== null && trackStrings !== 6) || state.frameProblem === 'not_six_string';
  const status = connected ? t('fretlight.connected', { device: state.device || t('fretlight.title') })
    : connecting ? t('fretlight.connecting') : state.phase === 'lost' ? t('fretlight.lost') : state.phase === 'disconnected' ? t('fretlight.idle') : '';
  const choose = (value: InstrumentFocus) => { writeInstrumentViewPreferences({ focus: value }); announceInstrumentFocus(value); };
  return <details className="input-preferences fretlight-panel" data-menu-keep=""><summary>{t('fretlight.title')}</summary>
    <p className="hint fretlight-experimental"><strong>{t('fretlight.experimental')}</strong></p>
    <button type="button" {...busyGuard({ busy: connecting, onClick: () => { void (connected ? session.disconnect() : session.connect()); } })}>{connected ? t('fretlight.disconnect') : t('fretlight.connect')}</button>
    {status && <p className="hint" role="status">{status}</p>}
    {state.phase === 'error' && <p role="alert">{connectError(state.message, t)}</p>}
    <label>{t('fretlight.follow')}<select value={focus} onChange={event => choose(event.target.value as InstrumentFocus)}>
      {FOCUS_LABELS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select></label>
    <p className="hint">{t('fretlight.follow_hint')}</p>
    {notSixStrings && <p className="hint" role="status">{t('fretlight.not_six_strings')}</p>}
    {state.droppedPositions > 0 && <p className="hint" role="status">{t(`fretlight.dropped_${state.droppedPositions === 1 ? 'one' : 'other'}` as MessageKey, { count: state.droppedPositions })}</p>}
    {state.unavailable && <p className="hint" role="status">{t('fretlight.unavailable', { error: state.unavailable })}</p>}
    {state.problem && <p role="alert">{t('fretlight.problem', { error: state.problem })}</p>}
    <p className="hint">{t('fretlight.hint')}</p>
  </details>;
}
