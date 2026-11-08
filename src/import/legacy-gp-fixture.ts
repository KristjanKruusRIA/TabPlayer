import { model, Settings } from '@coderline/alphatab';

class Out {
  readonly data: number[] = [];
  byte(value: number): void { this.data.push(value & 255); }
  short(value: number): void { this.byte(value); this.byte(value >> 8); }
  int(value: number): void { this.short(value); this.short(value >> 16); }
  raw(bytes: ArrayLike<number>): void { for (let i = 0; i < bytes.length; i++) this.data.push(bytes[i] & 255); }
  zeros(count: number): void { for (let i = 0; i < count; i++) this.data.push(0); }
  toBytes(): Uint8Array { return Uint8Array.from(this.data); }
}

function fixedString(out: Out, text: string, field: number): void {
  const bytes = new TextEncoder().encode(text);
  out.byte(bytes.length);
  out.raw(bytes);
  out.zeros(field - bytes.length);
}

function sizedString(out: Out, text: string): void {
  const bytes = new TextEncoder().encode(text);
  out.int(bytes.length + 1);
  out.byte(bytes.length);
  out.raw(bytes);
}

function longString(out: Out, text: string): void {
  const bytes = new TextEncoder().encode(text);
  out.int(bytes.length);
  out.raw(bytes);
}

/**
 * Encodes an alphaTab Score into a Guitar Pro 3 (300), 4 (406), or 5 (510) binary format
 * conforming directly to alphaTab's Gp3To5Importer specifications.
 */
export function exportLegacyGp(score: model.Score, version: 300 | 400 | 406 | 500 | 510): Uint8Array {
  const out = new Out();

  // 1. Version header (30 bytes fixed string)
  const verStr = version >= 500 ? 'FICHIER GUITAR PRO v5.10' :
                 version >= 400 ? 'FICHIER GUITAR PRO v4.06' :
                                  'FICHIER GUITAR PRO v3.00';
  fixedString(out, verStr, 30);

  // 2. Score info
  sizedString(out, score.title || '');
  sizedString(out, score.subTitle || '');
  sizedString(out, score.artist || '');
  sizedString(out, score.album || '');
  sizedString(out, score.words || '');
  if (version >= 500) {
    sizedString(out, score.music || '');
  }
  sizedString(out, score.copyright || '');
  sizedString(out, score.tab || '');
  sizedString(out, score.instructions || '');
  out.int(0); // notice line count = 0

  // 3. Triplet feel (< 500)
  if (version < 500) {
    out.byte(0); // triplet feel = false
  }

  // 4. Lyrics (>= 400)
  if (version >= 400) {
    out.int(0); // lyrics track = 0
    for (let i = 0; i < 5; i++) {
      out.int(1); // startBar = 1
      longString(out, ''); // empty lyrics
    }
  }

  // 5. Page setup & tempo
  if (version >= 510) {
    out.int(100);
    out.zeros(15);
  }
  if (version >= 500) {
    // Page setup
    for (const v of [210, 297, 10, 10, 15, 10, 100]) out.int(v);
    out.short(0x1ff);
    for (const t of [
      '%TITLE%', '%SUBTITLE%', '%ARTIST%', '%ALBUM%',
      'Words by %WORDS%', 'Music by %MUSIC%', 'Words & Music by %WORDSMUSIC%',
      'Copyright %COPYRIGHT%', 'All Rights Reserved - International Copyright Secured', 'Page %N%/%P%'
    ]) sizedString(out, t);
    sizedString(out, score.tempoLabel || '');
  }

  // Tempo value
  out.int(120);
  if (version >= 510) {
    out.byte(0); // hide tempo = false
  }
  out.int(0); // key signature
  if (version >= 400) {
    out.byte(0); // octave = 0
  }

  // 6. Playback infos (64 entries * 12 bytes)
  const channelPrograms = new Map<number, number>();
  for (let t = 0; t < score.tracks.length; t++) {
    const trk = score.tracks[t];
    const isP = trk.staves[0].isPercussion;
    const c = isP ? 9 : (t === 0 ? 0 : 2); // 0-based channel
    channelPrograms.set(c, trk.playbackInfo.program);
    if (!isP) channelPrograms.set(c + 1, trk.playbackInfo.program);
  }
  for (let i = 0; i < 64; i++) {
    const isPerc = i % 16 === 9;
    const prog = channelPrograms.get(i) ?? (isPerc ? 0 : 25);
    out.int(prog);
    out.byte(13); // volume
    out.byte(8);  // balance
    out.zeros(6); // chorus, reverb, phaser, tremolo, blanks
  }

  // 7. Directions (>= 500)
  if (version >= 500) {
    for (let i = 0; i < 19; i++) out.short(-1);
    out.int(0); // padding
  }

  // 8. Bar count and Track count
  out.int(score.masterBars.length);
  out.int(score.tracks.length);

  // 9. Master Bars
  for (let b = 0; b < score.masterBars.length; b++) {
    const mb = score.masterBars[b];
    const isRepStart = mb.isRepeatStart;
    const isRepEnd = mb.repeatCount > 0;
    const flags = (b === 0 ? 3 : 0) | (isRepStart ? 4 : 0) | (isRepEnd ? 8 : 0);
    out.byte(flags);
    if (b === 0) {
      out.byte(4); // 4/4
      out.byte(4);
    }
    if (isRepEnd) {
      // In GP3 and GP4 (< 500), repeatCount is stored as count - 1
      // In GP5 (>= 500), repeatCount is stored as count
      out.byte(version >= 500 ? mb.repeatCount : mb.repeatCount - 1);
    }
    if (version >= 500) {
      if (b === 0) out.raw([2, 2, 2, 2]); // beam groups
      out.byte(0); // alternate endings
      out.byte(0); // triplet feel
      out.byte(0); // padding
    }
  }

  // 10. Tracks
  for (let t = 0; t < score.tracks.length; t++) {
    const track = score.tracks[t];
    const staff = track.staves[0];
    const isPerc = staff.isPercussion;
    const trackFlags = (isPerc ? 1 : 0) | (version >= 500 ? 8 : 0);
    out.byte(trackFlags);
    fixedString(out, track.name, 40);
    const numStrings = isPerc ? 6 : staff.stringTuning.tunings.length;
    out.int(numStrings);
    for (let s = 0; s < 7; s++) {
      out.int(s < numStrings ? (isPerc ? 0 : staff.stringTuning.tunings[s]) : -1);
    }
    const port = 1;
    const ch = isPerc ? 10 : (t === 0 ? 1 : 3);
    const effCh = isPerc ? 10 : (t === 0 ? 2 : 4);
    out.int(port);
    out.int(ch);
    out.int(effCh);
    out.int(24); // frets
    out.int(0);  // capo
    out.raw([255, 0, 0, 0]); // color

    if (version >= 500) {
      out.short(0x140 | 1 | 2); // show tab & standard notation
      out.byte(0);
      out.byte(0); // bank
      out.byte(0);
      out.int(0);  // clef
      out.int(0);
      out.int(100);
      out.raw([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 255, 3]);
      for (let i = 0; i < 16; i++) out.byte(255);
      out.int(0);
      sizedString(out, '');
      sizedString(out, '');
    }
  }

  // 11. Bars, Voices, Beats
  for (let b = 0; b < score.masterBars.length; b++) {
    for (let t = 0; t < score.tracks.length; t++) {
      const track = score.tracks[t];
      const staff = track.staves[0];
      const bar = staff.bars[b];
      const voice = bar.voices[0];

      if (version >= 500) {
        out.byte(0); // voice header
      }

      // Voice 0
      const beats = voice.beats;
      out.int(beats.length);
      for (const beat of beats) {
        const isRest = beat.isEmpty;
        const hasTuplet = beat.hasTuplet;
        const hasHarmonic = version < 400 && beat.notes.some(n => n.harmonicType !== model.HarmonicType.None);
        const beatEffects = hasHarmonic;

        const beatFlags = (beatEffects ? 8 : 0) | (hasTuplet ? 32 : 0) | (isRest ? 64 : 0);
        out.byte(beatFlags);
        if (isRest) {
          out.byte(0); // empty rest
        }
        const dur = beat.duration === model.Duration.Whole ? -2 :
                    beat.duration === model.Duration.Half ? -1 :
                    beat.duration === model.Duration.Quarter ? 0 : 1;
        out.byte(dur);
        if (hasTuplet) {
          out.int(beat.tupletNumerator);
        }
        if (beatEffects) {
          // In GP3, beat effects: bit 2 (4) = Natural, bit 3 (8) = Artificial
          const isNat = beat.notes.some(n => n.harmonicType === model.HarmonicType.Natural);
          out.byte(isNat ? 4 : 8);
        }

        // String flags (bitmask for 7 strings)
        let stringFlags = 0;
        const notes = beat.notes;
        const tuningLen = staff.isPercussion ? 6 : staff.tuning.length;
        for (const note of notes) {
          const stringIdx = staff.isPercussion ? 0 : (tuningLen - note.string);
          stringFlags |= (1 << (6 - stringIdx));
        }
        out.byte(stringFlags);

        // Notes
        for (const note of notes) {
          const hasBend = note.bendPoints && note.bendPoints.length > 0;
          const hasHammer = note.isHammerPullOrigin;
          const hasSlide = note.slideOutType !== model.SlideOutType.None;
          const hasNoteHarmonic = version >= 400 && note.harmonicType !== model.HarmonicType.None;
          const hasEffects = hasBend || hasHammer || hasSlide || hasNoteHarmonic;

          const noteFlags = 32 | (hasEffects ? 8 : 0);
          out.byte(noteFlags);
          out.byte(1); // normal note
          out.byte(staff.isPercussion ? note.percussionArticulation : note.fret);

          if (version >= 500) {
            out.byte(0); // swap accidentals
          }

          if (hasEffects) {
            const bendPoints = note.bendPoints ?? [];
            if (version < 400) {
              // GP3: 1 byte flags: bit 0 bend, bit 1 hammer, bit 2 slide (shift)
              const gp3Flags = (hasBend ? 1 : 0) | (hasHammer ? 2 : 0) | (hasSlide ? 4 : 0);
              out.byte(gp3Flags);
              if (hasBend) {
                out.byte(1);
                out.int(100);
                out.int(bendPoints.length);
                for (const p of bendPoints) {
                  out.int(p.offset);
                  out.int(p.value * 25);
                  out.byte(0);
                }
              }
            } else if (version < 500) {
              // GP4: 2 bytes flags
              const flags1 = (hasBend ? 1 : 0) | (hasHammer ? 2 : 0);
              const flags2 = (hasSlide ? 8 : 0) | (hasNoteHarmonic ? 16 : 0);
              out.byte(flags1);
              out.byte(flags2);
              if (hasBend) {
                out.byte(1);
                out.int(100);
                out.int(bendPoints.length);
                for (const p of bendPoints) {
                  out.int(p.offset);
                  out.int(p.value * 25);
                  out.byte(0);
                }
              }
              if (hasSlide) {
                out.byte(1); // shift slide
              }
              if (hasNoteHarmonic) {
                out.byte(note.harmonicType === model.HarmonicType.Natural ? 1 : 4);
              }
            } else {
              // GP5: 2 bytes flags
              const flags1 = (hasBend ? 1 : 0) | (hasHammer ? 2 : 0);
              const flags2 = (hasSlide ? 8 : 0) | (hasNoteHarmonic ? 16 : 0);
              out.byte(flags1);
              out.byte(flags2);
              if (hasBend) {
                out.byte(1);
                out.int(100);
                out.int(bendPoints.length);
                for (const p of bendPoints) {
                  out.int(p.offset);
                  out.int(p.value * 25);
                  out.byte(0);
                }
              }
              if (hasSlide) {
                out.byte(1); // shift slide
              }
              if (hasNoteHarmonic) {
                out.byte(note.harmonicType === model.HarmonicType.Natural ? 1 : 4);
              }
            }
          }
        }

        if (version >= 500) {
          out.short(0);
        }
      }

      // Voice 1 for GP5
      if (version >= 500) {
        out.int(1);
        out.byte(0x40);
        out.byte(0);
        out.byte(0);
        out.byte(0);
        out.short(0);
      }
    }
  }

  return out.toBytes();
}

/**
 * Builds the canonical legacy audit score exercising:
 * - multiple tracks (Lead Guitar, Bass)
 * - percussion track (Drums)
 * - repeats (repeat start bar 0, repeat end count 2 bar 1)
 * - bends (single bend)
 * - overlapping bends (polyphonic bend on two strings simultaneously)
 * - slides (shift slide)
 * - hammer-ons (isHammerPullOrigin)
 * - harmonics (Natural and Pinch/Artificial)
 * - tuplets (3:2 eighths)
 */
export function buildLegacyAuditScore(): model.Score {
  const score = new model.Score();
  score.title = 'Legacy Audit Score';
  score.artist = 'TabPlayer Test';

  const lead = new model.Track();
  lead.name = 'Lead Guitar';
  lead.playbackInfo.program = 25;
  const leadStaff = new model.Staff();
  leadStaff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  leadStaff.displayTranspositionPitch = -12;
  lead.addStaff(leadStaff);
  score.addTrack(lead);

  const bass = new model.Track();
  bass.name = 'Bass';
  bass.playbackInfo.program = 33;
  const bassStaff = new model.Staff();
  bassStaff.stringTuning.tunings = [43, 38, 33, 28];
  bassStaff.displayTranspositionPitch = -12;
  bass.addStaff(bassStaff);
  score.addTrack(bass);

  const drums = new model.Track();
  drums.name = 'Drums';
  drums.playbackInfo.program = 0;
  const drumsStaff = new model.Staff();
  drumsStaff.isPercussion = true;
  drumsStaff.stringTuning.tunings = [];
  drums.addStaff(drumsStaff);
  score.addTrack(drums);

  for (let b = 0; b < 2; b++) {
    const mb = new model.MasterBar();
    if (b === 0) mb.isRepeatStart = true;
    if (b === 1) mb.repeatCount = 2;
    score.addMasterBar(mb);

    const leadBar = new model.Bar();
    leadBar.clef = model.Clef.G2;
    leadBar.addVoice(new model.Voice());
    leadStaff.addBar(leadBar);

    const bassBar = new model.Bar();
    bassBar.clef = model.Clef.F4;
    bassBar.addVoice(new model.Voice());
    bassStaff.addBar(bassBar);

    const drumsBar = new model.Bar();
    drumsBar.clef = model.Clef.Neutral;
    drumsBar.addVoice(new model.Voice());
    drumsStaff.addBar(drumsBar);
  }

  // Lead Bar 0:
  // Beat 0: Hammer-on
  const v0 = leadStaff.bars[0].voices[0];
  const b0 = new model.Beat();
  b0.duration = model.Duration.Quarter;
  b0.isEmpty = false;
  const n0 = new model.Note();
  n0.string = 3;
  n0.fret = 5;
  n0.isHammerPullOrigin = true;
  b0.addNote(n0);
  v0.addBeat(b0);

  // Beat 1: Slide
  const b1 = new model.Beat();
  b1.duration = model.Duration.Quarter;
  b1.isEmpty = false;
  const n1 = new model.Note();
  n1.string = 3;
  n1.fret = 7;
  n1.slideOutType = model.SlideOutType.Shift;
  b1.addNote(n1);
  v0.addBeat(b1);

  // Beat 2: Natural Harmonic
  const b2 = new model.Beat();
  b2.duration = model.Duration.Quarter;
  b2.isEmpty = false;
  const n2 = new model.Note();
  n2.string = 3;
  n2.fret = 12;
  n2.harmonicType = model.HarmonicType.Natural;
  b2.addNote(n2);
  v0.addBeat(b2);

  // Beat 3: Artificial/Pinch Harmonic
  const b3 = new model.Beat();
  b3.duration = model.Duration.Quarter;
  b3.isEmpty = false;
  const n3 = new model.Note();
  n3.string = 3;
  n3.fret = 7;
  n3.harmonicType = model.HarmonicType.Pinch;
  b3.addNote(n3);
  v0.addBeat(b3);

  // Lead Bar 1:
  // Beat 0: Bend
  const v1 = leadStaff.bars[1].voices[0];
  const b4 = new model.Beat();
  b4.duration = model.Duration.Quarter;
  b4.isEmpty = false;
  const n4 = new model.Note();
  n4.string = 3;
  n4.fret = 7;
  n4.bendType = model.BendType.Bend;
  n4.addBendPoint(new model.BendPoint(0, 0));
  n4.addBendPoint(new model.BendPoint(60, 4));
  b4.addNote(n4);
  v1.addBeat(b4);

  // Beat 1: Overlapping Bends (2 strings in same beat)
  const b5 = new model.Beat();
  b5.duration = model.Duration.Quarter;
  b5.isEmpty = false;
  const n5a = new model.Note();
  n5a.string = 2;
  n5a.fret = 8;
  n5a.bendType = model.BendType.Bend;
  n5a.addBendPoint(new model.BendPoint(0, 0));
  n5a.addBendPoint(new model.BendPoint(60, 2));
  b5.addNote(n5a);
  const n5b = new model.Note();
  n5b.string = 3;
  n5b.fret = 7;
  n5b.bendType = model.BendType.Bend;
  n5b.addBendPoint(new model.BendPoint(0, 0));
  n5b.addBendPoint(new model.BendPoint(60, 4));
  b5.addNote(n5b);
  v1.addBeat(b5);

  // Beat 2: Tuplet (3 eighth notes)
  for (let t = 0; t < 3; t++) {
    const bt = new model.Beat();
    bt.duration = model.Duration.Eighth;
    bt.tupletNumerator = 3;
    bt.tupletDenominator = 2;
    bt.isEmpty = false;
    const nt = new model.Note();
    nt.string = 1;
    nt.fret = t + 5;
    bt.addNote(nt);
    v1.addBeat(bt);
  }
  const rest = new model.Beat();
  rest.duration = model.Duration.Quarter;
  rest.isEmpty = true;
  v1.addBeat(rest);

  // Bass
  for (let b = 0; b < 2; b++) {
    const vb = bassStaff.bars[b].voices[0];
    const bb = new model.Beat();
    bb.duration = model.Duration.Whole;
    bb.isEmpty = false;
    const nb = new model.Note();
    nb.string = 4;
    nb.fret = b * 2;
    bb.addNote(nb);
    vb.addBeat(bb);
  }

  // Drums
  for (let b = 0; b < 2; b++) {
    const vd = drumsStaff.bars[b].voices[0];
    for (let k = 0; k < 4; k++) {
      const db = new model.Beat();
      db.duration = model.Duration.Quarter;
      db.isEmpty = false;
      const dn = new model.Note();
      dn.percussionArticulation = k % 2 === 0 ? 36 : 38;
      db.addNote(dn);
      vd.addBeat(db);
    }
  }

  score.finish(new Settings());
  return score;
}
