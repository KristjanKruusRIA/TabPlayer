/** A message a person can act on for any failure while preparing playback. Engine limits surface as RangeError. */
export function planFailureMessage(error: unknown): string {
  if (error instanceof RangeError) return 'This score is too large or complex to play: it has more notes than playback can prepare. Try a smaller score or remove repeats.';
  const detail = error instanceof Error ? error.message : String(error);
  return `Playback could not be prepared for this score: ${detail}`;
}
