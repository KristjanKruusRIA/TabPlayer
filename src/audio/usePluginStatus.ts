import { useEffect, useState } from 'react';
import { onPluginStatus, pluginStatus, type TrackPluginStatus } from './plugin-host';

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
