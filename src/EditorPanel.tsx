import { useI18n } from './i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { model } from '@coderline/alphatab';
import { describeSelection } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { IndexInput } from './editor/IndexInput';
import { TechniquePanel } from './editor/TechniquePanel';
import { StructurePanel } from './editor/StructurePanel';
import type { TuningAudition } from './audio/audition';
import { MeasurePanel } from './editor/MeasurePanel';
import { EnumInput } from './editor/controls';
import { formatPitch } from './tuning';
import { NonTabPanel } from './editor/NonTabPanel';
import { SongPanel } from './editor/SongPanel';
import { AuthorDefaultsPanel } from './editor/AuthorDefaultsPanel';
import { newScoreDefaults, writeAuthorDefaults } from './workspace/author-defaults';
import { DirectionsPanel } from './editor/DirectionsPanel';
import { SpellingControl } from './editor/SpellingControl';
import { LyricsPanel } from './editor/LyricsPanel';
import { GesturePanel } from './editor/GesturePanel';
import { BarGesturePanel } from './editor/BarGesturePanel';
import { RangePanel } from './editor/RangePanel';
import { MeasureTransformPanel } from './editor/MeasureTransformPanel';
import { EditingToolbar } from './editor/EditingToolbar';
import { durationLabel } from './editor/common';
import { displayedBpm, shownBpm, quarterUnit, tempoUnitKeys, tempoUnitOf } from './editor/tempo-unit';
import type { MusicSelection } from './editor/range-types';
import { rangeExtent } from './editor/range-edge';
import { rangeCutsBeat } from './editor/clipboard-subdivide';
import './editor-panel.css';

export type InspectorContextScope = 'all' | 'note' | 'beat' | 'measure' | 'staff' | 'selection';

const CONTEXT_SCOPES: ReadonlyArray<readonly [InspectorContextScope, string]> = [
  ['all', 'All'],
  ['note', 'Note'],
  ['beat', 'Beat'],
  ['measure', 'Measure'],
  ['staff', 'Staff'],
  ['selection', 'Selection'],
];

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
  onString,
  onFret,
  onEdit,
  musicSelection,
  onMusicSelection,
  onChord,
  onScales,
  onAudition,
  children,
  practiceTools,
  tunerTool,
  presentationTools,
  presentationViewTools,
  contextScope: controlledScope,
  onContextScopeChange,
  documentEpoch,
  paletteHost,
  songHost,
  practiceHost,
  measureRequest = 0,
  lyricsRequest = 0,
  onOpenLyrics,
  onOpenMeasure,
}: {
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
  onString: (string: number) => void;
  onFret: (fret: number) => void;
  onEdit: (edit: EditCommand) => void;
  musicSelection: MusicSelection | null;
  onMusicSelection: (selection: MusicSelection | null) => void;
  onChord: () => void;
  onScales: () => void;
  onAudition?: TuningAudition;
  children?: ReactNode;
  practiceTools?: ReactNode;
  /** The tuner, outside the busy-disabled practice controls, so it can be stopped at any time. */
  tunerTool?: ReactNode;
  presentationTools?: ReactNode;
  presentationViewTools?: ReactNode;
  contextScope?: InspectorContextScope;
  onContextScopeChange?: (scope: InspectorContextScope) => void;
  /** Where the edition palette goes: beside the score, as in Guitar Pro. Without one it stays at the top of Edit. */
  paletteHost?: HTMLElement | null;
  /** Where the song-wide settings go: the inspector's Song tab. Without one they stay under Presentation. */
  songHost?: HTMLElement | null;
  /** Where the practice settings go: the toolbar's practice pop-up. Without one they stay under Practice. */
  practiceHost?: HTMLElement | null;
  /** Each increase opens and focuses the measure settings, as the song-position display's tempo and signature links ask. */
  measureRequest?: number;
  /** Bumped to reveal and focus the Lyrics section, as measureRequest does for Measure & notation. */
  lyricsRequest?: number;
  /** Reveals the lyrics editor wherever it is hosted; without it the panel reveals its own Lyrics section. */
  onOpenLyrics?: () => void;
  /** Opens the measure settings for a bar; the palette's time signature and tempo buttons use it. */
  onOpenMeasure?: (bar: number) => void;
}) {
  const { t } = useI18n();
  const busy = controlsBusy || locked;
  const id = useId();
  const editTask = useRef<HTMLDetailsElement>(null);
  const practiceTask = useRef<HTMLDetailsElement>(null);
  const presentationTask = useRef<HTMLDetailsElement>(null);
  const editBodyRef = useRef<HTMLDivElement>(null);
  const [internalScope, setInternalScope] = useState<InspectorContextScope>('all');
  const contextScope = controlledScope ?? internalScope;
  const setContextScope = onContextScopeChange ?? setInternalScope;

  const openTask = (section: HTMLDetailsElement | null) => {
    if (section) {
      section.open = true;
      section.querySelector('summary')?.focus();
    }
  };

  const openSummaryByText = (summaryText: string) => {
    const summaries = Array.from(editBodyRef.current?.querySelectorAll<HTMLElement>('details > summary') ?? []);
    const match = summaries.find(el => el.textContent?.trim() === summaryText);
    if (match && match.parentElement instanceof HTMLDetailsElement) {
      match.parentElement.open = true;
    }
  };

  const selectContextScope = (scope: InspectorContextScope) => {
    setContextScope(scope);
    if (scope === 'note') openSummaryByText(t('editor.notes_and_techniques'));
    else if (scope === 'beat') openSummaryByText(t('editor.beat_notation'));
    else if (scope === 'measure') openSummaryByText(t('editor.measure_and_notation'));
    else if (scope === 'staff') openSummaryByText(t('editor.staff_voices_layout'));
    else if (scope === 'selection') openSummaryByText(t('editor.music_selection'));
  };

  const revealSummary = (summaryText: string) => {
    const match = Array.from(editBodyRef.current?.querySelectorAll<HTMLElement>('details > summary') ?? []).find(el => el.textContent?.trim() === summaryText);
    if (match?.parentElement instanceof HTMLDetailsElement) {
      for (let section: HTMLElement | null = match.parentElement; section; section = section.parentElement?.closest('details') ?? null) {
        if (section instanceof HTMLDetailsElement) section.open = true;
      }
      match.focus();
      match.scrollIntoView?.({ block: 'nearest' });
    }
  };
  useEffect(() => {
    if (!measureRequest) return;
    revealSummary(t('editor.measure_and_notation'));
  }, [measureRequest]);
  const [ownLyricsRequest, setOwnLyricsRequest] = useState(0);
  useEffect(() => {
    if (!lyricsRequest && !ownLyricsRequest) return;
    revealSummary(t('editor.lyrics'));
  }, [lyricsRequest, ownLyricsRequest]);
  const openLyrics = () => {
    if (onOpenLyrics) { onOpenLyrics(); return; }
    setContextScope('staff');
    setOwnLyricsRequest(tick => tick + 1);
  };

  useEffect(() => {
    if (controlledScope !== undefined) return;
    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'v'
      ) {
        if (
          event.target instanceof HTMLElement &&
          (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) ||
            event.target.isContentEditable ||
            Boolean(event.target.closest('[role="dialog"]')))
        ) {
          return;
        }
        setContextScope('all');
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [controlledScope, setContextScope]);

  const { staff, bar, voice, beat, master } = describeSelection(score, target);
  const indexed = staff.isPercussion || !staff.tuning.length;
  const note = indexed
    ? noteIndex === null
      ? undefined
      : beat?.notes[noteIndex]
    : beat?.notes.find(n => n.string === string);

  const [duration, setDuration] = useState(4);
  const [dots, setDots] = useState(0);
  const [tupletNumerator, setTupletNumerator] = useState(1);
  const [tupletDenominator, setTupletDenominator] = useState(1);
  const [graceType, setGraceType] = useState(0);
  const [text, setText] = useState(beat?.text ?? '');

  useEffect(() => {
    setDuration(beat?.duration ?? 4);
    setDots(beat?.dots ?? 0);
    setTupletNumerator(beat?.tupletNumerator && beat.tupletNumerator > 0 ? beat.tupletNumerator : 1);
    setTupletDenominator(beat?.tupletDenominator && beat.tupletDenominator > 0 ? beat.tupletDenominator : 1);
    setGraceType(beat?.graceType ?? 0);
    setText(beat?.text ?? '');
  }, [score, beat, target.bar, target.beat, target.track, target.staff, target.voice]);

  const remaining =
    master.calculateDuration(false) -
    voice.beats.reduce((total, b) => total + (b.isEmpty || b.graceType !== 0 ? 0 : b.playbackDuration), 0);

  // The opening tempo in the note it is written in, such as 100 BPM (Dotted quarter note); the quarter-note tempo plays.
  const opening = score.masterBars[0].tempoAutomations.find(a => a.ratioPosition === 0);
  const openingTempo = opening && tempoUnitOf(opening) !== quarterUnit
    ? t('editor.context_tempo_unit', { bpm: shownBpm(displayedBpm(opening)), unit: t(tempoUnitKeys[tempoUnitOf(opening)]) })
    : `${score.tempo} BPM`;
  const [title, setTitle] = useState(score.title);
  const [artist, setArtist] = useState(score.artist);
  const [tempo, setTempo] = useState(score.tempo);
  useEffect(() => {
    setTitle(score.title);
    setArtist(score.artist);
    setTempo(score.tempo);
  }, [score.title, score.artist, score.tempo]);

  const activeTechniques: string[] = [];
  if (note) {
    if ((note.bendType ?? 0) !== 0) activeTechniques.push('Bend');
    if ((note.slideOutType ?? 0) !== 0 || (note.slideInType ?? 0) !== 0) activeTechniques.push('Slide');
    if ((note.vibrato ?? 0) !== 0) activeTechniques.push('Vibrato');
    if (note.isHammerPullOrigin || note.isHammerPullDestination) activeTechniques.push('H/P');
    if (note.isTieOrigin || note.isTieDestination) activeTechniques.push('Tie');
    if (note.isPalmMute) activeTechniques.push('PM');
    if (note.isLetRing) activeTechniques.push('Let ring');
    if ((note.harmonicType ?? 0) !== 0) activeTechniques.push('Harmonic');
    if (note.isDead) activeTechniques.push('Dead');
    if (note.isGhost) activeTechniques.push('Ghost');
    if (note.isStaccato) activeTechniques.push('Staccato');
    if (note.isTrill) activeTechniques.push('Trill');
  }

  const selectionSummary = musicSelection
    ? musicSelection.kind === 'range'
      ? rangeCutsBeat(score, musicSelection.range)
        ? t('editor.range_extent', rangeExtent(score, musicSelection.range))
        : `Range selection · M${musicSelection.range.start.bar + 1}–M${musicSelection.range.end.bar + 1}`
      : musicSelection.kind === 'bars'
        ? `Range selection · Measures ${musicSelection.firstBar + 1}–${musicSelection.lastBar + 1}`
        : `Range selection · ${musicSelection.notes.length} note${musicSelection.notes.length === 1 ? '' : 's'}`
    : note
      ? indexed
        ? `Selected note · Note ${(noteIndex ?? 0) + 1}${staff.isPercussion ? '' : ` (${formatPitch(note.realValue)})`}`
        : `Selected note · String ${string} Fret ${note.fret} (${formatPitch(note.realValue)})`
      : beat?.isRest
        ? `Rest beat · ${durationLabel(beat.duration)}${beat.dots ? '.'.repeat(beat.dots) : ''}`
        : indexed
          ? `Empty note slot (Beat ${durationLabel(beat?.duration ?? duration)})`
          : `Empty string slot · String ${string} (Beat ${durationLabel(beat?.duration ?? duration)})`;

  const showSection = (scopes: readonly InspectorContextScope[]) =>
    contextScope === 'all' || scopes.includes(contextScope);

  /** Hosted, the song-wide and practice settings live in their own places (the Song tab and the toolbar), so the task links go. */
  const hosted = songHost !== undefined;
  const scoreInfo = (
    <fieldset disabled={busy}>
      <label>
        {t('editor.title')}
        <input value={title} onChange={e => setTitle(e.target.value)} />
      </label>
      <label>
        {t('editor.artist')}
        <input value={artist} onChange={e => setArtist(e.target.value)} />
      </label>
      <label>
        {t('editor.initial_tempo')}
        <input type="number" min={1} value={tempo} onChange={e => setTempo(Number(e.target.value))} />
      </label>
      <button onClick={() => onEdit({ type: 'setScoreInfo', title, artist, tempo, ...(tempo === score.tempo ? { preserveOpeningMark: true } : {}) })}>{t('editor.apply_score_info')}</button>
    </fieldset>
  );
  return (
    <aside className="inspector">
      <header className="inspector-heading">
        <h2>{t('editor.inspector_title')}</h2>
        <p className="inspector-location" aria-label={t('editor.editing_location')}>
          {score.tracks[target.track].name || `Track ${target.track + 1}`} · Measure {target.bar + 1} · Beat {target.beat + 1}
          <span>
            Staff {target.staff + 1} · Voice {target.voice + 1}
            {indexed ? (noteIndex === null ? ' · No note selected' : ` · Note ${noteIndex + 1}`) : ` · String ${string}`}
          </span>
        </p>
        {!hosted && <nav aria-label={t('editor.inspector_tasks')}>
          <button aria-controls={`${id}-edit`} onClick={() => openTask(editTask.current)}>
            {t('editor.task_edit')}
          </button>
          <button aria-controls={`${id}-practice`} onClick={() => openTask(practiceTask.current)}>
            {t('editor.task_practice')}
          </button>
          <button aria-controls={`${id}-presentation`} onClick={() => openTask(presentationTask.current)}>
            {t('editor.task_presentation')}
          </button>
        </nav>}
      </header>
      <section aria-label={t('editor.edit_tools')}>
        <details className="inspector-task" id={`${id}-edit`} ref={editTask} open>
          <summary>{t('editor.task_edit')}</summary>
          <div ref={editBodyRef} className="tp-inspector-edit-body">
            {(() => {
              const palette = (
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
                  onEdit={onEdit}
                  orientation={paletteHost ? 'vertical' : 'horizontal'}
                  onSelect={onSelect}
                  onOpenMeasure={onOpenMeasure}
                  onOpenPanel={panel => (panel === 'chord' ? onChord() : panel === 'scales' ? onScales() : openLyrics())}
                />
              );
              return paletteHost ? createPortal(palette, paletteHost) : palette;
            })()}

            <div className="tp-context-card" role="region" aria-label={t('editor.selection_context')}>
              <div className="tp-context-summary">
                <span className="tp-context-primary">{selectionSummary}</span>
                <span className="tp-context-meta">
                  {master.timeSignatureNumerator}/{master.timeSignatureDenominator} · {openingTempo}
                  {beat?.chord?.name ? ` · ${t('editor.context_chord', { name: beat.chord.name })}` : ''}
                </span>
              </div>
              {activeTechniques.length > 0 && (
                <div className="tp-context-pills" aria-label={t('editor.active_note_techniques')}>
                  {activeTechniques.map(tag => (
                    <span key={tag} className="tp-context-pill">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="tp-context-filter" role="group" aria-label={t('editor.inspector_context')}>
                {CONTEXT_SCOPES.map(([scope]) => {
                  const labels: Record<InspectorContextScope, string> = { all: t('editor.scope_all'), note: t('editor.scope_note'), beat: t('editor.scope_beat'), measure: t('editor.scope_measure'), staff: t('editor.scope_staff'), selection: t('editor.scope_selection') };
                  return (
                  <button
                    key={scope}
                    type="button"
                    className="tp-context-tab"
                    aria-pressed={contextScope === scope}
                    onClick={() => selectContextScope(scope)}
                  >
                    {labels[scope]}
                  </button>
                );})}
              </div>
            </div>

            <fieldset disabled={controlsBusy}>
              <div className="pair" hidden={!showSection(['note', 'beat', 'measure'])}>
                <IndexInput
                  label={t('editor.measure')}
                  value={target.bar + 1}
                  min={1}
                  max={score.masterBars.length}
                  onValue={value => onSelect({ ...target, bar: value - 1, beat: 0 })}
                />
                <IndexInput
                  label={t('editor.beat')}
                  value={target.beat + 1}
                  min={1}
                  max={Math.max(1, voice.beats.length)}
                  onValue={value => onSelect({ ...target, beat: value - 1 })}
                />
              </div>
              <div className="pair" hidden={!showSection(['staff', 'note'])}>
                <label>
                  {t('editor.staff')}
                  <select
                    value={target.staff}
                    onChange={e => onSelect({ ...target, staff: Number(e.target.value), voice: 0, beat: 0 })}
                  >
                    {score.tracks[target.track].staves.map((s, i) => (
                      <option key={s.index} value={i}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('editor.voice')}
                  <select
                    value={target.voice}
                    onChange={e => onSelect({ ...target, voice: Number(e.target.value), beat: 0 })}
                  >
                    {bar.voices.map(v => (
                      <option key={v.index} value={v.index}>
                        {v.index + 1}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div hidden={!showSection(['note'])}>
                {indexed ? (
                  <NonTabPanel
                    score={score}
                    target={target}
                    noteIndex={noteIndex}
                    onSelectNote={onSelectNote}
                    busy={controlsBusy}
                    locked={locked}
                    onEdit={onEdit}
                  />
                ) : (
                  <div className="pair">
                    <label>
                      {t('editor.string')}
                      <select
                        value={string}
                        disabled={!staff.tuning.length}
                        onChange={e => onString(Number(e.target.value))}
                      >
                        {staff.tuning.map((pitch, i) => (
                          <option key={i} value={staff.tuning.length - i}>
                            {staff.tuning.length - i} · {formatPitch(pitch)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('editor.fret')}
                      <input type="number" min={0} max={127} value={fret} onChange={e => onFret(Number(e.target.value))} />
                    </label>
                  </div>
                )}
              </div>
              <fieldset className="inspector-edit-locked" disabled={locked}>
                {!indexed && (
                  <div hidden={!showSection(['note'])}>
                    <div className="pair">
                      <button
                        className="primary"
                        disabled={!beat || staff.isPercussion || !staff.tuning.length}
                        onClick={() => onEdit({ type: 'setNote', target, string, fret })}
                      >{t('editor.set_note')}</button>
                      <button
                        disabled={!beat || !staff.tuning.length}
                        onClick={() => onEdit({ type: 'removeNote', target, string })}
                      >{t('editor.remove_note')}</button>
                    </div>
                    <p className="muted">{t('editor.chord_hint')}</p>
                  </div>
                )}
                <div hidden={!showSection(['beat', 'note'])}>
                  <div className="pair">
                    <label>
                      {t('editor.duration')}
                      <select value={duration} onChange={e => setDuration(Number(e.target.value))}>
                        {[-4, -2, 1, 2, 4, 8, 16, 32, 64, 128, 256].map(d => (
                          <option key={d} value={d}>
                            {d === -4 ? 'Quadruple whole' : d === -2 ? 'Double whole' : `1/${d}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('editor.dots')}
                      <input type="number" min={0} max={3} value={dots} onChange={e => setDots(Number(e.target.value))} />
                    </label>
                  </div>
                  <details className="inspector-advanced">
                    <summary>{t('editor.advanced_rhythm')}</summary>
                    <div className="pair">
                      <label>
                        {t('editor.tuplet_numerator')}
                        <input
                          type="number"
                          min={1}
                          value={tupletNumerator}
                          onChange={e => setTupletNumerator(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        {t('editor.tuplet_denominator')}
                        <input
                          type="number"
                          min={1}
                          value={tupletDenominator}
                          onChange={e => setTupletDenominator(Number(e.target.value))}
                        />
                      </label>
                    </div>
                    <EnumInput label={t('editor.grace_type')} value={graceType} enumeration={model.GraceType} onValue={setGraceType} />
                  </details>
                  <div className="pair">
                    <button
                      disabled={!beat}
                      onClick={() =>
                        onEdit({
                          type: 'setBeatRhythm',
                          target,
                          duration,
                          dots,
                          tupletNumerator,
                          tupletDenominator,
                          graceType,
                        })
                      }
                    >{t('editor.apply_rhythm')}</button>
                    <button disabled={!beat} onClick={() => onEdit({ type: 'setRest', target })}>{t('editor.make_rest')}</button>
                  </div>
                  <p className="muted">
                    {!beat
                      ? t('editor.beat_state_empty')
                      : beat.isFullBarRest
                        ? t('editor.beat_state_full_rest')
                        : beat.isRest
                          ? t('editor.beat_state_explicit_rest')
                          : t('editor.beat_state_pitched')}
                    {beat?.isRest && !beat.isFullBarRest ? ` · ${t('editor.full_rest_hint')}` : ''}
                  </p>
                  <p className="muted">
                    {master.timeSignatureNumerator}/{master.timeSignatureDenominator} · {t('editor.quarters_remaining', { count: remaining / 960 })}
                  </p>
                  <div className="pair">
                    <button onClick={() => onEdit({ type: 'insertBeat', target, duration, dots })}>{t('editor.insert_beat')}</button>
                    <button disabled={!beat} onClick={() => onEdit({ type: 'deleteBeat', target })}>{t('editor.delete_beat')}</button>
                  </div>
                </div>
                <div className="pair" hidden={!showSection(['measure'])}>
                  <button onClick={() => onEdit({ type: 'appendMeasure' })}>{t('editor.append_measure')}</button>
                  <button
                    disabled={score.masterBars.length === 1}
                    onClick={() => onEdit({ type: 'removeMeasure', bar: target.bar })}
                  >{t('editor.remove_measure')}</button>
                </div>
              </fieldset>
            </fieldset>
            <div className="inspector-musical-tools" hidden={!showSection(['beat', 'note'])}>
              <h3>{t('editor.musical_tools')}</h3>
              <div className="pair">
                <button disabled={busy || !beat} onClick={onChord}>{t('editor.edit_chord_diagram')}</button>
                <button disabled={controlsBusy} onClick={onScales}>{t('editor.browse_scales')}</button>
              </div>
              <p className="muted">{beat?.chord?.name || t('editor.no_chord_diagram')}</p>
            </div>
            <div hidden={!showSection(['note'])}>
              <SpellingControl
                score={score}
                target={target}
                noteIndex={indexed ? (noteIndex ?? -1) : (beat?.notes.findIndex(n => n.string === string) ?? -1)}
                busy={busy}
                onEdit={onEdit}
              />
            </div>
            <div hidden={!showSection(['note', 'beat'])}>
              <TechniquePanel score={score} target={target} string={string} noteIndex={noteIndex} busy={busy} onEdit={onEdit} />
            </div>
            <div hidden={!showSection(['beat'])}>
              <GesturePanel score={score} target={target} busy={busy} onEdit={onEdit} />
            </div>
            <div hidden={!showSection(['selection'])}>
              <RangePanel
                score={score}
                target={target}
                selection={musicSelection}
                busy={controlsBusy}
                locked={locked}
                onSelection={onMusicSelection}
                onEdit={onEdit}
              />
              {children}
            </div>
            <div hidden={!showSection(['beat'])}>
              <details>
                <summary>{t('editor.beat_text')}</summary>
                <fieldset disabled={busy || !beat}>
                  <label>
                    {t('editor.beat_text')}
                    <input value={text} onChange={e => setText(e.target.value)} />
                  </label>
                  <button onClick={() => onEdit({ type: 'setBeatText', target, text })}>{t('editor.apply_beat_text')}</button>
                </fieldset>
              </details>
            </div>
            <div hidden={!showSection(['measure'])}>
              <MeasurePanel score={score} target={target} string={string} busy={busy} onEdit={onEdit} />
              <DirectionsPanel score={score} target={target} busy={busy} onEdit={onEdit} />
            </div>
            <div hidden={!showSection(['staff'])}>
              <StructurePanel
                key={documentEpoch}
                score={score}
                target={target}
                string={string}
                busy={controlsBusy}
                locked={locked}
                onEdit={onEdit}
                onSelect={onSelect}
                onAudition={onAudition}
              />
            </div>
            <div hidden={!showSection(['measure'])}>
              <BarGesturePanel score={score} track={target.track} staff={target.staff} bar={target.bar} busy={busy} onEdit={onEdit} />
            </div>
            <div hidden={!showSection(['staff'])}>
              <LyricsPanel score={score} track={target.track} busy={busy} onEdit={onEdit} />
            </div>
            <div hidden={!showSection(['measure'])}>
              <MeasureTransformPanel score={score} bar={target.bar} busy={busy} onEdit={onEdit} />
            </div>
          </div>
        </details>
      </section>
      {practiceHost ? createPortal(
        <section className="gp-practice-section" aria-label={t('editor.practice_tools')}>
          <h3>{t('editor.task_practice')}</h3>
          <fieldset disabled={controlsBusy}>
            {practiceTools ?? <p className="muted">{t('editor.practice_hint')}</p>}
          </fieldset>
          {tunerTool}
        </section>, practiceHost) : !hosted && <section aria-label={t('editor.practice_tools')}>
        <details className="inspector-task" id={`${id}-practice`} ref={practiceTask}>
          <summary>{t('editor.task_practice')}</summary>
          <fieldset disabled={controlsBusy}>
            {practiceTools ?? <p className="muted">{t('editor.practice_hint')}</p>}
          </fieldset>
          {tunerTool}
        </details>
      </section>}
      {songHost ? createPortal(<>
        <section className="inspector-section" aria-labelledby={`${id}-song-information`}>
          <h3 id={`${id}-song-information`}>{t('inspector.information')}</h3>
          {scoreInfo}
          <SongPanel score={score} busy={busy} onEdit={onEdit} />
          <AuthorDefaultsPanel score={score} load={newScoreDefaults} onSave={writeAuthorDefaults} />
        </section>
        <section className="inspector-section" aria-labelledby={`${id}-song-notation`}>
          <h3 id={`${id}-song-notation`}>{t('inspector.musical_notation')}</h3>
          <fieldset disabled={busy}>{presentationTools}</fieldset>
          {presentationViewTools && <fieldset disabled={controlsBusy}>{presentationViewTools}</fieldset>}
        </section>
      </>, songHost) : !hosted && <section aria-label={t('editor.presentation_tools')}>
        <details className="inspector-task" id={`${id}-presentation`} ref={presentationTask}>
          <summary>{t('editor.task_presentation')}</summary>
          <fieldset disabled={busy}>{presentationTools}</fieldset>
          {presentationViewTools && <fieldset disabled={controlsBusy}>{presentationViewTools}</fieldset>}
          <details>
            <summary>{t('editor.score_info')}</summary>
            {scoreInfo}
          </details>
          <SongPanel score={score} busy={busy} onEdit={onEdit} />
          <AuthorDefaultsPanel score={score} load={newScoreDefaults} onSave={writeAuthorDefaults} />
        </details>
      </section>}
    </aside>
  );
}
