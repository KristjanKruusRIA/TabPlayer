import { useEffect, useMemo, useRef, useState } from 'react';
import type { model } from '@coderline/alphatab';
import { createPortal } from 'react-dom';
import { formatPitch, formatTuning, parseTuning } from '../tuning';
import { instrumentTitle, tuningPresetName, tuningPresets, type PresetInstrument } from '../tuning-presets';
import type { StringCountKeep } from '../edit-types';
import { Dialog } from '../ui/Dialog';
import { busyGuard } from '../ui/useBusyGuard';
import { useI18n } from '../i18n';
import { PlayGlyph } from '../shell/glyphs';
import { SavedTuningsDialog } from './SavedTuningsDialog';
import { PartialCapoControls, type SettledDraft } from '../editor/PartialCapoControls';
import { BanjoDroneControls } from '../editor/BanjoDroneControls';
import { getPartialCapo, noPartialCapo, type PartialCapo } from '../editor/partial-capo';
import { getBanjoDrone } from '../editor/banjo-drone';
import './tuning-dialog.css';

export interface TuningChoice {
  pitches: number[];
  name: string;
  /** Move notes to new frets so they sound the same. Without it every fret number stays. */
  keepPitch: boolean;
  /** Which side stays in place when the string count changes. */
  keep: StringCountKeep;
  /** The capo section's values; only when the dialog was given a staff. `changed` is whether any of them differs from the staff's. */
  capo?: { capo: number; partialCapo: PartialCapo; droneFret: number; changed: boolean };
}

const instruments = [...new Set(tuningPresets.map(preset => preset.instrument))];
const countsOf = (instrument: PresetInstrument) => [...new Set(tuningPresets.filter(preset => preset.instrument === instrument).map(preset => preset.strings))].sort((a, b) => a - b);
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((pitch, index) => pitch === b[index]);

/** One string: its number, a note you can type or step (arrows, Page keys, wheel while focused, the two buttons), and a button that plays it. */
function StringRow({ index, pitch, revision, onPitch, onInvalid, onPlay, playable }: { index: number; pitch: number; /** Changes whenever the draft does, so a note typed wrongly is put back. */ revision: number; onPitch: (pitch: number) => void; onInvalid: (message: string | null) => void; onPlay?: () => void; playable: boolean }) {
  const { t } = useI18n();
  const note = formatPitch(pitch);
  const [text, setText] = useState(note);
  useEffect(() => setText(note), [note, revision]);
  const field = useRef<HTMLInputElement>(null);
  const n = index + 1;
  /** Only a different pitch is a change: stepping against a limit, or back to where it was, leaves the draft as it is. */
  const set = (next: number) => {
    const clamped = Math.max(0, Math.min(127, next));
    if (clamped !== pitch) onPitch(clamped);
  };
  const commit = () => {
    try {
      const next = parseTuning(text);
      if (next.length !== 1) throw new Error(t('tuning_dialog.one_note'));
      onInvalid(null);
      set(next[0]);
      setText(formatPitch(next[0]));
    } catch (cause) {
      onInvalid(t('tuning_dialog.row_invalid', { n, message: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const latest = useRef({ pitch, set });
  latest.current = { pitch, set };
  // Wheel over the focused field steps it. A native listener, because React's wheel handlers cannot cancel the page scroll.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    const listener = (event: WheelEvent) => {
      if (document.activeElement !== node || event.deltaY === 0) return;
      event.preventDefault();
      latest.current.set(latest.current.pitch + (event.deltaY < 0 ? 1 : -1));
    };
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, []);
  return <li className="tuning-string-row" style={{ '--string-weight': `${1 + index * 0.45}px` } as React.CSSProperties} aria-label={t('tuning_dialog.string_row', { n })}>
    <span className="tuning-string-number" aria-hidden="true">{n}</span>
    <span className="tuning-string-note">
      <input
        ref={field}
        value={text}
        aria-label={t('tuning_dialog.note_of', { n })}
        spellCheck={false}
        onChange={event => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); return; }
          const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : event.key === 'PageUp' ? 12 : event.key === 'PageDown' ? -12 : 0;
          if (!step) return;
          event.preventDefault();
          onInvalid(null);
          setText(note);
          set(pitch + (event.shiftKey && Math.abs(step) === 1 ? step * 12 : step));
        }}
      />
      <button type="button" tabIndex={-1} className="tuning-string-step" aria-label={t('tuning_dialog.step_down', { n })} title={t('tuning_dialog.step_down', { n })} aria-disabled={pitch <= 0 || undefined} onClick={() => { onInvalid(null); setText(note); set(pitch - 1); }}>{'\u2212'}</button>
      <button type="button" tabIndex={-1} className="tuning-string-step" aria-label={t('tuning_dialog.step_up', { n })} title={t('tuning_dialog.step_up', { n })} aria-disabled={pitch >= 127 || undefined} onClick={() => { onInvalid(null); setText(note); set(pitch + 1); }}>+</button>
    </span>
    <span className="tuning-string-line" aria-hidden="true" />
    {playable && <button type="button" className="tuning-string-play" aria-label={t('tuning_dialog.play_string', { n, note })} title={t('tuning_dialog.play_string', { n, note })} onClick={onPlay}><PlayGlyph /></button>}
  </li>;
}

/** The tuning editor. Mounted only while open, so Cancel and Escape discard every change; nothing is recorded until Keep fingering or Keep pitch. */
export function TuningDialog({ pitches, name, mode = 'track', staff, staffCount = 1, busy = false, locked = false, refusal = null, onApply, onClose, onAudition }: {
  pitches: readonly number[];
  name: string;
  /** `track` retunes a track that has notes (Keep fingering, Keep pitch, string count). `draft` fills in a tuning for something not made yet: one Use tuning button, any string count. */
  mode?: 'track' | 'draft';
  /** The staff whose capo, partial capo and banjo drone the Capo section edits with the tuning. Without it there is no Capo section. */
  staff?: model.Staff;
  /** How many staves the track has; a string count change applies to all of them, and the dialog says so before it is applied. */
  staffCount?: number;
  busy?: boolean;
  locked?: boolean;
  /** The app's reason for refusing the last edit. It is shown in the dialog, beside the draft it refused, once an apply comes back refused. */
  refusal?: string | null;
  /** May return the edit's promise: the dialog then stays open, draft intact, until it lands, and keeps the draft if the edit is refused. */
  onApply: (choice: TuningChoice) => unknown;
  onClose: () => void;
  onAudition?: (pitches: number[], strum: boolean) => void;
}) {
  const { lang, t } = useI18n();
  const [notes, setNotes] = useState(() => formatTuning(pitches));
  const [draftName, setDraftName] = useState(name);
  const [keep, setKeep] = useState<StringCountKeep>('high');
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ index: number; message: string } | null>(null);
  const [refused, setRefused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [library, setLibrary] = useState(false);
  const notesInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  // The Capo section: drafts like the notes, discarded with them. Nothing is recorded until an apply button.
  const savedPartial = staff ? getPartialCapo(staff) ?? noPartialCapo : noPartialCapo, savedDrone = staff ? getBanjoDrone(staff) : 0;
  const [capoText, setCapoText] = useState(String(staff?.capo ?? 0));
  const [partial, setPartial] = useState<PartialCapo>(savedPartial);
  const [drone, setDrone] = useState(savedDrone);
  const [partialInvalid, setPartialInvalid] = useState(false), [droneInvalid, setDroneInvalid] = useState(false);
  const capoNumber = capoText.trim() === '' ? NaN : Number(capoText), capoValid = Number.isInteger(capoNumber) && capoNumber >= 0 && capoNumber <= 127;
  /** The partial capo and drone fret fields settle when they are left; at an apply they are asked for what they hold now, so a fret typed but not left is not dropped. */
  const partialSettle = useRef<(() => SettledDraft<PartialCapo>) | null>(null), droneSettle = useRef<(() => SettledDraft<number>) | null>(null);
  const capoChoiceFor = (partialNow: PartialCapo, droneNow: number) => staff ? { capo: capoValid ? capoNumber : staff.capo, partialCapo: partialNow, droneFret: droneNow, changed: (capoValid && capoNumber !== staff.capo) || JSON.stringify(partialNow) !== JSON.stringify(savedPartial) || droneNow !== savedDrone } : undefined;
  const capoChoice = capoChoiceFor(partial, drone);

  const parsed = useMemo(() => { try { return parseTuning(notes); } catch { return null; } }, [notes]);
  const draft = parsed ?? [];
  const recount = mode === 'track' && !!parsed && parsed.length !== pitches.length;

  const matched = useMemo(() => {
    if (!parsed) return undefined;
    const exact = tuningPresets.filter(preset => same(preset.tuning, parsed));
    return exact.find(preset => preset.instrument === 'guitar' || preset.instrument === 'bass') ?? exact[0];
  }, [parsed]);
  const [instrument, setInstrument] = useState<PresetInstrument>(matched?.instrument ?? 'guitar');
  const [count, setCount] = useState(() => matched?.strings ?? (countsOf('guitar').includes(pitches.length) ? pitches.length : 6));
  const groupPresets = tuningPresets.filter(preset => preset.instrument === instrument && preset.strings === count);
  const selectedPreset = parsed ? groupPresets.find(preset => same(preset.tuning, parsed)) : undefined;

  /** Every change to the draft goes through here: the reasons shown for the old draft go, and the name is kept while the pitches are still the document's. */
  const changeDraft = (nextNotes: string, nextName?: string) => {
    let chosenName = nextName;
    if (chosenName === undefined) {
      let parsedNext: number[] | null = null;
      try { parsedNext = parseTuning(nextNotes); } catch { /* A name needs notes. */ }
      chosenName = parsedNext && same(parsedNext, pitches) ? name : '';
    }
    setNotes(nextNotes);
    setDraftName(chosenName);
    setError(null);
    setRowError(null);
    setRefused(false);
    setRevision(count => count + 1);
  };
  const setPitch = (index: number, pitch: number) => {
    if (!parsed) return;
    changeDraft(formatTuning(parsed.map((p, i) => (i === index ? pitch : p))));
  };
  const chooseInstrument = (next: PresetInstrument) => {
    const counts = countsOf(next);
    setInstrument(next);
    setCount(counts.includes(count) ? count : counts[0]);
  };

  const apply = (keepPitch: boolean) => {
    if ((mode === 'track' && (busy || locked)) || pending.current) return;
    if (rowError) return;
    let choice = capoChoice, held = partialInvalid || droneInvalid;
    if (staff) {
      // A field typed in but not left answers for itself; the others keep what they last reported.
      const typedPartial = partialSettle.current?.() ?? null, typedDrone = droneSettle.current?.() ?? null;
      held = (typedPartial ? 'invalid' in typedPartial : partialInvalid) || (typedDrone ? 'invalid' in typedDrone : droneInvalid);
      choice = capoChoiceFor(typedPartial && 'value' in typedPartial ? typedPartial.value : partial, typedDrone && 'value' in typedDrone ? typedDrone.value : drone);
    }
    if (staff && (!capoValid || held)) { setError(!capoValid ? t('tuning_dialog.capo_invalid') : t('tuning_dialog.capo_fix_first')); return; }
    let chosen: number[];
    try {
      chosen = parseTuning(notes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      notesInput.current?.focus();
      return;
    }
    setError(null);
    const result = onApply({ pitches: chosen, name: draftName, keepPitch: mode === 'track' && keepPitch && chosen.length === pitches.length, keep, ...(choice ? { capo: choice } : {}) });
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      pending.current = true;
      setRefused(false);
      (result as Promise<unknown>).then(landed => { pending.current = false; if (landed !== false) onClose(); else setRefused(true); }, () => { pending.current = false; setRefused(true); });
    } else onClose();
  };

  const play = (list: number[], strum: boolean) => onAudition?.(list, strum);
  const canPlay = !!onAudition && !!parsed && parsed.length > 0;
  const errorId = 'tuning-dialog-error';
  const shown = error ?? rowError?.message ?? (refused ? (refusal || t('tuning_dialog.refused')) : null);
  const actions = <>
    <button type="button" className="tp-button tuning-saved" onClick={() => setLibrary(true)}>{t('tuning_dialog.saved')}</button>
    <button type="button" className="tp-button" onClick={onClose}>{t('dialog.cancel')}</button>
    {mode === 'draft'
      ? <button type="submit" className="tp-button primary">{t('tuning.use_tuning')}</button>
      : recount
      ? <button type="submit" {...busyGuard({ busy, disabled: locked, className: 'tp-button primary' })}>{t('track_settings.change_string_count')}</button>
      : <>
        <button type="button" {...busyGuard({ busy, disabled: locked, className: 'tp-button', onClick: () => apply(true) })}>{t('track_settings.keep_pitch')}</button>
        <button type="submit" {...busyGuard({ busy, disabled: locked, className: 'tp-button primary' })}>{t('tuning_dialog.keep_fingering')}</button>
      </>}
  </>;

  return <>
    {createPortal(<Dialog title={t('tuning_dialog.title')} className="tuning-dialog" onClose={onClose} onSubmit={event => { event.preventDefault(); apply(false); }} actions={actions}>
      <div className="tuning-dialog-body">
        <div className="tuning-library" role="group" aria-label={t('tuning_dialog.library')}>
          <span className="tuning-dialog-label">{t('tuning_dialog.library')}</span>
          <select aria-label={t('tuning_dialog.instrument')} value={instrument} onChange={event => chooseInstrument(event.target.value as PresetInstrument)}>
            {instruments.map(item => <option key={item} value={item}>{instrumentTitle(item, lang)}</option>)}
          </select>
          <select aria-label={t('tuning_dialog.string_count')} value={count} onChange={event => setCount(Number(event.target.value))}>
            {countsOf(instrument).map(item => <option key={item} value={item}>{t('tuning_dialog.string_count_option', { count: item })}</option>)}
          </select>
          <select
            aria-label={t('tuning_dialog.preset')}
            value={selectedPreset?.id ?? 'custom'}
            onChange={event => {
              const preset = tuningPresets.find(item => item.id === event.target.value);
              if (!preset) return;
              changeDraft(formatTuning(preset.tuning), preset.name);
            }}
          >
            {!selectedPreset && <option value="custom" disabled>{t('tuning_dialog.custom')}</option>}
            {groupPresets.map(preset => <option key={preset.id} value={preset.id}>{tuningPresetName(preset, lang)}</option>)}
          </select>
        </div>
        <div className="tuning-notes-line">
          <label className="tuning-dialog-label" htmlFor="tuning-dialog-notes">{t('tuning_dialog.notes')}</label>
          <input
            id="tuning-dialog-notes"
            ref={notesInput}
            data-autofocus
            value={notes}
            spellCheck={false}
            placeholder="E4 B3 G3 D3 A2 E2"
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? errorId : undefined}
            onChange={event => changeDraft(event.target.value)}
          />
          {onAudition && <button type="button" aria-label={t('track_settings.play_tuning')} title={t('track_settings.play_tuning')} {...busyGuard({ disabled: !canPlay || draft.length > 12, className: 'tuning-play-all', onClick: () => play([...draft], true) })}><PlayGlyph /></button>}
        </div>
        {shown && <p id={errorId} role="alert" className="tuning-error">{shown}</p>}
        {parsed && parsed.length > 0 && <ul className="tuning-strings" aria-label={t('tuning_dialog.strings')}>
          {parsed.map((pitch, index) => <StringRow key={index} index={index} pitch={pitch} revision={revision} playable={!!onAudition} onPitch={next => setPitch(index, next)} onInvalid={message => setRowError(message ? { index, message } : current => (current?.index === index ? null : current))} onPlay={() => play([pitch], false)} />)}
        </ul>}
        {staff && mode === 'track' && <fieldset className="tuning-capo">
          <legend>{t('tuning_dialog.capo_section')}</legend>
          <div className="tuning-capo-row">
            <label htmlFor="tuning-dialog-capo" className="tp-sr">{t('editor.capo')}</label>
            <input id="tuning-dialog-capo" type="number" min={0} max={127} value={capoText} aria-invalid={!capoValid || undefined} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} onChange={event => { setCapoText(event.target.value); setError(null); setRefused(false); }} />
            <span className="tuning-hint">{t('tuning_dialog.capo_fret')}</span>
          </div>
          <details className="tuning-capo-more" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
            <summary>{t('tuning_dialog.capo_more')}</summary>
            <PartialCapoControls key={`partial/${staff.tuning.join()}`} staff={staff} value={partial} onChange={setPartial} onInvalid={setPartialInvalid} settleRef={partialSettle} />
            <BanjoDroneControls key={`drone/${staff.tuning.length}`} staff={staff} value={drone} onChange={setDrone} onInvalid={setDroneInvalid} settleRef={droneSettle} />
          </details>
        </fieldset>}
        {recount && <fieldset className="string-count">
          <legend>{t('track_settings.recount_legend', { from: pitches.length, to: draft.length })}</legend>
          <label>{t('track_settings.strings_kept')}<select value={keep} aria-describedby="string-count-help" onChange={event => setKeep(event.target.value as StringCountKeep)}><option value="high">{t('track_settings.high_strings_option')}</option><option value="low">{t('track_settings.low_strings_option')}</option></select></label>
          <p className="tuning-hint" id="string-count-help">{t('track_settings.string_count_help')}</p>
          {staffCount > 1 && <p className="tuning-hint" role="note">{t('track_settings.string_count_all_staves', { count: staffCount })}</p>}
        </fieldset>}
        {mode === 'track' && !recount && <p className="tuning-hint">{t('tuning_dialog.apply_hint')}</p>}
      </div>
    </Dialog>, document.body)}
    {library && <SavedTuningsDialog
      onAudition={onAudition}
      notes={notes}
      name={draftName}
      onClose={() => setLibrary(false)}
      onUse={(next, nextName) => changeDraft(next, nextName)}
    />}
  </>;
}
