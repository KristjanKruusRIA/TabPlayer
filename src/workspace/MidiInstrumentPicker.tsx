import { useState } from 'react';
import type { TuningAudition } from '../audio/audition';
import { useI18n } from '../i18n';
import type { MidiPartInfo } from '../interchange/midi-import';
import { midiPrograms } from '../midi-programs';
import { Dialog } from '../ui/Dialog';
import { Segmented } from '../ui/Segmented';

export type MidiInstrumentChoice = 'auto' | 'guitar' | 'bass' | 'keys';
export type MidiInstrumentSelection = {
  kind: MidiInstrumentChoice | 'drums';
  program: number | null;
};

interface MidiInstrumentPickerProps {
  part: MidiPartInfo;
  initial?: MidiInstrumentSelection;
  defaultKind: MidiInstrumentChoice;
  onAudition?: TuningAudition;
  onApply: (selection: MidiInstrumentSelection) => void;
  onClose: () => void;
}

const families = [
  'piano', 'chromatic', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass',
  'reed', 'pipe', 'lead', 'pad', 'effects', 'world', 'percussion', 'sound_effects',
] as const;

export function MidiInstrumentPicker({ part, initial, defaultKind, onAudition, onApply, onClose }: MidiInstrumentPickerProps) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<MidiInstrumentSelection>(initial ?? { kind: 'auto', program: null });
  const kind = selection.kind === 'auto' ? defaultKind : selection.kind;
  const percussion = kind === 'drums' || (selection.kind === 'auto' && part.defaultPercussion);
  const fileProgram = kind === 'guitar' && (part.program < 24 || part.program > 31) ? 25
    : kind === 'bass' && (part.program < 32 || part.program > 39) ? 33
    : kind === 'keys' && part.program >= 24 && part.program <= 39 ? 0
    : part.program;
  const program = selection.program ?? fileProgram;
  const family = Math.floor(program / 8);
  const kinds = [
    { value: 'auto', label: t('midi_import.instrument_auto') },
    { value: 'guitar', label: t('midi_import.instrument_guitar') },
    { value: 'bass', label: t('midi_import.instrument_bass') },
    { value: 'keys', label: t('midi_import.instrument_keys') },
    { value: 'drums', label: t('midi_import.part_as_drums') },
  ] as const;
  return (
    <Dialog
      title={t('midi_import.part_instrument_aria', { name: part.name })}
      onClose={onClose}
      className="midi-instrument-picker"
      onSubmit={event => {
        event.preventDefault();
        onApply(selection);
      }}
      actions={<>
        <button className="tp-button primary" type="submit">{t('midi_import.apply_instrument')}</button>
        <button className="tp-button" type="button" onClick={onClose}>{t('dialog.cancel')}</button>
      </>}
    >
      <div className="midi-instrument-form">
        <div className="tp-field">
          <span className="tp-field-label" aria-hidden="true">{t('midi_import.instrument_type')}</span>
          <Segmented
            label={t('midi_import.instrument_type')}
            value={selection.kind}
            options={kinds}
            onChange={kind => setSelection(previous => ({ ...previous, kind }))}
          />
        </div>
        {percussion ? (
          <p className="muted">{t('midi_import.instrument_drum_hint')}</p>
        ) : (
          <>
            <div className="midi-instrument-sounds">
              <label>
                {t('midi_import.instrument_family')}
                <select size={8} value={family} onChange={event => {
                  const program = Number(event.target.value) * 8;
                  setSelection(previous => ({ ...previous, program }));
                }}>
                  {families.map((key, index) => (
                    <option key={key} value={index}>{t(`midi_family.${key}`)}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('track_settings.midi_instrument')}
                <select size={8} value={program} onChange={event => {
                  const program = Number(event.target.value);
                  setSelection(previous => ({ ...previous, program }));
                }}>
                  {midiPrograms.slice(family * 8, family * 8 + 8).map((name, index) => {
                    const value = family * 8 + index;
                    return <option key={value} value={value}>{String(value).padStart(3, '0')} {name}</option>;
                  })}
                </select>
              </label>
            </div>
            <div className="midi-instrument-actions">
              <button type="button" className="tp-button" disabled={selection.program === null}
                onClick={() => setSelection(previous => ({ ...previous, program: null }))}>
                {t('midi_import.use_default_sound')}
              </button>
              {onAudition && (
                <button type="button" className="tp-button" onClick={() => onAudition({ program }, [60], false)}>
                  {t('midi_import.audition_sound')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
