import type { model } from '@coderline/alphatab';
import { resolvePercussionArticulation, standardPercussionCatalog } from '../editor/percussion-catalog';
import { standardArticulationId } from './kit-sound';

const standardIds = new Set(standardPercussionCatalog.map(entry => entry.id));

/** Whether `id` is a standard articulation. */
export const isStandardArticulation = (id: number): boolean => standardIds.has(id);

/**
 * A track's own articulation that carries the id of a standard one under its own table entry: alphaTab's Guitar Pro 7 importer
 * reads an articulation's `id` from the first of its InputMidiNumbers, and the standard set's ids are those numbers. It counts only
 * where the piece and the sound agree with the catalogue, so a custom articulation that merely reuses a number does not.
 */
function gpIdMatch(track: model.Track, id: number): number | undefined {
  if (id >= track.percussionArticulations.length) return undefined;
  const articulation = resolvePercussionArticulation(track, id);
  if (!articulation) return undefined;
  return standardPercussionCatalog.some(entry => entry.id === articulation.id && entry.element === articulation.elementType && entry.outputMidiNumber === articulation.outputMidiNumber) ? articulation.id : undefined;
}

/** The standard articulation a drum note's articulation is, by its shape in the track's table or else by the id the file gave it. */
export function mapArticulationId(track: model.Track, id: number): number | undefined {
  return standardArticulationId(track, id) ?? gpIdMatch(track, id);
}
