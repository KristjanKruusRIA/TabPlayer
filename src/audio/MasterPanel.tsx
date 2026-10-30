import { useEffect, useRef, useState } from 'react';
import { defaultMaster, masterIsNeutral } from '../document-settings';
import type { MasterSettings } from '../edit-types';
import './master-panel.css';

type Commit = (next: MasterSettings) => Promise<unknown> | void;
const signed = (value: number, digits: number) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

/** A range that follows the pointer or keys on a draft of its own, and commits once at the end of the gesture, so one
 * drag is one undoable change and one mix handed to the player. The draft is dropped when the edit settles. */
function Slider({ label, value, min, max, step, format, disabled, commit }: {
  label: string; value: number; min: number; max: number; step: number; format: (value: number) => string;
  disabled: boolean; commit: (value: number) => Promise<unknown> | void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const finish = () => {
    if (draft === null) return;
    if (draft === value) { setDraft(null); return; }
    void Promise.resolve(commit(draft)).catch(() => {}).finally(() => setDraft(null));
  };
  useEffect(() => { if (disabled) setDraft(null); }, [disabled]);
  return <label className="track-channel-range">{label} <output>{format(shown)}</output>
    <input type="range" min={min} max={max} step={step} value={shown} disabled={disabled} aria-label={label} aria-valuetext={format(shown)}
      onChange={event => setDraft(Number(event.target.value))} onPointerUp={finish} onKeyUp={finish} onBlur={finish} />
  </label>;
}

/** The master strip of the mixer: overall level and balance, then the compressor, EQ, reverb and limiter that every
 * track, the backing and the click pass through. Like the track faders it works on a finalized document, since it is
 * how a player balances playback. */
export function MasterPanel({ master, disabled, onChange }: {
  master: MasterSettings | undefined; disabled: boolean; onChange: Commit;
}): React.JSX.Element {
  const current = master ?? defaultMaster();
  const neutral = masterIsNeutral(master);
  // A change is built on the master as it stands now, not as it was drawn: a second control touched while the first
  // one's edit is still on its way would otherwise be built from the old master and put the first back. `latest`
  // holds the master with every change sent so far; it follows the prop again once nothing is in flight.
  const latest = useRef(current);
  const inFlight = useRef(0);
  const shown = useRef(current);
  shown.current = current;
  useEffect(() => { if (inFlight.current === 0) latest.current = current; });
  const send = (next: MasterSettings): Promise<unknown> => {
    latest.current = next;
    let result: Promise<unknown> | void;
    try { result = onChange(next); } catch { result = undefined; }
    if (!result || typeof (result as Promise<unknown>).then !== 'function') {
      // Settled at once; the prop is the truth again when it next renders.
      latest.current = shown.current;
      return Promise.resolve();
    }
    inFlight.current += 1;
    return Promise.resolve(result).then(() => {}, () => {
      // Refused: the player has said why. What was shown stays.
      if (inFlight.current === 1) latest.current = shown.current;
    }).finally(() => { inFlight.current -= 1; });
  };
  const change = (patch: Partial<MasterSettings>) => send({ ...latest.current, ...patch });
  const block = <K extends 'compressor' | 'eq' | 'reverb' | 'limiter'>(name: K, patch: Partial<MasterSettings[K]>) =>
    change({ [name]: { ...latest.current[name], ...patch } } as Partial<MasterSettings>);
  const on = (name: 'compressor' | 'eq' | 'reverb' | 'limiter', title: string) =>
    <label className="master-switch"><input type="checkbox" checked={current[name].enabled} disabled={disabled} onChange={event => { void block(name, { enabled: event.target.checked } as never); }} />{title} on</label>;
  const db = (value: number) => `${signed(value, 1)} dB`;
  const plain = (value: number) => value.toFixed(2);
  const balance = (value: number) => value === 0 ? 'Centre' : `${value < 0 ? 'Left' : 'Right'} ${Math.round(Math.abs(value) * 100)}%`;
  return <section className="track-channel track-master" aria-label="Master">
    <div className="track-channel-heading"><span>Master</span><span className="track-channel-status">{neutral ? 'Untouched' : 'Changed'}</span></div>
    <Slider label="Master level" value={current.gainDb} min={-24} max={12} step={.5} format={db} disabled={disabled} commit={value => change({ gainDb: value })} />
    <Slider label="Master balance" value={current.balance} min={-1} max={1} step={.05} format={balance} disabled={disabled} commit={value => change({ balance: value })} />
    <details>
      <summary>Compressor{current.compressor.enabled ? ' (on)' : ''}</summary>
      {on('compressor', 'Compressor')}
      <Slider label="Master compressor threshold" value={current.compressor.thresholdDb} min={-60} max={0} step={1} format={db} disabled={disabled} commit={value => block('compressor', { thresholdDb: value })} />
      <Slider label="Master compressor ratio" value={current.compressor.ratio} min={1} max={20} step={.1} format={value => `${value.toFixed(1)}:1`} disabled={disabled} commit={value => block('compressor', { ratio: value })} />
      <Slider label="Master compressor attack" value={current.compressor.attackMs} min={.1} max={200} step={.1} format={value => `${value.toFixed(1)} ms`} disabled={disabled} commit={value => block('compressor', { attackMs: value })} />
      <Slider label="Master compressor release" value={current.compressor.releaseMs} min={1} max={2000} step={1} format={value => `${value.toFixed(0)} ms`} disabled={disabled} commit={value => block('compressor', { releaseMs: value })} />
      <Slider label="Master compressor makeup" value={current.compressor.makeupDb} min={0} max={24} step={.1} format={db} disabled={disabled} commit={value => block('compressor', { makeupDb: value })} />
    </details>
    <details>
      <summary>EQ{current.eq.enabled ? ' (on)' : ''}</summary>
      {on('eq', 'EQ')}
      <Slider label="Master EQ low" value={current.eq.lowDb} min={-24} max={24} step={.5} format={db} disabled={disabled} commit={value => block('eq', { lowDb: value })} />
      <Slider label="Master EQ mid" value={current.eq.midDb} min={-24} max={24} step={.5} format={db} disabled={disabled} commit={value => block('eq', { midDb: value })} />
      <Slider label="Master EQ mid frequency" value={current.eq.midHz} min={200} max={5000} step={50} format={value => `${value.toFixed(0)} Hz`} disabled={disabled} commit={value => block('eq', { midHz: value })} />
      <Slider label="Master EQ high" value={current.eq.highDb} min={-24} max={24} step={.5} format={db} disabled={disabled} commit={value => block('eq', { highDb: value })} />
    </details>
    <details>
      <summary>Reverb{current.reverb.enabled ? ' (on)' : ''}</summary>
      {on('reverb', 'Reverb')}
      <label className="master-select">Master reverb model<select aria-label="Master reverb model" value={current.reverb.model} disabled={disabled} onChange={event => { void block('reverb', { model: event.target.value as MasterSettings['reverb']['model'] }); }}>
        <option value="room">Room</option><option value="hall">Hall</option><option value="plate">Plate</option><option value="spring">Spring</option>
      </select></label>
      <Slider label="Master reverb send" value={current.reverb.mix} min={0} max={1} step={.01} format={plain} disabled={disabled} commit={value => block('reverb', { mix: value })} />
      <Slider label="Master reverb room" value={current.reverb.room} min={0} max={1} step={.01} format={plain} disabled={disabled} commit={value => block('reverb', { room: value })} />
      <Slider label="Master reverb damping" value={current.reverb.damping} min={0} max={1} step={.01} format={plain} disabled={disabled} commit={value => block('reverb', { damping: value })} />
    </details>
    <details>
      <summary>Limiter{current.limiter.enabled ? ' (on)' : ''}</summary>
      {on('limiter', 'Limiter')}
      <Slider label="Master limiter ceiling" value={current.limiter.ceilingDb} min={-12} max={0} step={.5} format={db} disabled={disabled} commit={value => block('limiter', { ceilingDb: value })} />
      <Slider label="Master limiter release" value={current.limiter.releaseMs} min={10} max={1000} step={10} format={value => `${value.toFixed(0)} ms`} disabled={disabled} commit={value => block('limiter', { releaseMs: value })} />
    </details>
    <button type="button" disabled={disabled || !master || JSON.stringify(master) === JSON.stringify(defaultMaster())} onClick={() => { void send(defaultMaster()); }}>Reset master</button>
  </section>;
}
