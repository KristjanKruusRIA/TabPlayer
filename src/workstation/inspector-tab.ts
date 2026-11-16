/** The inspector's tabs. There used to be a third, Selection; it is gone (its controls moved to the palette, the menus and the Properties dialog). */
export type InspectorTab = 'song' | 'track';

const key = 'tabplayer.inspectorTab';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const browserStorage = (): PreferenceStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** The tab kept for this user. Anything else, including the removed Selection tab, reads as Track. A view preference only: it never records an edit. */
export function readInspectorTab(storage: PreferenceStorage | undefined = browserStorage()): InspectorTab {
  try {
    const stored = storage?.getItem(key);
    return stored === 'song' ? 'song' : 'track';
  } catch { return 'track'; }
}

/** Returns false when storage refuses the write. */
export function writeInspectorTab(tab: InspectorTab, storage: PreferenceStorage | undefined = browserStorage()): boolean {
  try { if (!storage) return false; storage.setItem(key, tab); return true; } catch { return false; }
}
