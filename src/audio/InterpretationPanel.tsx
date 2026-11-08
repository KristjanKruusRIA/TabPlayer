import { useState } from 'react';
import { defaultMix } from '../document-settings';
import type { ChannelMix, EditCommand, TrackInterpretation } from '../edit-types';
import { canonicalInterpretation } from './interpretation';
import { useI18n } from '../i18n';

type Option<K extends keyof TrackInterpretation> = NonNullable<TrackInterpretation[K]>;

/**
 * How the selected track's stringed notes are performed in playback and audio export. The score is not changed:
 * the choice is saved with the track's mix, so it follows the mixer's rules and stays usable on a finalized score.
 */
export function InterpretationPanel({ trackId, mix, stringed, busy = false, onEdit }: { trackId: string; mix?: ChannelMix; stringed: boolean; busy?: boolean; onEdit: (edit: EditCommand) => void | Promise<void> }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  if (!stringed) return null;
  const choices: { [K in 'style' | 'palmMute' | 'accent' | 'brush']: { label: string; none: string; options: [Option<K>, string][] } } = {
    style: { label: t('sound.interp_style'), none: t('sound.interp_style_auto'), options: [['pick', t('sound.interp_pick')], ['fingers', t('sound.interp_fingers')]] },
    palmMute: { label: t('sound.interp_palm_mute'), none: t('sound.interp_palm_mute_normal'), options: [['light', t('sound.interp_palm_mute_light')], ['heavy', t('sound.interp_palm_mute_heavy')]] },
    accent: { label: t('sound.interp_accent'), none: t('sound.interp_accent_off'), options: [['light', t('sound.interp_accent_light')], ['strong', t('sound.interp_accent_strong')]] },
    brush: { label: t('sound.interp_brush'), none: t('sound.interp_brush_off'), options: [['down', t('sound.interp_brush_down')], ['up', t('sound.interp_brush_up')]] },
  };
  const current: TrackInterpretation = mix?.interpretation ?? {}, base = mix ?? defaultMix();
  const change = (patch: Partial<Record<keyof TrackInterpretation, unknown>>) => {
    const next = canonicalInterpretation({ ...current, ...patch } as TrackInterpretation), { interpretation: _dropped, ...rest } = base;
    setError(null);
    Promise.resolve(onEdit({ type: 'setTrackMix', trackId, mix: next ? { ...rest, interpretation: next } : rest })).catch(e => setError(String(e instanceof Error ? e.message : e)));
  };
  return <section className="sound-panel interpretation-panel" aria-label={t('sound.interpretation_title')}><h3>{t('sound.interpretation_heading')}</h3><fieldset disabled={busy}>
    {(Object.keys(choices) as (keyof typeof choices)[]).map(key => <label key={key}>{choices[key].label}
      <select value={current[key] ?? ''} onChange={e => change({ [key]: e.target.value || undefined })}>
        <option value="">{choices[key].none}</option>{choices[key].options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>)}
    <label className="check"><input type="checkbox" checked={current.letRing === true} onChange={e => change({ letRing: e.target.checked ? true : undefined })} />{t('sound.interp_auto_let_ring')}</label>
  </fieldset>
  <p className="hint">{t('sound.interp_hint')}</p>
  {error && <p role="alert">{error}</p>}</section>;
}
