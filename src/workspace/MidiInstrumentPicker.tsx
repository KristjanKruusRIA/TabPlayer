import { useState } from 'react';
import type { TuningAudition } from '../audio/audition';
import { useI18n } from '../i18n';
import type { MidiPartInfo, MidiPartInstrument, MidiPartOverride } from '../interchange/midi-import';
import { midiPrograms } from '../midi-programs';
import { formatTuning } from '../tuning';
import { TuningDialog } from '../tuning/TuningDialog';
import { tuningPresetName, tuningPresets } from '../tuning-presets';
import { Dialog } from '../ui/Dialog';
import { Segmented } from '../ui/Segmented';

export type MidiInstrumentChoice = MidiPartInstrument;
export type MidiInstrumentSelection = Pick<MidiPartOverride, 'name' | 'shortName' | 'notation' | 'tuning'> & {
  kind: MidiInstrumentChoice;
  program: number | null;
};

interface MidiInstrumentPickerProps {
  part?: MidiPartInfo;
  initial?: MidiInstrumentSelection;
  defaults: MidiInstrumentSelection;
  defaultTuning: Record<'guitar' | 'bass', readonly number[]>;
  onAudition?: TuningAudition;
  onApply: (selection: MidiInstrumentSelection) => void;
  onClose: () => void;
}

const families = [
  'piano', 'chromatic', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass',
  'reed', 'pipe', 'lead', 'pad', 'effects', 'world', 'percussion', 'sound_effects',
] as const;
const orchestra = [5, 6, 7, 8, 9];
type Category = 'stringed' | 'orchestra' | 'drums' | 'midi';

export function MidiInstrumentPicker({ part, initial, defaults, defaultTuning, onAudition, onApply, onClose }: MidiInstrumentPickerProps) {
  const { t, lang } = useI18n();
  const [selection, setSelection] = useState<MidiInstrumentSelection>(initial ?? { kind: 'auto', program: null });
  const kind = selection.kind === 'auto' ? defaults.kind : selection.kind;
  const percussion = kind === 'drums' || (selection.kind === 'auto' && !!part?.defaultPercussion);
  const [category, setCategory] = useState<Category>(percussion ? 'drums' : kind === 'guitar' || kind === 'bass' ? 'stringed' : 'midi');
  const [editingTuning, setEditingTuning] = useState(false);
  const sourceProgram = part?.program ?? 0;
  const fileProgram = kind === 'guitar' && (sourceProgram < 24 || sourceProgram > 31) ? 25
    : kind === 'bass' && (sourceProgram < 32 || sourceProgram > 39) ? 33
    : kind === 'keys' && sourceProgram >= 24 && sourceProgram <= 39 ? 0
    : sourceProgram;
  const program = selection.program ?? (selection.kind === 'auto' ? defaults.program : null) ?? fileProgram;
  const family = Math.floor(program / 8);
  const stringed = !percussion && kind !== 'keys'
    ? kind === 'guitar' || kind === 'bass' ? kind : family === 3 ? 'guitar' : family === 4 ? 'bass' : null
    : null;
  const tuning = stringed
    ? selection.tuning ?? defaultTuning[stringed]
    : [];
  const presets = tuningPresets.filter(preset => preset.instrument === stringed);
  const preset = presets.find(candidate => candidate.tuning.length === tuning.length &&
    candidate.tuning.every((pitch, index) => pitch === tuning[index]));
  const visibleFamilies = category === 'stringed' ? [3, 4]
    : category === 'orchestra' ? orchestra : families.map((_, index) => index);

  const pickProgram = (next: number, from: Category = category) => {
    const nextKind = from === 'orchestra' ? 'keys' : next >= 24 && next <= 31 ? 'guitar' : next >= 32 && next <= 39 ? 'bass' : 'keys';
    setSelection(previous => ({
      ...previous, kind: nextKind, program: next,
      tuning: nextKind === stringed ? previous.tuning : undefined,
    }));
  };
  const pickCategory = (next: Category) => {
    setCategory(next);
    if (next === 'drums') setSelection(previous => ({ ...previous, kind: 'drums', program: null, tuning: undefined }));
    else if (next === 'stringed') pickProgram(family === 3 || family === 4 ? program : 25, next);
    else if (next === 'orchestra') pickProgram(orchestra.includes(family) ? program : 40, next);
    else if (percussion) pickProgram(sourceProgram, next);
  };
  const useFile = () => {
    setSelection(previous => ({ ...previous, kind: 'auto', program: null, tuning: undefined }));
    setCategory('midi');
  };

  return (
    <>
      <Dialog
        title={part ? t('midi_import.part_instrument_aria', { name: part.name }) : t('midi_import.choose_instrument')}
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
          <div className="midi-instrument-categories">
            <Segmented
              label={t('midi_import.instrument_type')}
              value={category}
              options={[
                { value: 'stringed', label: t('midi_import.instrument_stringed') },
                { value: 'orchestra', label: t('midi_import.instrument_orchestra') },
                { value: 'drums', label: t('midi_import.part_as_drums') },
                { value: 'midi', label: 'MIDI' },
              ]}
              onChange={pickCategory}
            />
          </div>
          {percussion ? (
            <p className="muted">{t('midi_import.instrument_drum_hint')}</p>
          ) : (
            <div className="midi-instrument-sounds">
              <label>
                {t('midi_import.instrument_family')}
                <select size={6} value={family} onChange={event => pickProgram(Number(event.target.value) * 8)}>
                  {visibleFamilies.map(index => (
                    <option key={index} value={index}>{t(`midi_family.${families[index]}`)}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('track_settings.midi_instrument')}
                <select size={6} value={program} onChange={event => pickProgram(Number(event.target.value))}>
                  {midiPrograms.slice(family * 8, family * 8 + 8).map((name, index) => {
                    const value = family * 8 + index;
                    return <option key={value} value={value}>{String(value).padStart(3, '0')} {name}</option>;
                  })}
                </select>
              </label>
            </div>
          )}
          <section className="midi-instrument-details">
            <h3>{percussion ? t('midi_import.part_as_drums') : midiPrograms[program]}</h3>
            {part && (
              <div className="midi-instrument-names">
                <label>
                  {t('track_settings.track_name')}
                  <input value={selection.name ?? ''} placeholder={part.name} maxLength={128}
                    onChange={event => setSelection({ ...selection, name: event.target.value })} />
                </label>
                <label>
                  {t('track_settings.track_short_name')}
                  <input value={selection.shortName ?? ''} placeholder={part.name.slice(0, 12)} maxLength={32}
                    onChange={event => setSelection({ ...selection, shortName: event.target.value })} />
                </label>
              </div>
            )}
            {!percussion && kind !== 'keys' && (
              <div className="tp-field">
                <span className="tp-field-label" aria-hidden="true">{t('track_settings.notation')}</span>
                <Segmented label={t('track_settings.notation')}
                  value={selection.notation ?? defaults.notation ?? 'both'}
                  options={[
                    { value: 'both', label: t('engraving.profile_standard_tab') },
                    { value: 'score', label: t('engraving.profile_standard') },
                    { value: 'tab', label: t('engraving.profile_tablature') },
                  ]}
                  onChange={notation => setSelection(previous => ({ ...previous, notation }))}
                />
              </div>
            )}
            {stringed && (selection.notation ?? defaults.notation) !== 'score' && (
              <div className="midi-instrument-tuning">
                <label>
                  {t('tuning_dialog.title')}
                  <select value={preset?.id ?? ''} onChange={event => {
                    const selected = presets.find(candidate => candidate.id === event.target.value);
                    if (selected) setSelection(previous => ({ ...previous, tuning: selected.tuning }));
                  }}>
                    {!preset && <option value="">{formatTuning(tuning)}</option>}
                    {presets.map(candidate => (
                      <option value={candidate.id} key={candidate.id}>{tuningPresetName(candidate, lang)} · {formatTuning(candidate.tuning)}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="tp-button" onClick={() => setEditingTuning(true)}>
                  {t('tuning_dialog.title')}…
                </button>
              </div>
            )}
          </section>
          <div className="midi-instrument-actions">
            <button type="button" className="tp-button" disabled={selection.program === null && selection.kind === 'auto'}
              onClick={useFile}>{t(part ? 'midi_import.use_default_sound' : 'midi_import.instrument_auto')}</button>
            {onAudition && !percussion && (
              <button type="button" className="tp-button" onClick={() => onAudition({ program }, [60], false)}>
                {t('midi_import.audition_sound')}
              </button>
            )}
          </div>
        </div>
      </Dialog>
      {editingTuning && stringed && (
        <TuningDialog mode="draft" pitches={[...tuning]} defaultInstrument={stringed}
          name={preset ? tuningPresetName(preset, lang) : ''}
          onApply={choice => setSelection(previous => ({ ...previous, tuning: choice.pitches }))}
          onClose={() => setEditingTuning(false)}
          onAudition={onAudition && ((notes, strum) => onAudition({ program }, notes, strum))}
        />
      )}
    </>
  );
}
