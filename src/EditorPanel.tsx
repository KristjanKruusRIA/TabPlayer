import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
import type { MusicSelection } from './editor/range-types';
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
  presentationTools,
  presentationViewTools,
}: {
  score: model.Score;
  target: BeatTarget;
  string: number;
  fret: number;
  busy: boolean;
  /** The document is finalized: every edit control is disabled, but practice tools and view settings are not. */
  locked?: boolean;
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
  presentationTools?: ReactNode;
  presentationViewTools?: ReactNode;
}) {
  const busy = controlsBusy || locked;
  const id = useId();
  const editTask = useRef<HTMLDetailsElement>(null);
  const practiceTask = useRef<HTMLDetailsElement>(null);
  const presentationTask = useRef<HTMLDetailsElement>(null);
  const editBodyRef = useRef<HTMLDivElement>(null);
  const [contextScope, setContextScope] = useState<InspectorContextScope>('all');

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
    if (scope === 'note') openSummaryByText('Notes & techniques');
    else if (scope === 'beat') openSummaryByText('Beat notation');
    else if (scope === 'measure') openSummaryByText('Measure & notation');
    else if (scope === 'staff') openSummaryByText('Staff, voices & layout');
    else if (scope === 'selection') openSummaryByText('Music selection');
  };

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
      ? `Range selection · M${musicSelection.range.start.bar + 1}–M${musicSelection.range.end.bar + 1}`
      : musicSelection.kind === 'bars'
        ? `Range selection · Measures ${musicSelection.firstBar + 1}–${musicSelection.lastBar + 1}`
        : `Range selection · ${musicSelection.notes.length} note${musicSelection.notes.length === 1 ? '' : 's'}`
    : note
      ? indexed
        ? `Selected note · Note ${(noteIndex ?? 0) + 1}${staff.isPercussion ? '' : ` (${formatPitch(note.realValue)})`}`
        : `Selected note · String ${string} Fret ${note.fret} (${formatPitch(note.realValue)})`
      : beat?.isRest
        ? `Rest beat · 1/${beat.duration}${beat.dots ? '.'.repeat(beat.dots) : ''}`
        : `Empty string slot · String ${string} (Beat 1/${beat?.duration ?? duration})`;

  const showSection = (scopes: readonly InspectorContextScope[]) =>
    contextScope === 'all' || scopes.includes(contextScope);

  return (
    <aside className="inspector">
      <header className="inspector-heading">
        <h2>Inspector</h2>
        <p className="inspector-location" aria-label="Editing location">
          {score.tracks[target.track].name || `Track ${target.track + 1}`} · Measure {target.bar + 1} · Beat {target.beat + 1}
          <span>
            Staff {target.staff + 1} · Voice {target.voice + 1}
            {indexed ? (noteIndex === null ? ' · No note selected' : ` · Note ${noteIndex + 1}`) : ` · String ${string}`}
          </span>
        </p>
        <nav aria-label="Inspector tasks">
          <button aria-controls={`${id}-edit`} onClick={() => openTask(editTask.current)}>
            Edit
          </button>
          <button aria-controls={`${id}-practice`} onClick={() => openTask(practiceTask.current)}>
            Practice
          </button>
          <button aria-controls={`${id}-presentation`} onClick={() => openTask(presentationTask.current)}>
            Presentation
          </button>
        </nav>
      </header>
      <section aria-label="Edit tools">
        <details className="inspector-task" id={`${id}-edit`} ref={editTask} open>
          <summary>Edit</summary>
          <div ref={editBodyRef} className="tp-inspector-edit-body">
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
            />

            <div className="tp-context-card" role="region" aria-label="Selection context">
              <div className="tp-context-summary">
                <span className="tp-context-primary">{selectionSummary}</span>
                <span className="tp-context-meta">
                  {master.timeSignatureNumerator}/{master.timeSignatureDenominator} · {score.tempo} BPM
                  {beat?.chord?.name ? ` · Chord ${beat.chord.name}` : ''}
                </span>
              </div>
              {activeTechniques.length > 0 && (
                <div className="tp-context-pills" aria-label="Active note techniques">
                  {activeTechniques.map(tag => (
                    <span key={tag} className="tp-context-pill">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="tp-context-filter" role="group" aria-label="Inspector context">
                {CONTEXT_SCOPES.map(([scope, label]) => (
                  <button
                    key={scope}
                    type="button"
                    className="tp-context-tab"
                    aria-pressed={contextScope === scope}
                    onClick={() => selectContextScope(scope)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <fieldset disabled={controlsBusy}>
              <div className="pair" hidden={!showSection(['note', 'beat', 'measure'])}>
                <IndexInput
                  label="Measure"
                  value={target.bar + 1}
                  min={1}
                  max={score.masterBars.length}
                  onValue={value => onSelect({ ...target, bar: value - 1, beat: 0 })}
                />
                <IndexInput
                  label="Beat"
                  value={target.beat + 1}
                  min={1}
                  max={Math.max(1, voice.beats.length)}
                  onValue={value => onSelect({ ...target, beat: value - 1 })}
                />
              </div>
              <div className="pair" hidden={!showSection(['staff', 'note'])}>
                <label>
                  Staff
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
                  Voice
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
                      String
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
                      Fret
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
                      >
                        Set note
                      </button>
                      <button
                        disabled={!beat || !staff.tuning.length}
                        onClick={() => onEdit({ type: 'removeNote', target, string })}
                      >
                        Remove note
                      </button>
                    </div>
                    <p className="muted">Add notes on different strings of this beat to make a chord.</p>
                  </div>
                )}
                <div hidden={!showSection(['beat', 'note'])}>
                  <div className="pair">
                    <label>
                      Duration
                      <select value={duration} onChange={e => setDuration(Number(e.target.value))}>
                        {[-4, -2, 1, 2, 4, 8, 16, 32, 64, 128, 256].map(d => (
                          <option key={d} value={d}>
                            {d === -4 ? 'Quadruple whole' : d === -2 ? 'Double whole' : `1/${d}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Dots
                      <input type="number" min={0} max={3} value={dots} onChange={e => setDots(Number(e.target.value))} />
                    </label>
                  </div>
                  <details className="inspector-advanced">
                    <summary>Advanced rhythm</summary>
                    <div className="pair">
                      <label>
                        Tuplet numerator
                        <input
                          type="number"
                          min={1}
                          value={tupletNumerator}
                          onChange={e => setTupletNumerator(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        Tuplet denominator
                        <input
                          type="number"
                          min={1}
                          value={tupletDenominator}
                          onChange={e => setTupletDenominator(Number(e.target.value))}
                        />
                      </label>
                    </div>
                    <EnumInput label="Grace type" value={graceType} enumeration={model.GraceType} onValue={setGraceType} />
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
                    >
                      Apply rhythm
                    </button>
                    <button disabled={!beat} onClick={() => onEdit({ type: 'setRest', target })}>
                      Make rest
                    </button>
                  </div>
                  <p className="muted">
                    {!beat
                      ? 'Empty voice insertion'
                      : beat.isFullBarRest
                        ? 'Full-measure rest'
                        : beat.isRest
                          ? 'Explicit rest'
                          : 'Pitched beat'}
                    {beat?.isRest && !beat.isFullBarRest ? ' · Use a single whole rest for a full-measure rest.' : ''}
                  </p>
                  <p className="muted">
                    {master.timeSignatureNumerator}/{master.timeSignatureDenominator} · {remaining / 960} quarter notes
                    remaining
                  </p>
                  <div className="pair">
                    <button onClick={() => onEdit({ type: 'insertBeat', target, duration, dots })}>Insert beat</button>
                    <button disabled={!beat} onClick={() => onEdit({ type: 'deleteBeat', target })}>
                      Delete beat
                    </button>
                  </div>
                </div>
                <div className="pair" hidden={!showSection(['measure'])}>
                  <button onClick={() => onEdit({ type: 'appendMeasure' })}>Append measure</button>
                  <button
                    disabled={score.masterBars.length === 1}
                    onClick={() => onEdit({ type: 'removeMeasure', bar: target.bar })}
                  >
                    Remove measure
                  </button>
                </div>
              </fieldset>
            </fieldset>
            <div className="inspector-musical-tools" hidden={!showSection(['beat', 'note'])}>
              <h3>Musical tools</h3>
              <div className="pair">
                <button disabled={busy || !beat} onClick={onChord}>
                  Edit chord diagram
                </button>
                <button disabled={controlsBusy} onClick={onScales}>
                  Browse scales
                </button>
              </div>
              <p className="muted">{beat?.chord?.name || 'No chord diagram on this beat'}</p>
            </div>
            <div hidden={!showSection(['note'])}>
              <SpellingControl
                score={score}
                target={target}
                noteIndex={indexed ? (noteIndex ?? -1) : (beat?.notes.findIndex(n => n.string === string) ?? -1)}
                busy={busy}
                onEdit={onEdit}
              />
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
                <summary>Beat text</summary>
                <fieldset disabled={busy || !beat}>
                  <label>
                    Beat text
                    <input value={text} onChange={e => setText(e.target.value)} />
                  </label>
                  <button onClick={() => onEdit({ type: 'setBeatText', target, text })}>Apply beat text</button>
                </fieldset>
              </details>
            </div>
            <div hidden={!showSection(['measure'])}>
              <MeasurePanel score={score} target={target} string={string} busy={busy} onEdit={onEdit} />
              <DirectionsPanel score={score} target={target} busy={busy} onEdit={onEdit} />
            </div>
            <div hidden={!showSection(['staff'])}>
              <StructurePanel
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
      <section aria-label="Practice tools">
        <details className="inspector-task" id={`${id}-practice`} ref={practiceTask}>
          <summary>Practice</summary>
          <fieldset disabled={controlsBusy}>
            {practiceTools ?? <p className="muted">Use the playback controls below the score to rehearse.</p>}
          </fieldset>
        </details>
      </section>
      <section aria-label="Presentation tools">
        <details className="inspector-task" id={`${id}-presentation`} ref={presentationTask}>
          <summary>Presentation</summary>
          <fieldset disabled={busy}>{presentationTools}</fieldset>
          {presentationViewTools && <fieldset disabled={controlsBusy}>{presentationViewTools}</fieldset>}
          <details>
            <summary>Score information</summary>
            <fieldset disabled={busy}>
              <label>
                Title
                <input value={title} onChange={e => setTitle(e.target.value)} />
              </label>
              <label>
                Artist
                <input value={artist} onChange={e => setArtist(e.target.value)} />
              </label>
              <label>
                Initial tempo
                <input type="number" min={1} value={tempo} onChange={e => setTempo(Number(e.target.value))} />
              </label>
              <button onClick={() => onEdit({ type: 'setScoreInfo', title, artist, tempo })}>Apply score info</button>
            </fieldset>
          </details>
          <SongPanel score={score} busy={busy} onEdit={onEdit} />
          <AuthorDefaultsPanel score={score} load={newScoreDefaults} onSave={writeAuthorDefaults} />
        </details>
      </section>
    </aside>
  );
}
