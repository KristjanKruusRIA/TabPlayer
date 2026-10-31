import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { formatPitch, formatTuning, parseTuning } from './tuning';
import { findTuningPreset, tuningPresets } from './tuning-presets';
import { SavedTuningsDialog } from './tuning/SavedTuningsDialog';
import { AuditionButtons } from './tuning/AuditionButtons';
import { busyGuard } from './ui/useBusyGuard';

const groups = [...new Set(tuningPresets.map(p => `${p.instrument}/${p.strings}`))];

export function TuningInput({
  label,
  presetLabel,
  value,
  onChange,
  tuningName,
  onTuningNameChange,
  onCommit,
  disabled = false,
  busy = false,
  placeholder,
  revision,
  error,
  inputRef,
  onAudition,
  stringCount,
}: {
  label: string;
  presetLabel: string;
  value: string;
  onChange: (notes: string) => void;
  tuningName: string;
  onTuningNameChange: (name: string) => void;
  /** One call per gesture group: `pitches` is the whole draft, `changed` the ascending string indexes the gesture touched. */
  onCommit?: (pitches: number[], changed: number[]) => void;
  /** Unavailable for a reason other than busy (locked, no strings); native `disabled`. */
  disabled?: boolean;
  /** An edit is in flight: controls stay focusable, refuse changes and say aria-disabled. */
  busy?: boolean;
  placeholder?: string;
  revision?: object;
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
  onAudition?: (pitches: number[], strum: boolean) => void;
  stringCount?: number;
}) {
  const [custom, setCustom] = useState(false);
  const [library, setLibrary] = useState(false);
  useEffect(() => setCustom(false), [value, revision]);
  useEffect(() => {
    if (disabled || busy) setLibrary(false);
  }, [disabled, busy]);
  useEffect(() => setLibrary(false), [revision]);

  const errorId = useId();
  const errorElement = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (error) errorElement.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  const parsedPitches = useMemo(() => {
    try {
      return parseTuning(value);
    } catch {
      return null;
    }
  }, [value]);

  const audible = onAudition ? parsedPitches : null;
  const selected = custom ? 'custom' : (findTuningPreset(value)?.id ?? 'custom');

  const dragRef = useRef<{ index: number; startY: number; startPitch: number; initialPitches: number[]; latest: number[]; initialTuningName: string } | null>(null);
  const wheelRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: number[] | null;
    base: number[];
    baseName: string;
    changed: Set<number>;
  }>({ timer: null, pending: null, base: [], baseName: '', changed: new Set() });
  const latest = useRef({ onCommit, onChange, onTuningNameChange, busy, disabled });
  latest.current = { onCommit, onChange, onTuningNameChange, busy, disabled };
  const blocked = disabled || busy;

  const clearWheel = () => {
    const wheel = wheelRef.current;
    if (wheel.timer) clearTimeout(wheel.timer);
    wheel.timer = null;
    wheel.pending = null;
    wheel.changed = new Set();
  };
  /** Takes the wheel gesture still waiting for its timer, so a later gesture commits in the same edit. */
  const takeWheelChanged = () => {
    const changed = [...wheelRef.current.changed];
    clearWheel();
    return changed;
  };
  useEffect(() => clearWheel, []);
  // A new document revision (undo, redo, another edit) has already replaced the draft; the pending wheel change is stale.
  useEffect(() => clearWheel(), [revision]);
  const flushWheel = () => {
    const wheel = wheelRef.current;
    const { pending, base, baseName } = wheel;
    const changed = [...wheel.changed].sort((a, b) => a - b);
    clearWheel();
    if (!pending) return;
    const now = latest.current;
    if (now.busy || now.disabled) {
      now.onChange(formatTuning(base));
      now.onTuningNameChange(baseName);
      return;
    }
    now.onCommit?.(pending, changed);
  };

  const pegElements = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevWheelListeners = useRef<Map<number, (e: WheelEvent) => void>>(new Map());
  const registerPeg = (index: number, el: HTMLDivElement | null) => {
    const prev = pegElements.current.get(index);
    if (prev) {
      const l = prevWheelListeners.current.get(index);
      if (l) prev.removeEventListener('wheel', l);
      pegElements.current.delete(index);
    }
    if (el) {
      pegElements.current.set(index, el);
      const listener = (e: WheelEvent) => handlePegWheel(index, e);
      prevWheelListeners.current.set(index, listener);
      el.addEventListener('wheel', listener, { passive: false });
    }
  };

  useEffect(() => {
    return () => {
      pegElements.current.forEach((el, index) => {
        const l = prevWheelListeners.current.get(index);
        if (l) el.removeEventListener('wheel', l);
      });
    };
  }, []);

  const commitPitches = (pitches: number[], index: number) => {
    const changed = [...new Set([...takeWheelChanged(), index])].sort((a, b) => a - b);
    onCommit?.(pitches, changed);
  };

  const updateStringPitch = (index: number, nextPitch: number, commit: boolean) => {
    if (blocked || !parsedPitches || (stringCount !== undefined && index >= stringCount)) return;
    const clamped = Math.max(0, Math.min(127, Math.round(nextPitch)));
    if (clamped === parsedPitches[index]) return;
    const next = parsedPitches.map((p, i) => (i === index ? clamped : p));
    setCustom(false);
    onChange(formatTuning(next));
    onTuningNameChange('');
    if (commit) commitPitches(next, index);
  };

  const handlePegPointerDown = (index: number, pitch: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (blocked || !parsedPitches || (stringCount !== undefined && index >= stringCount) || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      index,
      startY: event.clientY,
      startPitch: pitch,
      initialPitches: [...parsedPitches],
      latest: [...parsedPitches],
      initialTuningName: tuningName,
    };
  };

  const handlePegPointerMove = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.index !== index || blocked || !parsedPitches) return;
    const deltaSemitones = Math.round((dragRef.current.startY - event.clientY) / 8);
    const nextPitch = Math.max(0, Math.min(127, dragRef.current.startPitch + deltaSemitones));
    if (nextPitch === dragRef.current.latest[index]) return;
    const next = dragRef.current.latest.map((p, i) => (i === index ? nextPitch : p));
    dragRef.current.latest = next;
    const isInitial = next.every((p, i) => p === dragRef.current!.initialPitches[i]);
    setCustom(false);
    onChange(formatTuning(next));
    onTuningNameChange(isInitial ? dragRef.current.initialTuningName : '');
  };

  const handlePegPointerUp = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.index !== index) return;
    const { initialPitches, initialTuningName, latest } = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    }
    if (blocked) {
      setCustom(false);
      onChange(formatTuning(initialPitches));
      onTuningNameChange(initialTuningName);
      return;
    }
    const changed = latest.some((p, i) => p !== initialPitches[i]);
    if (changed) {
      commitPitches(latest, index);
    } else {
      onTuningNameChange(initialTuningName);
    }
  };

  const handlePegPointerCancel = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.index !== index) return;
    const { initialPitches, initialTuningName } = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    }
    setCustom(false);
    onChange(formatTuning(initialPitches));
    onTuningNameChange(initialTuningName);
  };

  const handlePegKeyDown = (index: number, pitch: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (blocked || !parsedPitches || (stringCount !== undefined && index >= stringCount)) return;
    let delta = 0;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') delta = event.shiftKey ? 12 : 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') delta = event.shiftKey ? -12 : -1;
    else if (event.key === 'PageUp') delta = 12;
    else if (event.key === 'PageDown') delta = -12;
    else return;
    event.preventDefault();
    if (event.repeat) return;
    updateStringPitch(index, pitch + delta, true);
  };

  const handlePegWheel = (index: number, event: ReactWheelEvent<HTMLDivElement> | WheelEvent) => {
    if (blocked || !parsedPitches || (stringCount !== undefined && index >= stringCount) || !('deltaY' in event) || event.deltaY === 0) return;
    const targetElement = (event.currentTarget ?? event.target) as HTMLElement | null;
    if (document.activeElement !== targetElement) return;
    event.preventDefault();
    const wheel = wheelRef.current;
    const currentBase = wheel.pending ?? parsedPitches;
    const currentPitch = currentBase[index];
    const delta = event.deltaY < 0 ? 1 : -1;
    const nextPitch = Math.max(0, Math.min(127, currentPitch + delta));
    if (nextPitch === currentPitch) return;
    const next = currentBase.map((p, i) => (i === index ? nextPitch : p));
    if (!wheel.pending) {
      wheel.base = [...parsedPitches];
      wheel.baseName = tuningName;
    }
    wheel.pending = next;
    wheel.changed.add(index);
    setCustom(false);
    onChange(formatTuning(next));
    onTuningNameChange('');
    if (wheel.timer) clearTimeout(wheel.timer);
    wheel.timer = setTimeout(flushWheel, 300);
  };

  return (
    <>
      <label>
        {presetLabel}
        <select
          disabled={disabled}
          aria-disabled={busy || undefined}
          value={selected}
          onMouseDown={busy ? e => e.preventDefault() : undefined}
          onChange={e => {
            if (busy) return;
            if (e.target.value === 'custom') {
              setCustom(true);
              return;
            }
            const preset = tuningPresets.find(p => p.id === e.target.value);
            if (preset) {
              setCustom(false);
              onChange(formatTuning(preset.tuning));
              onTuningNameChange(preset.name);
            }
          }}
        >
          <option value="custom">Custom</option>
          {groups.map(group => {
            const presets = tuningPresets.filter(p => `${p.instrument}/${p.strings}` === group);
            const first = presets[0];
            return (
              <optgroup
                key={group}
                label={`${first.instrument === 'guitar' ? 'Guitar' : 'Bass'} · ${first.strings} strings`}
              >
                {presets.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>
      <div className="tuning-field">
        <label>
          {label}
          <input
            ref={inputRef}
            disabled={disabled}
            readOnly={busy || undefined}
            aria-disabled={busy || undefined}
            placeholder={placeholder}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={e => {
              if (busy) return;
              setCustom(false);
              onChange(e.target.value);
              onTuningNameChange('');
            }}
          />
        </label>
        {error && (
          <span id={errorId} ref={errorElement} role="alert" className="tuning-error">
            {error}
          </span>
        )}
        {parsedPitches && parsedPitches.length > 0 && (
          <div
            className="tp-tuning-pegs"
            data-compact={parsedPitches.length >= 7 ? 'true' : undefined}
            role="group"
            aria-label={`${label} string pegs`}
          >
            <svg
              viewBox={`0 0 ${Math.max(160, parsedPitches.length * 36)} 32`}
              className="tp-tuning-headstock-svg"
              aria-hidden="true"
            >
              <rect
                x="4"
                y="4"
                width={Math.max(152, parsedPitches.length * 36 - 8)}
                height="24"
                rx="6"
                className="tp-headstock-body"
              />
              <line
                x1="10"
                y1="26"
                x2={Math.max(150, parsedPitches.length * 36 - 10)}
                y2="26"
                className="tp-headstock-nut"
              />
              {parsedPitches.map((pitch, index) => {
                const count = parsedPitches.length;
                const width = Math.max(160, count * 36);
                const x = ((index + 0.5) / count) * (width - 24) + 12;
                const angle = ((pitch % 12) * 30 * Math.PI) / 180;
                const ix = x + Math.sin(angle) * 5;
                const iy = 14 - Math.cos(angle) * 5;
                return (
                  <g key={index}>
                    <line
                      x1={x}
                      y1={26}
                      x2={x}
                      y2={14}
                      className="tp-headstock-string"
                      strokeWidth={0.9 + (index / Math.max(1, count - 1)) * 1.3}
                    />
                    <circle cx={x} cy={14} r={6.5} className="tp-headstock-post" />
                    <line x1={x} y1={14} x2={ix} y2={iy} className="tp-headstock-indicator" />
                  </g>
                );
              })}
            </svg>
            <div
              className="tp-tuning-peg-strip"
              data-compact={parsedPitches.length >= 7 ? 'true' : undefined}
              style={{
                gridTemplateColumns: `repeat(${parsedPitches.length}, minmax(${parsedPitches.length >= 9 ? '20px' : '0'}, 1fr))`,
                ...(parsedPitches.length >= 7 ? { gap: '2px' } : {}),
                overflowX: 'auto',
              }}
            >
              {parsedPitches.map((pitch, index) => {
                const isOutOfRange = stringCount !== undefined && index >= stringCount;
                const deg = (pitch % 12) * 30;
                const noteText = formatPitch(pitch);
                return (
                  <div key={index} className="tp-tuning-peg-cell">
                    <span className="tp-peg-string-num" aria-hidden="true">
                      S{index + 1}
                    </span>
                    <div
                      ref={el => registerPeg(index, el)}
                      role="slider"
                      tabIndex={isOutOfRange ? -1 : 0}
                      aria-disabled={blocked || isOutOfRange || undefined}
                      aria-label={`${label} string ${index + 1} peg`}
                      aria-valuemin={0}
                      aria-valuemax={127}
                      aria-valuenow={pitch}
                      aria-valuetext={noteText}
                      className="tp-peg-dial"
                      onPointerDown={e => handlePegPointerDown(index, pitch, e)}
                      onPointerMove={e => handlePegPointerMove(index, e)}
                      onPointerUp={e => handlePegPointerUp(index, e)}
                      onPointerCancel={e => handlePegPointerCancel(index, e)}
                      onLostPointerCapture={e => handlePegPointerCancel(index, e)}
                      onKeyDown={e => handlePegKeyDown(index, pitch, e)}
                    >
                      <svg viewBox="0 0 28 24" width="24" height="20" aria-hidden="true" className="tp-peg-svg">
                        <g transform={`rotate(${deg} 14 12)`}>
                          <rect x="3" y="8.5" width="22" height="7" rx="3.5" className="tp-peg-wing" />
                        </g>
                        <circle cx="14" cy="12" r="4.5" className="tp-peg-cap" />
                      </svg>
                      <span className="tp-peg-pitch">{noteText}</span>
                    </div>
                    <div className="tp-peg-steps">
                      <button
                        type="button"
                        aria-label={`Tune ${label} string ${index + 1} down`}
                        {...busyGuard({
                          busy,
                          className: 'tp-peg-step',
                          disabled: isOutOfRange,
                          unavailable: disabled || pitch <= 0,
                          onClick: () => updateStringPitch(index, pitch - 1, true),
                        })}
                      >
                        −
                      </button>
                      <button
                        type="button"
                        aria-label={`Tune ${label} string ${index + 1} up`}
                        {...busyGuard({
                          busy,
                          className: 'tp-peg-step',
                          disabled: isOutOfRange,
                          unavailable: disabled || pitch >= 127,
                          onClick: () => updateStringPitch(index, pitch + 1, true),
                        })}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <button
          type="button"
          aria-label={`Saved tunings for ${label}`}
          {...busyGuard({ busy, disabled, className: 'tuning-saved-button', onClick: () => setLibrary(true) })}
        >
          Saved tunings…
        </button>
        {audible && onAudition && (
          <AuditionButtons pitches={audible} disabled={disabled} busy={busy} label={label} onAudition={onAudition} />
        )}
      </div>
      {library && (
        <SavedTuningsDialog
          onAudition={onAudition}
          notes={value}
          name={tuningName}
          onClose={() => setLibrary(false)}
          onUse={(notes, name) => {
            setCustom(false);
            onChange(notes);
            onTuningNameChange(name);
          }}
        />
      )}
    </>
  );
}
