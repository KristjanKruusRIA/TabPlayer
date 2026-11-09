import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  movedPlugins,
  onPluginNotice,
  onPluginStatus,
  pluginLibrary,
  pluginNotices,
  pluginStatus,
  type MovedPlugin,
  type PluginNotice,
  type TrackPluginStatus,
} from './plugin-host';

/**
 * Loads and tracks the plug-in status of all tracks in `documentId`.
 * Refreshes whenever a native `plugin-status` event is received for this document.
 */
export function usePluginStatus(documentId: string | undefined): TrackPluginStatus[] {
  const [statuses, setStatuses] = useState<TrackPluginStatus[]>([]);

  useEffect(() => {
    if (!documentId) {
      setStatuses([]);
      return;
    }
    let alive = true;

    const refresh = () => {
      pluginStatus(documentId).then(
        items => { if (alive) setStatuses(items); },
        () => { if (alive) setStatuses([]); },
      );
    };

    refresh();

    let unlisten: (() => void) | undefined;
    onPluginStatus(payload => {
      if (payload.documentId === documentId) {
        refresh();
      }
    }).then(fn => {
      if (alive) unlisten = fn;
      else fn();
    }, () => {});

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [documentId]);

  return statuses;
}

/** The tracks whose plug-in now loads from another file than before, found by joining the statuses to the library. */
export function usePluginMoves(statuses: readonly TrackPluginStatus[]): MovedPlugin[] {
  const [moved, setMoved] = useState<MovedPlugin[]>([]);
  useEffect(() => {
    if (!statuses.length) {
      setMoved([]);
      return;
    }
    let alive = true;
    pluginLibrary.list().then(
      entries => { if (alive) setMoved(movedPlugins(statuses, entries)); },
      () => { if (alive) setMoved([]); },
    );
    return () => { alive = false; };
  }, [statuses]);
  return moved;
}

/**
 * The plug-in notices for `documentId` (a plug-in that did not take new settings in time, or editor changes that could
 * not be saved), from native `plugin-notice` events and from editor closes, until the user dismisses them.
 */
export function usePluginNotices(documentId: string | undefined): PluginNotice[] {
  const all = useSyncExternalStore(pluginNotices.subscribe, pluginNotices.list);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    onPluginNotice(payload => pluginNotices.add(payload)).then(
      fn => {
        if (alive) unlisten = fn;
        else fn();
      },
      () => {},
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return useMemo(() => (documentId ? all.filter(notice => notice.documentId === documentId) : []), [all, documentId]);
}
