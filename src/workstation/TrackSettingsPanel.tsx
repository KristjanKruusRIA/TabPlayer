import { useI18n } from '../i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { model } from '@coderline/alphatab';
import type { EditCommand } from '../project';
import { midiPrograms } from '../midi-programs';
import { formatTuning } from '../tuning';
import { TuningRow } from '../tuning/TuningRow';
import { TuningDialog, type TuningChoice } from '../tuning/TuningDialog';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import { BusyFieldset } from '../ui/BusyFieldset';
import { CommitField } from '../ui/CommitField';
import { CommitSelect } from '../ui/CommitSelect';
import { ArrowDownGlyph, ArrowUpGlyph, DuplicateGlyph, ScoreGlyph, TrashGlyph } from '../shell/glyphs';
import { trackIdentity } from '../engine';
import type { TuningAudition } from '../audio/audition';
import { readStaffSettings, staffSettingsUnchanged } from '../editor/staff-settings';
import { getBanjoDrone } from '../editor/banjo-drone';
import { getPartialCapo, noPartialCapo } from '../editor/partial-capo';
import { trackColorHex } from '../track-color';
import { defaultEngraving, isDrumTrack } from '../engraving/projection';
import type { EngravingOverrides, TrackProfile } from '../engraving/types';
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
  const id = trackIdentity(current);
  /** Records the change for the track with identity `owner`: a name typed for one track is still that track's when the selection has moved on. */
  const info = (change: { name?: string; shortName?: string; program?: number }, owner = id) => {
    const index = score.tracks.findIndex(track => trackIdentity(track) === owner);
    if (locked || index < 0) return false;
    const track = score.tracks[index], saved = track.playbackInfo.program;
    if ((change.name ?? track.name) === track.name && (change.shortName ?? track.shortName) === track.shortName && (change.program ?? saved) === saved) return false;
    return onEdit({ type: 'setTrackInfo', track: index, name: change.name ?? track.name, shortName: change.shortName ?? track.shortName, program: change.program ?? saved });
  };
  return <BusyFieldset busy={busy} className="track-info">
    <div className="track-info-row">
      <ColorSwatch label={t('track_settings.track_color')} value={trackColorHex(current.color)} busy={busy} locked={locked} onCommit={color => { if (!locked) void onEdit({ type: 'setTrackColor', track: selected, color }); }} />
      <CommitField hideLabel label={t('track_settings.track_name')} value={current.name} target={id} busy={busy} disabled={locked} onCommit={(name, owner) => info({ name }, owner)} />
      <CommitField hideLabel className="track-short-name" label={t('track_settings.track_short_name')} value={current.shortName} target={id} busy={busy} disabled={locked} onCommit={(shortName, owner) => info({ shortName }, owner)} />
    </div>
    {!current.isPercussion && <details className="inspector-more">
      <summary>{t('inspector.more')}</summary>
      <label>{t('track_settings.track_midi_instrument')}<CommitSelect value={program} target={id} busy={busy} disabled={locked} {...busySelect(busy)} onCommit={chosen => (busy ? false : info({ program: Number(chosen) }))}>{midiPrograms.map((name, index) => <option key={index} value={index}>{index + 1}. {name}</option>)}</CommitSelect></label>
    </details>}
  </BusyFieldset>;
}

/** Tab and standard notation as two toggles, the tuning as one row that opens the Tuning dialog (with its Capo section), and the rest of the staff's settings behind More. */
function NotationSection({ score, selected, staffIndex, barIndex, busy, locked, refusal, engraving, drumTabLeftOff, onEdit, onAudition, onSelectStaff }: {
  score: model.Score; selected: number; staffIndex: number; barIndex: number; busy: boolean; locked: boolean; refusal: string | null; engraving: EngravingOverrides; drumTabLeftOff: number; onEdit: (command: EditCommand) => unknown; onAudition?: TuningAudition; onSelectStaff?: (staff: number) => void;
}) {
  const { t } = useI18n();
  const noteId = useId();
  const current = score.tracks[selected];
  const staffAt = Math.min(staffIndex, current.staves.length - 1), staff = current.staves[staffAt];
  const clef = staff.bars[barIndex]?.clef ?? staff.bars[0]?.clef ?? model.Clef.G2;
  // A track with several staves is tuned one staff at a time (the selected one); a track with one staff is tuned as a whole, as before.
  const several = current.staves.length > 1, tuned = several ? staff : current.staves[0];
  const pitches = formatTuning(tuned.tuning), savedName = tuned.stringTuning.name;
  const strings = tuned.tuning.length, tuningUnavailable = current.isPercussion || !strings;
  const editable = !staff.isPercussion && !!staff.tuning.length;
  // The dialog belongs to the track it was opened for, by identity: moving or removing tracks while it is open must not retarget it.
  const [tuningFor, setTuningFor] = useState<string | null>(null);
  const [capoRefusal, setCapoRefusal] = useState<string | null>(null);
  const dialogIndex = tuningFor === null ? -1 : score.tracks.findIndex(track => trackIdentity(track) === tuningFor), dialogTrack = dialogIndex >= 0 ? score.tracks[dialogIndex] : null;
  useEffect(() => { if (tuningFor !== null && dialogIndex < 0) setTuningFor(null); }, [tuningFor, dialogIndex]);
  const dialogStaffIndex = Math.min(staffIndex, (dialogTrack?.staves.length ?? 1) - 1), dialogSeveral = (dialogTrack?.staves.length ?? 1) > 1;
  const dialogBase = dialogTrack ? dialogTrack.staves[dialogSeveral ? dialogStaffIndex : 0] : null;
  /** The staff's settings as they are now, plus the changes; the same payload the old Apply staff settings button sent. */
  const settingsFor = (target: model.Staff, targetClef: number, change: Partial<ReturnType<typeof readStaffSettings>> & { tuningName?: string; keepPitch?: boolean } = {}) => ({ ...readStaffSettings(target, targetClef), ...(!target.isPercussion && target.tuning.length ? { tuningName: target.stringTuning.name } : {}), ...change });
  const staffKey = `${trackIdentity(current)}\u001f${staffAt}\u001f${current.staves.length}`;
  /** The track and staff a key made by `staffKey` names, in the score as it is now. Null when the track is gone, the staff is gone, or the track's staves were added or removed since (the index may then name another staff). */
  const resolve = (key: string) => {
    const [owner, at, count] = key.split('\u001f'), track = score.tracks.findIndex(candidate => trackIdentity(candidate) === owner);
    if (track < 0) return null;
    const staves = score.tracks[track].staves, index = Number(at);
    if (staves.length !== Number(count) || !(index < staves.length)) return null;
    const found = staves[index];
    return { track, index, staff: found, clef: found.bars[barIndex]?.clef ?? found.bars[0]?.clef ?? model.Clef.G2 };
  };
  /** Records the change on the staff `key` names, which a field that was typed in earlier passes back so the change reaches that staff even when the cursor has moved. */
  const applySettings = (change: Partial<ReturnType<typeof readStaffSettings>>, key = staffKey) => {
    if (locked || busy) return false;
    const at = resolve(key);
    if (!at) return false;
    const next = settingsFor(at.staff, at.clef, change);
    if (staffSettingsUnchanged(at.staff, at.clef, next)) return false;
    return onEdit({ type: 'setStaffSettings', track: at.track, staff: at.index, settings: next });
  };
  /** Records nothing when the tuning, its name, the string count and the capo section are the ones the track already has. Targets the track the dialog was opened for, and does nothing if that track is gone. */
  const applyTuning = ({ pitches: notes, name: tuningName, keepPitch, keep, capo }: TuningChoice) => {
    if (locked || !dialogTrack || dialogIndex < 0) return;
    setCapoRefusal(null);
    const base = dialogBase!, count = base.tuning.length;
    const sameTuning = notes.length === count && (dialogSeveral ? [base] : dialogTrack.staves).every(target => target.tuning.every((pitch, index) => pitch === notes[index]) && target.stringTuning.name === tuningName);
    if (capo?.changed) {
      // What the dialog opened with is the tuning and name of the staff it was opened for; a draft equal to that is no retune.
      const retuned = notes.length !== count || notes.some((pitch, index) => pitch !== base.tuning[index]) || tuningName !== base.stringTuning.name;
      const target = dialogTrack.staves[dialogStaffIndex], targetClef = target.bars[barIndex]?.clef ?? target.bars[0]?.clef ?? model.Clef.G2;
      const settings = { ...settingsFor(target, targetClef, { capo: capo.capo }), ...(JSON.stringify(capo.partialCapo) !== JSON.stringify(getPartialCapo(target) ?? noPartialCapo) ? { partialCapo: capo.partialCapo } : {}), ...(capo.droneFret !== getBanjoDrone(target) ? { droneFret: capo.droneFret } : {}) };
      if (retuned) {
        // One gesture is one edit: a new string count is a change of the whole track, so it does not share an edit with a capo on one staff.
        if (notes.length !== count) { setCapoRefusal(t('tuning_dialog.capo_separately')); return Promise.resolve(false); }
        Object.assign(settings, { tuning: notes, tuningName, ...(keepPitch ? { keepPitch: true } : {}) });
      }
      return onEdit({ type: 'setStaffSettings', track: dialogIndex, staff: dialogStaffIndex, settings });
    }
    if (sameTuning) return;
    if (notes.length !== count) return onEdit({ type: 'setStringCount', track: dialogIndex, tuning: notes, keep, tuningName, crossVoice: true });
    // One staff of several: the same edit the old Staff tuning field recorded (the staff's settings with the new tuning, and Keep pitch when chosen).
    if (dialogSeveral) {
      const target = dialogTrack.staves[dialogStaffIndex], targetClef = target.bars[barIndex]?.clef ?? target.bars[0]?.clef ?? model.Clef.G2;
      return onEdit({ type: 'setStaffSettings', track: dialogIndex, staff: dialogStaffIndex, settings: settingsFor(target, targetClef, { tuning: notes, tuningName, ...(keepPitch ? { keepPitch: true } : {}) }) });
    }
    return onEdit({ type: 'setTuning', track: dialogIndex, tuning: notes, tuningName, ...(keepPitch ? { keepPitch: true } : {}) });
  };
  const audition = (list: number[], strum: boolean) => onAudition?.({ trackId: trackIdentity(current) }, list, strum);
  const toggle = (label: string, pressed: boolean, disabled: boolean, onClick: () => void, content: ReactNode, drum?: { unavailable: boolean; describedBy: string; title: string }) =>
    <button type="button" aria-pressed={pressed} title={drum?.title ?? label} aria-label={label} aria-describedby={drum?.describedBy} {...busyGuard({ busy, disabled: disabled || locked, unavailable: drum?.unavailable, className: 'notation-toggle', onClick })}>{content}</button>;
  // A drum track (one percussion staff) shows what its engraving profile says: standard (today), tablature (the drum tab alone) or both. The staff's own flags are not touched: alphaTab resets them for percussion, so an edit there changed nothing.
  const drum = isDrumTrack(current);
  const drumProfile = engraving.profiles.find(entry => entry.trackId === trackIdentity(current))?.profile ?? 'source';
  const drumTab = drumProfile === 'tablature' || drumProfile === 'standardTab', drumStandard = drumProfile !== 'tablature';
  const drumStateName = t(drumProfile === 'tablature' ? 'engraving.profile_tablature' : drumTab ? 'engraving.profile_standard_tab' : 'engraving.profile_standard');
  /** One setEngraving edit for the track's profile; nothing is recorded when the profile would stay what it is. The neutral state removes the track's entry, as the style panel does for Source. */
  const setDrumProfile = (tab: boolean, standard: boolean) => {
    if (locked || busy || (!tab && !standard)) return false;
    const next: TrackProfile = tab && standard ? 'standardTab' : tab ? 'tablature' : 'source';
    if (next === drumProfile || (next === 'source' && drumProfile === 'standard')) return false;
    // Entries of tracks that were removed stay in the settings; the new edit drops them, as the style panels do, or it would be refused for naming a missing track.
    const id = trackIdentity(current), live = new Set(score.tracks.map(trackIdentity));
    return onEdit({ type: 'setEngraving', engraving: { ...engraving, profiles: [...engraving.profiles.filter(entry => entry.trackId !== id && live.has(entry.trackId)), ...(next === 'source' ? [] : [{ trackId: id, profile: next }])] } });
  };
  const drumToggle = (label: string, pressed: boolean, other: boolean, click: () => void, content: ReactNode) => {
    const inert = pressed && !other;
    return toggle(label, pressed, false, click, content, { unavailable: inert, describedBy: `${noteId}-${inert ? 'only' : 'hint'}`, title: inert ? `${label}. ${t('track_settings.drum_notation_last')}` : label });
  };
  return <div className="track-notation">
    <div className="notation-toggles" role="group" aria-label={t('track_settings.notation_toggles')}>
      <span className="notation-toggles-label">{t('track_settings.notation')}</span>
      {drum
        ? <>
          {drumToggle(t('editor.show_tablature'), drumTab, drumStandard, () => setDrumProfile(!drumTab, drumStandard), <span className="notation-toggle-tab" aria-hidden="true">TAB</span>)}
          {drumToggle(t('editor.show_notation'), drumStandard, drumTab, () => setDrumProfile(drumTab, !drumStandard), <ScoreGlyph />)}
        </>
        : <>
          {toggle(t('editor.show_tablature'), staff.showTablature, !editable && !staff.isPercussion, () => applySettings({ showTab: !staff.showTablature }), <span className="notation-toggle-tab" aria-hidden="true">TAB</span>)}
          {toggle(t('editor.show_notation'), staff.showStandardNotation, false, () => applySettings({ showNotation: !staff.showStandardNotation }), <ScoreGlyph />)}
        </>}
      {several && (onSelectStaff
        ? <label className="notation-staff">{t('track_settings.staff_select')}<select value={staffAt} onChange={event => onSelectStaff(Number(event.target.value))}>{current.staves.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
        : <span className="notation-staff">{t('editor.staff_n', { staff: staffAt + 1 })}</span>)}
    </div>
    {drum && <>
      <span id={`${noteId}-hint`} className="track-sr-only">{t('track_settings.drum_notation_state', { style: drumStateName })} {t('track_settings.drum_tab_hint')}</span>
      <span id={`${noteId}-only`} className="track-sr-only">{t('track_settings.drum_notation_state', { style: drumStateName })} {t('track_settings.drum_notation_last')}</span>
      {drumTabLeftOff > 0 && <p className="notation-note" role="note">{t('track_settings.drum_tab_left_off', { count: drumTabLeftOff })}</p>}
    </>}
    <TuningRow label={t('track_settings.tuning_row')} notes={pitches} title={savedName ? `${savedName}: ${pitches}` : pitches} unavailable={tuningUnavailable} busy={busy} locked={locked} onOpen={() => { setCapoRefusal(null); setTuningFor(trackIdentity(current)); }} onPlay={onAudition && (() => audition([...tuned.tuning], true))} playDisabled={strings > 12} />
    {dialogTrack && <TuningDialog pitches={dialogBase!.tuning} name={dialogBase!.stringTuning.name} staff={dialogTrack.staves[dialogStaffIndex]} staffCount={dialogTrack.staves.length} busy={busy} locked={locked} refusal={capoRefusal ?? refusal} onApply={applyTuning} onClose={() => setTuningFor(null)} onAudition={onAudition && ((list, strum) => onAudition({ trackId: trackIdentity(dialogTrack) }, list, strum))} />}
    <BusyFieldset busy={busy} className="track-notation-more">
      <details className="inspector-more">
        <summary>{t('inspector.more')}</summary>
        <label>{t('editor.staff_clef')}<CommitSelect value={clef} target={staffKey} busy={busy} disabled={locked} {...busySelect(busy)} onCommit={chosen => applySettings({ clef: Number(chosen) })}>{Object.entries(model.Clef).filter(([, value]) => typeof value === 'number').map(([name, value]) => <option key={name} value={value as number}>{name.replace(/([a-z])([A-Z])/g, '$1 $2')}</option>)}</CommitSelect></label>
        <CommitField type="number" label={t('editor.sounding_transposition')} value={String(staff.transpositionPitch)} target={staffKey} busy={busy} disabled={locked} onCommit={(value, key) => applySettings({ transposition: Number(value) }, key)} />
        <CommitField type="number" label={t('editor.display_transposition')} value={String(staff.displayTranspositionPitch)} target={staffKey} busy={busy} disabled={locked} onCommit={(value, key) => applySettings({ displayTransposition: Number(value) }, key)} />
        <div className="track-staff-actions">
          <button type="button" {...busyGuard({ busy, disabled: locked || staff.isPercussion, onClick: () => onEdit({ type: 'addStaff', track: selected, settings: settingsFor(staff, clef) }) })}>{t('editor.add_staff')}</button>
          <button type="button" {...busyGuard({ busy, disabled: locked || current.staves.length === 1, onClick: () => onEdit({ type: 'removeStaff', track: selected, staff: staffAt }) })}>{t('editor.remove_staff')}</button>
        </div>
      </details>
    </BusyFieldset>
  </div>;
}

/**
 * The Track tab in the manner of Guitar Pro's track inspector: the track actions and one Information row, Musical notation
 * (two toggles, the tuning row, More), then whatever the app puts under Sounds and Interpretation and MIDI output. The Information row's arrows select the previous and next track; adding and moving tracks are in the Track menu.
 */
export function TrackSettingsPanel({ score, selected, staff = 0, bar = 0, busy, locked = false, refusal = null, engraving, drumTabLeftOff = 0, onEdit, onAudition, onSelectStaff, onStepTrack, sounds, interpretation, midi }: {
  score: model.Score; selected: number;
  /** The staff and bar under the cursor: the toggles, clef and transposition act on that staff. */
  staff?: number; bar?: number;
  busy: boolean; /** Finalized: edits are disabled, but tuning audition is not. */ locked?: boolean; /** The app's message for the edit it last refused, shown in the Tuning dialog. */ refusal?: string | null;
  /** The document's engraving: a drum track's TAB and notation toggles read and write its profile there. Without it the default (no profiles) is assumed. */ engraving?: EngravingOverrides;
  /** How many of the selected drum track's hits the drum tab leaves off (more than six sounds on one beat); shown only when above zero. */ drumTabLeftOff?: number;
  onEdit: (command: EditCommand) => unknown; onAudition?: TuningAudition;
  /** Moves the cursor to another staff of the selected track; the staff selector (shown for a track with several staves) uses it. */
  onSelectStaff?: (staff: number) => void;
  /** Selects the previous (-1) or next (+1) track, as Ctrl+Up and Ctrl+Down do. Selecting records no edit. */
  onStepTrack?: (direction: -1 | 1) => void;
  sounds?: ReactNode; interpretation?: ReactNode; midi?: ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const current = score.tracks[selected];
  const action = (label: string, glyph: React.JSX.Element, disabled: boolean, onClick: () => void, className?: string) => <button type="button" title={label} aria-label={label} {...busyGuard({ busy, disabled, className, onClick })}>{glyph}</button>;
  // Choosing a track is not an edit, so it stays available while a document is finalized; at either end the button keeps focus and says why it does nothing.
  const step = (direction: -1 | 1) => {
    const label = t(direction < 0 ? 'track_settings.previous_track' : 'track_settings.next_track'), atEnd = direction < 0 ? selected === 0 : selected === score.tracks.length - 1;
    const note = t(direction < 0 ? 'track_settings.first_track_note' : 'track_settings.last_track_note');
    return <button type="button" title={atEnd ? `${label} (${note})` : label} aria-label={label} {...busyGuard({ busy, unavailable: atEnd || !onStepTrack, onClick: () => onStepTrack?.(direction) })}>{direction < 0 ? <ArrowUpGlyph /> : <ArrowDownGlyph />}</button>;
  };
  return <aside className="track-settings" aria-label={t('track_settings.aria_label')}>
    <section className="inspector-section" aria-labelledby="inspector-track-info"><h3 id="inspector-track-info">{t('inspector.information')}</h3>
      <div className="track-actions" role="group" aria-label={t('track_settings.track_actions')}>
        {step(-1)}
        {step(1)}
        {action(t('track_settings.duplicate_track'), <DuplicateGlyph />, locked, () => onEdit({ type: 'duplicateTrack', track: selected }))}
        <span className="track-actions-gap" aria-hidden="true" />
        {action(t('track_settings.remove_track'), <TrashGlyph />, locked || score.tracks.length === 1, () => onEdit({ type: 'removeTrack', track: selected }), 'track-remove')}
      </div>
      <TrackInfoRow score={score} selected={selected} busy={busy} locked={locked} onEdit={onEdit} />
    </section>
    <section className="inspector-section" aria-labelledby="inspector-track-notation"><h3 id="inspector-track-notation">{t('inspector.musical_notation')}</h3>
      <NotationSection score={score} selected={selected} staffIndex={staff} barIndex={bar} busy={busy} locked={locked} refusal={refusal} engraving={engraving ?? defaultEngraving()} drumTabLeftOff={drumTabLeftOff} onEdit={onEdit} onAudition={onAudition} onSelectStaff={onSelectStaff} />
    </section>
    {sounds && <section className="inspector-section" aria-labelledby="inspector-track-sounds"><h3 id="inspector-track-sounds">{t('inspector.sounds')}</h3>{sounds}</section>}
    {interpretation}
    {midi}
  </aside>;
}
