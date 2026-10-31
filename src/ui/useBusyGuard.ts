import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';

export interface BusyGuardProps<T = HTMLElement> {
  busy?: boolean;
  /** Unavailable for a reason other than busy; the control keeps `disabled` off the element, so it can hold focus. */
  unavailable?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent<T>) => void;
  onKeyDown?: (event: KeyboardEvent<T>) => void;
  onKeyUp?: (event: KeyboardEvent<T>) => void;
  onPointerDown?: (event: PointerEvent<T>) => void;
  className?: string;
}

/** Gives aria-disabled="true", a class matching the :disabled look, and handlers that refuse activation while busy.
 * A control that may hold focus never gets the `disabled` attribute because of `busy`. */
export function busyGuard<T extends HTMLElement = HTMLButtonElement>({
  busy = false,
  disabled = false,
  unavailable = false,
  onClick,
  onKeyDown,
  onKeyUp,
  onPointerDown,
  className,
}: BusyGuardProps<T>) {
  const isHtmlDisabled = !busy && disabled;
  const isAriaDisabled = busy || unavailable || (!isHtmlDisabled && disabled);
  const isRefusing = busy || unavailable || disabled;

  const classes = [className, (busy || unavailable || disabled) ? 'is-disabled' : null].filter(Boolean).join(' ');

  return {
    disabled: isHtmlDisabled || undefined,
    'aria-disabled': isAriaDisabled ? ('true' as const) : undefined,
    className: classes || undefined,
    onClick: (event: MouseEvent<T>) => {
      if (isRefusing) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event);
    },
    onKeyDown: (event: KeyboardEvent<T>) => {
      if (isRefusing) {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      onKeyDown?.(event);
    },
    onKeyUp: (event: KeyboardEvent<T>) => {
      if (isRefusing) {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      onKeyUp?.(event);
    },
    onPointerDown: (event: PointerEvent<T>) => {
      if (isRefusing) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onPointerDown?.(event);
    },
  };
}
