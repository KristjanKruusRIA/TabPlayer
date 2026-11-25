import { useI18n } from './i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { model } from '@coderline/alphatab';
import type { BeatTarget, EditCommand } from './project';
import { describeSelection } from './engine';
import { EditingToolbar } from './editor/EditingToolbar';
import { PropertiesDialog, type PropertiesRequest, type PropertiesTab } from './editor/PropertiesDialog';
import type { MusicSelection } from './editor/range-types';
import './editor-panel.css';

/**
 * Where the editing tools live now that the inspector has only the Song and Track tabs: the edition palette beside the
 * score, the practice tools in the toolbar's pop-up, and the Properties dialog that holds what the old Selection tab held.
 * It draws nothing in the inspector itself.
 */
export function EditorPanel({
  score,
  target,
  string,
  fret,
  noteIndex,
  onSelectNote,
  busy: controlsBusy,
  locked = false,
  onSelect,
  onEdit,
  musicSelection,
  onMusicSelection,
  onChord,
  onScales,
  practiceTools,
  tunerTool,
  documentEpoch,
  paletteHost,
  practiceHost,
  properties,
  onProperties,
  onCloseProperties,
  selectionTools,
  entryTools,
  scoreTools,
  onOpenLyrics,
  onOpenMeasure,
  onPaletteCommit,
}: {
  /** Called after a pointer action in the edition palette commits, to return keyboard focus to the score workspace. */
  onPaletteCommit?: () => void;
  score: model.Score;
  target: BeatTarget;
  string: number;
  fret: number;
  busy: boolean;
  /** The document is finalized: every edit control is disabled, but practice tools and view settings are not. */
  locked?: boolean;
  /** Changes when another document is opened; per-document panel state starts again. */
  documentEpoch?: number;
  noteIndex: number | null;
  onSelectNote: (index: number | null) => void;
  onSelect: (target: BeatTarget) => void;
  onEdit: (edit: EditCommand) => void | Promise<boolean>;
  musicSelection: MusicSelection | null;
  onMusicSelection: (selection: MusicSelection | null) => void;
  onChord: () => void;
  onScales: () => void;
  practiceTools?: ReactNode;
  /** The tuner, outside the busy-disabled practice controls, so it can be stopped at any time. */
  tunerTool?: ReactNode;
  /** Where the edition palette goes: beside the score, as in Guitar Pro. Without one the palette is not drawn. */
  paletteHost?: HTMLElement | null;
  /** Where the practice settings go: the toolbar's practice pop-up. */
  practiceHost?: HTMLElement | null;
  /** The open Properties dialog, if any. */
  properties?: PropertiesRequest | null;
  onProperties: (tab: PropertiesTab) => void;
  onCloseProperties: () => void;
  selectionTools?: ReactNode;
  entryTools?: ReactNode;
  scoreTools?: ReactNode;
  /** Reveals the lyrics editor. */
  onOpenLyrics: () => void;
  /** Opens the measure settings for a bar; the palette's time signature and tempo buttons use it. */
  onOpenMeasure?: (bar: number) => void;
}) {
  const { t } = useI18n();
  const [duration, setDuration] = useState(4);
  const [dots, setDots] = useState(0);
  const { beat } = describeSelection(score, target);
  useEffect(() => {
    setDuration(beat?.duration ?? 4);
    setDots(beat?.dots ?? 0);
  }, [score, beat, target.bar, target.beat, target.track, target.staff, target.voice]);
  const palette = paletteHost ? createPortal(
    <EditingToolbar
      score={score}
      target={target}
      string={string}
      fret={fret}
      noteIndex={noteIndex}
      duration={duration}
      dots={dots}
      busy={controlsBusy}
      locked={locked}
      onDurationChange={setDuration}
      onDotsChange={setDots}
      onEdit={onEdit as (edit: EditCommand) => void}
      orientation="vertical"
      onSelect={onSelect}
      onOpenMeasure={onOpenMeasure}
      onOpenPanel={panel => (panel === 'chord' ? onChord() : panel === 'scales' ? onScales() : onOpenLyrics())}
      onPointerCommit={onPaletteCommit}
    />, paletteHost) : null;
  return <>
    {palette}
    {practiceHost && createPortal(
      <section className="gp-practice-section" aria-label={t('editor.practice_tools')}>
        <h3>{t('editor.task_practice')}</h3>
        <fieldset disabled={controlsBusy}>
          {practiceTools ?? <p className="muted">{t('editor.practice_hint')}</p>}
        </fieldset>
        {tunerTool}
      </section>, practiceHost)}
    {properties && <PropertiesDialog
      request={properties}
      onTab={onProperties}
      onClose={onCloseProperties}
      score={score}
      target={target}
      string={string}
      noteIndex={noteIndex}
      busy={controlsBusy}
      locked={locked}
      onSelect={onSelect}
      onSelectNote={onSelectNote}
      onEdit={onEdit}
      musicSelection={musicSelection}
      onMusicSelection={onMusicSelection}
      documentEpoch={documentEpoch}
      selectionTools={selectionTools}
      entryTools={entryTools}
      scoreTools={scoreTools}
    />}
  </>;
}
