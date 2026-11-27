import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import { defaultMix } from '../document-settings';
import type { ChannelMix, DrumMapRef, EditCommand } from '../edit-types';
import { collectTrackDrumSounds, presetRemapForTrack } from '../editor/drum-remap';
import { catalogs, useI18n, type MessageKey } from '../i18n';
import { BusyFieldset, CommitField, Segmented, busyGuard, busySelect } from '../ui';
import maps from './drum-maps.json';
import { SILENT, drumMapPresets, resolveDrumMap, withDrumMap } from './drum-map';
import { drumMapFiles, exportedName, fileProblem, mapFromImport } from './drum-map-file';
import { localizedDrumSoundGroups, type DrumSoundRow as Row } from './drum-map-groups';
import { noteName } from './tuner';
const SOUND_COUNT = maps.sounds.length;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What a key field holds as text: the key, or nothing for no sound. */
const keyText = (key: number | null) => key === null ? '' : String(key);
/** Text to a key: empty is no sound, 0-127 is a key, anything else is not a key at all (undefined). */
const parseKey = (text: string): number | null | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const key = Number(trimmed);
  return key <= 127 ? key : undefined;
};

export interface DrumMapPanelProps {
  trackId: string;
  mix?: ChannelMix;
  /** The standard sounds the track's notes play, as `usedDrumSounds` gives them. */
  used: readonly number[];
  /** Optional track model + index so switching the layout can also rewrite the score's drum notes when toggled on. */
  track?: model.Track;
  trackIndex?: number;
  busy?: boolean;
  onEdit: (edit: EditCommand) => void | Promise<void>;
}

/**
 * The drum map of one drum track: which key each standard drum sound is sent as to the track's plug-in instrument and its MIDI output.
 * It shows the layout and what the track changes from it, and edits the changes row by row. Every change is one `setTrackMix` that
 * carries the mix as it was with only `drumMap` different, so nothing else in the mix moves.
 */
export function DrumMapPanel({ trackId, mix, used, track, trackIndex, busy = false, onEdit }: DrumMapPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const ids = useId(), selectId = `${ids}-layout`, usedId = `${ids}-used`, resetId = `${ids}-reset`;
  const [view, setView] = useState<'track' | 'all'>('track');
  const [updateNotes, setUpdateNotes] = useState(false);
  const [error, setError] = useState('');
  /** Why the last import or export did not happen, in words; empty while there is nothing to say. A cancelled dialog is not a reason. */
  const [fileError, setFileError] = useState('');
  const transferring = useRef(false), commitNow = useRef<(next: DrumMapRef | undefined) => Promise<boolean> | false>(() => false);
  /** The layout whose choice cleared changed keys, so the status can say Undo brings them back for as long as that layout is the one shown. */
  const [cleared, setCleared] = useState<string | null>(null);
  const map = mix?.drumMap, presetId = map?.preset ?? 'gm';
  const presets = drumMapPresets(), preset = presets.find(entry => entry.id === presetId), known = preset !== undefined;
  const tables = resolveDrumMap(map, true), base = resolveDrumMap({ preset: presetId }, true);
  const keyOf = (id: number): number | null => tables.byId[id] < 128 ? tables.byId[id] : null;
  const changed = new Set(maps.sounds.map(([id]) => id).filter(id => tables.byId[id] !== base.byId[id]));
  /** The sound and piece names in the shown language; an id the catalogue of translations does not know keeps its English name. Display only: a map file holds ids. */
  const say = (key: string, fallback: string): string => t(key as MessageKey) || fallback;
  /** A layout's paragraph about where its numbers come from, in the shown language: found by its English text, so no layout id names a message. */
  const sourceText = (english: string): string => {
    const key = Object.keys(catalogs.en).find(name => name.startsWith('drum_map.source_text_') && (catalogs.en as Record<string, string>)[name] === english);
    return key ? say(key, english) : english;
  };
  const everything = localizedDrumSoundGroups(t);
  const usedSet = new Set(used);
  const silent = used.filter(id => tables.byId[id] === SILENT).length;
  const shown = view === 'track' ? everything.map(group => ({ ...group, rows: group.rows.filter(row => usedSet.has(row.id)) })).filter(group => group.rows.length) : everything;
  const label = (id: string): string => {
    const entry = presets.find(item => item.id === id);
    if (id === 'gm') return t('drum_map.preset_gm');
    const name = entry?.name ?? id;
    return entry?.state === 'unverified' ? t('drum_map.preset_unchecked', { name }) : name;
  };
  const source = !known ? '' : presetId === 'gm' ? t('drum_map.source_gm') : sourceText(preset.source ?? '');
  const unverified = known && presetId !== 'gm' && preset.state === 'unverified';
  // An unchecked layout gets one short line; the paragraph the data carries about where its numbers come from sits in a disclosure.
  const status = !known ? t('drum_map.status_unknown')
    : unverified ? t('drum_map.status_unverified')
    : preset.checked ? t('drum_map.status_checked', { source, date: typeof preset.checked === 'string' ? preset.checked : preset.checked.date }).trim() : source;

  /** Stores `next` as the track's map as one edit; the current map, or a refusal while busy, records nothing. */
  const commit = (next: DrumMapRef | undefined): Promise<boolean> | false => {
    const current = mix ?? defaultMix(), nextMix = withDrumMap(current, next);
    if (busy || nextMix === current) return false;
    setError('');
    setFileError('');
    return Promise.resolve(onEdit({ type: 'setTrackMix', trackId, mix: nextMix })).then(() => true, reason => { setError(message(reason)); return false; });
  };
  commitNow.current = commit;
  /** One import or export at a time. Whatever the dialog gave is applied to the track as it is when the dialog closes, not as it was when it opened. */
  const transfer = (failed: 'drum_map.import_failed' | 'drum_map.export_failed', run: () => Promise<void>) => {
    if (transferring.current) return;
    transferring.current = true;
    setFileError('');
    void run().catch(reason => {
      const { key, detail } = fileProblem(reason);
      setFileError(t(failed, { error: t(key, { detail }) }));
    }).finally(() => { transferring.current = false; });
  };
  const applyLayoutChange = async (nextMap: DrumMapRef | undefined): Promise<boolean> => {
    const previousMap = map;
    const landed = await Promise.resolve(commitNow.current(nextMap));
    if (landed && updateNotes && track && trackIndex !== undefined) {
      const sounds = collectTrackDrumSounds(track);
      const entries = [...presetRemapForTrack(sounds, nextMap, previousMap).entries()].sort((a, b) => a[0] - b[0]);
      if (entries.length > 0) {
        await Promise.resolve(onEdit({ type: 'remapPercussion', track: trackIndex, map: entries })).catch(reason => {
          setError(message(reason));
        });
      }
    }
    return landed;
  };
  const importFile = () => transfer('drum_map.import_failed', async () => {
    const imported = await drumMapFiles.import();
    if (imported) await applyLayoutChange(mapFromImport(imported));
  });
  const exportFile = () => transfer('drum_map.export_failed', async () => {
    await drumMapFiles.export(map, exportedName(presetId, preset?.name));
  });
  const withRow = (id: number, key: number | null | 'reset'): DrumMapRef => {
    const rows = new Map(map?.keys ?? []);
    if (key === 'reset') rows.delete(id); else rows.set(id, key);
    return { preset: presetId, keys: [...rows] };
  };
  const stepOut = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
  };
  const count = changed.size;
  const summary = [count ? t(`drum_map.changed_${count === 1 ? 'one' : 'other'}` as MessageKey, { count }) : '', silent ? t(`drum_map.missing_${silent === 1 ? 'one' : 'other'}` as MessageKey, { count: silent }) : ''].filter(Boolean).join(' ');
  const candidates = new Map((preset?.candidates ?? []).map(([id, keys]) => [id, keys]));

  /** `flat` names the sound by its piece and its hit on the row itself, because no group heading above it says the piece. */
  const row = (item: Row, flat: boolean) => {
    const key = keyOf(item.id), isChanged = changed.has(item.id), states = [isChanged ? t('drum_map.sr_changed') : '', key === null ? t('drum_map.sr_none') : ''].filter(Boolean);
    const named = states.length ? t('drum_map.key_of_state', { sound: item.sound, state: states.join(', ') }) : t('drum_map.key_of', { sound: item.sound });
    const same = key !== null && item.id !== item.plain && key === keyOf(item.plain) ? everything.flatMap(group => group.rows).find(other => other.id === item.plain) : undefined;
    return <li key={item.id} className="drum-map-row" data-changed={isChanged || undefined}>
      <span className="drum-map-sound"><span>{flat && item.piece ? `${item.piece} · ${item.name}` : item.name}</span>{same && <span className="muted drum-map-same">{t('drum_map.same_key', { sound: same.sound })}</span>}</span>
      <CommitField hideLabel label={named} value={keyText(key)} target={trackId} busy={busy} onCommit={text => {
        const parsed = parseKey(text);
        return parsed === undefined ? false : commit(withRow(item.id, parsed));
      }} />
      <span className="drum-map-note">{key === null ? <span className="muted">{t('drum_map.no_sound')}</span> : <span className="drum-map-notename">{noteName(key)}</span>}</span>
      <span className="drum-map-state">{isChanged && <><span className="drum-map-changed">{t('drum_map.changed')}</span>
        <button type="button" aria-label={t('drum_map.reset_row_named', { sound: item.sound })} {...busyGuard({ busy, onClick: event => {
          // The button goes with the marker, so focus moves to the row's key first and stays in the row.
          event.currentTarget.closest('li')?.querySelector('input')?.focus();
          void commit(withRow(item.id, 'reset'));
        } })}>{t('drum_map.reset_row')}</button></>}</span>
      {candidates.get(item.id) && <span className="drum-map-candidates" role="group" aria-label={t('drum_map.candidates_named', { sound: item.sound })}><span className="muted drum-map-try">{t('drum_map.try_keys')}</span>{candidates.get(item.id)!.map(candidate =>
        <button key={candidate} type="button" aria-pressed={key === candidate} aria-label={t('drum_map.use_key', { sound: item.sound, key: candidate })} {...busyGuard({ busy, onClick: () => { void commit(withRow(item.id, candidate)); } })}>{candidate}</button>)}</span>}
    </li>;
  };

  const flat = view === 'track' ? shown.flatMap(group => group.rows) : [];
  return <section className="drum-map" aria-label={t('drum_map.title')}>
    <div className="drum-map-preset">
      <label htmlFor={selectId}>{t('drum_map.title')}</label>
      <p id={usedId} className="muted">{t('drum_map.used_by')}</p>
      <select id={selectId} aria-describedby={usedId} value={presetId} {...busySelect(busy)} onChange={event => {
        const chosen = event.target.value;
        if (busy || chosen === presetId) return;
        const lost = count > 0;
        void applyLayoutChange({ preset: chosen }).then(landed => { if (landed) setCleared(lost ? chosen : null); });
      }}>
        <option value="gm">{label('gm')}</option>
        {presets.some(entry => entry.id !== 'gm') && <optgroup label={t('drum_map.presets_group')}>{presets.filter(entry => entry.id !== 'gm').map(entry => <option key={entry.id} value={entry.id}>{label(entry.id)}</option>)}</optgroup>}
        {!known && <option value={presetId}>{t('drum_map.preset_unknown', { id: presetId })}</option>}
      </select>
      {track && trackIndex !== undefined && (
        <label className="check drum-map-remap-toggle">
          <input type="checkbox" disabled={busy} checked={updateNotes} onChange={event => setUpdateNotes(event.target.checked)} />
          <span>{t('drum_map.update_notes')}</span>
        </label>
      )}
    </div>
    <p className="muted">{status}</p>
    {unverified && preset.source && <details className="drum-map-source"><summary>{t('drum_map.source_title')}</summary><p className="muted">{source}</p></details>}
    <details className="drum-map-keys" data-escape-closes onKeyDown={stepOut}><summary>{t('drum_map.keys')}</summary>
      <Segmented label={t('drum_map.view')} value={view} disabled={busy} onChange={setView} options={[
        { value: 'track', label: t('drum_map.view_track', { count: used.length }) },
        { value: 'all', label: t('drum_map.view_all', { count: SOUND_COUNT }) },
      ]} />
      <p className="muted">{t('drum_map.key_hint')}</p>
      {shown.length === 0 ? <p className="muted">{t('drum_map.track_empty')}</p> : <div className="drum-map-table">
        {view === 'track'
          ? <BusyFieldset busy={busy}><ul className="drum-map-list">{flat.map(item => row(item, true))}</ul></BusyFieldset>
          : shown.map(group => <details key={group.id} className="drum-map-group" open={group.kit || undefined}><summary>{group.id === 'other' ? t('drum_map.group_other') : group.label}</summary>
            <BusyFieldset busy={busy}><ul className="drum-map-list">{group.rows.map(item => row(item, false))}</ul></BusyFieldset>
          </details>)}
      </div>}
    </details>
    {/* What changed and the note that a layout choice cleared changes share one live line that holds no space while it is empty. */}
    <p className="muted drum-map-status" role="status">{[summary, cleared === presetId && count === 0 ? t('drum_map.cleared_note') : ''].filter(Boolean).join(' ')}</p>
    <div className="drum-map-footer">
      <button type="button" aria-describedby={count === 0 ? resetId : undefined} {...busyGuard({ busy, unavailable: count === 0, onClick: () => { void commit({ preset: presetId }); } })}>{t('drum_map.reset_all')}</button>
      {count === 0 && <span id={resetId} className="drum-map-sr">{t('drum_map.reset_all_none')}</span>}
      <span className="drum-map-files" role="group" aria-label={t('drum_map.files')}>
        <button type="button" {...busyGuard({ busy, onClick: importFile })}>{t('drum_map.import')}</button>
        <button type="button" {...busyGuard({ busy, onClick: exportFile })}>{t('drum_map.export')}</button>
      </span>
    </div>
    <p className="muted drum-map-disclaimer">{t('drum_map.disclaimer')}</p>
    {error && <p role="alert">{t('drum_map.change_failed', { error })}</p>}
    {fileError && <p role="alert">{fileError}</p>}
  </section>;
}
