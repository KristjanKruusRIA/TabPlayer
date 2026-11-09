import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { EditCommand, PluginSlot, TrackSound } from '../edit-types';
import type { MessageKey } from '../i18n';
import type { AssetCandidate } from '../project';

export function makePluginStateCandidate(stateId: string, token: string): AssetCandidate {
  return {
    token,
    assetId: stateId,
    info: {
      filename: 'plugin-state.tpstate',
      mediaType: 'application/x-tabplayer-plugin-state',
      // A placeholder: the native side does not return the asset's real size, and nothing in the UI shows this number.
      byteLength: 20,
    },
  };
}

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
  /** Why the editor's changes were not kept (a notice key such as `plugin.history_full`); the plug-in went back to the score's settings. */
  error?: string | null;
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

interface OpenedEditor { documentId: string; trackId: string; classId?: string }

/** The editors open now, one per track, so that closing one track's editor never judges it by another's. */
const openedEditors = new Map<string, OpenedEditor>();
const editorKey = (documentId: string, trackId: string) => `${documentId}/${trackId}`;

/** Remembers which plug-in class an editor was opened for. `null` forgets every editor. */
export const setOpenedEditor = (editor: OpenedEditor | null) => {
  if (!editor) openedEditors.clear();
  else openedEditors.set(editorKey(editor.documentId, editor.trackId), editor);
};

export const getOpenedEditor = (documentId: string, trackId: string) => openedEditors.get(editorKey(documentId, trackId)) ?? null;

export const pluginEditorOpen = (documentId: string, trackId: string, title: string, classId?: string) => {
  setOpenedEditor({ documentId, trackId, classId });
  return invoke<number>('plugin_editor_open', { documentId, trackId, title });
};

/** Drops a staged state the document will not take, as the controller does for a refused edit. */
export const pluginCancelAsset = (documentId: string, token: string) =>
  invoke<boolean>('cancel_asset', { documentId, token });

export const pluginEditorSave = (documentId: string, trackId: string) =>
  invoke<PluginEditorSaveResult | null>('plugin_editor_save', { documentId, trackId });

/** Closes the editor. When its changes could not be kept, the payload's `error` joins the plug-in notices. */
export const pluginEditorClose = (documentId: string, trackId: string) =>
  invoke<PluginEditorClosedPayload>('plugin_editor_close', { documentId, trackId }).then(payload => {
    if (payload?.error) pluginNotices.add({ documentId, trackId, key: payload.error });
    return payload;
  });

/** What the native side tells the user about one track's plug-in, beside its status. */
export type PluginNoticeKey = 'plugin.busy' | 'plugin.save_failed' | 'plugin.history_full';
const PLUGIN_NOTICE_KEYS: readonly string[] = ['plugin.busy', 'plugin.save_failed', 'plugin.history_full'];
export const isPluginNoticeKey = (key: unknown): key is PluginNoticeKey => typeof key === 'string' && PLUGIN_NOTICE_KEYS.includes(key);

export interface PluginNotice {
  documentId: string;
  trackId: string;
  key: PluginNoticeKey;
}

/** The most notices kept; the oldest go first. */
const MAX_PLUGIN_NOTICES = 32;
let noticeList: readonly PluginNotice[] = [];
const noticeSubscribers = new Set<() => void>();
const sameNotice = (a: PluginNotice, b: { documentId: string; trackId: string; key: string }) =>
  a.documentId === b.documentId && a.trackId === b.trackId && a.key === b.key;
const setNotices = (next: readonly PluginNotice[]) => {
  noticeList = next;
  for (const subscriber of noticeSubscribers) subscriber();
};

/**
 * The plug-in notices shown until the user dismisses them. The same notice for the same track is kept once, so a close
 * whose error arrives both in the command's answer and as a `plugin-notice` event shows one notice. Keys this app does
 * not know are dropped rather than shown raw.
 */
export const pluginNotices = {
  list: (): readonly PluginNotice[] => noticeList,
  add(notice: { documentId: string; trackId: string; key: string }) {
    if (!isPluginNoticeKey(notice.key) || noticeList.some(item => sameNotice(item, notice))) return;
    const added: PluginNotice = { documentId: notice.documentId, trackId: notice.trackId, key: notice.key };
    setNotices([...noticeList, added].slice(-MAX_PLUGIN_NOTICES));
  },
  dismiss(notice: PluginNotice) {
    if (noticeList.some(item => sameNotice(item, notice))) setNotices(noticeList.filter(item => !sameNotice(item, notice)));
  },
  clear() {
    if (noticeList.length) setNotices([]);
  },
  subscribe(subscriber: () => void) {
    noticeSubscribers.add(subscriber);
    return () => {
      noticeSubscribers.delete(subscriber);
    };
  },
};

export const onPluginNotice = (handler: (payload: { documentId: string; trackId: string; key: string }) => void) =>
  listen<{ documentId: string; trackId: string; key: string }>('plugin-notice', event => handler(event.payload));

export const onPluginStatus = (handler: (payload: { documentId: string }) => void) =>
  listen<{ documentId: string }>('plugin-status', event => handler(event.payload));

export const onPluginEditorClosed = (handler: (payload: PluginEditorClosedPayload) => void) =>
  listen<PluginEditorClosedPayload>('plugin-editor-closed', event => handler(event.payload));

export interface EditorCloseController {
  getState: () => { settings: { sounds: Record<string, TrackSound | undefined> } };
  edit: (command: EditCommand, asset?: AssetCandidate) => Promise<unknown> | void;
  cancelAsset?: (token: string) => Promise<unknown> | void;
}

export function handlePluginEditorClosed(
  payload: PluginEditorClosedPayload,
  currentDocumentId: string,
  controller: EditorCloseController
): void {
  if (payload.documentId !== currentDocumentId) return;
  if (!payload.assetToken || !payload.state) {
    openedEditors.delete(editorKey(payload.documentId, payload.trackId));
    return;
  }

  const currentSound = controller.getState().settings.sounds[payload.trackId];
  const currentPlugin = currentSound?.plugin;
  const opened = getOpenedEditor(payload.documentId, payload.trackId);
  openedEditors.delete(editorKey(payload.documentId, payload.trackId));
  const changedMeanwhile =
    !currentPlugin || Boolean(opened?.classId && currentPlugin.classId !== opened.classId);

  if (changedMeanwhile) {
    void controller.cancelAsset?.(payload.assetToken);
    return;
  }

  const nextSound: TrackSound = {
    ...currentSound,
    plugin: {
      ...currentPlugin,
      state: payload.state,
    },
  };
  const candidate = makePluginStateCandidate(payload.state, payload.assetToken);
  void controller.edit({ type: 'setTrackSound', trackId: payload.trackId, sound: nextSound }, candidate);
}

export interface MovedPlugin {
  trackId: string;
  name: string;
  bundle: string;
  previousBundle: string;
}

/** Every track whose plug-in class now loads from another file than before, so none is overlooked because it is not selected. */
export function movedPlugins(statuses: readonly TrackPluginStatus[], entries: readonly PluginLibraryEntry[]): MovedPlugin[] {
  const out: MovedPlugin[] = [];
  for (const status of statuses) {
    const entry = entries.find(held => held.classId === status.classId);
    if (entry?.previousBundle) {
      out.push({ trackId: status.trackId, name: entry.name || status.name, bundle: entry.bundle, previousBundle: entry.previousBundle });
    }
  }
  return out;
}

/** The entries an add just took over: a class that was in the library from another file and now comes from the new one. */
export function replacedByAdd(before: readonly PluginLibraryEntry[], after: readonly PluginLibraryEntry[]): PluginLibraryEntry[] {
  return after.filter(entry => {
    if (!entry.previousBundle) return false;
    const held = before.find(old => old.classId === entry.classId);
    return Boolean(held && held.bundle !== entry.bundle);
  });
}

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

/** The English text the native side sends when a plug-in's state would overflow the undo history (`HISTORY_FULL_MESSAGE` in `plugins/state.rs`). */
const HISTORY_FULL_MESSAGE = 'The undo history holds as much plug-in state as it can.';

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
  if (msg === 'plugin.history_full' || msg.includes(HISTORY_FULL_MESSAGE)) return t('plugin.history_full');
  if (msg.includes('Plug-in class not found in library.')) return t('plugin.error.not_in_library');
  if (msg.includes('Plug-in session is not ready.')) return t('plugin.error.not_ready');
  if (msg.includes('Invalid plug-in class ID.')) return t('plugin.error.bad_class_id');
  const reported = msg.match(/the plug-in helper reported [^:]*:\s*([\s\S]*)$/);
  if (reported) return t('plugin.error.helper_reported', { detail: reported[1] });
  const broke = msg.match(/the plug-in helper broke the protocol:\s*([\s\S]*)$/);
  if (broke) return t('plugin.error.protocol', { detail: broke[1] });
  const refused = msg.match(/request refused:\s*([\s\S]*)$/);
  if (refused) return t('plugin.error.refused', { detail: refused[1] });

  return msg;
}
