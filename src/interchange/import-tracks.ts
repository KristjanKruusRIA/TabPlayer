import { model, Settings } from '@coderline/alphatab';
import { mapArticulationId } from '../audio/drum-map';
import type { SingleCommand } from '../edit-types';
import { convertClipboardBeat } from '../editor/clipboard-conversion';
import { makeMusicClip, readMusicClip, scoreFromMusicClip } from '../editor/clipboard-source';
import type { MusicClip } from '../editor/clipboard-types';
import { integer, restBeats, rhythmTicks } from '../editor/common';
import { allNotes, captureNoteLinks, detachNote, restoreNoteLinks, type NoteLinks } from '../editor/links';
import type { BarIndexMap } from '../editor/measures-types';
import { resolvePercussionArticulation } from '../editor/percussion-catalog';
import { copyGpInterchangeSource } from './gp';
import { scoreFromJson } from '../model-clone';

export type ImportTracksCommand = Extract<SingleCommand, { type: 'importTracks' }>;
export interface PreparedImportTracks {
  score: model.Score;
  barMap: BarIndexMap;
  addedTracks: number;
}

const settings = new Settings();
const MAX_IMPORT_TRACKS = 32;
const MAX_TOTAL_TRACKS = 64;
const MAX_IMPORT_BARS = 3000;

const emptyVoice = () => {
  const voice = new model.Voice();
  const beat = new model.Beat();
  beat.isEmpty = true;
  voice.addBeat(beat);
  return voice;
};

function cloneScore(score: model.Score): model.Score {
  const copy = scoreFromJson(model.JsonConverter.scoreToJson(score), settings);
  restoreNoteLinks(copy, captureNoteLinks(score));
  copyGpInterchangeSource(score, copy);
  return copy;
}

function preserveObjects(score: model.Score) {
  return {
    bars: new Set(score.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars))),
    voices: new Set(score.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars.flatMap(bar => bar.voices)))),
    beats: new Set(score.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars.flatMap(bar => bar.voices.flatMap(voice => voice.beats))))),
  };
}

function finishFreshIds(score: model.Score, preserved: ReturnType<typeof preserveObjects>) {
  const fix = <T extends { id: number }>(objects: T[], existing: Set<T>, create: () => number) => {
    const used = new Set([...existing].map(value => value.id));
    for (const value of objects) {
      if (!existing.has(value)) {
        while (used.has(value.id)) value.id = create();
        used.add(value.id);
      }
    }
  };
  const bars = score.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars));
  fix(bars, preserved.bars, () => new model.Bar().id);
  fix(bars.flatMap(bar => bar.voices), preserved.voices, () => new model.Voice().id);
  fix(bars.flatMap(bar => bar.voices.flatMap(voice => voice.beats)), preserved.beats, () => new model.Beat().id);
}

function reserveIds(destination: model.Score) {
  const voices = new Set(destination.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars.flatMap(bar => bar.voices.map(voice => voice.id)))));
  const beatIds = new Set(destination.tracks.flatMap(track => track.staves.flatMap(staff => staff.bars.flatMap(bar => bar.voices.flatMap(voice => voice.beats.map(beat => beat.id))))));
  const notes = new Set(allNotes(destination).map(note => note.id));
  const take = (used: Set<number>, create: () => number) => {
    let id = create();
    while (used.has(id)) id = create();
    used.add(id);
    return id;
  };
  return (source: model.Score): NoteLinks => {
    const oldLinks = captureNoteLinks(source);
    const ids = new Map<number, number>();
    for (const track of source.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            voice.id = take(voices, () => new model.Voice().id);
            for (const beat of voice.beats) {
              beat.id = take(beatIds, () => new model.Beat().id);
              for (const note of beat.notes) {
                const old = note.id;
                note.id = take(notes, () => new model.Note().id);
                ids.set(old, note.id);
              }
            }
          }
        }
      }
    }
    return oldLinks.map(link => ({ ...link, from: ids.get(link.from)!, to: ids.get(link.to)! }));
  };
}

function relink(score: model.Score) {
  score.masterBars.forEach((master, index) => {
    master.index = index;
    master.score = score;
    master.previousMasterBar = score.masterBars[index - 1] ?? null;
    master.nextMasterBar = score.masterBars[index + 1] ?? null;
  });
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      staff.bars.forEach((bar, index) => {
        bar.index = index;
        bar.staff = staff;
        bar.previousBar = staff.bars[index - 1] ?? null;
        bar.nextBar = staff.bars[index + 1] ?? null;
        bar.voices.forEach((voice, voiceIndex) => {
          voice.index = voiceIndex;
          voice.bar = bar;
          voice.beats.forEach((beat, beatIndex) => {
            beat.index = beatIndex;
            beat.voice = voice;
            beat.notes.forEach((note, noteIndex) => {
              note.index = noteIndex;
              note.beat = beat;
            });
          });
        });
      });
    }
  }
  score.rebuildRepeatGroups();
}

function restBar(
  master: model.MasterBar,
  voiceCount: number,
  clef: model.Clef,
  clefOttava: model.Ottavia,
  keySignature: model.KeySignature,
  keySignatureType: model.KeySignatureType,
): model.Bar {
  const bar = new model.Bar();
  bar.clef = clef;
  bar.clefOttava = clefOttava;
  bar.keySignature = keySignature;
  bar.keySignatureType = keySignatureType;
  const first = new model.Voice();
  if (master.isFreeTime) {
    const rest = new model.Beat();
    rest.duration = model.Duration.Whole;
    rest.isEmpty = false;
    first.addBeat(rest);
  } else {
    for (const beat of restBeats(master.calculateDuration(false))) first.addBeat(beat);
  }
  bar.addVoice(first);
  for (let v = 1; v < voiceCount; v++) bar.addVoice(emptyVoice());
  return bar;
}

function stripImportedBeatMetadata(beat: model.Beat) {
  beat.lyrics = null;
  beat.timer = null;
  beat.chordId = null;
  beat.text = null;
  beat.showTimer = false;
  beat.automations = [];
}

/** Packages an imported score into a validated bar clip with tempo automations stripped so the open project keeps its own tempo. */
export function buildImportClip(score: model.Score): MusicClip {
  const clean = cloneScore(score);
  for (const master of clean.masterBars) master.tempoAutomations = [];
  const mode = clean.tracks.length === 1 ? 'singleTrack' : 'multiTrack';
  return makeMusicClip(
    clean,
    {
      kind: 'bars',
      tracks: clean.tracks.map((_, index) => index),
      firstBar: 0,
      lastBar: clean.masterBars.length - 1,
    },
    mode,
  );
}

/** Applies an `importTracks` command to a detached copy of `score`, appending tracks or replacing `targetTrack` in place. */
export function prepareImportTracks(score: model.Score, command: ImportTracksCommand): PreparedImportTracks {
  const destination = cloneScore(score);
  const preserved = preserveObjects(destination);
  const existingLinks = captureNoteLinks(destination);

  const clip = readMusicClip(command.clip);
  if (clip.kind !== 'bars') throw new Error('Track import requires complete measures.');
  const source = scoreFromMusicClip(clip);
  if (source.tracks.length < 1 || source.tracks.length > MAX_IMPORT_TRACKS) {
    throw new Error('Imported clip track count is out of range.');
  }
  if (source.masterBars.length < 1 || source.masterBars.length > MAX_IMPORT_BARS) {
    throw new Error('Imported clip measure count is out of range.');
  }

  const replacing = command.targetTrack !== undefined;
  if (replacing) {
    const targetTrack = command.targetTrack!;
    if (!integer(targetTrack) || !destination.tracks[targetTrack]) {
      throw new Error('Select an existing track to replace.');
    }
    if (source.tracks.length !== 1 || source.tracks[0].staves.length !== 1) {
      throw new Error('Replacing a track requires one imported track and staff.');
    }
    const destTrack = destination.tracks[targetTrack];
    if (!destTrack.staves.length || destTrack.staves[0].isPercussion !== source.tracks[0].staves[0].isPercussion) {
      throw new Error('The imported part must match the target track type (drums or melodic).');
    }
  } else if (destination.tracks.length + source.tracks.length > MAX_TOTAL_TRACKS) {
    throw new Error(`A score is limited to ${MAX_TOTAL_TRACKS} tracks.`);
  }

  const oldBarCount = destination.masterBars.length;
  const sharedBarCount = Math.min(oldBarCount, source.masterBars.length);
  for (let barIndex = 0; barIndex < sharedBarCount; barIndex++) {
    const master = destination.masterBars[barIndex];
    if (master.isFreeTime) continue;
    const capacity = master.calculateDuration(false);
    for (const srcTrack of source.tracks) {
      for (const srcStaff of srcTrack.staves) {
        const bar = srcStaff.bars[barIndex];
        for (const voice of bar.voices) {
          if (voice.isEmpty && voice.beats.every(beat => beat.isEmpty)) continue;
          const ticks = voice.beats.reduce((sum, beat) => sum + rhythmTicks(beat, capacity), 0);
          if (ticks !== capacity) {
            throw new Error('Imported rhythms do not match the destination measure meter.');
          }
        }
      }
    }
  }

  const importedLinks = reserveIds(destination)(source);

  let barMap: BarIndexMap;
  if (source.masterBars.length > oldBarCount) {
    const lastMaster = destination.masterBars[oldBarCount - 1];
    const refBar = destination.tracks[0]?.staves[0]?.bars[oldBarCount - 1];
    const inserted: number[] = [];
    for (let barIndex = oldBarCount; barIndex < source.masterBars.length; barIndex++) {
      const srcMaster = source.masterBars[barIndex];
      const master = new model.MasterBar();
      master.timeSignatureNumerator = srcMaster.timeSignatureNumerator;
      master.timeSignatureDenominator = srcMaster.timeSignatureDenominator;
      master.timeSignatureCommon = srcMaster.timeSignatureCommon;
      master.isFreeTime = srcMaster.isFreeTime;
      master.tripletFeel = lastMaster?.tripletFeel ?? model.TripletFeel.NoTripletFeel;
      destination.addMasterBar(master);
      for (const track of destination.tracks) {
        for (const staff of track.staves) {
          const prevBar = staff.bars[oldBarCount - 1];
          staff.addBar(restBar(
            master,
            Math.max(1, prevBar?.voices.length ?? 1),
            prevBar?.clef ?? (staff.isPercussion ? model.Clef.Neutral : model.Clef.G2),
            prevBar?.clefOttava ?? model.Ottavia.Regular,
            prevBar?.keySignature ?? refBar?.keySignature ?? model.KeySignature.C,
            prevBar?.keySignatureType ?? refBar?.keySignatureType ?? model.KeySignatureType.Major,
          ));
        }
      }
      inserted.push(barIndex);
    }
    barMap = { oldToNew: Array.from({ length: oldBarCount }, (_, index) => index), inserted };
  } else {
    barMap = { oldToNew: Array.from({ length: oldBarCount }, (_, index) => index), inserted: [] };
  }

  let survivingLinks = existingLinks;
  let addedTracks = 0;

  if (replacing) {
    const destTrack = destination.tracks[command.targetTrack!];
    const srcTrack = source.tracks[0];
    const srcStaff = srcTrack.staves[0];
    const destStaff = destTrack.staves[0];

    const removedNoteIds = new Set<number>();
    for (const staff of destTrack.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              removedNoteIds.add(note.id);
              detachNote(note);
            }
          }
        }
      }
    }
    survivingLinks = existingLinks.filter(link => !removedNoteIds.has(link.from) && !removedNoteIds.has(link.to));

    const destArticulationMap = new Map<number, number>();
    if (destStaff.isPercussion) {
      for (let i = 0; i < destTrack.percussionArticulations.length; i++) {
        const standardId = mapArticulationId(destTrack, i);
        if (standardId !== undefined && !destArticulationMap.has(standardId)) {
          destArticulationMap.set(standardId, i);
        }
      }
    }

    const voiceCount = Math.max(1, ...srcStaff.bars.map(bar => bar.voices.length));
    const fallbackBar = destStaff.bars[0];
    const newBars: model.Bar[] = [];
    for (let barIndex = 0; barIndex < destination.masterBars.length; barIndex++) {
      const master = destination.masterBars[barIndex];
      const existingBar = destStaff.bars[barIndex];
      const clef = existingBar?.clef ?? (destStaff.isPercussion ? model.Clef.Neutral : fallbackBar?.clef ?? model.Clef.G2);
      const clefOttava = existingBar?.clefOttava ?? fallbackBar?.clefOttava ?? model.Ottavia.Regular;
      const keySignature = existingBar?.keySignature ?? fallbackBar?.keySignature ?? model.KeySignature.C;
      const keySignatureType = existingBar?.keySignatureType ?? fallbackBar?.keySignatureType ?? model.KeySignatureType.Major;

      if (barIndex < srcStaff.bars.length) {
        const srcBar = srcStaff.bars[barIndex];
        const bar = new model.Bar();
        bar.clef = clef;
        bar.clefOttava = clefOttava;
        bar.keySignature = keySignature;
        bar.keySignatureType = keySignatureType;
        bar.simileMark = model.SimileMark.None;
        bar.sustainPedals = [];
        for (let v = 0; v < voiceCount; v++) {
          if (v < srcBar.voices.length) {
            const voice = srcBar.voices[v];
            for (const beat of voice.beats) {
              stripImportedBeatMetadata(beat);
              if (destStaff.isPercussion) {
                const customCount = destTrack.percussionArticulations.length;
                const mappedIds: number[] = [];
                let allMapped = true;
                for (const note of beat.notes) {
                  const stdId = mapArticulationId(srcTrack, note.percussionArticulation) ?? note.percussionArticulation;
                  if (customCount === 0) {
                    if (resolvePercussionArticulation(destTrack, stdId)) mappedIds.push(stdId);
                    else { allMapped = false; break; }
                  } else if (destArticulationMap.has(stdId)) {
                    mappedIds.push(destArticulationMap.get(stdId)!);
                  } else if (stdId >= customCount && resolvePercussionArticulation(destTrack, stdId)) {
                    mappedIds.push(stdId);
                  } else {
                    allMapped = false;
                    break;
                  }
                }
                if (allMapped) {
                  beat.notes.forEach((note, index) => { note.percussionArticulation = mappedIds[index]; });
                  beat.noteValueLookup.clear();
                } else {
                  convertClipboardBeat(beat, srcStaff, destStaff);
                }
              } else {
                convertClipboardBeat(beat, srcStaff, destStaff);
              }
            }
            bar.addVoice(voice);
          } else {
            bar.addVoice(emptyVoice());
          }
        }
        newBars.push(bar);
      } else {
        newBars.push(restBar(master, voiceCount, clef, clefOttava, keySignature, keySignatureType));
      }
    }
    destStaff.bars = [];
    destStaff.chords = new Map();
    for (const bar of newBars) destStaff.addBar(bar);

    for (let s = 1; s < destTrack.staves.length; s++) {
      const extraStaff = destTrack.staves[s];
      const extraBars: model.Bar[] = [];
      for (let barIndex = 0; barIndex < destination.masterBars.length; barIndex++) {
        const existingBar = extraStaff.bars[barIndex];
        const fallback = extraStaff.bars[0];
        extraBars.push(restBar(
          destination.masterBars[barIndex],
          Math.max(1, existingBar?.voices.length ?? fallback?.voices.length ?? 1),
          existingBar?.clef ?? fallback?.clef ?? (extraStaff.isPercussion ? model.Clef.Neutral : model.Clef.G2),
          existingBar?.clefOttava ?? fallback?.clefOttava ?? model.Ottavia.Regular,
          existingBar?.keySignature ?? fallback?.keySignature ?? model.KeySignature.C,
          existingBar?.keySignatureType ?? fallback?.keySignatureType ?? model.KeySignatureType.Major,
        ));
      }
      extraStaff.bars = [];
      extraStaff.chords = new Map();
      for (const bar of extraBars) extraStaff.addBar(bar);
    }
  } else {
    const used = new Set(destination.tracks.flatMap(track => [track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel]));
    const channel = (shared: number) => {
      let value = 0;
      while (value === 9 || used.has(value)) value++;
      if (value > 15) return integer(shared, 0, 15) && shared !== 9 ? shared : 0;
      used.add(value);
      return value;
    };
    const referenceStaff = destination.tracks[0]?.staves[0];
    for (const srcTrack of source.tracks) {
      const percussion = srcTrack.staves.some(staff => staff.isPercussion);
      srcTrack.playbackInfo.isMute = false;
      srcTrack.playbackInfo.isSolo = false;
      srcTrack.playbackInfo.primaryChannel = percussion ? 9 : channel(srcTrack.playbackInfo.primaryChannel);
      srcTrack.playbackInfo.secondaryChannel = percussion ? 9 : channel(srcTrack.playbackInfo.primaryChannel);
      for (const srcStaff of srcTrack.staves) {
        const voiceCount = Math.max(1, ...srcStaff.bars.map(bar => bar.voices.length));
        const fallbackBar = srcStaff.bars[0];
        for (const bar of srcStaff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) stripImportedBeatMetadata(beat);
          }
          while (bar.voices.length < voiceCount) bar.addVoice(emptyVoice());
        }
        for (let barIndex = srcStaff.bars.length; barIndex < destination.masterBars.length; barIndex++) {
          const refBar = referenceStaff?.bars[barIndex];
          srcStaff.addBar(restBar(
            destination.masterBars[barIndex],
            voiceCount,
            fallbackBar?.clef ?? (srcStaff.isPercussion ? model.Clef.Neutral : model.Clef.G2),
            fallbackBar?.clefOttava ?? model.Ottavia.Regular,
            refBar?.keySignature ?? fallbackBar?.keySignature ?? model.KeySignature.C,
            refBar?.keySignatureType ?? fallbackBar?.keySignatureType ?? model.KeySignatureType.Major,
          ));
        }
      }
      destination.addTrack(srcTrack);
    }
    addedTracks = source.tracks.length;
  }

  relink(destination);
  // Restore only links whose endpoints survive and stay valid after any melodic re-fingering.
  const survivingNotes = new Set(allNotes(destination).map(note => note.id));
  const lookup = new Map(allNotes(destination).map(note => [note.id, note]));
  const nextLinks = [...survivingLinks, ...importedLinks].filter(link => {
    if (!survivingNotes.has(link.from) || !survivingNotes.has(link.to)) return false;
    if (link.kind === 'tie') {
      const from = lookup.get(link.from)!, to = lookup.get(link.to)!;
      if (from.isStringed !== to.isStringed || (from.isStringed && from.string !== to.string) || from.realValue !== to.realValue) return false;
    }
    return true;
  });
  restoreNoteLinks(destination, nextLinks);
  finishFreshIds(destination, preserved);
  return { score: destination, barMap, addedTracks };
}
