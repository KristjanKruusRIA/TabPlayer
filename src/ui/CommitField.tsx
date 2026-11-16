import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * A text or number field that records one change when the person leaves it or presses Enter, and nothing when the text is
 * what the document already has (a number is compared as a number, so "120.0" is 120). Escape puts the document's value back.
 * It follows `value` when that changes (an undo, another score).
 *
 * The change belongs to the thing the field showed when typing began: `target` names that thing (a track, a staff), and
 * `onCommit` is handed it back with the text, so a commit that happens after the selection moved still reaches the thing it
 * was typed for and never another. When `target` changes with a half-typed draft, the draft is committed to its own target
 * before the field shows the new one. While `busy` (an edit is in flight) a blur is refused by the surrounding `BusyFieldset`,
 * so the draft is kept and applied, still as one edit to its own target, as soon as the pending edit ends and the field is not
 * being typed in.
 */
export function CommitField({ label, value, onCommit, target = '', busy = false, multiline = false, type = 'text', min, max, disabled = false, hideLabel = false, className, placeholder }: {
  label: string;
  value: string;
  /** Called with the text and the `target` the field had when typing began. */
  onCommit: (value: string, target: string) => void;
  /** What the field edits (for instance a track's identity and a staff); it changes when the selection moves. */
  target?: string;
  /** An edit is in flight: a draft that was left meanwhile is applied when it ends. */
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
  const same = (a: string, b: string) => type === 'number' ? a.trim() !== '' && Number(a) === Number(b) : a === b;
  const show = (next: string) => { text.current = next; setDraft(next); };
  /** Records the draft for the target it was typed for, or puts the document's value back when it is nothing or not a number. */
  const flush = () => {
    const from = origin.current;
    if (!from) return;
    origin.current = null;
    const typed = text.current, now = latest.current;
    if (type === 'number' && !(typed.trim() !== '' && Number.isFinite(Number(typed)))) { show(now.value); return; }
    if (same(typed, from.base)) { if (from.target === now.target) show(now.value); return; }
    now.onCommit(typed, from.target);
    if (from.target !== now.target) show(now.value);
  };
  useEffect(() => {
    const from = origin.current;
    if (from && from.target !== target) { if (!latest.current.busy) flush(); return; }
    origin.current = null;
    show(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, target]);
  // A draft left while an edit was in flight is applied when it ends; one still being typed in is left alone.
  useEffect(() => {
    if (busy || !origin.current) return;
    if (origin.current.target === target && document.activeElement === field.current) return;
    flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const settle = () => { if (!latest.current.busy) flush(); };
  const change = (next: string) => {
    if (!origin.current) origin.current = { target: latest.current.target, base: latest.current.value };
    show(next);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && origin.current) { event.preventDefault(); event.stopPropagation(); origin.current = null; show(latest.current.value); return; }
    if (event.key === 'Enter' && !multiline) { event.preventDefault(); settle(); }
  };
  const control = multiline
    ? <textarea ref={field} id={id} value={draft} disabled={disabled} placeholder={placeholder} onChange={event => change(event.target.value)} onBlur={settle} onKeyDown={keys} />
    : <input ref={field} id={id} type={type} min={min} max={max} value={draft} disabled={disabled} placeholder={placeholder} title={hideLabel ? label : undefined} aria-label={hideLabel ? label : undefined} onChange={event => change(event.target.value)} onBlur={settle} onKeyDown={keys} />;
  return hideLabel ? control : <label className={className} htmlFor={id}>{label}{control}</label>;
}
