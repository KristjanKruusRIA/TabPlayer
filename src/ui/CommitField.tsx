import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * A text or number field that records one change when the person leaves it or presses Enter, and nothing when the text is
 * what the document already has (a number is compared as a number, so "120.0" is 120). Escape puts the document's value back.
 *
 * The change belongs to the thing the field showed when typing began: `target` names that thing (a track, a staff), and
 * `onCommit` is handed it back with the text, so a commit made after the selection moved still reaches the thing it was typed
 * for and never another.
 *
 * What happens to a draft that has not been recorded:
 * - the field is left: it is recorded;
 * - `target` changes (the selection moved before the field was left): it is recorded at once for its own target, or dropped
 *   when an edit is in flight, and the field shows the new target;
 * - the field is left while an edit is in flight (the surrounding `BusyFieldset` refuses that blur, so it is seen from the
 *   browser's own event): it is recorded when that edit ends, still for the same target, which cannot have changed or the
 *   draft would have been dropped above;
 * - the value changes under it (an undo, another score) or the field is unmounted (another document): it is dropped. Nothing is
 *   ever written after the field is gone, so a draft cannot reach a different document.
 * A commit that is refused (`onCommit` returns false, or its edit resolves false) puts the document's value back on screen.
 */
export function CommitField({ label, value, onCommit, target = '', busy = false, multiline = false, type = 'text', min, max, disabled = false, hideLabel = false, className, placeholder }: {
  label: string;
  value: string;
  /** Called with the text and the `target` the field had when typing began. Return false (or a promise of false) when the change was refused or is nothing. */
  onCommit: (value: string, target: string) => unknown;
  /** What the field edits (a track, a staff); it changes when the selection moves. */
  target?: string;
  /** An edit is in flight. */
  busy?: boolean;
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
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const latest = useRef({ value, onCommit, busy, target });
  latest.current = { value, onCommit, busy, target };
  const text = useRef(value);
  /** Set when typing begins, cleared when the draft is recorded or dropped: the field's value and target at that moment. */
  const origin = useRef<{ target: string; base: string } | null>(null);
  /** The field lost focus while an edit was in flight. */
  const left = useRef(false);
  const same = (a: string, b: string) => type === 'number' ? a.trim() !== '' && Number(a) === Number(b) : a === b;
  const show = (next: string) => { text.current = next; setDraft(next); };
  const drop = () => { origin.current = null; left.current = false; show(latest.current.value); };
  /** Records the draft for the target it was typed for; nothing, or a number that is not one, puts the document's value back. */
  const flush = () => {
    const from = origin.current;
    if (!from) return;
    const typed = text.current;
    origin.current = null;
    left.current = false;
    if (type === 'number' && !(typed.trim() !== '' && Number.isFinite(Number(typed)))) { show(latest.current.value); return; }
    if (same(typed, from.base)) { show(latest.current.value); return; }
    const revert = () => { if (field.current) show(latest.current.value); };
    const result = latest.current.onCommit(typed, from.target);
    // The typed text stays on screen while the edit is made and the value follows it; a refused change goes.
    if (result === false) revert();
    else if (result instanceof Promise) result.then(landed => { if (landed === false) revert(); }, revert);
  };
  useEffect(() => {
    const from = origin.current;
    if (from && from.target !== target && !latest.current.busy) flush();
    drop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, target]);
  useEffect(() => () => { origin.current = null; }, []);
  // The surrounding fieldset refuses a blur while busy before React sees it, so the field notes it from the browser's own event.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    const note = () => { if (latest.current.busy) left.current = true; };
    node.addEventListener('blur', note);
    return () => node.removeEventListener('blur', note);
  }, []);
  // A draft left while an edit was in flight is recorded when that edit ends.
  useEffect(() => {
    if (!busy && left.current && origin.current) flush();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const settle = () => { if (!latest.current.busy) flush(); };
  const change = (next: string) => {
    if (!origin.current) origin.current = { target: latest.current.target, base: latest.current.value };
    show(next);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && origin.current) { event.preventDefault(); event.stopPropagation(); drop(); return; }
    if (event.key === 'Enter' && !multiline) { event.preventDefault(); settle(); }
  };
  const control = multiline
    ? <textarea ref={field} id={id} value={draft} disabled={disabled} placeholder={placeholder} onChange={event => change(event.target.value)} onFocus={() => { left.current = false; }} onBlur={settle} onKeyDown={keys} />
    : <input ref={field} id={id} type={type} min={min} max={max} value={draft} disabled={disabled} placeholder={placeholder} title={hideLabel ? label : undefined} aria-label={hideLabel ? label : undefined} onChange={event => change(event.target.value)} onFocus={() => { left.current = false; }} onBlur={settle} onKeyDown={keys} />;
  return hideLabel ? control : <label className={className} htmlFor={id}>{label}{control}</label>;
}
