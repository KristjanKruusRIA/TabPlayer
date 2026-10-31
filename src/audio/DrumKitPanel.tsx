import { useState } from 'react';
import { defaultMix } from '../document-settings';
import type { ChannelMix, DrumElementMix, DrumKitElement, EditCommand } from '../edit-types';
import {
  canonicalDrumKitMix,
  defaultDrumElement,
  DRUM_KIT_ELEMENT_LABELS,
  DRUM_KIT_ELEMENTS,
} from './drum-kit';

/**
 * Lets the player mix individual kit elements (kick, snare, hats, toms, cymbals, other)
 * for a percussion track with volume, pan, mute and solo.
 * Saved on the track's mix, heard in playback and export alike, and usable on finalized scores.
 */
export function DrumKitPanel({
  trackId,
  mix,
  percussion,
  busy = false,
  onEdit,
}: {
  trackId: string;
  mix?: ChannelMix;
  percussion: boolean;
  busy?: boolean;
  onEdit: (edit: EditCommand) => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!percussion) return null;

  const base = mix ?? defaultMix(),
    currentKit = base.drumKit ?? {};

  const changeElement = (element: DrumKitElement, patch: Partial<DrumElementMix>) => {
    if (busy) return;
    const currentElement = currentKit[element] ?? defaultDrumElement();
    const nextElement: DrumElementMix = {
      gain: patch.gain !== undefined ? patch.gain : currentElement.gain,
      pan: patch.pan !== undefined ? patch.pan : currentElement.pan,
      mute: patch.mute !== undefined ? patch.mute : currentElement.mute,
      solo: patch.solo !== undefined ? patch.solo : currentElement.solo,
    };
    if (
      nextElement.gain === currentElement.gain &&
      nextElement.pan === currentElement.pan &&
      nextElement.mute === currentElement.mute &&
      nextElement.solo === currentElement.solo
    ) {
      return;
    }
    const nextKit = canonicalDrumKitMix({ ...currentKit, [element]: nextElement });
    const { drumKit: _dropped, ...rest } = base;
    const nextMix: ChannelMix = nextKit ? { ...rest, drumKit: nextKit } : rest;
    setError(null);
    Promise.resolve(onEdit({ type: 'setTrackMix', trackId, mix: nextMix })).catch(e =>
      setError(String(e instanceof Error ? e.message : e))
    );
  };

  return (
    <section className="sound-panel drum-kit-panel" aria-label="Drum kit mix">
      <h3>Drum kit mix</h3>
      <div className="drum-kit-elements">
        {DRUM_KIT_ELEMENTS.map(element => {
          const el = currentKit[element] ?? defaultDrumElement(),
            label = DRUM_KIT_ELEMENT_LABELS[element];
          return (
            <fieldset key={element} className="drum-element-channel">
              <legend>{label}</legend>
              <div className="drum-element-switches">
                <label>
                  <input
                    type="checkbox"
                    checked={el.mute}
                    aria-disabled={busy}
                    aria-label={`Mute ${label}`}
                    onChange={e => {
                      if (busy) return;
                      if (e.target.checked === el.mute) return;
                      changeElement(element, { mute: e.target.checked });
                    }}
                  />
                  Mute
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={el.solo}
                    aria-disabled={busy}
                    aria-label={`Solo ${label}`}
                    onChange={e => {
                      if (busy) return;
                      if (e.target.checked === el.solo) return;
                      changeElement(element, { solo: e.target.checked });
                    }}
                  />
                  Solo
                </label>
              </div>
              <label className="drum-element-range">
                Volume <output>{el.gain.toFixed(2)}</output>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={el.gain}
                  aria-disabled={busy}
                  aria-label={`Volume ${label}`}
                  aria-valuetext={String(el.gain)}
                  onChange={e => {
                    if (busy) return;
                    const val = Number(e.target.value);
                    if (val === el.gain) return;
                    changeElement(element, { gain: val });
                  }}
                />
              </label>
              <label className="drum-element-range">
                Pan <output>{el.pan.toFixed(2)}</output>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={el.pan}
                  aria-disabled={busy}
                  aria-label={`Pan ${label}`}
                  aria-valuetext={String(el.pan)}
                  onChange={e => {
                    if (busy) return;
                    const val = Number(e.target.value);
                    if (val === el.pan) return;
                    changeElement(element, { pan: val });
                  }}
                />
              </label>
            </fieldset>
          );
        })}
      </div>
      <p className="hint">
        Heard in playback and audio export. Kit elements (kick, snare, hats, toms, cymbals,
        other) are grouped from GM percussion note numbers and saved with the track mix.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
