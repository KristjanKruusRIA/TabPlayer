import { useI18n } from '../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { model } from '@coderline/alphatab';
import type { EditCommand } from '../project';
import { midiPrograms } from '../midi-programs';
import { formatTuning, parseTuning } from '../tuning';
import { TuningRow } from '../tuning/TuningRow';
import { TuningDialog, type TuningChoice } from '../tuning/TuningDialog';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import { BusyFieldset } from '../ui/BusyFieldset';
import { CommitField } from '../ui/CommitField';
import { ArrowDownGlyph, ArrowUpGlyph, DuplicateGlyph, ScoreGlyph, TrashGlyph } from '../shell/glyphs';
import { trackIdentity } from '../engine';
import type { TuningAudition } from '../audio/audition';
import { NotationTrackControls } from '../editor/NonTabPanel';
import { readStaffSettings, staffSettingsUnchanged } from '../editor/staff-settings';
import { getBanjoDrone } from '../editor/banjo-drone';
import { getPartialCapo, noPartialCapo } from '../editor/partial-capo';
import { trackColorHex } from '../track-color';
import './track-panels.css';
import './inspector-compact.css';

/** The track's colour as a swatch. One change is recorded when the picker settles (the browser's own `change`), not for every colour it passes through. */
function ColorSwatch({ label, value, busy, locked, onCommit }: { label: string; value: string; busy: boolean; locked: boolean; onCommit: (color: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, busy, locked, onCommit });
  latest.current = { value, busy, locked, onCommit };
  // React's onChange follows every `input` event of the colour picker; the native `change` is the settled choice.
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    const settle = () => {
      const { value: saved, busy: working, locked: finalized, onCommit: commit } = latest.current;
      if (working || finalized) { node.value = saved; return; }
      if (node.value.toLowerCase() !== saved.toLowerCase()) commit(node.value);
    };
    node.addEventListener('change', settle);
    return () => node.removeEventListener('change', settle);
  }, []);
  useEffect(() => { if (input.current) input.current.value = value; }, [value]);
  return <input ref={input} className="track-color-input" type="color" defaultValue={value} aria-label={label} title={label} disabled={locked} />;
}

/** Colour, name and short name in one row; the MIDI instrument behind More. Each field records one change when it is left. */
function TrackInfoRow({ score, selected, busy, locked, onEdit }: { score: model.Score; selected: number; busy: boolean; locked: boolean; onEdit: (command: EditCommand) => unknown }) {
  const { t } = useI18n();
  const current = score.tracks[selected];
  const program = current.playbackInfo.program;
  const info = (change: { name?: string; shortName?: string; program?: number }) => {
    if (locked) return;
    void onEdit({ type: 'setTrackInfo', track: selected, name: change.name ?? current.name, shortName: change.shortName ?? current.shortName, program: change.program ?? program });
  };
  return <BusyFieldset busy={busy} className="track-info">
    <div className="track-info-row">
      <ColorSwatch label={t('track_settings.track_color')} value={trackColorHex(current.color)} busy={busy} locked={locked} onCommit={color => { if (!locked) void onEdit({ type: 'setTrackColor', track: selected, color }); }} />
      <CommitField hideLabel label={t('track_settings.track_name')} value={current.name} disabled={locked} onCommit={name => info({ name })} />
      <CommitField hideLabel className="track-short-name" label={t('track_settings.track_short_name')} value={current.shortName} disabled={locked} onCommit={shortName => info({ shortName })} />
    </div>
    {!current.isPercussion && <details className="inspector-more">
      <summary>{t('inspector.more')}</summary>
      <label>{t('track_settings.track_midi_instrument')}<select value={program} disabled={locked} {...busySelect(busy)} onChange={event => { if (!busy) info({ program: Number(event.target.value) }); }}>{midiPrograms.map((name, index) => <option key={index} value={index}>{index + 1}. {name}</option>)}</select></label>
    </details>}
  </BusyFieldset>;
}

/** Tab and standard notation as two toggles, the tuning as one row that opens the Tuning dialog (with its Capo section), and the rest of the staff's settings behind More. */
function NotationSection({ score, selected, staffIndex, barIndex, busy, locked, refusal, onEdit, onAudition }: {
  score: model.Score; selected: number; staffIndex: number; barIndex: number; busy: boolean; locked: boolean; refusal: string | null; onEdit: (command: EditCommand) => unknown; onAudition?: TuningAudition;
}) {
  const { t } = useI18n();
  const current = score.tracks[selected];
  const staffAt = Math.min(staffIndex, current.staves.length - 1), staff = current.staves[staffAt];
  const clef = staff.bars[barIndex]?.clef ?? staff.bars[0]?.clef ?? model.Clef.G2;
  const pitches = formatTuning(current.staves[0].tuning), savedName = current.staves[0].stringTuning.name;
  const strings = current.staves[0].tuning.length, tuningUnavailable = current.isPercussion || !strings;
  const editable = !staff.isPercussion && !!staff.tuning.length;
  // The dialog belongs to the track it was opened for, by identity: moving or removing tracks while it is open must not retarget it.
  const [tuningFor, setTuningFor] = useState<string | null>(null);
  const [capoRefusal, setCapoRefusal] = useState<string | null>(null);
  const dialogIndex = tuningFor === null ? -1 : score.tracks.findIndex(track => trackIdentity(track) === tuningFor), dialogTrack = dialogIndex >= 0 ? score.tracks[dialogIndex] : null;
  useEffect(() => { if (tuningFor !== null && dialogIndex < 0) setTuningFor(null); }, [tuningFor, dialogIndex]);
  const dialogStaffIndex = Math.min(staffIndex, (dialogTrack?.staves.length ?? 1) - 1);
  /** The staff's settings as they are now, plus the changes; the same payload the old Apply staff settings button sent. */
  const settingsFor = (target: model.Staff, targetClef: number, change: Partial<ReturnType<typeof readStaffSettings>> & { tuningName?: string; keepPitch?: boolean } = {}) => ({ ...readStaffSettings(target, targetClef), ...(!target.isPercussion && target.tuning.length ? { tuningName: target.stringTuning.name } : {}), ...change });
  const applySettings = (change: Partial<ReturnType<typeof readStaffSettings>>) => {
    if (locked || busy) return;
    const next = settingsFor(staff, clef, change);
    if (staffSettingsUnchanged(staff, clef, next)) return;
    return onEdit({ type: 'setStaffSettings', track: selected, staff: staffAt, settings: next });
  };
  /** Records nothing when the tuning, its name, the string count and the capo section are the ones the track already has. Targets the track the dialog was opened for, and does nothing if that track is gone. */
  const applyTuning = ({ pitches: notes, name: tuningName, keepPitch, keep, capo }: TuningChoice) => {
    if (locked || !dialogTrack || dialogIndex < 0) return;
    setCapoRefusal(null);
    const count = dialogTrack.staves[0].tuning.length;
    const sameTuning = notes.length === count && dialogTrack.staves.every(target => target.tuning.every((pitch, index) => pitch === notes[index]) && target.stringTuning.name === tuningName);
    if (capo?.changed) {
      const target = dialogTrack.staves[dialogStaffIndex], targetClef = target.bars[barIndex]?.clef ?? target.bars[0]?.clef ?? model.Clef.G2;
      const settings = { ...settingsFor(target, targetClef, { capo: capo.capo }), ...(JSON.stringify(capo.partialCapo) !== JSON.stringify(getPartialCapo(target) ?? noPartialCapo) ? { partialCapo: capo.partialCapo } : {}), ...(capo.droneFret !== getBanjoDrone(target) ? { droneFret: capo.droneFret } : {}) };
      if (!sameTuning) {
        // One gesture is one edit: a retune of the whole track and a capo on one staff only share an edit when the track has the one staff and keeps its string count.
        if (notes.length !== count || dialogTrack.staves.length > 1) { setCapoRefusal(t('tuning_dialog.capo_separately')); return Promise.resolve(false); }
        Object.assign(settings, { tuning: notes, tuningName, ...(keepPitch ? { keepPitch: true } : {}) });
      }
      return onEdit({ type: 'setStaffSettings', track: dialogIndex, staff: dialogStaffIndex, settings });
    }
    if (sameTuning) return;
    return onEdit(notes.length !== count ? { type: 'setStringCount', track: dialogIndex, tuning: notes, keep, tuningName, crossVoice: true } : { type: 'setTuning', track: dialogIndex, tuning: notes, tuningName, ...(keepPitch ? { keepPitch: true } : {}) });
  };
  const audition = (list: number[], strum: boolean) => onAudition?.({ trackId: trackIdentity(current) }, list, strum);
  const toggle = (label: string, pressed: boolean, disabled: boolean, onClick: () => void, content: ReactNode) =>
    <button type="button" aria-pressed={pressed} title={label} aria-label={label} {...busyGuard({ busy, disabled: disabled || locked, className: 'notation-toggle', onClick })}>{content}</button>;
  return <div className="track-notation">
    <div className="notation-toggles" role="group" aria-label={t('track_settings.notation_toggles')}>
      <span className="notation-toggles-label">{t('track_settings.notation')}</span>
      {toggle(t('editor.show_tablature'), staff.showTablature, !editable && !staff.isPercussion, () => applySettings({ showTab: !staff.showTablature }), <span className="notation-toggle-tab" aria-hidden="true">TAB</span>)}
      {toggle(t('editor.show_notation'), staff.showStandardNotation, false, () => applySettings({ showNotation: !staff.showStandardNotation }), <ScoreGlyph />)}
      {current.staves.length > 1 && <span className="notation-staff">{t('editor.staff_n', { staff: staffAt + 1 })}</span>}
    </div>
    <TuningRow label={t('track_settings.tuning_row')} notes={pitches} title={savedName ? `${savedName}: ${pitches}` : pitches} unavailable={tuningUnavailable} busy={busy} locked={locked} onOpen={() => { setCapoRefusal(null); setTuningFor(trackIdentity(current)); }} onPlay={onAudition && (() => audition([...current.staves[0].tuning], true))} playDisabled={strings > 12} />
    {dialogTrack && <TuningDialog pitches={dialogTrack.staves[0].tuning} name={dialogTrack.staves[0].stringTuning.name} staff={dialogTrack.staves[dialogStaffIndex]} busy={busy} locked={locked} refusal={capoRefusal ?? refusal} onApply={applyTuning} onClose={() => setTuningFor(null)} onAudition={onAudition && ((list, strum) => onAudition({ trackId: trackIdentity(dialogTrack) }, list, strum))} />}
    <BusyFieldset busy={busy} className="track-notation-more">
      <details className="inspector-more">
        <summary>{t('inspector.more')}</summary>
        <label>{t('editor.staff_clef')}<select value={clef} disabled={locked} {...busySelect(busy)} onChange={event => { if (!busy) applySettings({ clef: Number(event.target.value) }); }}>{Object.entries(model.Clef).filter(([, value]) => typeof value === 'number').map(([name, value]) => <option key={name} value={value as number}>{name.replace(/([a-z])([A-Z])/g, '$1 $2')}</option>)}</select></label>
        <CommitField type="number" label={t('editor.sounding_transposition')} value={String(staff.transpositionPitch)} disabled={locked} onCommit={value => applySettings({ transposition: Number(value) })} />
        <CommitField type="number" label={t('editor.display_transposition')} value={String(staff.displayTranspositionPitch)} disabled={locked} onCommit={value => applySettings({ displayTransposition: Number(value) })} />
        <div className="track-staff-actions">
          <button type="button" {...busyGuard({ busy, disabled: locked || staff.isPercussion, onClick: () => onEdit({ type: 'addStaff', track: selected, settings: settingsFor(staff, clef) }) })}>{t('editor.add_staff')}</button>
          <button type="button" {...busyGuard({ busy, disabled: locked || current.staves.length === 1, onClick: () => onEdit({ type: 'removeStaff', track: selected, staff: staffAt }) })}>{t('editor.remove_staff')}</button>
        </div>
      </details>
    </BusyFieldset>
  </div>;
}

/** The new-track form: name, instrument and tuning, then Add track; and the notation tracks (pitched, percussion). Folded away until asked for. */
function AddInstrument({ busy, locked, onEdit, onAudition }: { busy: boolean; locked: boolean; onEdit: (command: EditCommand) => unknown; onAudition?: TuningAudition }) {
  const { t } = useI18n();
  const [name, setName] = useState('Bass'), [instrument, setInstrument] = useState(33), [newTuning, setNewTuning] = useState('G2 D2 A1 E1');
  const [newTuningName, setNewTuningName] = useState(''), [newTuningOpen, setNewTuningOpen] = useState(false);
  const applyNewTrack = () => { if (locked) return; onEdit({ type: 'addTrack', name, tuning: parseTuning(newTuning), program: instrument, tuningName: newTuningName }); };
  return <BusyFieldset busy={busy}>
    <details className="track-add"><summary>{t('track_settings.add_instrument')}</summary><label>{t('track_settings.new_track_name')}<input value={name} onChange={e => setName(e.target.value)} /></label>
      <label>{t('track_settings.midi_instrument')}<select value={instrument} onChange={e => setInstrument(Number(e.target.value))}>{midiPrograms.map((label, value) => <option key={value} value={value}>{value + 1}. {label}</option>)}</select></label>
      <TuningRow label={t('track_settings.tuning_row')} editKey="track_settings.new_track_tuning_edit" notes={newTuning} unavailable={false} busy={busy} onOpen={() => setNewTuningOpen(true)} onPlay={onAudition && (() => onAudition({ program: instrument }, parseTuning(newTuning), true))} />
      {newTuningOpen && <TuningDialog mode="draft" pitches={parseTuning(newTuning)} name={newTuningName} onApply={choice => { setNewTuning(formatTuning(choice.pitches)); setNewTuningName(choice.name); }} onClose={() => setNewTuningOpen(false)} onAudition={onAudition && ((list, strum) => onAudition({ program: instrument }, list, strum))} />}
      <button disabled={locked} onClick={applyNewTrack}>{t('track_settings.add_track')}</button>
      <NotationTrackControls busy={busy || locked} onEdit={onEdit} />
    </details>
  </BusyFieldset>;
}

/**
 * The Track tab in the manner of Guitar Pro's track inspector: the track actions and one Information row, Musical notation
 * (two toggles, the tuning row, More), then whatever the app puts under Sounds, Interpretation and MIDI output, and Add instrument.
 */
export function TrackSettingsPanel({ score, selected, staff = 0, bar = 0, busy, locked = false, refusal = null, onEdit, onAudition, sounds, interpretation, midi }: {
  score: model.Score; selected: number;
  /** The staff and bar under the cursor: the toggles, clef and transposition act on that staff. */
  staff?: number; bar?: number;
  busy: boolean; /** Finalized: edits are disabled, but tuning audition is not. */ locked?: boolean; /** The app's message for the edit it last refused, shown in the Tuning dialog. */ refusal?: string | null;
  onEdit: (command: EditCommand) => unknown; onAudition?: TuningAudition;
  sounds?: ReactNode; interpretation?: ReactNode; midi?: ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const current = score.tracks[selected];
  const action = (label: string, glyph: React.JSX.Element, disabled: boolean, onClick: () => void, className?: string) => <button type="button" title={label} aria-label={label} {...busyGuard({ busy, disabled, className, onClick })}>{glyph}</button>;
  return <aside className="track-settings" aria-label={t('track_settings.aria_label')}>
    <section className="inspector-section" aria-labelledby="inspector-track-info"><h3 id="inspector-track-info">{t('inspector.information')}</h3>
      <div className="track-actions" role="group" aria-label={t('track_settings.track_actions')}>
        {action(t('track_settings.move_track_up'), <ArrowUpGlyph />, locked || selected === 0, () => onEdit({ type: 'moveTrack', track: selected, to: selected - 1 }))}
        {action(t('track_settings.move_track_down'), <ArrowDownGlyph />, locked || selected === score.tracks.length - 1, () => onEdit({ type: 'moveTrack', track: selected, to: selected + 1 }))}
        {action(t('track_settings.duplicate_track'), <DuplicateGlyph />, locked, () => onEdit({ type: 'duplicateTrack', track: selected }))}
        <span className="track-actions-gap" aria-hidden="true" />
        {action(t('track_settings.remove_track'), <TrashGlyph />, locked || score.tracks.length === 1, () => onEdit({ type: 'removeTrack', track: selected }), 'track-remove')}
      </div>
      <TrackInfoRow key={trackIdentity(current)} score={score} selected={selected} busy={busy} locked={locked} onEdit={onEdit} />
    </section>
    <section className="inspector-section" aria-labelledby="inspector-track-notation"><h3 id="inspector-track-notation">{t('inspector.musical_notation')}</h3>
      <NotationSection score={score} selected={selected} staffIndex={staff} barIndex={bar} busy={busy} locked={locked} refusal={refusal} onEdit={onEdit} onAudition={onAudition} />
    </section>
    {sounds && <section className="inspector-section" aria-labelledby="inspector-track-sounds"><h3 id="inspector-track-sounds">{t('inspector.sounds')}</h3>{sounds}</section>}
    {interpretation}
    {midi}
    <section className="inspector-section inspector-add-section"><AddInstrument busy={busy} locked={locked} onEdit={onEdit} onAudition={onAudition} /></section>
  </aside>;
}
