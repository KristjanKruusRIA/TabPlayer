import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { exportMidi } from './midi';

// Independent Standard MIDI File (SMF) byte decoder; does not rely on alphaTab.
function decodeMidi(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const ascii = (n: number) => String.fromCharCode(...bytes.slice(p, (p += n)));
  const u32 = () => { const n = view.getUint32(p); p += 4; return n; };
  const u16 = () => { const n = view.getUint16(p); p += 2; return n; };
  const variable = () => {
    let v = 0, n = 0;
    do { n = bytes[p++]; v = (v << 7) | (n & 127); } while (n & 128);
    return v;
  };

  expect(ascii(4)).toBe('MThd');
  expect(u32()).toBe(6);
  const format = u16(), tracks = u16(), division = u16();
  const events: { tick: number; type: number; channel?: number; data: number[]; track: number }[] = [];

  for (let track = 0; track < tracks; track++) {
    expect(ascii(4)).toBe('MTrk');
    const end = p + 4 + view.getUint32(p);
    p += 4;
    let tick = 0, status = 0;
    while (p < end) {
      tick += variable();
      let type = bytes[p++];
      if (type < 128) {
        p--;
        type = status;
      } else if (type < 240) {
        status = type;
      }

      if (type === 255) {
        const meta = bytes[p++];
        const len = variable();
        events.push({ tick, type: meta, data: [...bytes.slice(p, (p += len))], track });
      } else if (type === 240 || type === 247) {
        p += variable();
      } else {
        const kind = type & 240;
        const n = kind === 192 || kind === 208 ? 1 : 2;
        events.push({ tick, type: kind, channel: type & 15, data: [...bytes.slice(p, (p += n))], track });
      }
    }
  }
  expect(p).toBe(bytes.length);
  return { events, format, division, tracks };
}

describe('F12 large arrangement MIDI export', () => {
  it('exports MIDI from 16 tracks and 1,000 bars arrangement within measured time bound', () => {
    const barCount = 1000;
    const melodicTrackCount = 15; // MIDI export caps melodic tracks at 15
    const totalTrackCount = 16;   // 15 melodic tracks + 1 percussion track

    const score = new model.Score();
    score.title = 'Large 16-Track 1000-Bar Arrangement';

    for (let b = 0; b < barCount; b++) {
      const mb = new model.MasterBar();
      if (b === 0) {
        mb.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
      }
      score.addMasterBar(mb);
    }

    for (let t = 0; t < totalTrackCount; t++) {
      const isPerc = t === melodicTrackCount;
      const track = new model.Track();
      track.name = isPerc ? 'Drums Track' : `Melodic Track ${t + 1}`;
      track.playbackInfo.program = isPerc ? 0 : 25 + (t % 10);
      const staff = new model.Staff();
      if (isPerc) {
        staff.isPercussion = true;
        staff.stringTuning.tunings = [];
      } else {
        staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
      }
      track.addStaff(staff);
      score.addTrack(track);

      for (let b = 0; b < barCount; b++) {
        const bar = new model.Bar();
        bar.clef = isPerc ? model.Clef.Neutral : model.Clef.G2;
        const voice = new model.Voice();
        bar.addVoice(voice);
        staff.addBar(bar);

        // One whole note per bar
        const beat = new model.Beat();
        beat.duration = model.Duration.Whole;
        beat.isEmpty = false;
        const note = new model.Note();
        if (isPerc) {
          note.percussionArticulation = 36; // kick drum
        } else {
          note.string = 6;
          note.fret = (t + b) % 12;
        }
        beat.addNote(note);
        voice.addBeat(beat);
      }
    }

    score.finish(new Settings());

    // Performance measurement:
    // Measured on this machine: ~1,380 ms to 1,500 ms (Windows x64, Node 24.22.1).
    // Bound set to 10,000 ms to accommodate CI and busy test environments while catching quadratic blowups.
    const startTime = performance.now();
    const selection = { tracks: score.tracks.map(t => t.index), range: null };
    const bytes = exportMidi(score, selection);
    const durationMs = performance.now() - startTime;

    expect(durationMs).toBeLessThan(10000);

    const parsed = decodeMidi(bytes);

    // SMF Format 1: Multi-track synchronous
    expect(parsed.format).toBe(1);

    // 17 tracks: Conductor track (track 0) + 16 instrument tracks (tracks 1..16)
    expect(parsed.tracks).toBe(17);

    // Event count:
    // Exactly 48,195 events generated:
    // 16 tracks * 1,000 bars * 2 note events (NoteOn + NoteOff) = 32,000 note events,
    // plus conductor tempo/time-signature events, track names, program changes,
    // volume/pan control changes per segment, and EndOfTrack events.
    expect(parsed.events.length).toBe(48195);

    // End time:
    // 1,000 bars of 4/4 meter at 960 PPQ division = 3,840 ticks per bar.
    // 1,000 * 3,840 = 3,840,000 ticks.
    const endOfTrackEvents = parsed.events.filter(e => e.type === 47); // Meta 0x2F = End of Track
    expect(endOfTrackEvents).toHaveLength(17);
    for (const eot of endOfTrackEvents) {
      expect(eot.tick).toBe(3840000);
    }
  });
});
