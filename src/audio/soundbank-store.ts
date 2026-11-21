import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import type { PickupPosition } from '../edit-types';

export interface Gp8SetInfo {
  id: string;
  name: string;
  instrumentSet: string;
  category: string;
  pickups: PickupPosition[];
  isPercussion: boolean;
}

export interface Gp8Status {
  enabled: boolean;
  available: boolean;
  configuredPath: string | null;
  resolvedPath: string | null;
  detectedDefaultPath: string | null;
  version: string | null;
  setCount: number;
  error: string | null;
  sets: Gp8SetInfo[];
}

export interface SoundbankBridge {
  status: () => Promise<Gp8Status>;
  configure: (enabled: boolean, path: string | null) => Promise<Gp8Status>;
  pickFolder: () => Promise<string | null>;
}

const DEFAULT_STATUS: Gp8Status = {
  enabled: true,
  available: false,
  configuredPath: null,
  resolvedPath: null,
  detectedDefaultPath: null,
  version: null,
  setCount: 0,
  error: null,
  sets: [],
};

const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const tauriBridge: SoundbankBridge = {
  status: () => invoke<Gp8Status>('soundbanks_status'),
  configure: (enabled, path) => invoke<Gp8Status>('soundbanks_configure', { enabled, path }),
  pickFolder: () => invoke<string | null>('soundbanks_pick_folder'),
};

let customBridge: SoundbankBridge | null = null;
let currentStatus: Gp8Status = DEFAULT_STATUS;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeSoundbankStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSoundbankStatus(): Gp8Status {
  return currentStatus;
}

export function useSoundbankStatus(): Gp8Status {
  return useSyncExternalStore(
    subscribeSoundbankStatus,
    getSoundbankStatus,
    getSoundbankStatus
  );
}

export function setSoundbankStatusForTest(next: Gp8Status): void {
  currentStatus = next;
  notify();
}

export function setSoundbankBridgeForTest(bridge: SoundbankBridge | null): void {
  customBridge = bridge;
}

export function resetSoundbankStoreForTest(): void {
  customBridge = null;
  currentStatus = DEFAULT_STATUS;
  notify();
}

function activeBridge(): SoundbankBridge | null {
  if (customBridge) return customBridge;
  return isTauriRuntime() ? tauriBridge : null;
}

export async function refreshSoundbankStatus(): Promise<Gp8Status> {
  const bridge = activeBridge();
  if (!bridge) return currentStatus;
  try {
    currentStatus = await bridge.status();
    notify();
  } catch {
    // Preserve previous status if IPC isn't available yet during startup.
  }
  return currentStatus;
}

export async function configureSoundbanks(
  enabled: boolean,
  path: string | null
): Promise<Gp8Status> {
  const bridge = activeBridge();
  if (!bridge) {
    throw new Error('Soundbank configuration requires the desktop runtime.');
  }
  const updated = await bridge.configure(enabled, path);
  currentStatus = updated;
  notify();
  return updated;
}

export async function pickSoundbankFolder(): Promise<string | null> {
  const bridge = activeBridge();
  if (!bridge) return null;
  return bridge.pickFolder();
}
