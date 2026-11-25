import { model } from '@coderline/alphatab';
import type { DrumMapRef } from '../edit-types';
import { isStandardArticulation, mapArticulationId, resolveInputDrumMap } from '../audio/drum-map';
import { detachNote } from './links';
import { resolvePercussionArticulation, standardPercussionCatalog } from './percussion-catalog';

export interface TrackDrumSound {
  /** Stored `note.percussionArticulation` value found on notes in the track. */
  sourceId: number;
  /** Standard catalog ID if resolved, else `null`. */
  standardId: number | null;
  /** GM / output MIDI key associated with this sound (`0..127`). */
  midiKey: number;
  /** Total note hits across the track. */
  count: number;
  /** Fallback display label from custom track articulation table, if any. */
  customLabel?: string;
}

export function collectTrackDrumSounds(track: model.Track): TrackDrumSound[] {
  const bySource = new Map<number, number>();
  for (const staff of track.staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            if (!note.isPercussion) continue;
            const id = note.percussionArticulation;
            if (!Number.isInteger(id) || id < 0 || id > 255) continue;
            bySource.set(id, (bySource.get(id) ?? 0) + 1);
          }
        }
      }
    }
  }
  const result: TrackDrumSound[] = [];
  for (const [sourceId, count] of [...bySource.entries()].sort((a, b) => a[0] - b[0])) {
    const standardId = mapArticulationId(track, sourceId) ?? (isStandardArticulation(sourceId) && sourceId >= track.percussionArticulations.length ? sourceId : null);
    const articulation = resolvePercussionArticulation(track, sourceId);
    const midiKey = articulation?.outputMidiNumber ?? (standardId !== null ? standardId : sourceId & 127);
    const customLabel = sourceId < track.percussionArticulations.length ? track.percussionArticulations[sourceId]?.elementType || undefined : undefined;
    result.push({ sourceId, standardId, midiKey, count, ...(customLabel ? { customLabel } : {}) });
  }
  return result;
}

export function presetRemapForTrack(
  sounds: readonly TrackDrumSound[],
  mapRef: DrumMapRef | undefined,
): Map<number, number | null> {
  const inputMap = resolveInputDrumMap(mapRef);
  const result = new Map<number, number | null>();
  for (const sound of sounds) {
    const next = sound.midiKey >= 0 && sound.midiKey <= 127 ? inputMap[sound.midiKey] : null;
    const currentEffective = sound.standardId ?? sound.sourceId;
    if (next !== currentEffective) {
      result.set(sound.sourceId, next);
    }
  }
  return result;
}

export function validateRemapPercussionMap(map: unknown): asserts map is [number, number | null][] {
  if (!Array.isArray(map) || map.length < 1 || map.length > 128) {
    throw new Error('Percussion remap needs 1 to 128 mapping rows.');
  }
  let previous = -1;
  for (const entry of map) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error('Each percussion remap row needs [from, to].');
    }
    const [from, to] = entry as unknown[];
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from > 255 || from <= previous) {
      throw new Error('Percussion remap source ids must be strictly ascending integers from 0 to 255.');
    }
    if (to !== null && (typeof to !== 'number' || !isStandardArticulation(to))) {
      throw new Error('Percussion remap target must be a standard drum articulation or null.');
    }
    previous = from;
  }
}

const standardById = new Map(standardPercussionCatalog.map(entry => [entry.id, entry]));

function resolveTargetArticulationId(track: model.Track, targetStandardId: number): number {
  if (track.percussionArticulations.length === 0) return targetStandardId;
  for (let i = 0; i < track.percussionArticulations.length; i++) {
    if (mapArticulationId(track, i) === targetStandardId) return i;
  }
  const entry = standardById.get(targetStandardId);
  if (!entry) throw new Error('Select a playable registered percussion articulation.');
  const nextIndex = track.percussionArticulations.length;
  track.percussionArticulations.push(
    new model.InstrumentArticulation(
      entry.element,
      entry.staffLine,
      entry.outputMidiNumber,
      entry.symbols[0],
      entry.symbols[1],
      entry.symbols[2],
      entry.symbols[3],
      entry.symbols[4],
      entry.id,
    ),
  );
  return nextIndex;
}

export function remapPercussionTrack(
  score: model.Score,
  trackIndex: number,
  entries: readonly [number, number | null][],
): boolean {
  validateRemapPercussionMap(entries);
  const track = score.tracks[trackIndex];
  if (!track || !track.isPercussion) {
    throw new Error('Select a percussion track.');
  }
  const resolved = new Map<number, number | null>();
  for (const [from, to] of entries) {
    resolved.set(from, to === null ? null : resolveTargetArticulationId(track, to));
  }
  for (const staff of track.staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          const seenArticulations = new Set<number>();
          const removeList: model.Note[] = [];
          let touched = false;
          for (const note of beat.notes) {
            if (!note.isPercussion) continue;
            const currentId = note.percussionArticulation;
            if (resolved.has(currentId)) {
              const nextId = resolved.get(currentId)!;
              touched = true;
              if (nextId === null || seenArticulations.has(nextId)) {
                removeList.push(note);
              } else {
                note.percussionArticulation = nextId;
                seenArticulations.add(nextId);
              }
            } else {
              if (seenArticulations.has(currentId)) {
                touched = true;
                removeList.push(note);
              } else {
                seenArticulations.add(currentId);
              }
            }
          }
          if (touched) {
            for (const doomed of removeList) {
              detachNote(doomed);
              beat.removeNote(doomed);
            }
            beat.notes.forEach((n, index) => { n.index = index; });
            beat.noteValueLookup.clear();
            if (beat.notes.length === 0) beat.isEmpty = true;
          }
        }
      }
    }
  }
  return true;
}
