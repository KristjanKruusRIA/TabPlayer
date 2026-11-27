import { model } from '@coderline/alphatab';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useSoundbankStatus } from '../audio/soundbank-store';
import type { TuningAudition } from '../audio/audition';
import { useI18n } from '../i18n';
import type { EditCommand } from '../project';
import {
  BassGlyph,
  BrassGlyph,
  CogGlyph,
  DrumGlyph,
  DrumsCategoryGlyph,
  GrandStaffGlyph,
  GuitarGlyph,
  KeysGlyph,
  MidiCategoryGlyph,
  NoteGlyph,
  OrchestraCategoryGlyph,
  PlayGlyph,
  ScoreGlyph,
  SingleStaffGlyph,
  SlashNotationGlyph,
  StringedCategoryGlyph,
  StringsGlyph,
  TabNotationGlyph,
  UkuleleGlyph,
  VocalGlyph,
} from '../shell/glyphs';
import { formatTuning, parseTuning } from '../tuning';
import { instrumentTitle, tuningPresetName, tuningPresets, type PresetInstrument } from '../tuning-presets';
import { TuningDialog } from '../tuning/TuningDialog';
import { BusyFieldset } from '../ui/BusyFieldset';
import { Dialog } from '../ui/Dialog';
import { busyGuard } from '../ui/useBusyGuard';
import {
  defaultTemplate,
  soundOptionsForTemplate,
  subCategoriesForCategory,
  templateTuningLabel,
  templateTuningNotes,
  type SoundOption,
  type TemplateGlyph,
  type TrackCategoryId,
  type TrackTemplate,
} from './track-templates';
import './add-track-dialog.css';

interface StaffDraft {
  instrument: PresetInstrument;
  notes: string;
  tuningName: string;
  clef: number;
}

const INSTRUMENTS = [...new Set(tuningPresets.map(p => p.instrument))];
const stringCountsFor = (instrument: PresetInstrument) =>
  [...new Set(tuningPresets.filter(p => p.instrument === instrument).map(p => p.strings))].sort((a, b) => a - b);

const samePitches = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((pitch, idx) => pitch === b[idx]);

function staffDraftFromTemplate(template: TrackTemplate, isLower: boolean): StaffDraft {
  const instrument = (isLower ? template.lowerInstrument : template.instrument) ?? template.instrument ?? 'guitar';
  const tuningId = (isLower ? template.lowerTuningId : template.tuningId) ?? template.tuningId ?? 'guitar-6-standard-e';
  const clef = isLower ? (template.lowerClef ?? model.Clef.F4) : (template.clef ?? model.Clef.G2);
  return {
    instrument,
    notes: templateTuningNotes(tuningId),
    tuningName: templateTuningLabel(tuningId),
    clef,
  };
}

function TemplateIcon({ glyph }: { glyph: TemplateGlyph }) {
  switch (glyph) {
    case 'guitar': return <GuitarGlyph />;
    case 'bass': return <BassGlyph />;
    case 'ukulele': return <UkuleleGlyph />;
    case 'strings': return <StringsGlyph />;
    case 'keys': return <KeysGlyph />;
    case 'brass': return <BrassGlyph />;
    case 'drums': return <DrumGlyph />;
    case 'vocal': return <VocalGlyph />;
    default: return <NoteGlyph />;
  }
}

function StringedStaffRow({
  label,
  staffKey,
  draft,
  disabled,
  busy,
  onChange,
  onOpenTuning,
}: {
  label: string;
  staffKey: 'upper' | 'lower';
  draft: StaffDraft;
  disabled: boolean;
  busy: boolean;
  onChange: (next: StaffDraft) => void;
  onOpenTuning: () => void;
}) {
  const { t, lang } = useI18n();
  const pitches = useMemo(() => {
    try { return parseTuning(draft.notes); } catch { return [64, 59, 55, 50, 45, 40]; }
  }, [draft.notes]);
  const stringCount = pitches.length;
  const baseCounts = stringCountsFor(draft.instrument);
  const counts = baseCounts.includes(stringCount) ? baseCounts : [...baseCounts, stringCount].sort((a, b) => a - b);
  const presets = tuningPresets.filter(p => p.instrument === draft.instrument && p.strings === stringCount);
  const matchedPreset = presets.find(p => samePitches(p.tuning, pitches));

  const chooseStringCount = (nextCount: number) => {
    const preset = tuningPresets.find(p => p.instrument === draft.instrument && p.strings === nextCount);
    if (preset) onChange({ ...draft, notes: formatTuning(preset.tuning), tuningName: preset.name });
  };
  const chooseInstrument = (nextInstrument: PresetInstrument) => {
    const validCounts = stringCountsFor(nextInstrument);
    const chosenCount = validCounts.includes(stringCount) ? stringCount : validCounts[0];
    const preset = tuningPresets.find(p => p.instrument === nextInstrument && p.strings === chosenCount) ?? tuningPresets.find(p => p.instrument === nextInstrument)!;
    onChange({ ...draft, instrument: nextInstrument, notes: formatTuning(preset.tuning), tuningName: preset.name });
  };
  const choosePreset = (presetId: string) => {
    const preset = tuningPresets.find(p => p.id === presetId);
    if (preset) onChange({ ...draft, notes: formatTuning(preset.tuning), tuningName: preset.name });
  };

  return (
    <div className="add-track-row" data-disabled={disabled || undefined}>
      <span className="add-track-row-label">{label}:</span>
      <div className="add-track-staff-grid">
        <select
          aria-label={t(staffKey === 'upper' ? 'add_track.upper_strings' : 'add_track.lower_strings')}
          value={stringCount}
          disabled={disabled || busy}
          onChange={event => chooseStringCount(Number(event.target.value))}
        >
          {counts.map(count => (
            <option key={count} value={count}>{t('tuning_dialog.string_count_option', { count })}</option>
          ))}
        </select>
        <select
          aria-label={t(staffKey === 'upper' ? 'add_track.upper_instrument' : 'add_track.lower_instrument')}
          value={draft.instrument}
          disabled={disabled || busy}
          onChange={event => chooseInstrument(event.target.value as PresetInstrument)}
        >
          {INSTRUMENTS.map(item => (
            <option key={item} value={item}>{instrumentTitle(item, lang)}</option>
          ))}
        </select>
        <select
          aria-label={t(staffKey === 'upper' ? 'add_track.upper_preset' : 'add_track.lower_preset')}
          value={matchedPreset?.id ?? 'custom'}
          disabled={disabled || busy}
          onChange={event => choosePreset(event.target.value)}
        >
          {!matchedPreset && <option value="custom" disabled>{t('tuning_dialog.custom')}</option>}
          {presets.map(preset => (
            <option key={preset.id} value={preset.id}>{tuningPresetName(preset, lang)}</option>
          ))}
        </select>
        <button
          type="button"
          aria-haspopup="dialog"
          title={draft.notes}
          aria-label={t(staffKey === 'upper' ? 'track_settings.new_track_tuning_edit' : 'add_track.lower_tuning_edit', { notes: draft.notes })}
          {...busyGuard({ busy, disabled, className: 'add-track-tuning-btn', onClick: onOpenTuning })}
        >
          <CogGlyph />
          <span>{draft.notes}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Guitar Pro 8-style Add Track dialog: 4 instrument category tabs, 2-column sub-category/instrument browser,
 * dynamic `<INSTRUMENT> SETTINGS` (color, name, short name, notation & grand-staff toggles, upper/lower staff tuning or clef,
 * sound choice & audition). Adding records a single undoable edit and closes the dialog.
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
  const gp8Status = useSoundbankStatus();
  const initial = useMemo(() => defaultTemplate(), []);

  const [category, setCategory] = useState<TrackCategoryId>(initial.category);
  const [selectedTemplate, setSelectedTemplate] = useState<TrackTemplate>(initial);
  const [name, setName] = useState(initial.defaultName);
  const [shortName, setShortName] = useState(initial.defaultShortName);
  const [color, setColor] = useState(initial.defaultColor);
  const [showTab, setShowTab] = useState(initial.showTab);
  const [showNotation, setShowNotation] = useState(initial.showNotation);
  const [showSlash, setShowSlash] = useState(initial.showSlash);
  const [grandStaff, setGrandStaff] = useState(initial.grandStaff);
  const [upperStaff, setUpperStaff] = useState<StaffDraft>(() => staffDraftFromTemplate(initial, false));
  const [lowerStaff, setLowerStaff] = useState<StaffDraft>(() => staffDraftFromTemplate(initial, true));
  const [soundId, setSoundId] = useState<string>(() => soundOptionsForTemplate(initial, gp8Status)[0]?.id ?? 'default');
  const [tuningEditorStaff, setTuningEditorStaff] = useState<'upper' | 'lower' | null>(null);

  const subCategories = useMemo(() => subCategoriesForCategory(category), [category]);
  const activeSubCategory = useMemo(
    () => subCategories.find(group => group.items.some(item => item.id === selectedTemplate.id)) ?? subCategories[0],
    [subCategories, selectedTemplate.id],
  );
  const soundOptions = useMemo(() => soundOptionsForTemplate(selectedTemplate, gp8Status), [selectedTemplate, gp8Status]);
  const activeSound: SoundOption = useMemo(
    () => soundOptions.find(opt => opt.id === soundId) ?? soundOptions[0] ?? { id: 'default', label: selectedTemplate.listLabel, program: selectedTemplate.program },
    [soundOptions, soundId, selectedTemplate],
  );

  const applyTemplate = (template: TrackTemplate) => {
    setSelectedTemplate(template);
    setName(template.defaultName);
    setShortName(template.defaultShortName);
    setColor(template.defaultColor);
    setShowTab(template.showTab);
    setShowNotation(template.showNotation);
    setShowSlash(template.showSlash);
    setGrandStaff(template.grandStaff);
    setUpperStaff(staffDraftFromTemplate(template, false));
    setLowerStaff(staffDraftFromTemplate(template, true));
    const options = soundOptionsForTemplate(template, gp8Status);
    setSoundId(options[0]?.id ?? 'default');
  };

  const selectCategory = (nextCategory: TrackCategoryId) => {
    setCategory(nextCategory);
    const groups = subCategoriesForCategory(nextCategory);
    const first = groups[0]?.items[0];
    if (first) applyTemplate(first);
  };

  const selectSubCategory = (subCategoryId: string) => {
    const group = subCategories.find(g => g.id === subCategoryId);
    const first = group?.items[0];
    if (first) applyTemplate(first);
  };

  const toggleNotationFlag = (which: 'tab' | 'standard' | 'slash') => {
    const nextTab = which === 'tab' ? !showTab : showTab;
    const nextStd = which === 'standard' ? !showNotation : showNotation;
    const nextSlash = which === 'slash' ? !showSlash : showSlash;
    if (!nextTab && !nextStd && !nextSlash) return;
    setShowTab(nextTab);
    setShowNotation(nextStd);
    setShowSlash(nextSlash);
  };

  const buildCommand = (): EditCommand => {
    const soundPatch = activeSound.sound ? { sound: activeSound.sound } : {};
    if (selectedTemplate.kind === 'stringed') {
      return {
        type: 'addTrack',
        name,
        tuning: parseTuning(upperStaff.notes),
        program: activeSound.program,
        tuningName: upperStaff.tuningName,
        shortName,
        color,
        showTab,
        showNotation,
        showSlash,
        ...(grandStaff ? { lowerTuning: parseTuning(lowerStaff.notes), lowerTuningName: lowerStaff.tuningName } : {}),
        ...soundPatch,
      };
    }
    if (selectedTemplate.kind === 'percussion') {
      return {
        type: 'addPercussionTrack',
        name,
        program: activeSound.program,
        shortName,
        color,
        showTab,
        showNotation,
        showSlash,
        ...soundPatch,
      };
    }
    return {
      type: 'addPitchedTrack',
      name,
      program: activeSound.program,
      shortName,
      color,
      showNotation,
      showSlash,
      clef: upperStaff.clef,
      ...(grandStaff ? { lowerClef: lowerStaff.clef } : {}),
      ...soundPatch,
    };
  };

  const addTrack = () => {
    if (busy || locked) return;
    onAdd(buildCommand());
    onClose();
  };

  const onEnterSubmit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      addTrack();
    }
  };

  const previewSound = () => {
    if (!onAudition) return;
    const source = {
      program: activeSound.program,
      percussion: selectedTemplate.kind === 'percussion',
      ...(activeSound.sound ? { sound: activeSound.sound } : {}),
    };
    if (selectedTemplate.kind === 'stringed') {
      onAudition(source, parseTuning(upperStaff.notes), true);
    } else if (selectedTemplate.kind === 'percussion') {
      onAudition(source, [36, 42, 38, 49], true);
    } else {
      const pitches = upperStaff.clef === model.Clef.F4 ? [48, 52, 55, 60] : [60, 64, 67, 72];
      onAudition(source, pitches, true);
    }
  };

  const categories: ReadonlyArray<{ id: TrackCategoryId; label: string; icon: React.JSX.Element }> = [
    { id: 'stringed', label: t('add_track.tab_stringed'), icon: <StringedCategoryGlyph /> },
    { id: 'orchestra', label: t('add_track.tab_orchestra'), icon: <OrchestraCategoryGlyph /> },
    { id: 'drums', label: t('add_track.tab_drums'), icon: <DrumsCategoryGlyph /> },
    { id: 'midi', label: t('add_track.tab_midi'), icon: <MidiCategoryGlyph /> },
  ];

  const clefs = [
    { value: model.Clef.G2, label: t('add_track.clef_treble') },
    { value: model.Clef.F4, label: t('add_track.clef_bass') },
    { value: model.Clef.C3, label: t('add_track.clef_alto') },
    { value: model.Clef.C4, label: t('add_track.clef_tenor') },
  ];

  const headingInstrument = selectedTemplate.listLabel.replace(/^\d+\.\s*/, '');
  const tuningTarget = tuningEditorStaff === 'lower' ? lowerStaff : upperStaff;

  return (
    <Dialog
      title={t('track_settings.add_track')}
      onClose={onClose}
      className="add-track-dialog"
      busy={busy}
      actions={
        <>
          <button type="button" onClick={onClose}>{t('dialog.cancel')}</button>
          <button type="button" {...busyGuard({ busy, disabled: locked, className: 'primary', onClick: addTrack })}>
            {t('track_settings.add_track')}
          </button>
        </>
      }
    >
      <div className="add-track-body">
        <BusyFieldset busy={busy}>
          <div className="add-track-tabs" role="tablist" aria-label={t('add_track.categories')}>
            {categories.map((cat, idx) => (
              <button
                key={cat.id}
                type="button"
                role="tab"
                className="add-track-tab"
                aria-selected={category === cat.id}
                tabIndex={category === cat.id ? 0 : -1}
                onClick={() => selectCategory(cat.id)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const next = categories[(idx + (event.key === 'ArrowRight' ? 1 : categories.length - 1)) % categories.length];
                  selectCategory(next.id);
                  const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  tabs?.[categories.indexOf(next)]?.focus();
                }}
              >
                {cat.icon}
                <span>{cat.label}</span>
              </button>
            ))}
          </div>

          <div className="add-track-browser">
            <div
              className="add-track-listbox"
              role="listbox"
              tabIndex={0}
              aria-label={t('add_track.subcategories')}
              onKeyDown={event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                const currentIdx = subCategories.findIndex(g => g.id === activeSubCategory?.id);
                const nextIdx = Math.max(0, Math.min(subCategories.length - 1, currentIdx + (event.key === 'ArrowDown' ? 1 : -1)));
                if (subCategories[nextIdx]) selectSubCategory(subCategories[nextIdx].id);
              }}
            >
              {subCategories.map(group => (
                <button
                  key={group.id}
                  type="button"
                  role="option"
                  className="add-track-option"
                  aria-selected={group.id === activeSubCategory?.id}
                  onClick={() => selectSubCategory(group.id)}
                >
                  {group.label}
                </button>
              ))}
            </div>

            <div
              className="add-track-listbox"
              role="listbox"
              tabIndex={0}
              aria-label={t('add_track.instruments')}
              onKeyDown={event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                const items = activeSubCategory?.items ?? [];
                const currentIdx = items.findIndex(item => item.id === selectedTemplate.id);
                const nextIdx = Math.max(0, Math.min(items.length - 1, currentIdx + (event.key === 'ArrowDown' ? 1 : -1)));
                if (items[nextIdx]) applyTemplate(items[nextIdx]);
              }}
            >
              {(activeSubCategory?.items ?? []).map(item => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  className="add-track-option"
                  aria-selected={item.id === selectedTemplate.id}
                  onClick={() => applyTemplate(item)}
                >
                  {item.listLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="add-track-settings">
            <h3 className="add-track-settings-title">
              {t('add_track.settings_heading', { instrument: headingInstrument })}
            </h3>

            <div className="add-track-row">
              <span className="add-track-row-label">{t('add_track.information')}:</span>
              <div className="add-track-info-controls">
                <input
                  type="color"
                  className="add-track-color"
                  aria-label={t('track_settings.track_color')}
                  title={t('track_settings.track_color')}
                  value={color}
                  onChange={event => setColor(event.target.value)}
                />
                <span className="add-track-icon" aria-hidden="true">
                  <TemplateIcon glyph={selectedTemplate.glyph} />
                </span>
                <input
                  data-autofocus
                  className="add-track-name-input"
                  aria-label={t('track_settings.new_track_name')}
                  value={name}
                  onChange={event => setName(event.target.value)}
                  onKeyDown={onEnterSubmit}
                />
                <input
                  className="add-track-short-input"
                  aria-label={t('track_settings.track_short_name')}
                  value={shortName}
                  onChange={event => setShortName(event.target.value)}
                  onKeyDown={onEnterSubmit}
                />
              </div>
            </div>

            <div className="add-track-row">
              <span className="add-track-row-label">{t('add_track.notation')}:</span>
              <div className="add-track-notation-controls">
                <div className="add-track-toggle-group" role="group" aria-label={t('add_track.notation')}>
                  <button
                    type="button"
                    className="add-track-toggle"
                    aria-label={t('add_track.notation_tab')}
                    title={t('add_track.notation_tab')}
                    aria-pressed={showTab}
                    disabled={selectedTemplate.kind === 'pitched'}
                    onClick={() => toggleNotationFlag('tab')}
                  >
                    <TabNotationGlyph />
                  </button>
                  <button
                    type="button"
                    className="add-track-toggle"
                    aria-label={t('add_track.notation_standard')}
                    title={t('add_track.notation_standard')}
                    aria-pressed={showNotation}
                    onClick={() => toggleNotationFlag('standard')}
                  >
                    <ScoreGlyph />
                  </button>
                  <button
                    type="button"
                    className="add-track-toggle"
                    aria-label={t('add_track.notation_slash')}
                    title={t('add_track.notation_slash')}
                    aria-pressed={showSlash}
                    onClick={() => toggleNotationFlag('slash')}
                  >
                    <SlashNotationGlyph />
                  </button>
                </div>
                <div className="add-track-toggle-group" role="group" aria-label={t('add_track.staff_mode')}>
                  <button
                    type="button"
                    className="add-track-toggle"
                    aria-label={t('add_track.staff_single')}
                    title={t('add_track.staff_single')}
                    aria-pressed={!grandStaff}
                    onClick={() => setGrandStaff(false)}
                  >
                    <SingleStaffGlyph />
                  </button>
                  <button
                    type="button"
                    className="add-track-toggle"
                    aria-label={t('add_track.staff_grand')}
                    title={t('add_track.staff_grand')}
                    aria-pressed={grandStaff}
                    disabled={selectedTemplate.kind === 'percussion'}
                    onClick={() => setGrandStaff(true)}
                  >
                    <GrandStaffGlyph />
                  </button>
                </div>
              </div>
            </div>

            {selectedTemplate.kind === 'stringed' ? (
              <>
                <StringedStaffRow
                  label={t('add_track.upper_staff')}
                  staffKey="upper"
                  draft={upperStaff}
                  disabled={false}
                  busy={busy}
                  onChange={setUpperStaff}
                  onOpenTuning={() => setTuningEditorStaff('upper')}
                />
                <StringedStaffRow
                  label={t('add_track.lower_staff')}
                  staffKey="lower"
                  draft={lowerStaff}
                  disabled={!grandStaff}
                  busy={busy}
                  onChange={setLowerStaff}
                  onOpenTuning={() => setTuningEditorStaff('lower')}
                />
              </>
            ) : selectedTemplate.kind === 'pitched' ? (
              <>
                <div className="add-track-row">
                  <span className="add-track-row-label">{t('add_track.upper_staff')}:</span>
                  <div className="add-track-row-controls">
                    <select
                      className="add-track-clef-select"
                      aria-label={t('add_track.upper_clef')}
                      value={upperStaff.clef}
                      onChange={event => setUpperStaff({ ...upperStaff, clef: Number(event.target.value) })}
                    >
                      {clefs.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="add-track-row" data-disabled={!grandStaff || undefined}>
                  <span className="add-track-row-label">{t('add_track.lower_staff')}:</span>
                  <div className="add-track-row-controls">
                    <select
                      className="add-track-clef-select"
                      aria-label={t('add_track.lower_clef')}
                      value={lowerStaff.clef}
                      disabled={!grandStaff}
                      onChange={event => setLowerStaff({ ...lowerStaff, clef: Number(event.target.value) })}
                    >
                      {clefs.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="add-track-row">
                  <span className="add-track-row-label">{t('add_track.upper_staff')}:</span>
                  <div className="add-track-row-controls">
                    <select className="add-track-clef-select" aria-label={t('add_track.upper_staff')} disabled value="percussion">
                      <option value="percussion">{t('add_track.percussion_staff')}</option>
                    </select>
                  </div>
                </div>
                <div className="add-track-row" data-disabled="true">
                  <span className="add-track-row-label">{t('add_track.lower_staff')}:</span>
                  <div className="add-track-row-controls">
                    <select className="add-track-clef-select" aria-label={t('add_track.lower_staff')} disabled value="none">
                      <option value="none">—</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            <div className="add-track-row">
              <span className="add-track-row-label">{t('add_track.sound')}:</span>
              <div className="add-track-sound-controls">
                <select
                  className="add-track-sound-select"
                  aria-label={t('add_track.sound')}
                  value={activeSound.id}
                  onChange={event => setSoundId(event.target.value)}
                >
                  {soundOptions.map(opt => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
                {onAudition && (
                  <button
                    type="button"
                    aria-label={t('add_track.preview_sound')}
                    title={t('add_track.preview_sound')}
                    {...busyGuard({ disabled: false, className: 'add-track-sound-play', onClick: previewSound })}
                  >
                    <PlayGlyph />
                  </button>
                )}
              </div>
            </div>
          </div>
        </BusyFieldset>
      </div>

      {tuningEditorStaff && (
        <TuningDialog
          mode="draft"
          pitches={parseTuning(tuningTarget.notes)}
          name={tuningTarget.tuningName}
          defaultInstrument={tuningTarget.instrument}
          onApply={choice => {
            const matched = tuningPresets.find(p => samePitches(p.tuning, choice.pitches));
            const nextDraft: StaffDraft = {
              ...tuningTarget,
              instrument: matched?.instrument ?? tuningTarget.instrument,
              notes: formatTuning(choice.pitches),
              tuningName: choice.name,
            };
            if (tuningEditorStaff === 'lower') setLowerStaff(nextDraft);
            else setUpperStaff(nextDraft);
          }}
          onClose={() => setTuningEditorStaff(null)}
          onAudition={onAudition && ((list, strum) => onAudition({ program: activeSound.program, ...(activeSound.sound ? { sound: activeSound.sound } : {}) }, list, strum))}
        />
      )}
    </Dialog>
  );
}
