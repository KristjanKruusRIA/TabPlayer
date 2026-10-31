// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { blankProject, type EditCommand, type Project } from '../project';
import { DRUM_KIT_ELEMENT_LABELS, DRUM_KIT_ELEMENTS } from './drum-kit';
import { DrumKitPanel } from './DrumKitPanel';

describe('DrumKitPanel', () => {
  afterEach(cleanup);
  function setupEngine() {
    const added = previewEdit(blankProject(), {
      type: 'addPercussionTrack',
      name: 'Drums',
      program: 0,
    });
    let currentProject: Project = added.project;
    let currentBuilt = buildDocument(currentProject);
    const trackId = trackIdentity(currentBuilt.score.tracks[1]);
    const edits: EditCommand[] = [];

    const onEdit = vi.fn((edit: EditCommand) => {
      edits.push(edit);
      const next = previewEdit(currentProject, edit, currentBuilt);
      currentProject = next.project;
      currentBuilt = next;
    });

    return {
      get project() { return currentProject; },
      get built() { return currentBuilt; },
      trackId,
      edits,
      onEdit,
    };
  }

  it('is never shown as a live control when track is not percussion', () => {
    const { trackId, onEdit } = setupEngine();
    const { container } = render(
      <DrumKitPanel trackId={trackId} percussion={false} onEdit={onEdit} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders all 6 kit elements with volume, pan, mute and solo controls', () => {
    const { trackId, onEdit } = setupEngine();
    render(<DrumKitPanel trackId={trackId} percussion onEdit={onEdit} />);

    for (const el of DRUM_KIT_ELEMENTS) {
      const label = DRUM_KIT_ELEMENT_LABELS[el];
      const vol = screen.getByLabelText(`Volume ${label}`);
      const pan = screen.getByLabelText(`Pan ${label}`);
      const mute = screen.getByLabelText(`Mute ${label}`);
      const solo = screen.getByLabelText(`Solo ${label}`);

      expect(vol).toHaveValue('1');
      expect(vol).toHaveAttribute('min', '0');
      expect(vol).toHaveAttribute('max', '1');
      expect(pan).toHaveValue('0');
      expect(pan).toHaveAttribute('min', '-1');
      expect(pan).toHaveAttribute('max', '1');
      expect(mute).not.toBeChecked();
      expect(solo).not.toBeChecked();
    }
  });

  it('applies one gesture as one undoable edit through the real engine', () => {
    const engine = setupEngine();
    const { rerender } = render(
      <DrumKitPanel
        trackId={engine.trackId}
        mix={engine.built.settings.mixes[engine.trackId]}
        percussion
        onEdit={engine.onEdit}
      />
    );

    const kickVol = screen.getByLabelText('Volume Kick');
    fireEvent.change(kickVol, { target: { value: '0.75' } });

    expect(engine.onEdit).toHaveBeenCalledTimes(1);
    expect(engine.edits[0]).toEqual({
      type: 'setTrackMix',
      trackId: engine.trackId,
      mix: expect.objectContaining({
        drumKit: {
          kick: { gain: 0.75, pan: 0, mute: false, solo: false },
        },
      }),
    });
    expect(engine.built.settings.mixes[engine.trackId].drumKit?.kick?.gain).toBe(0.75);

    // Rerender with updated mix from real engine
    rerender(
      <DrumKitPanel
        trackId={engine.trackId}
        mix={engine.built.settings.mixes[engine.trackId]}
        percussion
        onEdit={engine.onEdit}
      />
    );
    expect(screen.getByLabelText('Volume Kick')).toHaveValue('0.75');

    // Pan snare
    const snarePan = screen.getByLabelText('Pan Snare');
    fireEvent.change(snarePan, { target: { value: '-0.3' } });
    expect(engine.onEdit).toHaveBeenCalledTimes(2);
    expect(engine.built.settings.mixes[engine.trackId].drumKit?.snare?.pan).toBe(-0.3);

    // Mute hats
    const hatsMute = screen.getByLabelText('Mute Hi-Hat');
    fireEvent.click(hatsMute);
    expect(engine.onEdit).toHaveBeenCalledTimes(3);
    expect(engine.built.settings.mixes[engine.trackId].drumKit?.hats?.mute).toBe(true);

    // Solo toms
    const tomsSolo = screen.getByLabelText('Solo Toms');
    fireEvent.click(tomsSolo);
    expect(engine.onEdit).toHaveBeenCalledTimes(4);
    expect(engine.built.settings.mixes[engine.trackId].drumKit?.toms?.solo).toBe(true);
  });

  it('choosing the current value records nothing', () => {
    const engine = setupEngine();
    render(
      <DrumKitPanel
        trackId={engine.trackId}
        mix={engine.built.settings.mixes[engine.trackId]}
        percussion
        onEdit={engine.onEdit}
      />
    );

    const kickVol = screen.getByLabelText('Volume Kick');
    // Default value is 1; choosing 1 records nothing
    fireEvent.change(kickVol, { target: { value: '1' } });
    expect(engine.onEdit).not.toHaveBeenCalled();

    const snarePan = screen.getByLabelText('Pan Snare');
    fireEvent.change(snarePan, { target: { value: '0' } });
    expect(engine.onEdit).not.toHaveBeenCalled();
  });

  it('keeps controls focusable while busy (aria-disabled) and refuses interactions', () => {
    const engine = setupEngine();
    render(
      <DrumKitPanel
        trackId={engine.trackId}
        mix={engine.built.settings.mixes[engine.trackId]}
        percussion
        busy
        onEdit={engine.onEdit}
      />
    );

    const kickVol = screen.getByLabelText('Volume Kick');
    const kickMute = screen.getByLabelText('Mute Kick');

    // Focusable: NOT disabled attribute
    expect(kickVol).not.toBeDisabled();
    expect(kickMute).not.toBeDisabled();
    expect(kickVol).toHaveAttribute('aria-disabled', 'true');
    expect(kickMute).toHaveAttribute('aria-disabled', 'true');

    // Handlers refuse when busy
    fireEvent.change(kickVol, { target: { value: '0.4' } });
    fireEvent.click(kickMute);
    expect(engine.onEdit).not.toHaveBeenCalled();
  });

  it('displays alert on edit failure', async () => {
    const failingEdit = vi.fn(() => Promise.reject(new Error('Engine rejected mix.')));
    render(
      <DrumKitPanel
        trackId="base/0"
        percussion
        onEdit={failingEdit}
      />
    );

    fireEvent.change(screen.getByLabelText('Volume Kick'), { target: { value: '0.5' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Engine rejected mix.');
  });
});
