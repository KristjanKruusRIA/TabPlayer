import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, SelectHTMLAttributes } from 'react';

const browsing = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * A select that records one change per choice. A choice made with the pointer (or from the open list) is recorded at once.
 * Arrow, Home, End and Page keys on the closed select change its value once per key press, so those are only browsing: the
 * value shown follows them, and the choice is recorded when the select is left or Enter is pressed. Escape puts the recorded
 * value back.
 *
 * A browsed choice that has not been recorded is dropped, never carried over or applied later: the select shows the document's
 * value again when `target` (what the select edits: a track, a staff) changes, when the value changes (an undo), and when the
 * select is left while an edit is in flight (the surrounding `BusyFieldset` refuses that blur, so it is seen from the browser's
 * own event). A browsed choice therefore can only be recorded for the target it was browsed for.
 */
export function CommitSelect({ value, onCommit, target = '', busy = false, children, onKeyDown, onKeyUp, onBlur, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
  value: string | number;
  /** Called with the chosen option's value. */
  onCommit: (value: string) => unknown;
  /** What the select edits; a browsed choice is dropped when it changes. */
  target?: string;
  /** An edit is in flight: a select left now drops its browsed choice. */
  busy?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const field = useRef<HTMLSelectElement>(null);
  const latest = useRef({ value: String(value), onCommit, busy, target });
  latest.current = { value: String(value), onCommit, busy, target };
  /** The target the shown choice was made for: a choice is never recorded for another one, even before the reset below has run. */
  const shownFor = useRef(target);
  const shown = useRef(String(value));
  const arrow = useRef(false);
  const show = (next: string) => { shown.current = next; setDraft(next); };
  useEffect(() => { show(String(value)); }, [value, target]);
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    const left = () => { if (latest.current.busy) show(latest.current.value); };
    node.addEventListener('blur', left);
    return () => node.removeEventListener('blur', left);
  }, []);
  const settle = () => {
    if (shown.current === latest.current.value || latest.current.busy) return;
    if (shownFor.current !== latest.current.target) { show(latest.current.value); return; }
    // A refused choice (false, or a refused edit) is not kept on screen.
    const result = latest.current.onCommit(shown.current);
    if (result === false) show(latest.current.value);
    else if (result instanceof Promise) result.then(landed => { if (landed === false) show(latest.current.value); }, () => show(latest.current.value));
  };
  const change = (event: ChangeEvent<HTMLSelectElement>) => {
    shownFor.current = latest.current.target;
    show(event.target.value);
    if (!arrow.current) settle();
  };
  return <select
    {...rest}
    ref={field}
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
