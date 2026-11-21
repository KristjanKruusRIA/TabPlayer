import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { kitSound, RECORDED_KIT_SOUNDS, standardArticulationId } from './kit-sound';

const kitKeys = () => RECORDED_KIT_SOUNDS;
const drums = (articulations: model.InstrumentArticulation[] = []) => { const track = new model.Track(); track.percussionArticulations = articulations; return track; };
const copy = (id: number) => {
  const entry = standardPercussionCatalog.find(item => item.id === id)!;
  return new model.InstrumentArticulation(entry.element, entry.staffLine, entry.outputMidiNumber, entry.symbols[0], entry.symbols[1], entry.symbols[2], entry.symbols[3], entry.symbols[4]);
};

describe('recorded kit sounds', () => {
  it('names only sounds the kit map has, and every sound it has is reachable', () => {
    const keys = kitKeys(), track = drums(), named = new Set<number>();
    for (const entry of standardPercussionCatalog) {
      const sound = kitSound(track, entry.id, entry.outputMidiNumber).kitSound;
      if (sound !== undefined) { expect(keys.has(sound), `${entry.label} → ${sound}`).toBe(true); named.add(sound); }
    }
    expect([...keys].filter(key => !named.has(key))).toEqual([]);
  });
  it('tells articulations that share a pitch apart, and chokes only the choke articulations', () => {
    const track = drums();
    expect(kitSound(track, 38, 38)).toEqual({ kitSound: 38 });
    expect(kitSound(track, 91, 38)).toEqual({ kitSound: 1 });
    expect(kitSound(track, 46, 46)).toEqual({ kitSound: 46 });
    expect(kitSound(track, 92, 46)).toEqual({ kitSound: 2 });
    expect(kitSound(track, 94, 51)).toEqual({ kitSound: 51, choke: true });
    expect(kitSound(track, 97, 49)).toEqual({ kitSound: 49, choke: true });
    expect(kitSound(track, 84, 53)).toEqual({ kitSound: 84 });
    expect(kitSound(track, 52, 52)).toEqual({ kitSound: 52 });
    expect(kitSound(track, 96, 52)).toEqual({ kitSound: 52, choke: true });
    expect(kitSound(track, 40, 40)).toEqual({ kitSound: 40 });
    // Unrecorded articulations (ticks/metronome/golpe) fall back to GM without a kitSound.
    expect(kitSound(track, 30, 30)).toEqual({});
    expect(kitSound(track, 33, 33)).toEqual({});
    expect(kitSound(track, 124, 37)).toEqual({});
  });
  it("reads a track's own table by what each entry copies, not by its id", () => {
    // A Guitar Pro file numbers its own table: here 0 is the rim shot and 1 the ride choke.
    const custom = new model.InstrumentArticulation('Snare', 3, 41, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadBlack);
    const track = drums([copy(91), copy(94), custom]);
    expect(standardArticulationId(track, 0)).toBe(91);
    expect(kitSound(track, 0, 38)).toEqual({ kitSound: 1 });
    expect(kitSound(track, 1, 51)).toEqual({ kitSound: 51, choke: true });
    // An entry that copies no standard one sounds its own pitch, where the kit has it, else GM.
    expect(standardArticulationId(track, 2)).toBeUndefined();
    expect(kitSound(track, 2, 41)).toEqual({ kitSound: 41 });
    expect(kitSound(track, 2, 40)).toEqual({ kitSound: 40 });
    expect(kitSound(track, 2, 33)).toEqual({});
  });
});
