import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Settings, type model } from '@coderline/alphatab';
import type { TuningAudition } from '../audio/audition';
import {
  diProblem,
  diTranscribe,
  type DiAnalysisSummary,
  type DiDecodeParams,
  type DiTranscriber,
  type TranscribedDiNote,
} from '../audio/di-transcribe';
import { useI18n } from '../i18n';
import {
  defaultDiGuitarImportOptions,
  diImportFileName,
  extractScoreTempoMap,
  formatDiImportNote,
  importDiGuitarNotes,
  type DiFretPosition,
  type DiGuitarImport,
  type DiGuitarImportOptions,
  type DiGuitarQuantization,
  type DiTargetBar,
  type DiTupletMode,
} from '../interchange/di-guitar-import';
import { exportGpInterchange } from '../interchange/gp';
import { buildImportClip, type ImportTracksCommand } from '../interchange/import-tracks';
import { formatTuning } from '../tuning';
import { TuningDialog } from '../tuning/TuningDialog';
import { tuningGroupTitle, tuningPresetName, tuningPresets, type TuningPreset } from '../tuning-presets';
import { Dialog } from '../ui/Dialog';
import { Segmented } from '../ui/Segmented';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import './di-import.css';

export type DiImportDestination = 'new' | 'append' | 'replace';
export type DiSensitivity = 'conservative' | 'balanced' | 'sensitive';

export interface DiImportDialogProps {
  busy: boolean;
  currentScore?: model.Score;
  selectedTrack?: number;
  locked?: boolean;
  onAudition?: TuningAudition;
  onImport: (name: string, bytes: Uint8Array) => Promise<boolean>;
  onImportIntoScore?: (command: ImportTracksCommand) => Promise<boolean>;
  transcriber?: DiTranscriber;
  onClose: () => void;
}

const DEFAULT_TUNING = [64, 59, 55, 50, 45, 40] as const;
const sameTuning = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((pitch, index) => pitch === b[index]);
const TIME_SIGNATURES: readonly { id: string; label: string; meter: DiTargetBar }[] = [
  { id: '4/4', label: '4/4', meter: { numerator: 4, denominator: 4 } },
  { id: '3/4', label: '3/4', meter: { numerator: 3, denominator: 4 } },
  { id: '6/8', label: '6/8', meter: { numerator: 6, denominator: 8 } },
  { id: '5/4', label: '5/4', meter: { numerator: 5, denominator: 4 } },
  { id: '7/8', label: '7/8', meter: { numerator: 7, denominator: 8 } },
  { id: '2/4', label: '2/4', meter: { numerator: 2, denominator: 4 } },
];

const SENSITIVITY_PARAMS: Record<DiSensitivity, Pick<DiDecodeParams, 'onsetThreshold' | 'frameThreshold' | 'minNoteMs'>> = {
  conservative: { onsetThreshold: 0.55, frameThreshold: 0.36, minNoteMs: 70 },
  balanced: { onsetThreshold: 0.45, frameThreshold: 0.28, minNoteMs: 55 },
  sensitive: { onsetThreshold: 0.35, frameThreshold: 0.20, minNoteMs: 42 },
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Picks a DI guitar/bass audio file, runs local neural + DSP pitch/palm-mute analysis, solves guitar fretboard
 * fingering for the chosen tuning and tempo map, and imports either a new score or tracks into the current score.
 */
export function DiImportDialog({
  busy,
  currentScore,
  selectedTrack = 0,
  locked = false,
  onAudition,
  onImport,
  onImportIntoScore,
  transcriber = diTranscribe,
  onClose,
}: DiImportDialogProps) {
  const { t, lang } = useI18n();
  const quantizationOptions = [
    { value: '8', label: t('midi_import.quant_8') },
    { value: '16', label: t('midi_import.quant_16') },
    { value: '32', label: t('midi_import.quant_32') },
    { value: '64', label: t('midi_import.quant_64') },
  ] as const;
  const tupletModes: [DiTupletMode, string][] = [
    ['none', t('midi_import.tuplets_none')],
    ['triplets', t('midi_import.tuplets_triplets')],
    ['triplets-quintuplets', t('midi_import.tuplets_quintuplets')],
  ];
  const voiceOptions = [
    { value: '1', label: '1' },
    { value: '2', label: '2' },
  ] as const;
  const sensitivityOptions: readonly { value: DiSensitivity; label: string }[] = [
    { value: 'conservative', label: t('di_import.sensitivity_conservative') },
    { value: 'balanced', label: t('di_import.sensitivity_balanced') },
    { value: 'sensitive', label: t('di_import.sensitivity_sensitive') },
  ];
  const positionOptions: readonly { value: DiFretPosition; label: string }[] = [
    { value: 'auto', label: t('di_import.position_auto') },
    { value: 'low', label: t('di_import.position_low') },
    { value: 'mid', label: t('di_import.position_mid') },
    { value: 'high', label: t('di_import.position_high') },
  ];

  const tuningGroups = useMemo(() => {
    const groups: { key: string; title: string; items: TuningPreset[] }[] = [];
    const byKey = new Map<string, { key: string; title: string; items: TuningPreset[] }>();
    for (const preset of tuningPresets) {
      if (preset.instrument !== 'guitar' && preset.instrument !== 'bass') continue;
      const key = `${preset.instrument}-${preset.strings}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, title: tuningGroupTitle(preset.instrument, preset.strings, lang), items: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.items.push(preset);
    }
    return groups;
  }, [lang]);

  const canImportIntoScore = !!currentScore && !!onImportIntoScore;
  const scoreTrackCount = currentScore?.tracks.length ?? 0;

  const [analysis, setAnalysis] = useState<DiAnalysisSummary | null>(null);
  const [rawNotes, setRawNotes] = useState<readonly TranscribedDiNote[] | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [importProblem, setImportProblem] = useState<string | null>(null);

  const [destination, setDestination] = useState<DiImportDestination>('new');
  const [targetTrack, setTargetTrack] = useState<number>(() =>
    scoreTrackCount > 0 ? Math.max(0, Math.min(selectedTrack, scoreTrackCount - 1)) : 0,
  );
  const [tuningPitches, setTuningPitches] = useState<number[]>(() => [...DEFAULT_TUNING]);
  const [tuningName, setTuningName] = useState<string>('');
  const [tuningDialogOpen, setTuningDialogOpen] = useState<boolean>(false);
  const [bpmInput, setBpmInput] = useState<string>('120');
  const [timeSignatureId, setTimeSignatureId] = useState<string>('4/4');
  const [offsetMsInput, setOffsetMsInput] = useState<string>('0');
  const [quantization, setQuantization] = useState<DiGuitarQuantization>(16);
  const [tuplets, setTuplets] = useState<DiTupletMode>('none');
  const [voices, setVoices] = useState<1 | 2>(1);
  const [sensitivity, setSensitivity] = useState<DiSensitivity>('balanced');
  const [position, setPosition] = useState<DiFretPosition>('auto');
  const [maxFret, setMaxFret] = useState<number>(24);
  const [detectPalmMutes, setDetectPalmMutes] = useState<boolean>(true);
  const [suppressOvertones, setSuppressOvertones] = useState<boolean>(true);

  const decodeSeq = useRef(0);
  const mountedTranscriber = useRef(transcriber);
  mountedTranscriber.current = transcriber;
  useEffect(
    () => () => {
      void mountedTranscriber.current.clear().catch(() => {});
    },
    [],
  );

  const hint = useId();
  const status = useId();

  const activeDestination: DiImportDestination = canImportIntoScore ? destination : 'new';
  const effectiveTargetTrack = scoreTrackCount > 0 ? Math.max(0, Math.min(targetTrack, scoreTrackCount - 1)) : 0;
  const targetTrackObj = currentScore?.tracks[effectiveTargetTrack];
  const targetStaff = targetTrackObj?.staves[0];
  const targetIsPercussion = activeDestination === 'replace' && !!targetTrackObj?.isPercussion;
  const targetIsStringed =
    activeDestination === 'replace' &&
    !!targetStaff &&
    !targetStaff.isPercussion &&
    targetStaff.tuning.length > 0;
  const allowStringTechniques = !(activeDestination === 'replace' && !targetIsStringed);

  const matchedPreset = useMemo(
    () =>
      tuningGroups
        .flatMap(group => group.items)
        .find(preset => sameTuning(preset.tuning, tuningPitches)),
    [tuningGroups, tuningPitches],
  );
  const effectiveTuning = useMemo<readonly number[]>(
    () => (targetIsStringed && targetStaff ? [...targetStaff.tuning] : [...tuningPitches]),
    [targetIsStringed, targetStaff, tuningPitches],
  );
  const isCustomBass =
    (tuningPitches.at(-1) ?? 40) <= 31 && tuningPitches.length <= 6;
  const effectiveCapo = targetIsStringed && targetStaff ? targetStaff.capo : 0;
  const effectiveTransposition = targetIsStringed && targetStaff ? targetStaff.transpositionPitch : 0;

  const { minPitch, maxPitch } = useMemo(() => {
    const open = effectiveTuning.map(pitch => pitch + effectiveCapo - effectiveTransposition);
    const low = Math.max(21, Math.min(108, Math.min(...open)));
    const high = Math.max(low, Math.min(108, Math.max(...open) + maxFret));
    return { minPitch: low, maxPitch: high };
  }, [effectiveTuning, effectiveCapo, effectiveTransposition, maxFret]);

  const analysisId = analysis?.analysisId ?? null;
  const decodeParams = useMemo<DiDecodeParams>(
    () => ({
      ...SENSITIVITY_PARAMS[sensitivity],
      minPitch,
      maxPitch,
      suppressOvertones,
      openTuning: effectiveTuning.map(pitch =>
        Math.max(0, Math.min(127, pitch + effectiveCapo - effectiveTransposition)),
      ),
    }),
    [
      sensitivity,
      minPitch,
      maxPitch,
      suppressOvertones,
      effectiveTuning,
      effectiveCapo,
      effectiveTransposition,
    ],
  );

  useEffect(() => {
    if (!analysisId) {
      setRawNotes(null);
      return;
    }
    const seq = ++decodeSeq.current;
    setDecoding(true);
    setFileProblem(null);
    void transcriber
      .decode(analysisId, decodeParams)
      .then(notes => {
        if (seq !== decodeSeq.current) return;
        setRawNotes(notes);
      })
      .catch(reason => {
        if (seq !== decodeSeq.current) return;
        const { key, detail } = diProblem(reason);
        setRawNotes(null);
        setFileProblem(t(key, { detail }));
      })
      .finally(() => {
        if (seq === decodeSeq.current) setDecoding(false);
      });
  }, [analysisId, decodeParams, transcriber, t]);

  const parsedBpm = Number(bpmInput);
  const bpmValid =
    activeDestination !== 'new' ||
    (Number.isFinite(parsedBpm) && parsedBpm >= 20 && parsedBpm <= 350);
  const parsedOffsetMs = Number(offsetMsInput);
  const offsetValid = Number.isFinite(parsedOffsetMs) && Math.abs(parsedOffsetMs) <= 600_000;

  const targetBars = useMemo(() => {
    if (activeDestination === 'new' || !currentScore?.masterBars.length) return undefined;
    return currentScore.masterBars.map(bar => ({
      numerator: bar.timeSignatureNumerator,
      denominator: bar.timeSignatureDenominator,
    }));
  }, [activeDestination, currentScore]);

  const targetTempoMap = useMemo(() => {
    if (activeDestination === 'new' || !currentScore) return undefined;
    return extractScoreTempoMap(currentScore);
  }, [activeDestination, currentScore]);

  const chosenMeter =
    TIME_SIGNATURES.find(entry => entry.id === timeSignatureId)?.meter ?? TIME_SIGNATURES[0].meter;

  const importOptions = useMemo<DiGuitarImportOptions | null>(() => {
    if (!bpmValid || !offsetValid || targetIsPercussion) return null;
    return {
      ...defaultDiGuitarImportOptions,
      quantization,
      tuplets,
      voices,
      bpm: activeDestination === 'new' ? parsedBpm : (targetTempoMap?.[0]?.bpm ?? 120),
      timeSignature: chosenMeter,
      offsetMs: parsedOffsetMs,
      tuning: effectiveTuning,
      capo: effectiveCapo,
      transpositionPitch: effectiveTransposition,
      maxFret,
      position,
      detectPalmMutes: allowStringTechniques && detectPalmMutes,
      allowStringTechniques,
      ...(targetBars ? { targetBars } : {}),
      ...(targetTempoMap ? { targetTempoMap } : {}),
      trackName: analysis ? analysis.fileName.replace(/\.[^.]*$/, '') : undefined,
    };
  }, [
    bpmValid,
    offsetValid,
    targetIsPercussion,
    quantization,
    tuplets,
    voices,
    activeDestination,
    parsedBpm,
    targetTempoMap,
    chosenMeter,
    parsedOffsetMs,
    effectiveTuning,
    effectiveCapo,
    effectiveTransposition,
    maxFret,
    position,
    allowStringTechniques,
    detectPalmMutes,
    targetBars,
    analysis,
  ]);

  const settledOptions = useDeferredValue(importOptions);
  const settledNotes = useDeferredValue(rawNotes);

  const result = useMemo<{ value: DiGuitarImport } | { error: string } | null>(() => {
    if (!analysis || !settledNotes || !settledOptions || decoding) return null;
    try {
      const title = analysis.fileName.replace(/\.[^.]*$/, '');
      return { value: importDiGuitarNotes(settledNotes, settledOptions, title) };
    } catch (error) {
      return { error: message(error) };
    }
  }, [analysis, settledNotes, settledOptions, decoding]);

  const imported =
    !decoding &&
    settledOptions === importOptions &&
    settledNotes === rawNotes &&
    result &&
    'value' in result
      ? result.value
      : null;

  const validationError = !bpmValid
    ? t('di_import.invalid_bpm')
    : !offsetValid
      ? t('di_import.invalid_offset')
      : targetIsPercussion
        ? t('di_import.replace_percussion_error')
        : null;

  const problem =
    importProblem ??
    fileProblem ??
    validationError ??
    (result && 'error' in result ? result.error : null);

  const controlsLocked = analyzing || importing;

  const pickAndAnalyzeFile = () => {
    if (controlsLocked) return;
    setImportProblem(null);
    setFileProblem(null);
    setAnalyzing(true);
    void transcriber
      .pickAndAnalyze()
      .then(summary => {
        if (!summary) return;
        setAnalysis(summary);
        setBpmInput(String(Math.round(summary.estimatedBpm)));
      })
      .catch(reason => {
        const { key, detail } = diProblem(reason);
        setAnalysis(null);
        setRawNotes(null);
        setFileProblem(t(key, { detail }));
      })
      .finally(() => {
        setAnalyzing(false);
      });
  };

  const selectDestination = (next: DiImportDestination) => {
    setImportProblem(null);
    setDestination(next);
    if (next === 'replace' && currentScore?.tracks.length) {
      if (currentScore.tracks[effectiveTargetTrack]?.isPercussion) {
        const firstMelodic = currentScore.tracks.findIndex(track => !track.isPercussion);
        if (firstMelodic >= 0) setTargetTrack(firstMelodic);
      }
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

  const submit = async () => {
    if (!imported || !analysis || busy || importing || analyzing || decoding || problem) return;
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
      if (await onImport(diImportFileName(analysis.fileName), bytes)) onClose();
      else setImportProblem(t('midi_import.not_opened'));
    } catch (error) {
      setImportProblem(t('midi_import.open_failed', { error: message(error) }));
    } finally {
      setImporting(false);
    }
  };

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
    !imported ||
    analyzing ||
    decoding ||
    !!problem ||
    (activeDestination !== 'new' && locked);

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
        {...busyGuard({ busy: controlsLocked, className: 'tp-button', onClick: onClose })}
      >
        {t('dialog.cancel')}
      </button>
    </>
  );

  const fileLabel = analyzing
    ? t('di_import.analyzing')
    : analysis
      ? t('di_import.file_info', {
          name: analysis.fileName,
          seconds: analysis.durationSec.toFixed(1),
          rate: Math.round(analysis.sampleRate / 100) / 10,
        })
      : t('midi_import.no_file');

  const summaryText = imported
    ? t('di_import.summary', {
        notes: t(
          imported.summary.notesCount === 1
            ? 'midi_import.part_notes_one'
            : 'midi_import.part_notes_other',
          { count: imported.summary.notesCount },
        ),
        muted: imported.summary.palmMutedCount,
        measures: t(
          imported.summary.measures === 1
            ? 'midi_import.summary_measures_one'
            : 'midi_import.summary_measures_other',
          { count: imported.summary.measures },
        ),
        tempo: imported.summary.tempo,
      })
    : '';

  return (
    <Dialog
      title={t('di_import.title')}
      onClose={onClose}
      ariaDescribedBy={hint}
      busy={controlsLocked}
      closeDisabled={controlsLocked}
      dismissOnBackdrop
      className="ascii-import di-import"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
      actions={actions}
    >
      <div className="ascii-import-form">
        <p id={hint} className="muted">
          {t('di_import.hint')}
        </p>

        <div className="di-file">
          <button
            type="button"
            data-autofocus
            {...busyGuard({ busy: controlsLocked, onClick: pickAndAnalyzeFile })}
          >
            {t('di_import.choose_file')}
          </button>
          <span>{fileLabel}</span>
        </div>

        {canImportIntoScore && (
          <div className="di-destination">
            <div className="tp-field">
              <span className="tp-field-label" aria-hidden="true">
                {t('midi_import.destination')}
              </span>
              <Segmented
                label={t('midi_import.destination')}
                disabled={controlsLocked}
                value={activeDestination}
                options={destinationOptions}
                onChange={selectDestination}
              />
            </div>
            {locked && <p className="muted">{t('midi_import.locked_note')}</p>}
            {activeDestination === 'replace' && currentScore && (
              <div className="di-replace-targets">
                <label>
                  {t('midi_import.target_track')}
                  <select
                    value={String(effectiveTargetTrack)}
                    {...busySelect(controlsLocked)}
                    onChange={event => {
                      if (controlsLocked) return;
                      setImportProblem(null);
                      setTargetTrack(Number(event.target.value));
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
              </div>
            )}
            {activeDestination !== 'new' && (
              <p className="muted">{t('di_import.follows_score')}</p>
            )}
          </div>
        )}

        <fieldset className="di-options">
          <div className="di-tuning-row di-full-row">
            <label>
              {t('di_import.tuning')}
              <div className="di-inline-input">
                <select
                  value={
                    targetIsStringed
                      ? '__target__'
                      : matchedPreset?.id ?? '__custom__'
                  }
                  {...busySelect(controlsLocked || targetIsStringed)}
                  onChange={event => {
                    if (controlsLocked || targetIsStringed) return;
                    const picked = tuningPresets.find(p => p.id === event.target.value);
                    if (!picked) return;
                    setImportProblem(null);
                    setTuningPitches([...picked.tuning]);
                    setTuningName(picked.name);
                  }}
                >
                  {targetIsStringed && (
                    <option value="__target__">
                      {t('di_import.target_track_tuning', {
                        name: targetTrackObj?.name ?? '',
                        strings: effectiveTuning.length,
                      })}
                    </option>
                  )}
                  {!targetIsStringed && !matchedPreset && (
                    <option value="__custom__">
                      {tuningName.trim()
                        ? t('di_import.custom_tuning_named', {
                            name: tuningName.trim(),
                            notes: formatTuning(tuningPitches),
                          })
                        : t('di_import.custom_tuning_option', {
                            notes: formatTuning(tuningPitches),
                          })}
                    </option>
                  )}
                  {tuningGroups.map(group => (
                    <optgroup key={group.key} label={group.title}>
                      {group.items.map(preset => (
                        <option key={preset.id} value={preset.id}>
                          {tuningPresetName(preset, lang)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  {...busyGuard({
                    busy: controlsLocked || targetIsStringed,
                    className: 'tp-button',
                    onClick: () => setTuningDialogOpen(true),
                  })}
                >
                  {t('di_import.custom_tuning_btn')}
                </button>
              </div>
            </label>
          </div>

          <div className="di-timing-row di-full-row">
            {activeDestination === 'new' && (
              <>
                <label>
                  {t('di_import.bpm')}
                  <div className="di-inline-input">
                    <input
                      type="number"
                      min={20}
                      max={350}
                      step={1}
                      value={bpmInput}
                      aria-disabled={controlsLocked || undefined}
                      onChange={event => {
                        if (controlsLocked) return;
                        setImportProblem(null);
                        setBpmInput(event.target.value);
                      }}
                    />
                    {analysis && (
                      <button
                        type="button"
                        {...busyGuard({
                          busy: controlsLocked,
                          className: 'tp-button',
                          onClick: () => {
                            setImportProblem(null);
                            setBpmInput(String(Math.round(analysis.estimatedBpm)));
                          },
                        })}
                      >
                        {t('di_import.use_detected_bpm', {
                          bpm: Math.round(analysis.estimatedBpm),
                        })}
                      </button>
                    )}
                  </div>
                </label>
                <label>
                  {t('di_import.time_signature')}
                  <select
                    value={timeSignatureId}
                    {...busySelect(controlsLocked)}
                    onChange={event => {
                      if (controlsLocked) return;
                      setImportProblem(null);
                      setTimeSignatureId(event.target.value);
                    }}
                  >
                    {TIME_SIGNATURES.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <label>
              {t('di_import.offset_ms')}
              <div className="di-inline-input">
                <input
                  type="number"
                  min={-600000}
                  max={600000}
                  step={10}
                  value={offsetMsInput}
                  aria-disabled={controlsLocked || undefined}
                  onChange={event => {
                    if (controlsLocked) return;
                    setImportProblem(null);
                    setOffsetMsInput(event.target.value);
                  }}
                />
                {rawNotes && rawNotes.length > 0 && (
                  <button
                    type="button"
                    {...busyGuard({
                      busy: controlsLocked,
                      className: 'tp-button',
                      onClick: () => {
                        setImportProblem(null);
                        setOffsetMsInput(String(Math.round(-rawNotes[0].startSec * 1000)));
                      },
                    })}
                  >
                    {t('di_import.align_first_note')}
                  </button>
                )}
              </div>
            </label>
          </div>

          <div className="tp-field di-full-row">
            <span className="tp-field-label" aria-hidden="true">
              {t('midi_import.quantization')}
            </span>
            <Segmented
              label={t('midi_import.quantization')}
              disabled={controlsLocked}
              value={String(quantization)}
              options={quantizationOptions}
              onChange={val => {
                setImportProblem(null);
                const nextQ = Number(val) as DiGuitarQuantization;
                setQuantization(nextQ);
                if (nextQ < 16 && tuplets === 'triplets-quintuplets') setTuplets('triplets');
              }}
            />
          </div>

          <label>
            {t('midi_import.tuplets')}
            <select
              value={tuplets}
              {...busySelect(controlsLocked)}
              onChange={event => {
                if (!controlsLocked) {
                  setImportProblem(null);
                  setTuplets(event.target.value as DiTupletMode);
                }
              }}
            >
              {tupletModes.map(([value, label]) => (
                <option
                  key={value}
                  value={value}
                  disabled={value === 'triplets-quintuplets' && quantization < 16}
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
              disabled={controlsLocked}
              value={String(voices)}
              options={voiceOptions}
              onChange={val => {
                setImportProblem(null);
                setVoices(Number(val) as 1 | 2);
              }}
            />
          </div>

          <div className="tp-field di-full-row">
            <span className="tp-field-label" aria-hidden="true">
              {t('di_import.sensitivity')}
            </span>
            <Segmented
              label={t('di_import.sensitivity')}
              disabled={controlsLocked}
              value={sensitivity}
              options={sensitivityOptions}
              onChange={val => {
                setImportProblem(null);
                setSensitivity(val);
              }}
            />
          </div>
        </fieldset>

        <details className="di-finetune" data-escape-closes onKeyDown={stepOut}>
          <summary>{t('di_import.fine_tune')}</summary>
          <div className="di-finetune-body">
            <label>
              {t('di_import.position')}
              <select
                value={position}
                {...busySelect(controlsLocked)}
                onChange={event => {
                  if (!controlsLocked) {
                    setImportProblem(null);
                    setPosition(event.target.value as DiFretPosition);
                  }
                }}
              >
                {positionOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('di_import.max_fret')}
              <input
                type="number"
                min={12}
                max={24}
                step={1}
                value={maxFret}
                aria-disabled={controlsLocked || undefined}
                onChange={event => {
                  if (controlsLocked) return;
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 12 && next <= 24) {
                    setImportProblem(null);
                    setMaxFret(next);
                  }
                }}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={allowStringTechniques && detectPalmMutes}
                aria-disabled={controlsLocked || !allowStringTechniques || undefined}
                onChange={event => {
                  if (controlsLocked || !allowStringTechniques) return;
                  setImportProblem(null);
                  setDetectPalmMutes(event.target.checked);
                }}
              />
              {t('di_import.detect_palm_mutes')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={suppressOvertones}
                aria-disabled={controlsLocked || undefined}
                onChange={event => {
                  if (controlsLocked) return;
                  setImportProblem(null);
                  setSuppressOvertones(event.target.checked);
                }}
              />
              {t('di_import.suppress_overtones')}
            </label>
          </div>
        </details>

        <p id={status} role="status" className={problem ? 'error' : 'muted'}>
          {problem ??
            (analyzing
              ? t('di_import.analyzing')
              : decoding
                ? t('di_import.decoding')
                : importing
                  ? t(
                      activeDestination === 'new'
                        ? 'midi_import.opening'
                        : 'midi_import.importing_into_score',
                    )
                  : imported
                    ? summaryText
                    : t('midi_import.nothing_yet'))}
        </p>

        {imported && !problem && imported.summary.notes.length > 0 && (
          <p className="muted">
            {imported.summary.notes.map(item => formatDiImportNote(item, t)).join(' ')}
          </p>
        )}
      </div>
      {tuningDialogOpen && !targetIsStringed && (
        <TuningDialog
          mode="draft"
          pitches={tuningPitches}
          name={matchedPreset ? tuningPresetName(matchedPreset, lang) : tuningName}
          onAudition={
            onAudition &&
            ((list, strum) =>
              onAudition({ program: isCustomBass ? 33 : 29 }, list, strum))
          }
          onApply={choice => {
            setImportProblem(null);
            setTuningPitches(choice.pitches);
            setTuningName(choice.name);
          }}
          onClose={() => setTuningDialogOpen(false)}
        />
      )}
    </Dialog>
  );
}
