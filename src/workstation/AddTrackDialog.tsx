import { useState } from 'react';
import { useI18n } from '../i18n';
import type { EditCommand } from '../project';
import { midiPrograms } from '../midi-programs';
import { formatTuning, parseTuning } from '../tuning';
import { TuningRow } from '../tuning/TuningRow';
import { TuningDialog } from '../tuning/TuningDialog';
import { Dialog } from '../ui/Dialog';
import { BusyFieldset } from '../ui/BusyFieldset';
import { busyGuard } from '../ui/useBusyGuard';
import { NotationTrackControls } from '../editor/NonTabPanel';
import type { TuningAudition } from '../audio/audition';
import './track-panels.css';
import './inspector-compact.css';

/**
 * The new-track form: name, MIDI instrument and tuning, then Add track; and the notation tracks (pitched, percussion) below it.
 * Adding records one edit and closes the dialog; Escape and Cancel add nothing. The name field has focus when it opens, and Enter in it adds.
 * The tuning is chosen in the Tuning dialog, opened over this one as a draft that touches no track.
 */
export function AddTrackDialog({ busy, locked = false, onAdd, onAudition, onClose }: {
  busy: boolean;
  /** Finalized: nothing can be added. */
  locked?: boolean;
  /** Records the edit; the caller selects the new track once it exists. */
  onAdd: (command: EditCommand) => unknown;
  onAudition?: TuningAudition;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('Bass'), [instrument, setInstrument] = useState(33), [tuning, setTuning] = useState('G2 D2 A1 E1');
  const [tuningName, setTuningName] = useState(''), [tuningOpen, setTuningOpen] = useState(false);
  const add = (command: EditCommand) => { if (busy || locked) return; onAdd(command); onClose(); };
  const addTrack = () => add({ type: 'addTrack', name, tuning: parseTuning(tuning), program: instrument, tuningName });
  return <Dialog title={t('track_settings.add_track')} onClose={onClose} className="add-track-dialog" busy={busy}
    actions={<>
      <button type="button" onClick={onClose}>{t('dialog.cancel')}</button>
      <button type="button" {...busyGuard({ busy, disabled: locked, className: 'primary', onClick: addTrack })}>{t('track_settings.add_track')}</button>
    </>}>
    <div className="track-settings add-track-body">
      <BusyFieldset busy={busy}>
        <label>{t('track_settings.new_track_name')}<input data-autofocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addTrack(); } }} /></label>
        <label>{t('track_settings.midi_instrument')}<select value={instrument} onChange={event => setInstrument(Number(event.target.value))}>{midiPrograms.map((label, value) => <option key={value} value={value}>{value + 1}. {label}</option>)}</select></label>
        <TuningRow label={t('track_settings.tuning_row')} editKey="track_settings.new_track_tuning_edit" notes={tuning} unavailable={false} busy={busy} onOpen={() => setTuningOpen(true)} onPlay={onAudition && (() => onAudition({ program: instrument }, parseTuning(tuning), true))} />
      </BusyFieldset>
      <NotationTrackControls busy={busy || locked} onEdit={add} />
    </div>
    {tuningOpen && <TuningDialog mode="draft" pitches={parseTuning(tuning)} name={tuningName} defaultInstrument={instrument >= 32 && instrument <= 39 ? 'bass' : undefined} onApply={choice => { setTuning(formatTuning(choice.pitches)); setTuningName(choice.name); }} onClose={() => setTuningOpen(false)} onAudition={onAudition && ((list, strum) => onAudition({ program: instrument }, list, strum))} />}
  </Dialog>;
}
