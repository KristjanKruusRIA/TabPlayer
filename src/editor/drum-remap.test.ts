import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { blankProject } from '../project';
import { previewEdit } from '../engine';
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
});
