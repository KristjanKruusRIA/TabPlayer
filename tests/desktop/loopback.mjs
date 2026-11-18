import { soundRequested } from './silent-output.mjs';

/**
 * The drivers that record the output device with the WASAPI loopback helper (capture_loopback) hear only silence while the test app hands the
 * device silence (the default; see silent-output.mjs), so a pitch, an onset time or an RMS taken from the recording says nothing. They are
 * therefore only run when sound was asked for in the shell that runs the driver (TABPLAYER_TEST_SILENT_OUTPUT=0), never by this module.
 * Under silent output a driver keeps pressing Play and keeps the checks that do not need to hear anything, takes the rendered output meter
 * the app reports (`audio_status` outputPeak and renderedFrames, which the silent mode leaves untouched) in place of the recorded peak, and calls
 * `notRunnableUnderSilence` for each check it cannot make, so the run says plainly what it did not look at.
 */
export const loopbackRunnable = () => soundRequested();

const skipped = [];
/** Records and prints that an audible check was not made. `label` says what it would have shown. */
export function notRunnableUnderSilence(label) {
  skipped.push(label);
  console.log(`NOT RUN under silent output (the loopback recording would be silence): ${label}`);
}
/** One line at the end of a driver naming every audible check it skipped, or '' when it skipped none. */
export function silenceSummary() {
  return skipped.length ? `Audible checks not run under silent output (${skipped.length}): ${skipped.join('; ')}` : '';
}
