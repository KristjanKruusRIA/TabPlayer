import { invoke } from '@tauri-apps/api/core';

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
}

/** The plug-in library: the effects the user picked from `.vst3` files on this computer. A document names a class by its identity and never holds the plug-in. */
export const pluginLibrary = {
  list: () => invoke<PluginLibraryEntry[]>('plugin_library_list'),
  /** Asks for a `.vst3` file and scans it, which can take a minute. Resolves to the whole library, or null when the dialog is cancelled; a rejection says why the file was refused. */
  add: () => invoke<PluginLibraryEntry[] | null>('plugin_library_add'),
  remove: (classId: string) => invoke<void>('plugin_library_remove', { classId }),
};
