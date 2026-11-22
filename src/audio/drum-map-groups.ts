import { model } from '@coderline/alphatab';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { drumPieces, instrumentHits, percussionInstruments, type Instrument } from '../instruments/drum-kit';
import type { MessageKey } from '../i18n';
import maps from './drum-maps.json';

/** `piece` is the kit piece's label, which a flat list names the sound by; `sound` is the whole name that assistive technology reads. */
export interface DrumSoundRow {
  id: number;
  piece: string;
  name: string;
  sound: string;
  plain: number;
}

export interface DrumSoundGroup {
  id: string;
  label: string;
  kit: boolean;
  rows: DrumSoundRow[];
}

let built: DrumSoundGroup[] | undefined;

/**
 * Every standard sound under the piece that owns it, in the order of the drum kit and then the other percussion, named as the note-entry
 * view names them (the piece's label and the hit's name). A sound nobody owns, which the catalogue does not have today, would be
 * listed last so that no row of a map is out of reach.
 */
export function drumSoundGroups(): DrumSoundGroup[] {
  if (built) return built;
  const blank = new model.Track();
  const standard = new Set(maps.sounds.map(([id]) => id));
  const seen = new Set<number>();
  const out: DrumSoundGroup[] = [];
  const add = (items: readonly Instrument[], kit: boolean) => {
    for (const item of items) {
      const hits = instrumentHits(blank, item).filter(hit => standard.has(hit.id) && !seen.has(hit.id));
      if (!hits.length) continue;
      const plain = instrumentHits(blank, item).find(hit => hit.id === item.hit);
      for (const hit of hits) seen.add(hit.id);
      out.push({
        id: item.id,
        label: item.label,
        kit,
        rows: hits.map(hit => ({
          id: hit.id,
          piece: item.label,
          name: hit.name,
          sound: `${item.label} ${hit.name}`,
          plain: plain ? plain.id : hit.id,
        })),
      });
    }
  };
  add(drumPieces, true);
  add(percussionInstruments, false);
  const rest = [...standard].filter(id => !seen.has(id));
  if (rest.length) {
    out.push({
      id: 'other',
      label: '',
      kit: false,
      rows: rest.map(id => {
        const label = standardPercussionCatalog.find(entry => entry.id === id)?.label ?? String(id);
        return { id, piece: '', name: label, sound: label, plain: id };
      }),
    });
  }
  built = out;
  return out;
}

/** Localized sound groups in the shown language; an id the translation catalog does not know keeps its English name. */
export function localizedDrumSoundGroups(t: (key: MessageKey) => string): DrumSoundGroup[] {
  const say = (key: string, fallback: string): string => t(key as MessageKey) || fallback;
  return drumSoundGroups().map(group => {
    const groupLabel = group.label ? say(`drum_piece.${group.id}`, group.label) : '';
    return {
      ...group,
      label: groupLabel,
      rows: group.rows.map(item => {
        const name = say(`drum_sound.${item.id}`, item.name);
        const piece = item.piece ? say(`drum_piece.${group.id}`, item.piece) : '';
        return { ...item, piece, name, sound: piece ? `${piece} ${name}` : name };
      }),
    };
  });
}
