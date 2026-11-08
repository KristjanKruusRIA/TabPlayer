import { vi } from 'vitest';

// Import this first in a test file that renders the sound panel but is not about plug-ins. The panel asks the native side for
// the plug-in library when it mounts, and it shows a failure of that call (it must not hide one). Outside the app there is
// no native side, so without this the panel would show an alert in every such test. The answers here are an empty library
// and no statuses, and every other command fails as it did; a file that mocks `@tauri-apps/api/core` itself overrides them.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'plugin_library_list' || command === 'plugin_status') return [];
    // Every other command behaves as before: with no native side the call fails the way the real `invoke` does in a browser.
    throw new TypeError("Cannot read properties of undefined (reading 'invoke')");
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
