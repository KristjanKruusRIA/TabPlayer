import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, SelectHTMLAttributes } from 'react';

const browsing = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * A select that records one change per choice. A choice made with the pointer (or from the open list) is recorded at once. Arrow,
 * Home, End and Page keys on the closed select change its value once per key press, so those are only browsing: the value shown
 * follows them, and the choice is recorded when the select is left or Enter is pressed, not for every key. Escape puts the
 * recorded value back. It follows `value` when that changes (an undo, another score).
 */
export function CommitSelect({ value, onCommit, children, onKeyDown, onKeyUp, onBlur, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
  value: string | number;
  /** Called with the chosen option's value. */
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const latest = useRef({ value: String(value), onCommit });
  latest.current = { value: String(value), onCommit };
  const shown = useRef(String(value));
  const arrow = useRef(false);
  const show = (next: string) => { shown.current = next; setDraft(next); };
  useEffect(() => { show(String(value)); }, [value]);
  const settle = () => {
    if (shown.current === latest.current.value) return;
    latest.current.onCommit(shown.current);
  };
  const change = (event: ChangeEvent<HTMLSelectElement>) => {
    show(event.target.value);
    if (!arrow.current) settle();
  };
  return <select
    {...rest}
    value={draft}
    onChange={change}
    onBlur={event => { arrow.current = false; settle(); onBlur?.(event); }}
    onKeyDown={(event: KeyboardEvent<HTMLSelectElement>) => {
      if (browsing.has(event.key) && !event.altKey) arrow.current = true;
      else if (event.key === 'Enter') { event.preventDefault(); settle(); }
      else if (event.key === 'Escape' && shown.current !== latest.current.value) { event.preventDefault(); event.stopPropagation(); show(latest.current.value); }
      onKeyDown?.(event);
    }}
    onKeyUp={event => { arrow.current = false; onKeyUp?.(event); }}
  >{children}</select>;
}
