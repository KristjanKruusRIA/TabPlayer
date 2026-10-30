import { useState } from 'react';
import { defaultMix } from '../document-settings';
import type { ChannelMix, EditCommand, TrackInterpretation } from '../edit-types';
import { canonicalInterpretation } from './interpretation';

type Option<K extends keyof TrackInterpretation> = NonNullable<TrackInterpretation[K]>;
const choices: { [K in 'style' | 'palmMute' | 'accent' | 'brush']: { label: string; none: string; options: [Option<K>, string][] } } = {
  style: { label: 'Playing style', none: 'Automatic (from the instrument)', options: [['pick', 'Pick'], ['fingers', 'Fingers']] },
  palmMute: { label: 'Palm mute intensity', none: 'Normal', options: [['light', 'Light (looser, brighter)'], ['heavy', 'Heavy (softer)']] },
  accent: { label: 'Strong-beat accent', none: 'Off', options: [['light', 'Light'], ['strong', 'Strong']] },
  brush: { label: 'Automatic brush', none: 'Off', options: [['down', 'Down (low strings first)'], ['up', 'Up (high strings first)']] },
};
/**
 * How the selected track's stringed notes are performed in playback and audio export. The score is not changed:
 * the choice is saved with the track's mix, so it follows the mixer's rules and stays usable on a finalized score.
 */
export function InterpretationPanel({ trackId, mix, stringed, busy = false, onEdit }: { trackId: string; mix?: ChannelMix; stringed: boolean; busy?: boolean; onEdit: (edit: EditCommand) => void | Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  if (!stringed) return null;
  const current: TrackInterpretation = mix?.interpretation ?? {}, base = mix ?? defaultMix();
  const change = (patch: Partial<Record<keyof TrackInterpretation, unknown>>) => {
    const next = canonicalInterpretation({ ...current, ...patch } as TrackInterpretation), { interpretation: _dropped, ...rest } = base;
    setError(null);
    Promise.resolve(onEdit({ type: 'setTrackMix', trackId, mix: next ? { ...rest, interpretation: next } : rest })).catch(e => setError(String(e instanceof Error ? e.message : e)));
  };
  return <section className="sound-panel interpretation-panel" aria-label="Track interpretation"><h3>Interpretation</h3><fieldset disabled={busy}>
    {(Object.keys(choices) as (keyof typeof choices)[]).map(key => <label key={key}>{choices[key].label}
      <select value={current[key] ?? ''} onChange={e => change({ [key]: e.target.value || undefined })}>
        <option value="">{choices[key].none}</option>{choices[key].options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>)}
    <label className="check"><input type="checkbox" checked={current.letRing === true} onChange={e => change({ letRing: e.target.checked ? true : undefined })} />Automatic let ring</label>
  </fieldset>
  <p className="hint">Heard in playback and audio export; the written score is unchanged. Written palm mutes, pick strokes, finger marks and other techniques always win over the style.</p>
  {error && <p role="alert">{error}</p>}</section>;
}
