import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import type { MasterSettings } from '../edit-types';
import { Dialog } from '../ui/Dialog';
import { MasterPanel, useMasterChange } from '../audio/MasterPanel';
import { SlidersGlyph } from '../shell/glyphs';
import './inspector-compact.css';

type Effect = 'compressor' | 'eq' | 'reverb' | 'limiter';
const effects: readonly Effect[] = ['compressor', 'eq', 'reverb', 'limiter'];

/**
 * Sound mastering as four slot rows, as Guitar Pro's Song tab has them: the effect's name, a power switch that records one
 * undoable change, and an edit button that opens the full master controls (level, balance and every effect's settings) in a dialog.
 */
export function MasterSlots({ master, disabled, onChange }: { master: MasterSettings | undefined; disabled: boolean; onChange: (next: MasterSettings) => Promise<unknown> | void }) {
  const { t } = useI18n();
  const { current, latest, change } = useMasterChange(master, onChange);
  const [editing, setEditing] = useState<Effect | 'all' | null>(null);
  const name: Record<Effect, string> = { compressor: t('audio.compressor'), eq: t('audio.eq'), reverb: t('audio.reverb'), limiter: t('audio.limiter') };
  const power = (effect: Effect, on: boolean) => {
    if (disabled || current[effect].enabled === on) return;
    void change({ [effect]: { ...latest.current[effect], enabled: on } } as Partial<MasterSettings>);
  };
  return <div className="master-slots">
    <div className="slots-head"><h3 id="inspector-sound-mastering">{t('inspector.sound_mastering')}</h3>
      <button type="button" className="slot-all" aria-haspopup="dialog" title={t('master_slots.show_all')} aria-label={t('master_slots.show_all')} onClick={() => setEditing('all')}><SlidersGlyph /></button></div>
    <ul className="slot-rows" aria-label={t('inspector.sound_mastering')}>
      {effects.map(effect => <li key={effect} className="slot-row" data-on={current[effect].enabled}>
        <input id={`slot-${effect}`} type="checkbox" role="switch" checked={current[effect].enabled} aria-disabled={disabled || undefined} onChange={event => power(effect, event.target.checked)} />
        <label htmlFor={`slot-${effect}`} className="slot-name">{name[effect]}</label>
        <span className="slot-state">{current[effect].enabled ? t('sound.enabled') : t('sound.bypassed')}</span>
        <button type="button" className="slot-edit" aria-haspopup="dialog" title={t('master_slots.edit', { name: name[effect] })} aria-label={t('master_slots.edit', { name: name[effect] })} onClick={() => setEditing(effect)}><SlidersGlyph /></button>
      </li>)}
    </ul>
    {editing && createPortal(<Dialog title={t('inspector.sound_mastering')} className="master-dialog" onClose={() => setEditing(null)} dismissOnBackdrop>
      <MasterPanel master={master} disabled={disabled} onChange={onChange} open={editing === 'all' ? undefined : editing} />
    </Dialog>, document.body)}
  </div>;
}
