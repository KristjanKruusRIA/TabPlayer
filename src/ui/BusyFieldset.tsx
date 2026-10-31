import type { FieldsetHTMLAttributes, FocusEvent } from 'react';
import { busyRegion } from './useBusyGuard';

/** A fieldset whose controls refuse changes while busy without `disabled`, so a focused control keeps focus.
 * Built on `busyRegion`; a blur inside is refused too while busy, so an edit in progress is not committed.
 * `disabled` stays native for reasons other than busy (nothing selected). Caller handlers and class run when not busy. */
export function BusyFieldset({ busy = false, className, onBlurCapture, ...rest }: FieldsetHTMLAttributes<HTMLFieldSetElement> & { busy?: boolean }) {
  const region = busyRegion(busy);
  const merged = { ...region } as Record<string, unknown>;
  // Caller capture handlers still run while not busy; the region's refusals win while busy.
  for (const key of Object.keys(rest)) {
    const own = (rest as Record<string, unknown>)[key], guard = (region as Record<string, unknown>)[key];
    if (key.endsWith('Capture') && typeof own === 'function' && typeof guard === 'function') {
      merged[key] = (event: never) => { (guard as (e: never) => void)(event); if (!busy) (own as (e: never) => void)(event); };
      delete (rest as Record<string, unknown>)[key];
    }
  }
  const classes = [className, region.className].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset
      {...rest}
      {...merged}
      className={classes}
      onBlurCapture={(event: FocusEvent<HTMLFieldSetElement>) => {
        if (busy) { event.preventDefault(); event.stopPropagation(); return; }
        onBlurCapture?.(event);
      }}
    />
  );
}
