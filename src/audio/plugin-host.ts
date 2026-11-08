import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PluginSlot } from '../edit-types';
import type { MessageKey } from '../i18n';

export type PluginStatus =
  | 'loading'
  | 'ready'
  | 'needsConsent'
  | 'missing'
  | 'unreadable'
  | 'unsupportedFormat'
  | 'unsupportedPlatform'
  | 'unsupportedLayout'
  | 'tooMuchLatency'
  | 'tooMany'
  | 'crashed'
  | 'hung'
  | 'underrun'
  | 'nonFinite'
  | 'rejectedState'
  | 'stateTooLarge'
  | 'hostMissing';

/** An audio-effect class in the user's plug-in library, as the native app describes it. `classId` is 32 uppercase hex characters. */
export interface PluginLibraryEntry {
  classId: string;
  name: string;
  vendor: string;
  version: string;
  /** Where the plug-in lives: the `.vst3` folder, or a single-file module. */
  bundle: string;
  /** The size of the module file when the class was last scanned. */
  moduleLen: number;
  /** Its modification time then, in milliseconds since 1970. */
  moduleModified: number;
  /** Set when this class moved from another bundle file. */
  previousBundle?: string;
}

export interface TrackPluginStatus {
  trackId: string;
  classId: string;
  name: string;
  vendor: string;
  status: PluginStatus;
}

export interface PluginChooseResult {
  slot: PluginSlot;
  assetToken: string;
}

export interface PluginEditorSaveResult {
  state: string;
  assetToken: string;
}

export interface PluginEditorClosedPayload {
  documentId: string;
  trackId: string;
  state: string | null;
  assetToken: string | null;
}

/** The plug-in library: the effects the user picked from `.vst3` files on this computer. A document names a class by its identity and never holds the plug-in. */
export const pluginLibrary = {
  list: () => invoke<PluginLibraryEntry[]>('plugin_library_list'),
  /** Asks for a `.vst3` file and scans it, which can take a minute. Resolves to the whole library, or null when the dialog is cancelled; a rejection says why the file was refused. */
  add: () => invoke<PluginLibraryEntry[] | null>('plugin_library_add'),
  remove: (classId: string) => invoke<void>('plugin_library_remove', { classId }),
};

export const pluginChoose = (documentId: string, trackId: string, classId: string) =>
  invoke<PluginChooseResult>('plugin_choose', { documentId, trackId, classId });

export const pluginStatus = (documentId: string) =>
  invoke<TrackPluginStatus[]>('plugin_status', { documentId });

export const pluginConsentGrant = (documentId: string) =>
  invoke<void>('plugin_consent_grant', { documentId });

export const pluginRetry = (documentId: string, trackId: string) =>
  invoke<void>('plugin_retry', { documentId, trackId });

export const pluginEditorOpen = (documentId: string, trackId: string, title: string) =>
  invoke<number>('plugin_editor_open', { documentId, trackId, title });

export const pluginEditorSave = (documentId: string, trackId: string) =>
  invoke<PluginEditorSaveResult | null>('plugin_editor_save', { documentId, trackId });

export const pluginEditorClose = (documentId: string, trackId: string) =>
  invoke<PluginEditorClosedPayload>('plugin_editor_close', { documentId, trackId });

export const onPluginStatus = (handler: (payload: { documentId: string }) => void) =>
  listen<{ documentId: string }>('plugin-status', event => handler(event.payload));

export const onPluginEditorClosed = (handler: (payload: PluginEditorClosedPayload) => void) =>
  listen<PluginEditorClosedPayload>('plugin-editor-closed', event => handler(event.payload));

/** Maps status to its short label message key. */
export function statusLabelKey(status: PluginStatus): MessageKey {
  switch (status) {
    case 'ready': return 'plugin.status.ready';
    case 'loading': return 'plugin.status.loading';
    case 'needsConsent': return 'plugin.status.needs_consent';
    case 'missing': return 'plugin.status.missing';
    case 'unreadable': return 'plugin.status.unreadable';
    case 'unsupportedFormat': return 'plugin.status.unsupported_format';
    case 'unsupportedPlatform': return 'plugin.status.unsupported_platform';
    case 'unsupportedLayout': return 'plugin.status.unsupported_layout';
    case 'tooMuchLatency': return 'plugin.status.too_much_latency';
    case 'tooMany': return 'plugin.status.too_many';
    case 'crashed': return 'plugin.status.crashed';
    case 'hung': return 'plugin.status.hung';
    case 'underrun': return 'plugin.status.underrun';
    case 'nonFinite': return 'plugin.status.non_finite';
    case 'rejectedState': return 'plugin.status.rejected_state';
    case 'stateTooLarge': return 'plugin.status.state_too_large';
    case 'hostMissing': return 'plugin.status.host_missing';
  }
}

/** Maps non-ready status to its notice message key. */
export function noticeMessageKey(status: PluginStatus): MessageKey {
  switch (status) {
    case 'needsConsent': return 'plugin.notice.needs_consent';
    case 'missing': return 'plugin.notice.missing';
    case 'unreadable': return 'plugin.notice.unreadable';
    case 'unsupportedFormat': return 'plugin.notice.unsupported_format';
    case 'unsupportedPlatform': return 'plugin.notice.unsupported_platform';
    case 'unsupportedLayout': return 'plugin.notice.unsupported_layout';
    case 'tooMuchLatency': return 'plugin.notice.too_much_latency';
    case 'tooMany': return 'plugin.notice.too_many';
    case 'crashed': return 'plugin.notice.crashed';
    case 'hung': return 'plugin.notice.hung';
    case 'underrun': return 'plugin.notice.underrun';
    case 'nonFinite': return 'plugin.notice.non_finite';
    case 'rejectedState': return 'plugin.notice.rejected_state';
    case 'stateTooLarge': return 'plugin.notice.state_too_large';
    case 'hostMissing': return 'plugin.notice.host_missing';
    default: return 'plugin.notice.unreadable';
  }
}

/** Translates known English errors from the helper and library into localized text. */
export function localizePluginError(
  error: unknown,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  const msg = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  if (!msg) return '';

  if (msg.includes('Choose a .vst3 plug-in.')) return t('plugin.error.not_vst3');
  if (msg.includes('This .vst3 folder holds no plug-in for this computer.')) return t('plugin.error.no_module');
  if (msg.includes("This file is not the plug-in's main file")) return t('plugin.error.not_main_module');
  if (msg.includes("location is too long or is not valid text")) return t('plugin.error.bad_path');
  if (msg.includes('This file holds no audio effect.')) return t('plugin.error.no_effects');
  if (msg.includes('The plug-in library is full')) return t('plugin.error.too_many');
  if (msg.includes('plug-in library file is damaged')) return t('plugin.error.damaged');
  if (msg.includes('newer TabPlayer')) return t('plugin.error.newer_version');
  if (msg.includes('Could not use the plug-in library file:')) {
    const detail = msg.replace(/^.*?Could not use the plug-in library file:\s*/, '');
    return t('plugin.error.io', { detail });
  }
  if (msg.includes('Could not open the plug-in:')) {
    const detail = msg.replace(/^.*?Could not open the plug-in:\s*/, '');
    return t('plugin.error.not_found', { detail });
  }
  if (msg.includes('Could not scan the plug-in:')) {
    const detail = msg.replace(/^.*?Could not scan the plug-in:\s*/, '');
    return t('plugin.error.probe', { detail });
  }
  if (msg.includes('plug-in helper program is missing')) return t('plugin.error.host_missing');
  if (msg.includes('plug-in hosting is not available on this platform')) return t('plugin.error.unsupported_platform');
  if (msg.includes('could not start the plug-in helper:')) {
    const detail = msg.replace(/^.*?could not start the plug-in helper:\s*/, '');
    return t('plugin.error.spawn', { detail });
  }
  if (msg.includes('plug-in helper did not answer in time')) return t('plugin.error.timeout');
  if (msg.includes('plug-in did not load in time')) return t('plugin.error.load_timeout');
  if (msg.includes('plug-in did not scan in time')) return t('plugin.error.probe_timeout');
  if (msg.includes('plug-in helper was ended by the app')) return t('plugin.error.ended');
  if (msg.includes('the plug-in helper ended')) return t('plugin.error.exited');
  if (msg.includes('over the limit of')) return t('plugin.error.too_much_latency');
  if (msg.includes("state is too large to keep undo steps")) return t('plugin.history_full');

  return msg;
}
