import { useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { model } from '@coderline/alphatab';
import { defaultMix } from '../document-settings';
import type { ChannelMix, DrumMapRef, EditCommand } from '../edit-types';
import { useI18n } from '../i18n';
import { Dialog, BusyFieldset, busyGuard, busySelect } from '../ui';
import { drumMapPresets, withDrumMap } from '../audio/drum-map';
import { drumMapFiles, fileProblem, mapFromImport } from '../audio/drum-map-file';
import { localizedDrumSoundGroups } from '../audio/drum-map-groups';
import { collectTrackDrumSounds, presetRemapForTrack } from './drum-remap';
import './drum-remap-dialog.css';

export interface DrumRemapDialogProps {
  score: model.Score;
  trackIndex: number;
  trackId?: string;
  mix?: ChannelMix;
  busy?: boolean;
  locked?: boolean;
  onEdit: (command: EditCommand) => void | Promise<unknown>;
  onClose: () => void;
  onImportDrumMap?: () => ReturnType<typeof drumMapFiles.import>;
}

const KEEP_SOURCE_PRESET = '__keep__';
const FILE_PRESET = '__file__';

export function DrumRemapDialog({
  score,
  trackIndex,
  trackId,
  mix,
  busy = false,
  locked = false,
  onEdit,
  onClose,
  onImportDrumMap,
}: DrumRemapDialogProps) {
  const { t } = useI18n();
  const track = score.tracks[trackIndex];
  const sounds = useMemo(() => (track ? collectTrackDrumSounds(track) : []), [track]);
  const groups = useMemo(() => localizedDrumSoundGroups(t), [t]);
  const allRows = useMemo(() => groups.flatMap(g => g.rows), [groups]);
  const labelByStandardId = useMemo(() => new Map(allRows.map(r => [r.id, r.sound])), [allRows]);

  const presets = drumMapPresets();
  const currentMap = mix?.drumMap;
  const currentPreset = currentMap?.preset ?? 'gm';
  const initialPreset = trackId ? currentPreset : KEEP_SOURCE_PRESET;
  const [sourcePreset, setSourcePreset] = useState<string>(initialPreset);
  const [loadedMap, setLoadedMap] = useState<{ name: string; map: DrumMapRef | undefined } | null>(null);
  const [updateNotes, setUpdateNotes] = useState(false);
  const [mapError, setMapError] = useState('');
  const loadingMap = useRef(false);
  const [overrides, setOverrides] = useState<Map<number, number | null>>(() => new Map());

  const sourceId = useId();
  const readOnly = busy || locked;
  const knownPreset = presets.some(p => p.id === currentPreset);

  const mapRefFor = (choice: string, fileMap?: DrumMapRef | undefined): DrumMapRef | undefined => {
    if (choice === KEEP_SOURCE_PRESET) return currentMap;
    if (choice === FILE_PRESET) return fileMap;
    if (choice === currentPreset && !fileMap) return currentMap;
    return choice === 'gm' ? undefined : { preset: choice };
  };

  const targetMap = mapRefFor(sourcePreset, loadedMap?.map);
  const currentMix = mix ?? defaultMix();
  const nextMix = trackId ? withDrumMap(currentMix, targetMap) : currentMix;
  const mapChanged = Boolean(trackId && nextMix !== currentMix);

  const currentPieceName = (sourceIdVal: number, standardId: number | null, customLabel?: string) => {
    if (standardId !== null && labelByStandardId.has(standardId)) {
      return labelByStandardId.get(standardId)!;
    }
    return customLabel ? `${customLabel} (#${sourceIdVal})` : `Articulation #${sourceIdVal}`;
  };

  const presetLabel = (id: string) => {
    if (id === 'gm') return t('drum_map.preset_gm');
    const entry = presets.find(p => p.id === id);
    const name = entry?.name ?? id;
    return entry?.state === 'unverified' ? t('drum_map.preset_unchecked', { name }) : name;
  };

  const recomputePresetOverrides = (
    choice: string,
    shouldUpdateNotes: boolean,
    fileMap?: DrumMapRef | undefined,
  ) => {
    if (!shouldUpdateNotes || choice === KEEP_SOURCE_PRESET || (trackId && choice === currentPreset && choice !== FILE_PRESET)) {
      setOverrides(new Map());
      return;
    }
    const mapRef = mapRefFor(choice, fileMap);
    setOverrides(presetRemapForTrack(sounds, mapRef, trackId ? currentMap : undefined));
  };

  const applyPresetSelection = (choice: string, fileMap?: DrumMapRef | undefined) => {
    setSourcePreset(choice);
    setMapError('');
    recomputePresetOverrides(choice, updateNotes, fileMap);
  };

  const handleLoadFile = () => {
    if (loadingMap.current || readOnly) return;
    loadingMap.current = true;
    setMapError('');
    void (onImportDrumMap ? onImportDrumMap() : drumMapFiles.import())
      .then(result => {
        if (!result) return;
        const map = mapFromImport(result);
        const name = result.name.trim() || t('drum_map.preset_gm');
        setLoadedMap({ name, map });
        applyPresetSelection(FILE_PRESET, map);
      })
      .catch(reason => {
        const { key, detail } = fileProblem(reason);
        setMapError(t('drum_map.import_failed', { error: t(key, { detail }) }));
      })
      .finally(() => {
        loadingMap.current = false;
      });
  };

  const mapEntries = useMemo<[number, number | null][]>(
    () =>
      [...overrides.entries()]
        .filter(([from, to]) => {
          const sound = sounds.find(s => s.sourceId === from);
          if (!sound) return false;
          return to !== (sound.standardId ?? sound.sourceId);
        })
        .sort((a, b) => a[0] - b[0]),
    [overrides, sounds],
  );

  const affectedHits = useMemo(
    () => mapEntries.reduce((sum, [from]) => sum + (sounds.find(s => s.sourceId === from)?.count ?? 0), 0),
    [mapEntries, sounds],
  );

  const handleApply = async () => {
    if (readOnly || (!mapChanged && mapEntries.length === 0)) return;
    if (mapChanged && trackId) {
      await Promise.resolve(onEdit({ type: 'setTrackMix', trackId, mix: nextMix }));
    }
    if (mapEntries.length > 0) {
      await Promise.resolve(onEdit({ type: 'remapPercussion', track: trackIndex, map: mapEntries }));
    }
    onClose();
  };

  return createPortal(
    <Dialog
      title={t('drum_remap.title')}
      className="drum-remap-dialog"
      onClose={onClose}
      dismissOnBackdrop
      busy={busy}
      actions={
        <>
          <button type="button" onClick={onClose}>{t('drum_remap.cancel')}</button>
          <button
            type="button"
            data-autofocus
            {...busyGuard({ busy, disabled: readOnly || (!mapChanged && mapEntries.length === 0), className: 'primary', onClick: () => void handleApply() })}
          >
            {t('drum_remap.apply')}
          </button>
        </>
      }
    >
      <BusyFieldset busy={busy} disabled={locked} className="drum-remap-body">
        <p className="muted drum-remap-help">{t('drum_remap.help')}</p>

        <div className="drum-remap-source-bar">
          <div className="drum-remap-source-field">
            <label htmlFor={sourceId}>{t('drum_remap.source_map')}</label>
            <select
              id={sourceId}
              {...busySelect(readOnly)}
              value={sourcePreset}
              onChange={e => applyPresetSelection(e.target.value, loadedMap?.map)}
            >
              {!trackId && <option value={KEEP_SOURCE_PRESET}>{t('drum_remap.source_map_keep')}</option>}
              <option value="gm">{t('drum_map.preset_gm')}</option>
              {presets.some(p => p.id !== 'gm') && (
                <optgroup label={t('drum_map.presets_group')}>
                  {presets.filter(p => p.id !== 'gm').map(p => (
                    <option key={p.id} value={p.id}>{presetLabel(p.id)}</option>
                  ))}
                </optgroup>
              )}
              {trackId && !knownPreset && (
                <option value={currentPreset}>{t('drum_map.preset_unknown', { id: currentPreset })}</option>
              )}
              {loadedMap && (
                <option value={FILE_PRESET}>{t('drum_remap.file_option', { name: loadedMap.name })}</option>
              )}
            </select>
          </div>
          <div className="drum-remap-source-actions">
            <button type="button" disabled={readOnly} onClick={handleLoadFile}>
              {t('drum_remap.load_file')}
            </button>
            <button
              type="button"
              disabled={readOnly || (!mapChanged && mapEntries.length === 0 && !updateNotes && sourcePreset === initialPreset)}
              onClick={() => {
                setSourcePreset(initialPreset);
                setLoadedMap(null);
                setUpdateNotes(false);
                setOverrides(new Map());
                setMapError('');
              }}
            >
              {t('drum_remap.reset_all')}
            </button>
          </div>
        </div>

        <div className="drum-remap-toggle">
          <label className="drum-remap-check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={updateNotes}
              onChange={e => {
                const checked = e.target.checked;
                setUpdateNotes(checked);
                recomputePresetOverrides(sourcePreset, checked, loadedMap?.map);
              }}
            />
            <span>{t('drum_remap.update_notes')}</span>
          </label>
          <p className="muted drum-remap-toggle-hint">{t('drum_remap.update_notes_hint')}</p>
        </div>

        {mapError && <p role="alert" className="drum-remap-error">{mapError}</p>}

        {sounds.length === 0 ? (
          <p className="muted drum-remap-empty">{t('drum_remap.empty')}</p>
        ) : (
          <div className="drum-remap-table-wrap">
            <div className="drum-remap-head" aria-hidden="true">
              <span>{t('drum_remap.current_piece')}</span>
              <span>{t('drum_remap.target_piece')}</span>
            </div>
            <ul className="drum-remap-list">
              {sounds.map(sound => {
                const currentName = currentPieceName(sound.sourceId, sound.standardId, sound.customLabel);
                const effectiveDefault = sound.standardId ?? sound.sourceId;
                const overridden = overrides.has(sound.sourceId) ? overrides.get(sound.sourceId)! : effectiveDefault;
                const changed = overridden !== effectiveDefault;
                const selectVal = !changed ? '__keep__' : overridden === null ? '__remove__' : String(overridden);
                const hitsText = t(sound.count === 1 ? 'drum_remap.hits_one' : 'drum_remap.hits_other', {
                  key: sound.midiKey,
                  count: sound.count,
                });
                return (
                  <li key={sound.sourceId} className="drum-remap-row" data-changed={changed || undefined}>
                    <div className="drum-remap-piece">
                      <span className="drum-remap-piece-name">{currentName}</span>
                      <span className="muted drum-remap-piece-meta">{hitsText}</span>
                    </div>
                    <div className="drum-remap-target">
                      <select
                        aria-label={`${currentName} — ${t('drum_remap.target_piece')}`}
                        {...busySelect(readOnly)}
                        value={selectVal}
                        onChange={e => {
                          const val = e.target.value;
                          setOverrides(prev => {
                            const next = new Map(prev);
                            if (val === '__keep__') next.delete(sound.sourceId);
                            else if (val === '__remove__') next.set(sound.sourceId, null);
                            else next.set(sound.sourceId, Number(val));
                            return next;
                          });
                        }}
                      >
                        <option value="__keep__">{t('drum_remap.keep_current', { name: currentName })}</option>
                        <option value="__remove__">{t('drum_remap.remove_hits')}</option>
                        {groups.map(group => (
                          <optgroup key={group.id} label={group.label}>
                            {group.rows.map(item => (
                              <option key={item.id} value={String(item.id)}>{item.sound}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {changed && (
                        <button
                          type="button"
                          className="drum-remap-row-reset"
                          disabled={readOnly}
                          onClick={() => {
                            setOverrides(prev => {
                              const next = new Map(prev);
                              next.delete(sound.sourceId);
                              return next;
                            });
                          }}
                        >
                          {t('drum_remap.reset_row')}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p role="status" className="muted drum-remap-status">
          {mapChanged && mapEntries.length > 0
            ? t('drum_remap.map_and_notes_summary', { pieces: mapEntries.length, hits: affectedHits })
            : mapChanged
              ? t('drum_remap.map_only_summary')
              : mapEntries.length > 0
                ? t('drum_remap.changed_summary', { pieces: mapEntries.length, hits: affectedHits })
                : t('drum_remap.no_changes')}
        </p>
      </BusyFieldset>
    </Dialog>,
    document.body,
  );
}
