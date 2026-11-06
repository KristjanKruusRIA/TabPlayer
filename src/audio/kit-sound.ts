import { model } from '@coderline/alphatab';
import { resolvePercussionArticulation, standardPercussionCatalog } from '../editor/percussion-catalog';

/**
 * The recorded kit's sound for each standard Guitar Pro articulation, by its id. Most ids are General MIDI keys and sound
 * that key's recording; the rest borrow a recording of the same piece. 1 is the snare rim shot and 2 the half-open hi-hat,
 * which General MIDI lacks. `null` is a sound the kit has no recording of, which plays from the General MIDI set.
 * It must stay equal to the keys of assets/audio/drums/Programs/tabplayer-kit.sfz.
 */
const recorded = new Set([35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 67, 68, 69, 70, 71, 72, 73, 74, 75, 80, 81, 82, 83, 84]);
const borrowed = new Map<number, number | null>([
  [91, 1], [92, 2], [93, 51], [94, 51], [95, 55], [96, null], [97, 49], [98, 57], [99, 56], [100, 56], [101, 56], [102, 56],
  [103, 56], [104, 60], [105, 60], [106, 61], [107, 61], [108, 64], [109, 64], [110, 63], [111, 54], [112, 54], [113, 54],
  [114, null], [115, null], [116, null], [117, 69], [118, 70], [119, 70], [120, 70], [122, 82], [123, 84], [124, null], [125, null],
  [126, 59], [127, 53], [29, 59], [30, null], [31, null], [33, null], [34, null],
]);
/** The standard choke articulations: the cymbal is struck and stopped by hand when the note ends. */
const chokes = new Set([94, 95, 96, 97, 98, 29]);
const none = model.MusicFontSymbol.None;

/**
 * The standard articulation an articulation of this track is. A track's own table copies standard ones under its own ids,
 * so its entries are matched by piece, sound, notehead and technique; an id past the table is a standard one.
 */
export function standardArticulationId(track: model.Track, id: number): number | undefined {
  if (id >= track.percussionArticulations.length) return standardPercussionCatalog.some(entry => entry.id === id) ? id : undefined;
  const articulation = resolvePercussionArticulation(track, id);
  if (!articulation) return undefined;
  return standardPercussionCatalog.find(entry => entry.element === articulation.elementType && entry.outputMidiNumber === articulation.outputMidiNumber && entry.symbols[0] === articulation.noteHeadDefault && (entry.symbols[3] ?? none) === articulation.techniqueSymbol)?.id;
}

/** What the recorded kit plays for a drum note: its sound, if the kit has one, and whether the note is choked. */
export function kitSound(track: model.Track, id: number, key: number): { kitSound?: number; choke?: true } {
  const standard = standardArticulationId(track, id);
  // A track's own articulation that copies no standard one sounds its General MIDI key.
  const sound = standard === undefined ? (recorded.has(key) ? key : null) : borrowed.has(standard) ? borrowed.get(standard)! : recorded.has(standard) ? standard : null;
  return { ...(sound !== null ? { kitSound: sound } : {}), ...(standard !== undefined && chokes.has(standard) ? { choke: true as const } : {}) };
}
