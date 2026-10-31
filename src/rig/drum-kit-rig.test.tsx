// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import type { EditCommand, TrackSound } from '../edit-types';
import { soundPreset } from '../audio/sound-model';
import { SoundRig } from './SoundRig';

afterEach(() => { cleanup(); localStorage.clear(); });
function mount(percussion: boolean, initial: TrackSound = soundPreset('gm')) {
  const edits: EditCommand[] = [];
  function Host() {
    const [sound, setSound] = useState(initial);
    return <SoundRig trackId="t" sound={sound} tracks={[{ id: 't', name: 'Track', program: 0, percussion }]} onTrack={() => {}}
      onEdit={command => { edits.push(command); if (command.type === 'setTrackSound') setSound(command.sound); }} />;
  }
  render(<Host />);
  return edits;
}
const sounds = (edits: EditCommand[]) => edits.map(edit => (edit as Extract<EditCommand, { type: 'setTrackSound' }>).sound);

it('shows the drum kit select in the rig for a drum track, as one edit that keeps the rest of the sound', () => {
  const edits = mount(true);
  expect(Array.from(screen.getByLabelText('Drum kit').querySelectorAll('option')).map(o => o.textContent)).toEqual(['Standard', 'Room', 'Jazz', 'Brush']);
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '0' } });
  expect(edits).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '32' } });
  expect(sounds(edits)).toEqual([{ ...soundPreset('gm'), drumKit: 32 }]);
  expect(screen.getByLabelText('Drum kit')).toHaveValue('32');
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '32' } });
  expect(edits).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '0' } });
  expect(edits).toHaveLength(2);
  expect(sounds(edits)[1]).toEqual(soundPreset('gm'));
  expect(sounds(edits)[1]).not.toHaveProperty('drumKit');
});
it('keeps the kit through a preset chosen in the rig', () => {
  const edits = mount(true, { ...soundPreset('gm'), drumKit: 40 });
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sound preset' })).getByRole('radio', { name: 'Crunch' }));
  expect(sounds(edits).at(-1)).toEqual({ ...soundPreset('crunch'), drumKit: 40 });
});
it('shows no drum kit select for a pitched track', () => {
  mount(false);
  expect(screen.queryByLabelText('Drum kit')).toBeNull();
});
void vi;
