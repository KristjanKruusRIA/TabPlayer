import type { ChangeEvent, DragEvent, KeyboardEvent, MouseEvent, PointerEvent, SyntheticEvent } from 'react';

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

const passing = ['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta'];
/** For a group of controls (a fieldset or div) that must not act while busy but must not drop focus either: `disabled` would blur
 * the focused one. Gives aria-disabled, a class matching the dimmed look, and capture handlers that refuse presses, typing,
 * pasting and changes made inside it. */
export function busyRegion(busy: boolean) {
  const refuse = (event: SyntheticEvent) => {
    if (!busy) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    'aria-disabled': busy ? ('true' as const) : undefined,
    'aria-busy': busy || undefined,
    className: busy ? 'is-disabled' : undefined,
    onClickCapture: refuse,
    onMouseDownCapture: refuse,
    onPointerDownCapture: refuse,
    onBeforeInputCapture: refuse,
    onPasteCapture: refuse,
    onCutCapture: refuse,
    onDropCapture: refuse,
    onDoubleClickCapture: refuse,
    onContextMenuCapture: refuse,
    onAuxClickCapture: refuse,
    onDragStartCapture: refuse,
    // No preventDefault: that would mark the region as a drop target.
    onDragOverCapture: (event: DragEvent<HTMLElement>) => {
      if (!busy) return;
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      event.stopPropagation();
    },
    onInputCapture: refuse,
    onChangeCapture: (event: ChangeEvent<HTMLElement>) => refuse(event),
    onKeyUpCapture: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === ' ' || event.key === 'Enter') refuse(event);
    },
    onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
      if (!busy || passing.includes(event.key) || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      // Moving the caret inside a text field changes nothing.
      const text = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'radio');
      if (!(text && (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End'))) refuse(event);
    },
  };
}

/** For a select that must not act while busy but keeps focus: aria-disabled, and its popup does not open (the caller also ignores onChange). */
export function busySelect(busy: boolean) {
  return {
    'aria-disabled': busy ? ('true' as const) : undefined,
    onMouseDown: (event: MouseEvent<HTMLSelectElement>) => {
      if (busy) event.preventDefault();
    },
    onKeyDown: (event: KeyboardEvent<HTMLSelectElement>) => {
      if (busy && (event.key === ' ' || event.key === 'Enter' || event.key === 'F4' || event.key.startsWith('Arrow'))) event.preventDefault();
    },
  };
}
