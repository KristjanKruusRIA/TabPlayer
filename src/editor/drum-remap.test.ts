import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { blankProject } from '../project';
import { previewEdit } from '../engine';
import { exportMidi } from '../export/midi';
import { collectTrackDrumSounds, presetRemapForTrack, remapPercussionTrack } from './drum-remap';

function drumScore(articulations: number[][]): { score: model.Score; trackIndex: number } {
  const project = blankProject();
  const built = previewEdit(project, { type: 'addPercussionTrack', name: 'Drums', program: 0 });
  const score = built.score;
  const trackIndex = score.tracks.findIndex(t => t.isPercussion);
  const voice = score.tracks[trackIndex].staves[0].bars[0].voices[0];
  articulations.forEach((hits, beatIdx) => {
    const beat = voice.beats[beatIdx];
    beat.isEmpty = false;
    for (const id of hits) {
      const note = new model.Note();
      note.percussionArticulation = id;
      beat.addNote(note);
    }
  });
  return { score, trackIndex };
}

describe('drum-remap', () => {
  it('collects used drum sounds and remaps hits, collapsing duplicate articulations and removing null hits', () => {
    const { score, trackIndex } = drumScore([[36, 42], [38, 42], [44]]);
    const sounds = collectTrackDrumSounds(score.tracks[trackIndex]);
    expect(sounds.map(s => [s.sourceId, s.count])).toEqual([[36, 1], [38, 1], [42, 2], [44, 1]]);

    // Map 42 -> 46 (Hi-Hat open) and 44 -> null (removed, leaving beat 2 empty)
    const changed = remapPercussionTrack(score, trackIndex, [[42, 46], [44, null]]);
    expect(changed).toBe(true);

    const voice = score.tracks[trackIndex].staves[0].bars[0].voices[0];
    expect(voice.beats[0].notes.map(n => n.percussionArticulation)).toEqual([36, 46]);
    expect(voice.beats[1].notes.map(n => n.percussionArticulation)).toEqual([38, 46]);
    expect(voice.beats[2].notes).toHaveLength(0);
    expect(voice.beats[2].isEmpty).toBe(true);
  });

  it('drops duplicate target articulations created when merging two hits in the same beat', () => {
    const { score, trackIndex } = drumScore([[35, 36]]);
    remapPercussionTrack(score, trackIndex, [[35, 36]]);
    const notes = score.tracks[trackIndex].staves[0].bars[0].voices[0].beats[0].notes;
    expect(notes.map(n => n.percussionArticulation)).toEqual([36]);
  });

  it('suggests remapping from non-GM drum map presets', () => {
    const { score, trackIndex } = drumScore([[36], [38], [42]]);
    const sounds = collectTrackDrumSounds(score.tracks[trackIndex]);
    const suggestions = presetRemapForTrack(sounds, { preset: 'ezdrummer-3' });
    expect(suggestions instanceof Map).toBe(true);
  });

  it('translates drum notes from one mapping to another and exports under the target mapping', () => {
    // Score hits 43 and 36 were interpreted under soundblind-powerkit (keys 42 and 36).
    // Switching to gm with note updates ON re-interprets those keys into GM articulations 42 (closed hat) and 36 (kick).
    const { score, trackIndex } = drumScore([[43], [36]]);
    const sounds = collectTrackDrumSounds(score.tracks[trackIndex]);
    const fromPowerkitToGm = presetRemapForTrack(sounds, undefined, { preset: 'soundblind-powerkit' });
    expect(fromPowerkitToGm).toEqual(new Map([[43, 42]]));

    remapPercussionTrack(score, trackIndex, [...fromPowerkitToGm.entries()].sort((a, b) => a[0] - b[0]));
    const exported = exportMidi(score, { tracks: [trackIndex], range: null }, { drumMaps: [undefined, { preset: 'soundblind-counterkit' }] });
    // Extract channel-9 NoteOn keys from exported SMF bytes:
    const noteKeys: number[] = [];
    const view = new DataView(exported.buffer, exported.byteOffset, exported.byteLength);
    let p = 14;
    while (p < exported.length) {
      p += 4;
      const end = p + 4 + view.getUint32(p);
      p += 4;
      let status = 0;
      const vlq = () => { let n = 0; do { n = exported[p++]; } while (n & 128); };
      while (p < end) {
        vlq();
        let ev = exported[p++];
        if (ev < 128) { p--; ev = status; } else if (ev < 240) status = ev;
        if (ev === 255) { p++; let l = 0, b = 0; do { b = exported[p++]; l = (l << 7) | (b & 127); } while (b & 128); p += l; }
        else if (ev === 240 || ev === 247) { let l = 0, b = 0; do { b = exported[p++]; l = (l << 7) | (b & 127); } while (b & 128); p += l; }
        else { const len = (ev & 240) === 192 || (ev & 240) === 208 ? 1 : 2; if ((ev & 240) === 0x90 && (ev & 15) === 9 && exported[p + 1] > 0) noteKeys.push(exported[p]); p += len; }
      }
    }
    // Under soundblind-counterkit: 42 (closed hat) -> key 62, 36 (kick) -> key 36.
    expect(noteKeys).toEqual([62, 36]);
  });
});
