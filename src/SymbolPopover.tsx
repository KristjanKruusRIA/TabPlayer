import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import { useI18n } from './i18n';
import type { MessageKey } from './i18n';
import type { EditCommand } from './edit-types';
import { busyGuard } from './ui/useBusyGuard';
import {
  chordNameEdit, clefChoices, clefEdit, currentClef, removeChordEdit, removeTempoEdit, symbolMenu, symbolText, tempoEdit, titleEdit,
  type SymbolAction, type SymbolBuild, type SymbolMenuItem, type SymbolProblem, type SymbolRef,
} from './editor/symbol-edit';

/** What the popover shows: a menu of actions (for a clicked symbol, or for the edit target when `ref` is null), a one-line text editor, or the clef choices. */
export interface SymbolView { anchor: { x: number; y: number }; ref: SymbolRef | null; view: 'menu' | 'text' | 'clef'; /** Which popover this is, so that a late result of an earlier one cannot close a later one. */ id?: number }

export interface SymbolPopoverProps {
  state: SymbolView;
  score: model.Score;
  /** Entries of the edit-target menu, used when `state.ref` is null. */
  targets: readonly SymbolRef[];
  busy: boolean;
  /** Why editing is unavailable (a locked document), or null. */
  locked: string | null;
  /** Records the edit. A promise settles to whether it landed; the popover stays open, with what was typed, until it has. */
  onEdit: (command: EditCommand) => Promise<boolean> | void;
  onChordEditor: (ref: Extract<SymbolRef, { kind: 'chord' }>) => void;
  onView: (next: SymbolView) => void;
  /** `restore`: put focus back where it was before the popover opened. A focus move away from the popover closes it without restoring. */
  onClose: (restore: boolean, id?: number) => void;
}

const entryAction = (items: SymbolMenuItem[], ref: SymbolRef | null) => items.map(item => ({ item, ref }));
const RECORDS: SymbolAction[] = ['removeTempo', 'removeChord', 'openChordEditor'];

/** Sends one edit and closes once it has landed; one that is refused keeps the popover and says so. Only one is in flight at a time. */
function useApply(id: number | undefined, onEdit: SymbolPopoverProps['onEdit'], onClose: SymbolPopoverProps['onClose'], fail: (problem: SymbolProblem) => void) {
  const pending = useRef(false);
  return (command: EditCommand) => {
    if (pending.current) return;
    const result = onEdit(command);
    if (!result || typeof result.then !== 'function') { onClose(true, id); return; }
    pending.current = true;
    result.then(landed => { pending.current = false; if (landed) onClose(true, id); else fail({ key: 'symbol.not_applied' }); }, () => { pending.current = false; fail({ key: 'symbol.not_applied' }); });
  };
}

/** Keeps the popover inside the scrolling score area, shifting it by a transform so its anchor stays where it was clicked. */
function useKeepInside(root: { current: HTMLElement | null }, key: unknown) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const fit = () => {
      element.style.transform = '';
      // The visible part of the scroller: its padding box without the scrollbars.
      const scroller = element.closest<HTMLElement>('.paper-scroll'), host = scroller?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const edge = 8, left = host ? host.left + scroller!.clientLeft : 0, top = host ? host.top + scroller!.clientTop : 0;
      const right = host ? left + scroller!.clientWidth : window.innerWidth, bottom = host ? top + scroller!.clientHeight : window.innerHeight;
      let dx = 0, dy = 0;
      if (box.right > right - edge) dx = right - edge - box.right;
      if (box.left + dx < left + edge) dx = left + edge - box.left;
      if (box.bottom > bottom - edge) dy = bottom - edge - box.bottom;
      if (box.top + dy < top + edge) dy = top + edge - box.top;
      if (dx || dy) element.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    fit();
    // An error or status line grows the popover after it opened: fit again whenever its size changes.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, key]);
}

export function SymbolPopover(props: SymbolPopoverProps) {
  const { state, onClose } = props;
  const root = useRef<HTMLDivElement>(null);
  useKeepInside(root, state.view + JSON.stringify(state.ref));
  // Clicking anywhere else, or tabbing away, closes it unrecorded; focus then belongs to wherever the user went.
  useEffect(() => {
    const away = (event: MouseEvent) => { if (!(event.target instanceof Node && root.current?.contains(event.target))) onClose(false); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [onClose]);
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Nothing typed or pressed here reaches the score's own shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
  };
  // Pressing on the popover's padding, heading or text would move focus to the score and close it; only a field or button takes focus.
  const keepFocus = (event: ReactMouseEvent<HTMLDivElement>) => { if (!(event.target instanceof Element && event.target.closest('input, button'))) event.preventDefault(); };
  const blur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) onClose(false);
  };
  return <div ref={root} className="score-symbol-popover" data-view={state.view} style={{ left: state.anchor.x, top: state.anchor.y }}
    onMouseDown={keepFocus} onKeyDown={key} onBlur={blur} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => { event.stopPropagation(); if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
    {state.view === 'text' && state.ref && state.ref.kind !== 'clef' ? <TextView {...props} ref_={state.ref}/> : state.view === 'clef' && state.ref?.kind === 'clef' ? <ClefView {...props} ref_={state.ref}/> : <MenuView {...props}/>}
  </div>;
}

function Notes({ busy, locked, problem }: { busy: boolean; locked: string | null; problem: SymbolProblem | null }) {
  const { t } = useI18n();
  return <>
    {locked && <p className="score-symbol-note" role="status">{locked}</p>}
    {!locked && busy && <p className="score-symbol-note" role="status">{t('symbol.busy')}</p>}
    {problem && <p className="score-symbol-note score-symbol-problem" role="alert">{t(problem.key, problem.params)}</p>}
  </>;
}

function heading(t: ReturnType<typeof useI18n>['t'], score: model.Score, ref: SymbolRef | null): string {
  if (!ref) return t('symbol.menu_symbols');
  if (ref.kind === 'title') return t('symbol.menu_title');
  if (ref.kind === 'tempo') return t('symbol.menu_tempo', { bar: ref.bar + 1 });
  if (ref.kind === 'chord') return t('symbol.menu_chord', { name: symbolText(score, ref) });
  return t('symbol.menu_clef', { bar: ref.bar + 1 });
}

/** Moves focus between the items of a menu with the arrow keys; the one focused is the one Tab would leave from. */
function useRoving(root: { current: HTMLElement | null }, initial: (items: HTMLElement[]) => HTMLElement | undefined) {
  useEffect(() => {
    const items = [...root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []];
    (initial(items) ?? items[0])?.focus({ preventScroll: true });
    // Focus lands once, when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (event: ReactKeyboardEvent<HTMLElement>) => {
    const items = [...root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
    if (go === null || !items.length) return;
    event.preventDefault();
    items.forEach((item, index) => { item.tabIndex = index === go ? 0 : -1; });
    items[go].focus({ preventScroll: true });
  };
}

function MenuView({ state, score, targets, busy, locked, onEdit, onChordEditor, onView, onClose }: SymbolPopoverProps) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<SymbolProblem | null>(null);
  const roving = useRoving(list, items => items.find(item => item.getAttribute('aria-disabled') !== 'true'));
  const apply = useApply(state.id, onEdit, onClose, setProblem);
  const entries = state.ref ? entryAction(symbolMenu(score, state.ref), state.ref) : targets.flatMap(ref => entryAction(symbolMenu(score, ref, true), ref));
  const record = (build: SymbolBuild) => {
    if ('error' in build) { setProblem(build.error); return; }
    if ('command' in build) apply(build.command);
    else onClose(true);
  };
  const run = (action: SymbolAction, ref: SymbolRef) => {
    if (action === 'editTitle' || action === 'editTempo' || action === 'editChord') onView({ anchor: state.anchor, ref, view: 'text' });
    else if (action === 'chooseClef') onView({ anchor: state.anchor, ref, view: 'clef' });
    else if (action === 'removeTempo' && ref.kind === 'tempo') record(removeTempoEdit(score, ref));
    else if (action === 'removeChord' && ref.kind === 'chord') record(removeChordEdit(score, ref));
    else if (action === 'openChordEditor' && ref.kind === 'chord') { onClose(true); onChordEditor(ref); }
  };
  return <div ref={list} role="menu" aria-label={heading(t, score, state.ref)} onKeyDown={roving}>
    <p className="score-symbol-heading" aria-hidden="true">{heading(t, score, state.ref)}</p>
    {entries.map(({ item, ref }, index) => <button key={`${item.action}/${index}`} type="button" role="menuitem" tabIndex={index === 0 ? 0 : -1}
      {...busyGuard<HTMLButtonElement>({ className: 'score-symbol-item', busy: busy && RECORDS.includes(item.action), unavailable: !!locked, onClick: () => run(item.action, ref!) })}>{t(item.label, item.params)}</button>)}
    <Notes busy={busy} locked={locked} problem={problem}/>
  </div>;
}

function ClefView({ state, score, ref_, busy, locked, onEdit, onClose }: SymbolPopoverProps & { ref_: Extract<SymbolRef, { kind: 'clef' }> }) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<SymbolProblem | null>(null);
  const current = currentClef(score, ref_);
  const apply = useApply(state.id, onEdit, onClose, setProblem);
  const roving = useRoving(list, items => items.find(item => item.getAttribute('aria-checked') === 'true'));
  const choose = (clef: number) => {
    const build = clefEdit(score, ref_, clef);
    if ('error' in build) { setProblem(build.error); return; }
    if ('command' in build) apply(build.command);
    else onClose(true);
  };
  return <div ref={list} role="menu" aria-label={t('symbol.menu_clef', { bar: ref_.bar + 1 })} onKeyDown={roving}>
    <p className="score-symbol-heading" aria-hidden="true">{t('symbol.menu_clef', { bar: ref_.bar + 1 })}</p>
    {clefChoices.map(choice => <button key={choice.value} type="button" role="menuitemradio" aria-checked={choice.value === current} tabIndex={choice.value === current ? 0 : -1}
      {...busyGuard<HTMLButtonElement>({ className: 'score-symbol-item', busy, unavailable: !!locked, onClick: () => choose(choice.value) })}><span className="score-symbol-check" aria-hidden="true">{choice.value === current ? '✓' : ''}</span>{t(choice.label as MessageKey)}</button>)}
    <Notes busy={busy} locked={locked} problem={problem}/>
  </div>;
}

function TextView({ state, score, busy, locked, onEdit, onClose, ref_ }: SymbolPopoverProps & { ref_: Exclude<SymbolRef, { kind: 'clef' }> }) {
  const { t } = useI18n();
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => symbolText(score, ref_));
  const [problem, setProblem] = useState<SymbolProblem | null>(null);
  const apply = useApply(state.id, onEdit, onClose, setProblem);
  useEffect(() => { field.current?.focus({ preventScroll: true }); field.current?.select(); }, []);
  const label = ref_.kind === 'title' ? t('symbol.title_label') : ref_.kind === 'tempo' ? t('symbol.tempo_label') : t('symbol.chord_label');
  const build = (): SymbolBuild => ref_.kind === 'title' ? titleEdit(score, draft) : ref_.kind === 'tempo' ? tempoEdit(score, ref_, draft) : chordNameEdit(score, ref_, draft);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (locked) return;
    if (busy) { setProblem({ key: 'symbol.busy' }); return; }
    const built = build();
    if ('error' in built) { setProblem(built.error); field.current?.focus(); return; }
    // Typing the value the symbol already has records nothing.
    if ('command' in built) apply(built.command);
    else onClose(true);
  };
  const described = problem ? 'score-symbol-problem-text' : undefined;
  return <form role="dialog" aria-label={label} onSubmit={submit}>
    <label className="score-symbol-field">{label}
      <input ref={field} value={draft} inputMode={ref_.kind === 'tempo' ? 'decimal' : undefined} autoComplete="off" spellCheck={false} aria-invalid={problem ? true : undefined} aria-describedby={described}
        onChange={event => { setDraft(event.target.value); setProblem(null); }}/>
    </label>
    {problem && <p id="score-symbol-problem-text" className="score-symbol-note score-symbol-problem" role="alert">{t(problem.key, problem.params)}</p>}
    <Notes busy={busy} locked={locked} problem={null}/>
    <div className="score-symbol-actions">
      <button type="submit" {...busyGuard<HTMLButtonElement>({ busy, unavailable: !!locked })}>{t('symbol.apply')}</button>
      <button type="button" onClick={() => onClose(true)}>{t('symbol.cancel')}</button>
    </div>
  </form>;
}
