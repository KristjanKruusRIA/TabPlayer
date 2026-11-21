// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SoundbankSettingsPanel } from './SoundbankSettingsPanel';
import {
  resetSoundbankStoreForTest,
  setSoundbankBridgeForTest,
  setSoundbankStatusForTest,
  type Gp8Status,
} from './soundbank-store';

afterEach(() => {
  cleanup();
  resetSoundbankStoreForTest();
});

const detectedStatus: Gp8Status = {
  enabled: true,
  available: true,
  configuredPath: null,
  resolvedPath: 'C:/ProgramData/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard',
  detectedDefaultPath: 'C:/ProgramData/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard',
  version: '2.0.0-9',
  setCount: 372,
  error: null,
  sets: [],
};

it('shows detection status, toggles enabled state, picks custom folder, resets to default, and displays errors safely', async () => {
  const configure = vi.fn(async (enabled: boolean, path: string | null) => ({
    ...detectedStatus,
    enabled,
    available: enabled,
    configuredPath: path,
    resolvedPath: enabled ? (path ?? detectedStatus.detectedDefaultPath) : null,
    error: path === 'D:/Empty' ? 'Selected folder does not contain a GP8 soundbank' : null,
  }));
  const pickFolder = vi.fn(async () => 'D:/CustomGP8');
  const statusFn = vi.fn(async () => detectedStatus);

  setSoundbankBridgeForTest({ status: statusFn, configure, pickFolder });
  setSoundbankStatusForTest(detectedStatus);

  render(<SoundbankSettingsPanel embedded />);
  expect(screen.getByRole('status')).toHaveTextContent('372');
  expect(screen.getByRole('status')).toHaveTextContent('2.0.0-9');

  const toggle = screen.getByRole('checkbox', { name: /Guitar Pro 8/i });
  expect(toggle).toBeChecked();

  // Disable GP8 soundbanks.
  fireEvent.click(toggle);
  await waitFor(() => expect(configure).toHaveBeenCalledWith(false, null));
  expect(screen.getByRole('status')).toHaveTextContent(/Disabled/i);

  // Pick a custom folder.
  fireEvent.click(screen.getByRole('button', { name: /Choose folder/i }));
  await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(configure).toHaveBeenCalledWith(true, 'D:/CustomGP8'));

  // Use default button appears when custom path is set and clears it back to null.
  const resetBtn = await screen.findByRole('button', { name: /Use default path/i });
  fireEvent.click(resetBtn);
  await waitFor(() => expect(configure).toHaveBeenLastCalledWith(true, null));

  // Error status from backend displays in an alert without breaking controls.
  act(() => {
    setSoundbankStatusForTest({
      ...detectedStatus,
      available: false,
      error: 'Invalid AMARCHIVE magic',
    });
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid AMARCHIVE magic');
});
