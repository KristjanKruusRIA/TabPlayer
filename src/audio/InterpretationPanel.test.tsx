// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { InterpretationPanel } from './InterpretationPanel';

afterEach(cleanup);
const mix = { gain: .5, pan: 0, mute: false, solo: true };

it('sends each choice as a mix edit that keeps the rest of the mix, and clearing the last one removes the key', () => {
  const onEdit = vi.fn();
  const { rerender } = render(<InterpretationPanel trackId="base/0" mix={mix} stringed onEdit={onEdit} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Playing style' }), { target: { value: 'fingers' } });
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackMix', trackId: 'base/0', mix: { ...mix, interpretation: { style: 'fingers' } } });
  rerender(<InterpretationPanel trackId="base/0" mix={{ ...mix, interpretation: { style: 'fingers' } }} stringed onEdit={onEdit} />);
  expect(screen.getByRole('combobox', { name: 'Playing style' })).toHaveValue('fingers');
  fireEvent.change(screen.getByRole('combobox', { name: 'Palm mute intensity' }), { target: { value: 'heavy' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Strong-beat accent' }), { target: { value: 'strong' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Automatic brush' }), { target: { value: 'up' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic let ring' }));
  expect(onEdit.mock.calls.map(call => call[0].mix.interpretation)).toEqual([{ style: 'fingers' }, { style: 'fingers', palmMute: 'heavy' }, { style: 'fingers', accent: 'strong' }, { style: 'fingers', brush: 'up' }, { style: 'fingers', letRing: true }]);
  fireEvent.change(screen.getByRole('combobox', { name: 'Playing style' }), { target: { value: '' } });
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackMix', trackId: 'base/0', mix });
  expect(onEdit.mock.calls.at(-1)![0].mix).not.toHaveProperty('interpretation');
});

it('is hidden for a track with no strings, disabled while busy, and shows a refusal', async () => {
  const { container, rerender } = render(<InterpretationPanel trackId="base/0" mix={mix} stringed={false} onEdit={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
  rerender(<InterpretationPanel trackId="base/0" mix={mix} stringed busy onEdit={vi.fn()} />);
  expect(screen.getByRole('combobox', { name: 'Playing style' })).toBeDisabled();
  rerender(<InterpretationPanel trackId="base/0" stringed onEdit={() => Promise.reject(new Error('Refused.'))} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic let ring' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Refused.');
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Automatic let ring' })).not.toBeChecked());
});
