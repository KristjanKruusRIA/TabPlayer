import type { MessageKey } from '../i18n/en';

/** The native diagnostics and test-tone commands refuse with a stable code; the interface words it. */
export function audioErrorKey(error: unknown): MessageKey {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  switch (code) {
    case 'audio_output_failed': return 'audio.error.output_failed';
    case 'audio_output_unavailable': return 'audio.error.unavailable';
    case 'audio_test_tone_playback': return 'audio.error.tone_playback';
    default: return 'audio.error.generic';
  }
}
