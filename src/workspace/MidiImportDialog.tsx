import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Settings, type model } from '@coderline/alphatab';
import { drumMapPresets, resolveInputDrumMap } from '../audio/drum-map';
import { drumMapFiles, fileProblem as drumMapFileProblem, mapFromImport, type ImportedDrumMap } from '../audio/drum-map-file';
import { localizedDrumSoundGroups } from '../audio/drum-map-groups';
import { noteName } from '../audio/tuner';
import type { DrumMapRef } from '../edit-types';
import { useI18n } from '../i18n';
import { exportGpInterchange } from '../interchange/gp';
import { buildImportClip, type ImportTracksCommand } from '../interchange/import-tracks';
import {
  defaultMidiImportOptions,
  formatMidiImportNote,
  importMidi,
  inspectMidiParts,
  midiImportFileName,
  type MidiImport,
  type MidiImportOptions,
  type MidiPartInfo,
  type MidiQuantization,
  type MidiTrackKind,
  type MidiTupletMode,
} from '../interchange/midi-import';
import { MIDI_FILE_LIMIT, readMidiFile, type MidiSong } from '../interchange/midi-smf';
import { Dialog } from '../ui/Dialog';
import { Segmented } from '../ui/Segmented';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import './midi-import.css';

export type MidiImportDestination = 'new' | 'append' | 'replace';

export interface MidiImportDialogProps {
  busy: boolean;
  currentScore?: model.Score;
  selectedTrack?: number;
  locked?: boolean;
  onImport: (name: string, bytes: Uint8Array) => Promise<boolean>;
  onImportIntoScore?: (command: ImportTracksCommand) => Promise<boolean>;
  onImportDrumMap?: () => Promise<ImportedDrumMap | null>;
  onClose: () => void;
}

const FILE_PRESET_ID = '__file__';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const voiceOptions = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
] as const;

/**
 * Reads a Standard MIDI File, lets the destination, quantization, tuplet, voice, tablature and drum mapping options be
 * chosen while showing what they produce, and either opens a new untitled score or applies the imported tracks to the
 * current score as one undoable edit.
 */
export function MidiImportDialog({
  busy,
  currentScore,
  selectedTrack = 0,
  locked = false,
  onImport,
  onImportIntoScore,
  onImportDrumMap,
  onClose,
}: MidiImportDialogProps) {
  const { t } = useI18n();
  const quantizationOptions = [
    { value: '4', label: t('midi_import.quant_4') },
    { value: '8', label: t('midi_import.quant_8') },
    { value: '16', label: t('midi_import.quant_16') },
    { value: '32', label: t('midi_import.quant_32') },
    { value: '64', label: t('midi_import.quant_64') },
  ] as const;
  const tupletModes: [MidiTupletMode, string][] = [
    ['none', t('midi_import.tuplets_none')],
    ['triplets', t('midi_import.tuplets_triplets')],
    ['triplets-quintuplets', t('midi_import.tuplets_quintuplets')],
  ];
  const kinds: Record<MidiTrackKind, string> = {
    guitar: t('midi_import.kind_guitar'),
    bass: t('midi_import.kind_bass'),
    keys: t('midi_import.kind_keys'),
    drums: t('midi_import.kind_drums'),
  };

  const canImportIntoScore = !!currentScore && !!onImportIntoScore;
  const scoreTrackCount = currentScore?.tracks.length ?? 0;

  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [importProblem, setImportProblem] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const [destination, setDestination] = useState<MidiImportDestination>('new');
  const [targetTrack, setTargetTrack] = useState<number>(() =>
    scoreTrackCount > 0 ? Math.max(0, Math.min(selectedTrack, scoreTrackCount - 1)) : 0,
  );
  const [sourcePart, setSourcePart] = useState(0);
  const [options, setOptions] = useState<MidiImportOptions>(defaultMidiImportOptions);

  const [forceAllDrums, setForceAllDrums] = useState(false);
  const [partDrums, setPartDrums] = useState<readonly number[]>([]);
  const [drumMapPreset, setDrumMapPreset] = useState<string>('gm');
  const [loadedDrumMap, setLoadedDrumMap] = useState<{ name: string; map: DrumMapRef | undefined } | null>(null);
  const [drumKeyOverrides, setDrumKeyOverrides] = useState<Record<number, number | null>>({});
  const [drumMapError, setDrumMapError] = useState('');

  const picker = useRef<HTMLInputElement>(null);
  const reading = useRef(0);
  const loadingDrumMap = useRef(false);
  const hint = useId();
  const status = useId();

  const song = useMemo<{ value: MidiSong } | { error: string } | null>(() => {
    if (!file) return null;
    try {
      return { value: readMidiFile(file.bytes) };
    } catch (error) {
      return { error: message(error) };
    }
  }, [file]);

  const parts = useMemo<readonly MidiPartInfo[]>(() => {
    if (!song || !('value' in song)) return [];
    try {
      return inspectMidiParts(song.value);
    } catch {
      return [];
    }
  }, [song]);

  const presets = drumMapPresets();
  const activeDestination: MidiImportDestination = canImportIntoScore ? destination : 'new';
  const effectiveTargetTrack = scoreTrackCount > 0 ? Math.max(0, Math.min(targetTrack, scoreTrackCount - 1)) : 0;
  const targetTrackObj = currentScore?.tracks[effectiveTargetTrack];
  const targetIsPercussion = activeDestination === 'replace' && !!targetTrackObj?.isPercussion;
  const targetIsMelodic = activeDestination === 'replace' && !!targetTrackObj && !targetTrackObj.isPercussion;
  const chosenPart = parts.find(part => part.index === sourcePart) ?? parts[0];

  const replaceMismatch =
    activeDestination === 'replace' && targetIsMelodic && !!chosenPart?.defaultPercussion;

  const partDrumsSet = useMemo(() => new Set(partDrums), [partDrums]);
  const activeParts = useMemo(
    () => (activeDestination === 'replace' ? (chosenPart ? [chosenPart] : []) : parts),
    [activeDestination, chosenPart, parts],
  );
  const activeDrumPartIndices = useMemo(() => {
    if (activeDestination === 'replace') {
      return targetIsPercussion && chosenPart ? [chosenPart.index] : [];
    }
    if (forceAllDrums) return parts.map(part => part.index);
    return parts.filter(part => part.defaultPercussion || partDrumsSet.has(part.index)).map(part => part.index);
  }, [activeDestination, targetIsPercussion, chosenPart, forceAllDrums, parts, partDrumsSet]);

  const isDrumsActive =
    activeDestination === 'replace'
      ? targetIsPercussion
      : forceAllDrums || activeParts.some(part => part.defaultPercussion || partDrumsSet.has(part.index));

  const effectiveDrumMap = useMemo<DrumMapRef | undefined>(() => {
    if (drumMapPreset === FILE_PRESET_ID && loadedDrumMap) return loadedDrumMap.map;
    if (drumMapPreset !== 'gm' && drumMapPreset !== FILE_PRESET_ID) return { preset: drumMapPreset };
    return undefined;
  }, [drumMapPreset, loadedDrumMap]);

  const selectedPresetMeta =
    drumMapPreset !== 'gm' && drumMapPreset !== FILE_PRESET_ID
      ? presets.find(entry => entry.id === drumMapPreset)
      : undefined;

  const targetBars = useMemo(() => {
    if (activeDestination === 'new' || !currentScore?.masterBars.length) return undefined;
    return currentScore.masterBars.map(bar => ({
      numerator: bar.timeSignatureNumerator,
      denominator: bar.timeSignatureDenominator,
    }));
  }, [activeDestination, currentScore]);

  const effectiveOptions = useMemo<MidiImportOptions>(() => {
    const hasOverrides = Object.keys(drumKeyOverrides).length > 0;
    const needsCustomFields =
      activeDestination !== 'new' ||
      activeDrumPartIndices.length > 0 ||
      effectiveDrumMap !== undefined ||
      hasOverrides;
    if (!needsCustomFields) return options;
    return {
      ...options,
      ...(activeDestination === 'replace' && chosenPart ? { selectedParts: [chosenPart.index] } : {}),
      ...(activeDrumPartIndices.length > 0 ? { drumParts: activeDrumPartIndices } : {}),
      ...(effectiveDrumMap ? { drumMap: effectiveDrumMap } : {}),
      ...(hasOverrides ? { drumKeyOverrides } : {}),
      ...(targetBars ? { targetBars } : {}),
    };
  }, [options, activeDestination, chosenPart, activeDrumPartIndices, effectiveDrumMap, drumKeyOverrides, targetBars]);

  // Converting a long file takes a moment, so it follows the option controls rather than blocking them.
  const settled = useDeferredValue(effectiveOptions);
  const result = useMemo<{ value: MidiImport } | { error: string } | null>(() => {
    if (!file || !song || !('value' in song)) return null;
    try {
      return { value: importMidi(song.value, settled, file.name.replace(/\.[^.]*$/, '')) };
    } catch (error) {
      return { error: message(error) };
    }
  }, [file, song, settled]);

  const imported = settled === effectiveOptions && result && 'value' in result ? result.value : null;
  const problem =
    importProblem ??
    fileProblem ??
    (song && 'error' in song ? song.error : null) ??
    (replaceMismatch ? t('midi_import.replace_percussion_on_melodic') : null) ??
    (result && 'error' in result ? result.error : null);

  const drumKeys = useMemo(() => {
    if (!isDrumsActive || !activeDrumPartIndices.length) return [];
    const drumSet = new Set(activeDrumPartIndices);
    const counts = new Map<number, number>();
    for (const part of activeParts) {
      if (!drumSet.has(part.index)) continue;
      for (const entry of part.keys) {
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + entry.count);
      }
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([key, count]) => ({ key, count }));
  }, [isDrumsActive, activeDrumPartIndices, activeParts]);

  const baseInputMap = useMemo(() => resolveInputDrumMap(effectiveDrumMap), [effectiveDrumMap]);
  const resolvedInputMap = useMemo(
    () => resolveInputDrumMap(effectiveDrumMap, drumKeyOverrides),
    [effectiveDrumMap, drumKeyOverrides],
  );
  const soundGroups = useMemo(() => localizedDrumSoundGroups(t), [t]);

  const mappedKeyCount = drumKeys.filter(entry => resolvedInputMap[entry.key] !== null).length;
  const unmappedKeyCount = drumKeys.length - mappedKeyCount;
  const changedKeyCount = drumKeys.filter(
    entry =>
      Object.hasOwn(drumKeyOverrides, entry.key) &&
      drumKeyOverrides[entry.key] !== baseInputMap[entry.key],
  ).length;

  const choice = <K extends keyof MidiImportOptions>(key: K, value: MidiImportOptions[K]) => {
    setImportProblem(null);
    setOptions(current => {
      const next = { ...current, [key]: value };
      // A tuplet kind the new grid cannot hold gives way to the nearest one it can.
      if (next.quantization < 8) next.tuplets = 'none';
      else if (next.quantization < 16 && next.tuplets === 'triplets-quintuplets') next.tuplets = 'triplets';
      return next;
    });
  };

  const selectDestination = (next: MidiImportDestination) => {
    setImportProblem(null);
    setDestination(next);
    if (next === 'replace' && currentScore?.tracks.length) {
      const tracks = currentScore.tracks;
      const currentIsPercussion = tracks[effectiveTargetTrack]?.isPercussion ?? false;
      const wantsDrums = forceAllDrums || parts.some(part => part.defaultPercussion || partDrumsSet.has(part.index));
      const firstPercussionTrack = tracks.findIndex(track => track.isPercussion);
      const nextTarget =
        currentIsPercussion || !wantsDrums || firstPercussionTrack < 0
          ? effectiveTargetTrack
          : firstPercussionTrack;
      setTargetTrack(nextTarget);
      if (tracks[nextTarget]?.isPercussion) {
        const firstDrumPart = parts.find(part => part.defaultPercussion || partDrumsSet.has(part.index));
        setSourcePart(firstDrumPart ? firstDrumPart.index : 0);
      } else {
        setSourcePart(0);
      }
    }
  };

  const load = (chosen: File | undefined) => {
    if (!chosen) return;
    // A newer choice, even a refused one, supersedes any file still loading.
    const request = ++reading.current;
    setImportProblem(null);
    if (chosen.size > MIDI_FILE_LIMIT) {
      setFile(null);
      setFileProblem(t('midi_import.size_limit', { name: chosen.name }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (request !== reading.current) return;
      setFileProblem(null);
      setPartDrums([]);
      setSourcePart(0);
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      try {
        const parsed = readMidiFile(bytes);
        const inspected = inspectMidiParts(parsed);
        if (activeDestination === 'replace' && targetIsPercussion) {
          const firstDrum = inspected.find(part => part.defaultPercussion);
          if (firstDrum) setSourcePart(firstDrum.index);
        }
      } catch {
        // Error surfaced cleanly via song memo.
      }
      setFile({ name: chosen.name, bytes });
    };
    reader.onerror = () => {
      if (request === reading.current) {
        setFile(null);
        setFileProblem(t('midi_import.could_not_read', { name: chosen.name }));
      }
    };
    reader.readAsArrayBuffer(chosen);
  };

  const importDrumMapFile = () => {
    if (loadingDrumMap.current || importing) return;
    loadingDrumMap.current = true;
    setDrumMapError('');
    setImportProblem(null);
    void (onImportDrumMap ? onImportDrumMap() : drumMapFiles.import())
      .then(result => {
        if (!result) return;
        const map = mapFromImport(result);
        setLoadedDrumMap({ name: result.name.trim() || t('drum_map.preset_gm'), map });
        setDrumMapPreset(FILE_PRESET_ID);
        setDrumKeyOverrides({});
      })
      .catch(reason => {
        const { key, detail } = drumMapFileProblem(reason);
        setDrumMapError(t('drum_map.import_failed', { error: t(key, { detail }) }));
      })
      .finally(() => {
        loadingDrumMap.current = false;
      });
  };

  const submit = async () => {
    if (!imported || !file || busy || importing || replaceMismatch) return;
    if (activeDestination !== 'new') {
      if (!onImportIntoScore || locked) return;
      let clip;
      try {
        clip = buildImportClip(imported.score);
      } catch (error) {
        setImportProblem(message(error));
        return;
      }
      setImporting(true);
      setImportProblem(null);
      try {
        const command: ImportTracksCommand =
          activeDestination === 'replace'
            ? { type: 'importTracks', clip, targetTrack: effectiveTargetTrack }
            : { type: 'importTracks', clip };
        if (await onImportIntoScore(command)) onClose();
        else setImportProblem(t('midi_import.not_imported'));
      } catch (error) {
        setImportProblem(t('midi_import.import_into_score_failed', { error: message(error) }));
      } finally {
        setImporting(false);
      }
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = exportGpInterchange(imported.score, new Settings());
    } catch (error) {
      setImportProblem(message(error));
      return;
    }
    setImporting(true);
    setImportProblem(null);
    try {
      if (await onImport(midiImportFileName(file.name), bytes)) onClose();
      else setImportProblem(t('midi_import.not_opened'));
    } catch (error) {
      setImportProblem(t('midi_import.open_failed', { error: message(error) }));
    } finally {
      setImporting(false);
    }
  };

  const stepOut = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  };

  const presetLabel = (id: string) => {
    const entry = presets.find(item => item.id === id);
    if (id === 'gm') return t('drum_map.preset_gm');
    const name = entry?.name ?? id;
    return entry?.state === 'unverified' ? t('drum_map.preset_unchecked', { name }) : name;
  };

  const summary = imported
    ? t(activeDestination === 'new' ? 'midi_import.summary' : 'midi_import.summary_into_score', {
        format: t(imported.summary.format === 0 ? 'midi_import.format_0' : 'midi_import.format_1'),
        parts: t(
          imported.summary.tracks.length === 1
            ? 'midi_import.summary_parts_one'
            : 'midi_import.summary_parts_other',
          { count: imported.summary.tracks.length },
        ),
        measures: t(
          imported.summary.measures === 1
            ? 'midi_import.summary_measures_one'
            : 'midi_import.summary_measures_other',
          { count: imported.summary.measures },
        ),
        tempo: imported.summary.tempo,
      })
    : '';

  const destinationOptions = [
    { value: 'new' as const, label: t('midi_import.dest_new') },
    { value: 'append' as const, label: t('midi_import.dest_append'), disabled: locked },
    {
      value: 'replace' as const,
      label: t('midi_import.dest_replace'),
      disabled: locked || scoreTrackCount === 0,
    },
  ] as const;

  const importUnavailable =
    !imported || replaceMismatch || (activeDestination !== 'new' && locked);

  const actions = (
    <>
      <button
        type="submit"
        {...busyGuard({
          busy: busy || importing,
          unavailable: importUnavailable,
          className: 'tp-button primary',
        })}
      >
        {t('midi_import.import_btn')}
      </button>
      <button
        type="button"
        {...busyGuard({ busy: importing, className: 'tp-button', onClick: onClose })}
      >
        {t('dialog.cancel')}
      </button>
    </>
  );

  const keyDisclosureSummary =
    changedKeyCount > 0
      ? t('midi_import.drum_keys_toggle_changed', {
          count: drumKeys.length,
          changed: changedKeyCount,
        })
      : unmappedKeyCount > 0
        ? t('midi_import.drum_keys_toggle_unmapped', {
            count: drumKeys.length,
            unmapped: unmappedKeyCount,
          })
        : t('midi_import.drum_keys_toggle', { count: drumKeys.length });

  const canToggleGlobalDrums = activeDestination !== 'replace';
  const showPartDrumsToggle = activeDestination !== 'replace' && parts.length > 1;

  return (
    <Dialog
      title={t('midi_import.title')}
      onClose={onClose}
      ariaDescribedBy={hint}
      busy={importing}
      closeDisabled={importing}
      dismissOnBackdrop
      className="ascii-import midi-import"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
      actions={actions}
    >
      <div className="ascii-import-form">
        <p id={hint} className="muted">
          {t('midi_import.hint')}
        </p>
        <input
          ref={picker}
          type="file"
          accept=".mid,.midi,audio/midi,audio/x-midi"
          hidden
          aria-label={t('midi_import.file_aria')}
          onChange={event => {
            load(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <div className="midi-file">
          <button
            type="button"
            data-autofocus
            {...busyGuard({ busy: importing, onClick: () => picker.current?.click() })}
          >
            {t('midi_import.choose_file')}
          </button>
          <span>{file ? file.name : t('midi_import.no_file')}</span>
        </div>

        {canImportIntoScore && (
          <div className="midi-destination">
            <div className="tp-field">
              <span className="tp-field-label" aria-hidden="true">
                {t('midi_import.destination')}
              </span>
              <Segmented
                label={t('midi_import.destination')}
                disabled={importing}
                value={activeDestination}
                options={destinationOptions}
                onChange={selectDestination}
              />
            </div>
            {locked && <p className="muted">{t('midi_import.locked_note')}</p>}
            {activeDestination === 'replace' && currentScore && (
              <div className="midi-replace-targets">
                <label>
                  {t('midi_import.target_track')}
                  <select
                    value={String(effectiveTargetTrack)}
                    {...busySelect(importing)}
                    onChange={event => {
                      if (importing) return;
                      const nextTrack = Number(event.target.value);
                      setImportProblem(null);
                      setTargetTrack(nextTrack);
                      if (currentScore.tracks[nextTrack]?.isPercussion) {
                        const firstDrum = parts.find(part => part.defaultPercussion || partDrumsSet.has(part.index));
                        if (firstDrum) setSourcePart(firstDrum.index);
                      }
                    }}
                  >
                    {currentScore.tracks.map((track, index) => {
                      const trackLabel = track.isPercussion
                        ? t('midi_import.target_track_drums', { name: track.name })
                        : track.name;
                      return (
                        <option key={index} value={String(index)}>
                          {`${index + 1}. ${trackLabel}`}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {parts.length > 1 && (
                  <label>
                    {t('midi_import.source_part')}
                    <select
                      value={String(chosenPart?.index ?? 0)}
                      {...busySelect(importing)}
                      onChange={event => {
                        if (!importing) {
                          setImportProblem(null);
                          setSourcePart(Number(event.target.value));
                        }
                      }}
                    >
                      {parts.map(part => (
                        <option key={part.index} value={String(part.index)}>
                          {`${part.index + 1}. ${part.name} (${t(
                            part.noteCount === 1
                              ? 'midi_import.part_notes_one'
                              : 'midi_import.part_notes_other',
                            { count: part.noteCount },
                          )})`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {activeDestination !== 'new' && (
              <p className="muted">{t('midi_import.follows_measures')}</p>
            )}
          </div>
        )}

        <fieldset className="midi-options">
          <div className="tp-field midi-full-row">
            <span className="tp-field-label" aria-hidden="true">
              {t('midi_import.quantization')}
            </span>
            <Segmented
              label={t('midi_import.quantization')}
              disabled={importing}
              value={String(options.quantization)}
              options={quantizationOptions}
              onChange={val => choice('quantization', Number(val) as MidiQuantization)}
            />
          </div>
          <label>
            {t('midi_import.tuplets')}
            <select
              value={options.tuplets}
              {...busySelect(importing)}
              onChange={event => {
                if (!importing) choice('tuplets', event.target.value as MidiTupletMode);
              }}
            >
              {tupletModes.map(([value, label]) => (
                <option
                  key={value}
                  value={value}
                  disabled={
                    (value !== 'none' && options.quantization < 8) ||
                    (value === 'triplets-quintuplets' && options.quantization < 16)
                  }
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="tp-field">
            <span className="tp-field-label" aria-hidden="true">
              {t('midi_import.voices_per_track')}
            </span>
            <Segmented
              label={t('midi_import.voices_per_track')}
              disabled={importing}
              value={String(options.voices)}
              options={voiceOptions}
              onChange={val => choice('voices', Number(val) as MidiImportOptions['voices'])}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={options.tablature}
              aria-disabled={importing || undefined}
              onChange={event => {
                if (!importing) choice('tablature', event.target.checked);
              }}
            />
            {t('midi_import.tablature')}
          </label>
          {(canToggleGlobalDrums || targetIsPercussion) && (
            <label className="check">
              <input
                type="checkbox"
                checked={targetIsPercussion || forceAllDrums}
                aria-disabled={importing || targetIsPercussion || undefined}
                onChange={event => {
                  if (importing || targetIsPercussion) return;
                  setImportProblem(null);
                  setForceAllDrums(event.target.checked);
                }}
              />
              {t('midi_import.import_as_drums')}
            </label>
          )}
        </fieldset>

        {isDrumsActive && (
          <section className="midi-drum-mapping">
            <div className="midi-drum-map-row">
              <label>
                {t('midi_import.drum_map_source')}
                <select
                  value={drumMapPreset}
                  {...busySelect(importing)}
                  onChange={event => {
                    if (importing) return;
                    setImportProblem(null);
                    setDrumMapError('');
                    setDrumMapPreset(event.target.value);
                    setDrumKeyOverrides({});
                  }}
                >
                  <option value="gm">{presetLabel('gm')}</option>
                  {presets.some(entry => entry.id !== 'gm') && (
                    <optgroup label={t('drum_map.presets_group')}>
                      {presets
                        .filter(entry => entry.id !== 'gm')
                        .map(entry => (
                          <option key={entry.id} value={entry.id}>
                            {presetLabel(entry.id)}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {loadedDrumMap && (
                    <option value={FILE_PRESET_ID}>
                      {t('midi_import.drum_map_file_option', { name: loadedDrumMap.name })}
                    </option>
                  )}
                </select>
              </label>
              <button
                type="button"
                {...busyGuard({ busy: importing, className: 'tp-button', onClick: importDrumMapFile })}
              >
                {t('midi_import.load_drum_map')}
              </button>
            </div>
            {selectedPresetMeta?.state === 'unverified' && (
              <p className="muted midi-drum-map-note">{t('midi_import.drum_map_unverified')}</p>
            )}
            {drumMapError && (
              <p className="error" role="alert">
                {drumMapError}
              </p>
            )}
            {drumKeys.length > 0 && (
              <>
                <p className="muted">
                  {t(
                    unmappedKeyCount > 0
                      ? 'midi_import.drum_keys_summary_unmapped'
                      : 'midi_import.drum_keys_summary',
                    {
                      mapped: mappedKeyCount,
                      total: drumKeys.length,
                      unmapped: unmappedKeyCount,
                    },
                  )}
                </p>
                <details className="midi-drum-keys" data-escape-closes onKeyDown={stepOut}>
                  <summary>{keyDisclosureSummary}</summary>
                  <ul className="midi-drum-key-list">
                    {drumKeys.map(({ key, count }) => {
                      const baseValue = baseInputMap[key];
                      const currentValue = resolvedInputMap[key];
                      const isOverridden =
                        Object.hasOwn(drumKeyOverrides, key) && drumKeyOverrides[key] !== baseValue;
                      return (
                        <li
                          key={key}
                          className="midi-drum-key-row"
                          data-changed={isOverridden || undefined}
                        >
                          <span className="midi-drum-key-id">{`${key} · ${noteName(key)}`}</span>
                          <span className="muted midi-drum-key-hits">
                            {t(
                              count === 1
                                ? 'midi_import.drum_key_hits_one'
                                : 'midi_import.drum_key_hits_other',
                              { count },
                            )}
                          </span>
                          <select
                            aria-label={t('midi_import.drum_key_target', {
                              key,
                              note: noteName(key),
                            })}
                            value={currentValue === null ? '' : String(currentValue)}
                            {...busySelect(importing)}
                            onChange={event => {
                              if (importing) return;
                              const raw = event.target.value;
                              const nextVal = raw === '' ? null : Number(raw);
                              setImportProblem(null);
                              setDrumKeyOverrides(prev => {
                                const next = { ...prev };
                                if (nextVal === baseValue) delete next[key];
                                else next[key] = nextVal;
                                return next;
                              });
                            }}
                          >
                            <option value="">{t('midi_import.drum_key_skip')}</option>
                            {soundGroups.map(group => (
                              <optgroup
                                key={group.id}
                                label={
                                  group.id === 'other'
                                    ? t('drum_map.group_other')
                                    : group.label
                                }
                              >
                                {group.rows.map(row => (
                                  <option key={row.id} value={String(row.id)}>
                                    {row.piece ? `${row.piece} · ${row.name}` : row.name}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <span className="midi-drum-key-state">
                            {isOverridden ? (
                              <>
                                <span className="midi-drum-key-changed">
                                  {t('drum_map.changed')}
                                </span>
                                <button
                                  type="button"
                                  aria-label={t('midi_import.drum_key_reset_aria', { key })}
                                  {...busyGuard({
                                    busy: importing,
                                    onClick: event => {
                                      event.currentTarget
                                        .closest('li')
                                        ?.querySelector('select')
                                        ?.focus();
                                      setImportProblem(null);
                                      setDrumKeyOverrides(prev => {
                                        const next = { ...prev };
                                        delete next[key];
                                        return next;
                                      });
                                    },
                                  })}
                                >
                                  {t('drum_map.reset_row')}
                                </button>
                              </>
                            ) : currentValue === null ? (
                              <span className="muted">{t('midi_import.drum_key_skipped')}</span>
                            ) : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="midi-drum-keys-foot">
                    <button
                      type="button"
                      {...busyGuard({
                        busy: importing,
                        unavailable: changedKeyCount === 0,
                        className: 'tp-button',
                        onClick: () => {
                          setImportProblem(null);
                          setDrumKeyOverrides({});
                        },
                      })}
                    >
                      {t('midi_import.drum_keys_reset_all')}
                    </button>
                  </div>
                </details>
              </>
            )}
          </section>
        )}

        <p id={status} role="status" className={problem ? 'error' : 'muted'}>
          {problem ??
            (importing
              ? t(
                  activeDestination === 'new'
                    ? 'midi_import.opening'
                    : 'midi_import.importing_into_score',
                )
              : settled !== effectiveOptions
                ? t('midi_import.updating')
                : imported
                  ? summary
                  : t('midi_import.nothing_yet'))}
        </p>

        {imported && !problem && (
          <>
            <ul className="midi-parts" aria-label={t('midi_import.parts')}>
              {imported.summary.tracks.map((part, index) => {
                const matchingSource =
                  part.partIndex !== undefined
                    ? parts.find(entry => entry.index === part.partIndex)
                    : activeParts[index];
                const canTogglePart =
                  showPartDrumsToggle &&
                  !forceAllDrums &&
                  matchingSource &&
                  !matchingSource.defaultPercussion;
                const partText = `${part.name}: ${kinds[part.kind]}, ${t(
                  part.notes === 1 ? 'midi_import.part_notes_one' : 'midi_import.part_notes_other',
                  { count: part.notes },
                )}${part.voices > 1 ? `, ${t('midi_import.part_voices', { count: part.voices })}` : ''}`;
                return (
                  <li key={index} className="midi-part-item">
                    <span>{partText}</span>
                    {canTogglePart && (
                      <label className="midi-part-drums-toggle">
                        <input
                          type="checkbox"
                          checked={partDrumsSet.has(matchingSource.index)}
                          aria-label={t('midi_import.part_as_drums_aria', {
                            name: matchingSource.name,
                          })}
                          aria-disabled={importing || undefined}
                          onChange={event => {
                            if (importing) return;
                            setImportProblem(null);
                            const checked = event.target.checked;
                            setPartDrums(prev => {
                              const next = new Set(prev);
                              if (checked) next.add(matchingSource.index);
                              else next.delete(matchingSource.index);
                              return [...next].sort((a, b) => a - b);
                            });
                          }}
                        />
                        {t('midi_import.part_as_drums')}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
            {imported.summary.notes.length > 0 && (
              <p className="muted">
                {imported.summary.notes.map(note => formatMidiImportNote(note, t)).join(' ')}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
