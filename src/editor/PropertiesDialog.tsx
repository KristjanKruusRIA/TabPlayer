import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { model } from '@coderline/alphatab';
import { useI18n, type MessageKey } from '../i18n';
import type { BeatTarget } from '../project';
import type { EditCommand } from '../edit-types';
import { describeSelection } from '../engine';
import { Dialog } from '../ui/Dialog';
import { TechniquePanel } from './TechniquePanel';
import { NonTabPanel } from './NonTabPanel';
import { SpellingControl } from './SpellingControl';
import { GesturePanel } from './GesturePanel';
import { BeatRhythmPanel } from './BeatRhythmPanel';
import { MeasurePanel } from './MeasurePanel';
import { DirectionsPanel } from './DirectionsPanel';
import { BarGesturePanel } from './BarGesturePanel';
import { MeasureTransformPanel } from './MeasureTransformPanel';
import { RangePanel } from './RangePanel';
import { StructurePanel } from './StructurePanel';
import { LyricsPanel } from './LyricsPanel';
import type { MusicSelection } from './range-types';
import './properties-dialog.css';

/** The groups of properties the inspector's old Selection tab held, now one dialog: what belongs to a note, a beat, a bar, a selection, a staff, a pitch entry and the score as a whole. */
export type PropertiesTab = 'note' | 'beat' | 'bar' | 'selection' | 'staff' | 'entry' | 'score';
export const propertiesTabs: readonly PropertiesTab[] = ['note', 'beat', 'bar', 'selection', 'staff', 'entry', 'score'];
/** A request to open the dialog: which tab, and optionally which disclosure inside it to open and focus. `nonce` makes a repeated request count. */
export interface PropertiesRequest { tab: PropertiesTab; focus?: 'measure' | 'lyrics' | 'clipboard'; nonce: number }

const tabLabels: Record<PropertiesTab, MessageKey> = {
  note: 'properties.tab_note', beat: 'properties.tab_beat', bar: 'properties.tab_bar', selection: 'properties.tab_selection',
  staff: 'properties.tab_staff', entry: 'properties.tab_entry', score: 'properties.tab_score',
};
const focusSummary: Record<NonNullable<PropertiesRequest['focus']>, MessageKey> = { measure: 'editor.measure_and_notation', lyrics: 'editor.lyrics', clipboard: 'editor.musical_clipboard' };

export interface PropertiesDialogProps {
  request: PropertiesRequest;
  onTab: (tab: PropertiesTab) => void;
  onClose: () => void;
  score: model.Score;
  target: BeatTarget;
  string: number;
  noteIndex: number | null;
  /** Edits are refused while one is in flight. */
  busy: boolean;
  /** The document is finalized: edit controls are refused, but the Score tab's navigation is not. */
  locked: boolean;
  onSelect: (target: BeatTarget) => void;
  onSelectNote: (index: number | null) => void;
  onEdit: (command: EditCommand) => void | Promise<boolean>;
  musicSelection: MusicSelection | null;
  onMusicSelection: (selection: MusicSelection | null) => void;
  documentEpoch?: number;
  /** The clipboard panel and the harmony transposition, which need the app's clipboard and library. */
  selectionTools?: ReactNode;
  /** The standard-notation pitch entry. */
  entryTools?: ReactNode;
  /** The section list and the score-errors list. */
  scoreTools?: ReactNode;
}

/** One modal for what used to live in the inspector's Selection tab. Each tab hosts the same panels, with the same edits, as the tab did. */
export function PropertiesDialog(props: PropertiesDialogProps) {
  const { t } = useI18n();
  const { request, onTab, onClose, score, target, string, noteIndex, busy, locked, onSelect, onSelectNote, onEdit, musicSelection, onMusicSelection, documentEpoch, selectionTools, entryTools, scoreTools } = props;
  const id = useId(), body = useRef<HTMLDivElement>(null);
  const { staff } = describeSelection(score, target);
  const indexed = staff.isPercussion || !staff.tuning.length;
  const either = busy || locked;
  // Opens and focuses the disclosure a request names, once its tab has drawn.
  useEffect(() => {
    if (!request.focus) return;
    const wanted = t(focusSummary[request.focus]);
    const summary = Array.from(body.current?.querySelectorAll<HTMLElement>('details > summary') ?? []).find(element => element.textContent?.trim() === wanted);
    if (summary?.parentElement instanceof HTMLDetailsElement) {
      for (let section: HTMLElement | null = summary.parentElement; section; section = section.parentElement?.closest('details') ?? null) if (section instanceof HTMLDetailsElement) section.open = true;
      summary.focus();
      summary.scrollIntoView?.({ block: 'nearest' });
    }
  }, [request.nonce, request.focus, request.tab]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = propertiesTabs[(propertiesTabs.indexOf(request.tab) + step + propertiesTabs.length) % propertiesTabs.length];
    onTab(next);
    requestAnimationFrame(() => body.current?.parentElement?.querySelector<HTMLElement>(`[data-properties-tab="${next}"]`)?.focus());
  };
  const panel = (() => {
    switch (request.tab) {
      case 'note': return <>
        {indexed && <NonTabPanel score={score} target={target} noteIndex={noteIndex} onSelectNote={onSelectNote} busy={busy} locked={locked} onEdit={onEdit} />}
        <SpellingControl score={score} target={target} noteIndex={indexed ? (noteIndex ?? -1) : (describeSelection(score, target).beat?.notes.findIndex(note => note.string === string) ?? -1)} busy={either} onEdit={onEdit} />
        <TechniquePanel score={score} target={target} string={string} noteIndex={noteIndex} busy={either} onEdit={onEdit} />
      </>;
      case 'beat': return <>
        <BeatRhythmPanel score={score} target={target} busy={either} onEdit={onEdit} />
        <GesturePanel score={score} target={target} busy={either} onEdit={onEdit} />
      </>;
      case 'bar': return <>
        <MeasurePanel score={score} target={target} string={string} busy={either} onEdit={onEdit} />
        <DirectionsPanel score={score} target={target} busy={either} onEdit={onEdit} />
        <BarGesturePanel score={score} track={target.track} staff={target.staff} bar={target.bar} busy={either} onEdit={onEdit} />
        <MeasureTransformPanel score={score} bar={target.bar} busy={either} onEdit={onEdit} />
      </>;
      case 'selection': return <>
        <RangePanel score={score} target={target} selection={musicSelection} busy={busy} locked={locked} onSelection={onMusicSelection} onEdit={onEdit} />
        {selectionTools}
      </>;
      case 'staff': return <>
        <StructurePanel key={documentEpoch} score={score} target={target} string={string} busy={busy} locked={locked} onEdit={onEdit} onSelect={onSelect} />
        <LyricsPanel score={score} track={target.track} busy={either} onEdit={onEdit} />
      </>;
      case 'entry': return <>{entryTools}</>;
      case 'score': return <>{scoreTools}</>;
    }
  })();
  return <Dialog title={t('properties.title')} onClose={onClose} className="properties-dialog" dismissOnBackdrop closeLabel={t('dialog.close')}>
    <p className="muted properties-location" aria-label={t('properties.location')}>{t('properties.at', { track: score.tracks[target.track].name || t('track_display.track_fallback', { index: target.track + 1 }), bar: target.bar + 1, beat: target.beat + 1, voice: target.voice + 1 })}</p>
    <div className="properties-tabs" role="tablist" aria-label={t('properties.tabs')} onKeyDown={keys}>
      {propertiesTabs.map(tab => <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`} aria-controls={`${id}-panel`} data-properties-tab={tab} aria-selected={request.tab === tab} tabIndex={request.tab === tab ? 0 : -1} onClick={() => onTab(tab)}>{t(tabLabels[tab])}</button>)}
    </div>
    <div ref={body} className="properties-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${request.tab}`}>{panel}</div>
  </Dialog>;
}
