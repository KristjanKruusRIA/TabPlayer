import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * A text or number field that records one change when the person leaves it or presses Enter, and nothing when the text is
 * what the document already has. Escape puts the document's value back. It follows `value` when that changes (an undo, another score).
 * Blur is refused by a surrounding `BusyFieldset` while an edit is pending, so the draft stays until the field is left again.
 */
export function CommitField({ label, value, onCommit, multiline = false, type = 'text', min, max, disabled = false, hideLabel = false, className, placeholder }: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  disabled?: boolean;
  /** The label is only for assistive technology and the tooltip. */
  hideLabel?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => { setDraft(value); }, [value]);
  const settle = () => {
    if (draft === latest.current) return;
    if (type === 'number' && !(draft.trim() !== '' && Number.isFinite(Number(draft)))) { setDraft(latest.current); return; }
    onCommit(draft);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && draft !== latest.current) { event.preventDefault(); event.stopPropagation(); setDraft(latest.current); return; }
    if (event.key === 'Enter' && !multiline) { event.preventDefault(); settle(); }
  };
  const field = multiline
    ? <textarea id={id} value={draft} disabled={disabled} placeholder={placeholder} onChange={event => setDraft(event.target.value)} onBlur={settle} onKeyDown={keys} />
    : <input id={id} type={type} min={min} max={max} value={draft} disabled={disabled} placeholder={placeholder} title={hideLabel ? label : undefined} aria-label={hideLabel ? label : undefined} onChange={event => setDraft(event.target.value)} onBlur={settle} onKeyDown={keys} />;
  return hideLabel ? field : <label className={className} htmlFor={id}>{label}{field}</label>;
}
