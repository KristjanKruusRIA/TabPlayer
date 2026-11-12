import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importer, model, Settings } from '@coderline/alphatab';
import { buildLegacyAuditScore, exportLegacyGp } from './legacy-gp-fixture';

const fixtureDir = resolve(process.cwd(), 'tests/fixtures');
const gp3Path = resolve(fixtureDir, 'legacy-gp3.gp3');
const gp4Path = resolve(fixtureDir, 'legacy-gp4.gp4');
const gp5Path = resolve(fixtureDir, 'legacy-gp5.gp5');

// Ensure fixtures exist on disk
function ensureFixtures() {
  const score = buildLegacyAuditScore();
  writeFileSync(gp3Path, exportLegacyGp(score, 300));
  writeFileSync(gp4Path, exportLegacyGp(score, 406));
  writeFileSync(gp5Path, exportLegacyGp(score, 510));
}

ensureFixtures();

describe('Legacy Guitar Pro import audit (GP3, GP4, GP5)', () => {
  const settings = new Settings();

  describe('GP3 format import (legacy-gp3.gp3)', () => {
    it('fixture file is small and exists under tests/fixtures/', () => {
      expect(existsSync(gp3Path)).toBe(true);
      const bytes = readFileSync(gp3Path);
      expect(bytes.length).toBeGreaterThan(500);
      expect(bytes.length).toBeLessThan(4000); // small authored fixture (~1.5 KB)
    });

    it('imports GP3 and verifies what survives and what is lost', () => {
      const bytes = readFileSync(gp3Path);
      const loaded = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);

      // 1. Multiple tracks survive
      expect(loaded.tracks).toHaveLength(3);
      expect(loaded.tracks[0].name).toBe('Lead Guitar');
      expect(loaded.tracks[0].playbackInfo.program).toBe(25);
      expect(loaded.tracks[0].staves[0].stringTuning.tunings).toEqual([64, 59, 55, 50, 45, 40]);

      expect(loaded.tracks[1].name).toBe('Bass');
      expect(loaded.tracks[1].playbackInfo.program).toBe(33);
      expect(loaded.tracks[1].staves[0].stringTuning.tunings).toEqual([43, 38, 33, 28]);

      // 2. Percussion track survives
      expect(loaded.tracks[2].name).toBe('Drums');
      expect(loaded.tracks[2].staves[0].isPercussion).toBe(true);
      const drumBeats = loaded.tracks[2].staves[0].bars[0].voices[0].beats;
      expect(drumBeats[0].notes[0].percussionArticulation).toBe(36); // kick
      expect(drumBeats[1].notes[0].percussionArticulation).toBe(38); // snare

      // 3. Repeats survive
      expect(loaded.masterBars).toHaveLength(2);
      expect(loaded.masterBars[0].isRepeatStart).toBe(true);
      expect(loaded.masterBars[1].isRepeatEnd).toBe(true);
      expect(loaded.masterBars[1].repeatCount).toBe(2);

      const leadBar0 = loaded.tracks[0].staves[0].bars[0].voices[0];
      const leadBar1 = loaded.tracks[0].staves[0].bars[1].voices[0];

      // 4. Hammer-on survives
      expect(leadBar0.beats[0].notes[0].isHammerPullOrigin).toBe(true);

      // 5. Slide survives (GP3 supports 1-bit shift slide)
      expect(leadBar0.beats[1].notes[0].slideOutType).toBe(model.SlideOutType.Shift);

      // 6. Harmonics:
      // Natural harmonic survives
      expect(leadBar0.beats[2].notes[0].harmonicType).toBe(model.HarmonicType.Natural);
      // In GP3, harmonics are beat-level and can be Natural or Artificial only.
      // Pinch harmonic is lost/collapsed to Artificial harmonic.
      expect(leadBar0.beats[3].notes[0].harmonicType).toBe(model.HarmonicType.Artificial);

      // 7. Single bend survives
      expect(leadBar1.beats[0].notes[0].bendPoints?.length).toBeGreaterThan(0);
      expect(leadBar1.beats[0].notes[0].bendPoints![1].value).toBe(4); // 4 semitones

      // 8. Overlapping bends survive (polyphonic bend on two strings in the same beat)
      expect(leadBar1.beats[1].notes).toHaveLength(2);
      expect(leadBar1.beats[1].notes[0].bendPoints?.length).toBeGreaterThan(0);
      expect(leadBar1.beats[1].notes[1].bendPoints?.length).toBeGreaterThan(0);

      // 9. Tuplets survive
      expect(leadBar1.beats[2].hasTuplet).toBe(true);
      expect(leadBar1.beats[2].tupletNumerator).toBe(3);
      expect(leadBar1.beats[2].tupletDenominator).toBe(2);

      // 10. GP3 generation losses / unsupported features:
      // Voice 2 is unsupported in GP3: each bar has exactly 1 voice
      expect(loaded.tracks[0].staves[0].bars[0].voices).toHaveLength(1);
      // Note-level independent harmonic types on the same beat are unsupported (beat-level only)
      // Direction jumps (Coda, Segno, Fine, Da Capo) are unsupported in GP3
      expect(loaded.masterBars[0].directions ?? []).toHaveLength(0);
    });
  });

  describe('GP4 format import (legacy-gp4.gp4)', () => {
    it('fixture file is small and exists under tests/fixtures/', () => {
      expect(existsSync(gp4Path)).toBe(true);
      const bytes = readFileSync(gp4Path);
      expect(bytes.length).toBeGreaterThan(500);
      expect(bytes.length).toBeLessThan(4000); // small authored fixture (~1.5 KB)
    });

    it('imports GP4 and verifies what survives and what is lost', () => {
      const bytes = readFileSync(gp4Path);
      const loaded = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);

      // 1. Multiple tracks survive
      expect(loaded.tracks).toHaveLength(3);
      expect(loaded.tracks[0].name).toBe('Lead Guitar');
      expect(loaded.tracks[0].playbackInfo.program).toBe(25);
      expect(loaded.tracks[0].staves[0].stringTuning.tunings).toEqual([64, 59, 55, 50, 45, 40]);

      expect(loaded.tracks[1].name).toBe('Bass');
      expect(loaded.tracks[1].playbackInfo.program).toBe(33);
      expect(loaded.tracks[1].staves[0].stringTuning.tunings).toEqual([43, 38, 33, 28]);

      // 2. Percussion track survives
      expect(loaded.tracks[2].name).toBe('Drums');
      expect(loaded.tracks[2].staves[0].isPercussion).toBe(true);
      const drumBeats = loaded.tracks[2].staves[0].bars[0].voices[0].beats;
      expect(drumBeats[0].notes[0].percussionArticulation).toBe(36);
      expect(drumBeats[1].notes[0].percussionArticulation).toBe(38);

      // 3. Repeats survive
      expect(loaded.masterBars).toHaveLength(2);
      expect(loaded.masterBars[0].isRepeatStart).toBe(true);
      expect(loaded.masterBars[1].isRepeatEnd).toBe(true);
      expect(loaded.masterBars[1].repeatCount).toBe(2);

      const leadBar0 = loaded.tracks[0].staves[0].bars[0].voices[0];
      const leadBar1 = loaded.tracks[0].staves[0].bars[1].voices[0];

      // 4. Hammer-on survives
      expect(leadBar0.beats[0].notes[0].isHammerPullOrigin).toBe(true);

      // 5. Slide survives
      expect(leadBar0.beats[1].notes[0].slideOutType).toBe(model.SlideOutType.Shift);

      // 6. Harmonics:
      // Note-level Natural harmonic survives
      expect(leadBar0.beats[2].notes[0].harmonicType).toBe(model.HarmonicType.Natural);
      // Note-level Pinch harmonic survives in GP4 (GP4 added note-level harmonic types)
      expect(leadBar0.beats[3].notes[0].harmonicType).toBe(model.HarmonicType.Pinch);

      // 7. Single bend survives
      expect(leadBar1.beats[0].notes[0].bendPoints?.length).toBeGreaterThan(0);
      expect(leadBar1.beats[0].notes[0].bendPoints![1].value).toBe(4);

      // 8. Overlapping bends survive
      expect(leadBar1.beats[1].notes).toHaveLength(2);
      expect(leadBar1.beats[1].notes[0].bendPoints?.length).toBeGreaterThan(0);
      expect(leadBar1.beats[1].notes[1].bendPoints?.length).toBeGreaterThan(0);

      // 9. Tuplets survive
      expect(leadBar1.beats[2].hasTuplet).toBe(true);
      expect(leadBar1.beats[2].tupletNumerator).toBe(3);
      expect(leadBar1.beats[2].tupletDenominator).toBe(2);

      // 10. GP4 generation losses / unsupported features:
      // Voice 2 is still unsupported in GP4: each bar has 1 voice only
      expect(loaded.tracks[0].staves[0].bars[0].voices).toHaveLength(1);
      // Directions (Coda, Segno, Fine, Da Capo) are unsupported in GP4 (introduced in GP5)
      expect(loaded.masterBars[0].directions ?? []).toHaveLength(0);
    });
  });

  describe('GP5 format import (legacy-gp5.gp5)', () => {
    it('fixture file is small and exists under tests/fixtures/', () => {
      expect(existsSync(gp5Path)).toBe(true);
      const bytes = readFileSync(gp5Path);
      expect(bytes.length).toBeGreaterThan(500);
      expect(bytes.length).toBeLessThan(4000); // small authored fixture (~2 KB)
    });

    it('imports GP5 and verifies what survives and what is lost', () => {
      const bytes = readFileSync(gp5Path);
      const loaded = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);

      // 1. Multiple tracks survive
      expect(loaded.tracks).toHaveLength(3);
      expect(loaded.tracks[0].name).toBe('Lead Guitar');
      expect(loaded.tracks[0].playbackInfo.program).toBe(25);
      expect(loaded.tracks[0].staves[0].stringTuning.tunings).toEqual([64, 59, 55, 50, 45, 40]);

      expect(loaded.tracks[1].name).toBe('Bass');
      expect(loaded.tracks[1].playbackInfo.program).toBe(33);
      expect(loaded.tracks[1].staves[0].stringTuning.tunings).toEqual([43, 38, 33, 28]);

      // 2. Percussion track survives
      expect(loaded.tracks[2].name).toBe('Drums');
      expect(loaded.tracks[2].staves[0].isPercussion).toBe(true);
      const drumBeats = loaded.tracks[2].staves[0].bars[0].voices[0].beats;
      expect(drumBeats[0].notes[0].percussionArticulation).toBe(36);
      expect(drumBeats[1].notes[0].percussionArticulation).toBe(38);

      // 3. Repeats survive
      expect(loaded.masterBars).toHaveLength(2);
      expect(loaded.masterBars[0].isRepeatStart).toBe(true);
      expect(loaded.masterBars[1].isRepeatEnd).toBe(true);
      expect(loaded.masterBars[1].repeatCount).toBe(2);

      const leadBar0 = loaded.tracks[0].staves[0].bars[0].voices[0];
      const leadBar1 = loaded.tracks[0].staves[0].bars[1].voices[0];

      // 4. Hammer-on survives
      expect(leadBar0.beats[0].notes[0].isHammerPullOrigin).toBe(true);

      // 5. Slide survives
      expect(leadBar0.beats[1].notes[0].slideOutType).toBe(model.SlideOutType.Shift);

      // 6. Harmonics:
      expect(leadBar0.beats[2].notes[0].harmonicType).toBe(model.HarmonicType.Natural);
      expect(leadBar0.beats[3].notes[0].harmonicType).toBe(model.HarmonicType.Pinch);

      // 7. Single bend survives
      expect(leadBar1.beats[0].notes[0].bendPoints?.length).toBeGreaterThan(0);
      expect(leadBar1.beats[0].notes[0].bendPoints![1].value).toBe(4);

      // 8. Overlapping bends survive
      expect(leadBar1.beats[1].notes).toHaveLength(2);
      expect(leadBar1.beats[1].notes[0].bendPoints?.length).toBeGreaterThan(0);
      expect(leadBar1.beats[1].notes[1].bendPoints?.length).toBeGreaterThan(0);

      // 9. Tuplets survive
      expect(leadBar1.beats[2].hasTuplet).toBe(true);
      expect(leadBar1.beats[2].tupletNumerator).toBe(3);
      expect(leadBar1.beats[2].tupletDenominator).toBe(2);

      // 10. GP5 generation features & limits:
      // GP5 supports 2 voices per bar:
      expect(loaded.tracks[0].staves[0].bars[0].voices).toHaveLength(2);
      // Voices beyond 2 are unsupported in GP5 format
      // Modern tempo units are unsupported (quarter BPM only)
      // Backing audio tracks and alignment are unsupported in GP5
    });
  });
});
