// The desktop test app hands the output device silence by default (TABPLAYER_TEST_SILENT_OUTPUT, desktop-test builds only), so a
// driver that presses Play is never heard. Set TABPLAYER_TEST_SILENT_OUTPUT=0 in the shell that runs a driver to hear it.
/** Whether the person running the drivers asked for sound. */
export const soundRequested = () => process.env.TABPLAYER_TEST_SILENT_OUTPUT === '0';
/** The launch environment's setting: silent unless sound was asked for in the shell that runs the driver. */
export const silentOutputEnvironment = () => ({ TABPLAYER_TEST_SILENT_OUTPUT: soundRequested() ? '0' : '1' });
/**
 * Refuses to go on when the running app is about to play audibly by accident: asks the app (the desktop-test command) whether its
 * output is silent. A stale build without the mode, or a launch that turned it off, stops here before any driver presses Play.
 */
export async function assertSilentOutput(page, timeoutMs = 30000) {
  if (soundRequested()) return 'sound requested';
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke('desktop_test_silent_output'));
      if (last === true) return 'silent';
      if (last === false) break;
    } catch (error) { last = String(error?.message ?? error); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`The desktop test app is not running with silent output (reported ${JSON.stringify(last)}). Rebuild it (scripts/build-desktop-test.ps1) or unset TABPLAYER_TEST_SILENT_OUTPUT; set it to 0 only to hear a run.`);
}
