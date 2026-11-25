import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './context-menu.css';

export type ContextMenuItem =
  | {
      kind: 'item';
      id: string;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator'; id: string }
  | {
      kind: 'submenu';
      id: string;
      label: string;
      disabled?: boolean;
      items: readonly ContextMenuItem[];
    };

export interface ContextMenuProps {
  x: number;
  y: number;
  label: string;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Returns true when a right-click lands on an editable text control where the browser's own menu belongs. */
export function isEditableContextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
  if (target instanceof HTMLInputElement) {
    const type = (target.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type) && !target.disabled && !target.readOnly;
  }
  return Boolean(target.closest('[contenteditable="true"]'));
}

const VIEWPORT_MARGIN = 8;

function enabledButtons(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)')];
}

function clampPosition(left: number, top: number, width: number, height: number): { left: number; top: number } {
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, left), maxX),
    top: Math.min(Math.max(VIEWPORT_MARGIN, top), maxY),
  };
}

function SubmenuGlyph() {
  return (
    <svg className="tp-context-submenu-arrow" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M4.25 2.5 7.75 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [position, setPosition] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [subPosition, setSubPosition] = useState<{ left: number; top: number } | null>(null);
  const pendingSubFocus = useRef(false);

  // Position main menu within viewport and focus its first enabled item on mount.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition(clampPosition(x, y, rect.width, rect.height));
  }, [x, y, items]);

  useEffect(() => {
    const first = enabledButtons(menuRef.current)[0];
    first?.focus({ preventScroll: true });
  }, []);

  // Position floating submenu beside its trigger button.
  useLayoutEffect(() => {
    if (!openSub || !menuRef.current || !submenuRef.current) {
      setSubPosition(null);
      return;
    }
    const trigger = menuRef.current.querySelector<HTMLButtonElement>(`[data-menu-id="${CSS.escape(openSub)}"]`);
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    const subRect = submenuRef.current.getBoundingClientRect();
    const rightSpace = window.innerWidth - menuRect.right - VIEWPORT_MARGIN;
    const rawLeft = rightSpace >= subRect.width - 2 ? menuRect.right - 2 : menuRect.left - subRect.width + 2;
    const clamped = clampPosition(rawLeft, triggerRect.top - 4, subRect.width, subRect.height);
    setSubPosition(clamped);
    if (pendingSubFocus.current) {
      pendingSubFocus.current = false;
      enabledButtons(submenuRef.current)[0]?.focus({ preventScroll: true });
    }
  }, [openSub, items]);

  // Global dismissal on outside click, window blur, or scroll outside the menu.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (menuRef.current?.contains(target) || submenuRef.current?.contains(target))) return;
      onCloseRef.current();
    };
    const onWindowBlur = () => onCloseRef.current();
    const onScroll = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (menuRef.current?.contains(target) || submenuRef.current?.contains(target))) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const moveFocus = (container: HTMLElement | null, step: 1 | -1 | 'first' | 'last') => {
    const list = enabledButtons(container);
    if (!list.length) return;
    if (step === 'first') {
      list[0].focus({ preventScroll: true });
      return;
    }
    if (step === 'last') {
      list[list.length - 1].focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    const currentIndex = active ? list.indexOf(active) : -1;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + step + list.length) % list.length;
    list[nextIndex].focus({ preventScroll: true });
  };

  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(menuRef.current, 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(menuRef.current, -1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(menuRef.current, 'first');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(menuRef.current, 'last');
      return;
    }
    if (event.key === 'ArrowRight') {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const subId = active?.dataset.submenu;
      if (subId) {
        event.preventDefault();
        event.stopPropagation();
        pendingSubFocus.current = true;
        if (openSub === subId) {
          pendingSubFocus.current = false;
          enabledButtons(submenuRef.current)[0]?.focus({ preventScroll: true });
        } else {
          setOpenSub(subId);
        }
      }
    }
  };

  const handleSubKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      const closedId = openSub;
      setOpenSub(null);
      if (closedId) {
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-id="${CSS.escape(closedId)}"]`)?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(submenuRef.current, 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(submenuRef.current, -1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(submenuRef.current, 'first');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(submenuRef.current, 'last');
    }
  };

  const renderEntry = (entry: ContextMenuItem, isSubmenuChild: boolean) => {
    if (entry.kind === 'separator') {
      return <div key={entry.id} className="tp-context-separator" role="separator" />;
    }
    if (entry.kind === 'submenu') {
      const expanded = openSub === entry.id;
      return (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          data-menu-id={entry.id}
          data-submenu={entry.id}
          aria-haspopup="menu"
          aria-expanded={expanded}
          disabled={entry.disabled}
          className="tp-context-item tp-context-has-submenu"
          onMouseEnter={() => {
            if (!entry.disabled) setOpenSub(entry.id);
          }}
          onClick={() => {
            if (entry.disabled) return;
            pendingSubFocus.current = true;
            setOpenSub(entry.id);
          }}
        >
          <span className="tp-context-item-label">{entry.label}</span>
          <SubmenuGlyph />
        </button>
      );
    }
    return (
      <button
        key={entry.id}
        type="button"
        role="menuitem"
        data-menu-id={entry.id}
        disabled={entry.disabled}
        className={`tp-context-item${entry.danger ? ' tp-context-danger' : ''}`}
        onMouseEnter={() => {
          if (!isSubmenuChild) setOpenSub(null);
        }}
        onClick={() => {
          if (entry.disabled) return;
          onClose();
          entry.onSelect();
        }}
      >
        <span className="tp-context-item-label">{entry.label}</span>
        {entry.shortcut && <kbd className="tp-context-shortcut" aria-hidden="true">{entry.shortcut}</kbd>}
      </button>
    );
  };

  const activeSubmenu = openSub
    ? items.find((entry): entry is Extract<ContextMenuItem, { kind: 'submenu' }> => entry.kind === 'submenu' && entry.id === openSub)
    : undefined;

  const rootStyle: CSSProperties = { left: position.left, top: position.top };
  const subStyle: CSSProperties = subPosition
    ? { left: subPosition.left, top: subPosition.top }
    : { left: position.left, top: position.top, visibility: 'hidden' };

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        className="tp-context-menu"
        style={rootStyle}
        onKeyDown={handleRootKeyDown}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {items.map(entry => renderEntry(entry, false))}
      </div>
      {activeSubmenu && (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={activeSubmenu.label}
          className="tp-context-menu tp-context-submenu"
          style={subStyle}
          onKeyDown={handleSubKeyDown}
          onContextMenu={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {activeSubmenu.items.map(entry => renderEntry(entry, true))}
        </div>
      )}
    </>,
    document.body,
  );
}
