import maps from './drum-maps.json';

/** Phrases the layouts data uses that are not a product or maker: a technical standard and a licence. */
const GENERIC = new Set(['General MIDI', 'MIDI', 'MIT']);

/**
 * The product, maker and outside-source names in the layouts file, derived from it so that a new layout or a new source cannot slip past a
 * fixed list: parts of each layout's name, and every capitalised phrase inside a source paragraph that does not start its sentence.
 */
export function brandWords(): string[] {
  const words = new Set<string>();
  for (const preset of maps.presets as { name?: string; source?: string }[]) {
    if (preset.name) {
      const tokens = preset.name.split(/\s+/), rest = tokens.slice(1).join(' ');
      for (const phrase of [preset.name, tokens[0], rest, rest.replace(/\s+\d+$/, ''), preset.name.replace(/^.*\bDrums\s+/, '')]) if (phrase.length >= 6) words.add(phrase);
    }
    for (const sentence of (preset.source ?? '').split(/(?<=[.!?])\s+/)) {
      const inside = sentence.replace(/^\S+\s*/, '');
      for (const match of inside.matchAll(/\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*/g)) if (!GENERIC.has(match[0])) words.add(match[0]);
    }
  }
  return [...words];
}

/** Which of the words `text` names as a whole word, ignoring case. */
export const namesBrand = (text: string, words: readonly string[] = brandWords()): string[] =>
  words.filter(word => new RegExp(`(?<![A-Za-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text));
