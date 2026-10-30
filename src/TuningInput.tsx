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
  placeholder,
  revision,
  error,
  inputRef,
  onAudition,
}: {
  label: string;
  presetLabel: string;
  value: string;
  onChange: (notes: string) => void;
  tuningName: string;
  onTuningNameChange: (name: string) => void;
  onCommit?: (pitches: number[]) => void;
  disabled?: boolean;
  placeholder?: string;
  revision?: object;
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
  onAudition?: (pitches: number[], strum: boolean) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [library, setLibrary] = useState(false);
  useEffect(() => setCustom(false), [value, revision]);
  useEffect(() => {
    if (disabled) setLibrary(false);
  }, [disabled]);
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

  const dragRef = useRef<{ index: number; startY: number; startPitch: number; latest: number[] } | null>(null);

  const updateStringPitch = (index: number, nextPitch: number, commit: boolean) => {
    if (disabled || !parsedPitches) return;
    const clamped = Math.max(0, Math.min(127, Math.round(nextPitch)));
    const next = parsedPitches.map((p, i) => (i === index ? clamped : p));
    setCustom(false);
    onChange(formatTuning(next));
    onTuningNameChange('');
    if (commit) onCommit?.(next);
  };

  const handlePegPointerDown = (index: number, pitch: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !parsedPitches) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { index, startY: event.clientY, startPitch: pitch, latest: [...parsedPitches] };
  };

  const handlePegPointerMove = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.index !== index || disabled || !parsedPitches) return;
    const deltaSemitones = Math.round((dragRef.current.startY - event.clientY) / 8);
    const nextPitch = Math.max(0, Math.min(127, dragRef.current.startPitch + deltaSemitones));
    const next = dragRef.current.latest.map((p, i) => (i === index ? nextPitch : p));
    dragRef.current.latest = next;
    setCustom(false);
    onChange(formatTuning(next));
    onTuningNameChange('');
  };

  const handlePegPointerUp = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.index !== index) return;
    const committed = dragRef.current.latest;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit?.(committed);
  };

  const handlePegKeyDown = (index: number, pitch: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || !parsedPitches) return;
    let delta = 0;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') delta = event.shiftKey ? 12 : 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') delta = event.shiftKey ? -12 : -1;
    else if (event.key === 'PageUp') delta = 12;
    else if (event.key === 'PageDown') delta = -12;
    else return;
    event.preventDefault();
    updateStringPitch(index, pitch + delta, true);
  };

  const handlePegWheel = (index: number, pitch: number, event: ReactWheelEvent<HTMLDivElement>) => {
    if (disabled || !parsedPitches || event.deltaY === 0) return;
    event.preventDefault();
    updateStringPitch(index, pitch + (event.deltaY < 0 ? 1 : -1), true);
  };

  return (
    <>
      <label>
        {presetLabel}
        <select
          disabled={disabled}
          value={selected}
          onChange={e => {
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
            placeholder={placeholder}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={e => {
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
          <div className="tp-tuning-pegs" role="group" aria-label={`${label} string pegs`}>
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
            <div className="tp-tuning-peg-strip">
              {parsedPitches.map((pitch, index) => {
                const deg = (pitch % 12) * 30;
                const noteText = formatPitch(pitch);
                return (
                  <div key={index} className="tp-tuning-peg-cell">
                    <span className="tp-peg-string-num" aria-hidden="true">
                      S{index + 1}
                    </span>
                    <div
                      role="slider"
                      tabIndex={disabled ? -1 : 0}
                      aria-disabled={disabled || undefined}
                      aria-label={`${label} string ${index + 1} peg`}
                      aria-valuemin={0}
                      aria-valuemax={127}
                      aria-valuenow={pitch}
                      aria-valuetext={noteText}
                      className="tp-peg-dial"
                      onPointerDown={e => handlePegPointerDown(index, pitch, e)}
                      onPointerMove={e => handlePegPointerMove(index, e)}
                      onPointerUp={e => handlePegPointerUp(index, e)}
                      onKeyDown={e => handlePegKeyDown(index, pitch, e)}
                      onWheel={e => handlePegWheel(index, pitch, e)}
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
                        className="tp-peg-step"
                        disabled={disabled || pitch <= 0}
                        aria-label={`Tune ${label} string ${index + 1} down`}
                        onClick={() => updateStringPitch(index, pitch - 1, true)}
                      >
                        −
                      </button>
                      <button
                        type="button"
                        className="tp-peg-step"
                        disabled={disabled || pitch >= 127}
                        aria-label={`Tune ${label} string ${index + 1} up`}
                        onClick={() => updateStringPitch(index, pitch + 1, true)}
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
          className="tuning-saved-button"
          disabled={disabled}
          aria-label={`Saved tunings for ${label}`}
          onClick={() => setLibrary(true)}
        >
          Saved tunings…
        </button>
        {audible && onAudition && (
          <AuditionButtons pitches={audible} disabled={disabled} label={label} onAudition={onAudition} />
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
