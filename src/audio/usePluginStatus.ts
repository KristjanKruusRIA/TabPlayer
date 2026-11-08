import { useEffect, useState } from 'react';
import { movedPlugins, onPluginStatus, pluginLibrary, pluginStatus, type MovedPlugin, type TrackPluginStatus } from './plugin-host';

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
