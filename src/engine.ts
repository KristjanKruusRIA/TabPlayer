import { getMessage, getResolvedLanguage, type MessageKey } from './i18n';
import { model, Settings } from '@coderline/alphatab';
import type { BeatTarget, EditCommand, Project, ProjectInput } from './project';
import { appliesFilePartialCapo,projectCommands } from './project';
import { isSettingsEdit } from './edit-types';
import type { BackingSettings, ChannelMix, DocumentSettings, SingleCommand } from './edit-types';
import { describeScore, describeScoreSteps, duplicateIds, firstDifference, firstDifferenceSteps } from './engine-verify';
import { defaultDocumentSettings, defaultMix, applySettingsEdit, copyTrackSettings, completeSound, completeMaster } from './document-settings';
import { getLyricsSource, setLyricsSource } from './editor/lyrics-source';
import { copyHarmonyChord } from './harmony/chord-source';
import { copyTrackScaleDiagrams } from './harmony/scale-diagram';
import { applyAdvancedEdit } from './editor/advanced';
import { captureNoteLinks, restoreNoteLinks, detachNote } from './editor/links';
import { backingLocationsForScore,validateBackingAnchors } from './audio/plan';
import { adjustReferenceSyncBounds,referenceSyncTiming } from './audio/reference-sync';
import { scoreFromJson } from './model-clone';
import { MAX_SEQUENCE_COMMANDS,validateParityCommand } from './parity-commands';
import { defaultTuningName, validateTuningName } from './editor/structure';
import { stringCapo } from './editor/partial-capo';
import { setTempoUnit, tempoUnitOf } from './editor/tempo-unit';
import { assertDiagramFrets, assertDroneFrets, droneShift, droneTuningOk, fretExists, fretKey, getBanjoDrone } from './editor/banjo-drone';
import { refingerTrack } from './editor/refinger';
import { adoptAdmittedBase } from './interchange/archive-gate';
import { copyGpInterchangeSource, exportGpInterchange, forgetTrackOrderedEntries, loadInterchangeScore } from './interchange/gp';
import { reflowLyrics,removeLyricsMeasure } from './editor/lyrics';
import { prepareScoreTimers } from './editor/timers';
import { addTicks,trimStart,voiceTicks,writtenTicks,type Fraction } from './editor/score-errors';
import { planMeasureMap,mapBackingMeasures } from './editor/measures';
import { mapLyricsMeasures } from './editor/lyrics-measures';
import { preparePasteMusic } from './editor/clipboard-paste';
import { prepareImportTracks } from './interchange/import-tracks';
import { shortenCrossingBeat } from './editor/fit-shorten';
import { duplicateStylesheetTrack,remapStylesheetTracks,validateEngravingTracks } from './engraving/projection';
import { mapEngravingBars } from './engraving/bar-widths';
import { prepareHarmonyTranspose } from './harmony/transpose';
import { copyMasterTimeSignatureSource } from './editor/time-signature-source';
import { isPowerTabBytes } from './import/powertab';
import { importPowerTab } from './import/powertab-score';
import { isTablEditBytes } from './import/tabledit';
import { importTablEdit } from './import/tabledit-score';

const settings = new Settings();
const { Score, Track, Staff, Bar, Voice, Beat, Note, MasterBar, Automation, JsonConverter } = model;
const integer = (value: number, minimum = 0) => Number.isInteger(value) && value >= minimum;
const supportedDurations=[-4,-2,1,2,4,8,16,32,64,128,256];
const trackIdentities=new WeakMap<model.Track,string>();
export const trackIdentity=(track:model.Track)=>trackIdentities.get(track) ?? `base/${track.index}`;

function refusal(key: MessageKey, params?: Record<string, string | number>): Error {
  return new Error(getMessage(getResolvedLanguage(), key, params));
}

function tuningValid(tuning: number[]) {
  if (!Array.isArray(tuning) || !tuning.length || tuning.some(n => !integer(n) || n > 127)) throw refusal('engine.tuning_pitch_range');
}

export function validateProject(value: unknown): Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal('engine.invalid_project');
  const input = value as ProjectInput;
  if (input.format !== 'TabPlayer' || ![1,2,3].includes(input.schemaVersion)) throw refusal('engine.unsupported_project_version');
  const hasLock=Object.hasOwn(input,'lock'),hasPartialCapo=Object.hasOwn(input,'partialCapo');
  const fields=['format','schemaVersion','engineVersion','base','edits',...(input.schemaVersion>=2?['assets']:[]),...(input.schemaVersion===3?['baselineEdits']:[]),...(hasLock?['lock']:[]),...(hasPartialCapo?['partialCapo']:[])];
  if(Object.keys(input).length!==fields.length || fields.some(field=>!Object.hasOwn(input,field)))throw refusal('engine.invalid_project_fields');
  const p:Project={...structuredClone(input),schemaVersion:3,assets:input.schemaVersion===1?{}:structuredClone(input.assets),baselineEdits:input.schemaVersion===3?structuredClone(input.baselineEdits):[]};
  if(hasLock){const lock=(input as {lock?:unknown}).lock;if(!lock||typeof lock!=='object'||Array.isArray(lock)||Object.keys(lock).length!==1||(lock as {kind?:unknown}).kind!=='finalized')throw refusal('engine.invalid_project_lock');}
  if(hasPartialCapo&&((input as {partialCapo?:unknown}).partialCapo!==true||input.base?.kind!=='file'))throw refusal('engine.invalid_partial_capo_marker');
  if (p.engineVersion !== '1.8.4') throw refusal('engine.engine_version_mismatch');
  if (!p.base || !['blank', 'file'].includes(p.base.kind) || !Array.isArray(p.edits) || !Array.isArray(p.baselineEdits)) throw refusal('engine.invalid_project_contents');
  const baseFields=p.base.kind==='blank'?['kind','title','artist','tempo','tuning','measureCount']:['kind','filename','bytesBase64','sha256'];
  if(Object.keys(p.base).length!==baseFields.length || baseFields.some(field=>!Object.hasOwn(p.base,field)))throw refusal('engine.invalid_project_base_fields');
  if (p.base.kind === 'blank') {
    tuningValid(p.base.tuning);
    if (typeof p.base.title!=='string' || typeof p.base.artist!=='string' || !integer(p.base.measureCount, 1) || !Number.isFinite(p.base.tempo) || p.base.tempo <= 0) throw refusal('engine.invalid_new_score_settings');
  } else if (typeof p.base.bytesBase64 !== 'string' || typeof p.base.filename !== 'string' || !/^[a-f0-9]{64}$/i.test(p.base.sha256)) {
    throw refusal('engine.invalid_original_score_data');
  }
  if(!p.assets || typeof p.assets!=='object' || Array.isArray(p.assets)) throw refusal('engine.invalid_project_asset_metadata');
  for(const [id,asset] of Object.entries(p.assets)) {
    if(!/^[a-f0-9]{64}$/i.test(id) || !asset || Object.keys(asset).some(key=>!['filename','mediaType','byteLength'].includes(key)) || typeof asset.filename!=='string' || typeof asset.mediaType!=='string' || !integer(asset.byteLength)) throw refusal('engine.invalid_project_asset_metadata');
  }
  // History entries are validated as stored, so a sequence's own shape is checked before its steps replay.
  for(const edit of [...p.baselineEdits,...p.edits])validateParityCommand(edit);
  for(const edit of projectCommands(p)) {
    if(edit.type==='setBacking' && edit.backing && !p.assets[edit.backing.assetId]) throw refusal('engine.backing_asset_missing');
    if(edit.type==='setTrackSound' && edit.sound?.plugin && !p.assets[edit.sound.plugin.state]) throw refusal('engine.plugin_state_missing');
  }
  return structuredClone(p);
}

function rest(duration: number, dots = 0) {
  const beat = new Beat(); beat.duration = duration; beat.dots = dots; beat.isEmpty = false;
  return beat;
}

/** Standard rest lengths in ticks, longest first: a whole to a 64th, each plain, dotted or double dotted. */
const restLengths=[1,2,4,8,16,32,64].flatMap(duration=>[0,1,2].map(dots=>({duration,dots,ticks:3840/duration*(2**(dots+1)-1)/2**dots}))).sort((a,b)=>b.ticks-a.ticks);

/** Makes a voice fill its measure exactly. Beats from the one that crosses the barline on go (a tuplet and the grace
 * notes before a removed beat go whole), then the remainder is written as the fewest standard rests. A crossing beat
 * is removed, or with `shorten` cut at the barline when that is allowed (see `shortenCrossingBeat`; the declined cases fall back to removal). A last note tied into the next measure, or a remainder no standard rest can write, is refused. */
function fitVoiceToMeasure(master: model.MasterBar, voice: model.Voice, shorten = false) {
  if (master.isFreeTime) throw refusal('engine.free_time_fill');
  const expected = master.calculateDuration(false), whole = voiceTicks(voice, expected);
  if (!whole) throw refusal('engine.voice_unused_fill');
  if (whole[0] === expected * whole[1]) throw refusal('engine.voice_complete_fill');
  if (shorten && whole[0] > expected * whole[1]) shortenCrossingBeat(master, voice, expected);
  const fitted = shorten ? voiceTicks(voice, expected) : whole;
  const cut = fitted![0] > expected * fitted![1] ? trimStart(voice, expected) : voice.beats.length;
  const kept = voice.beats.slice(0, cut), removed = voice.beats.slice(cut);
  let total: Fraction = [0, 1];
  for (const beat of kept) total = addTicks(total, writtenTicks(beat, expected));
  const missing = expected * total[1] - total[0];
  if (missing % total[1]) throw refusal('engine.cannot_fill_standard_rests');
  let left = missing / total[1];
  const added: model.Beat[] = [];
  while (left > 0) {
    const length = restLengths.find(candidate => candidate.ticks <= left);
    if (!length) throw refusal('engine.cannot_fill_standard_rests');
    const inserted = rest(length.duration, length.dots); inserted.voice = voice; added.push(inserted); left -= length.ticks;
  }
  if (added.length) {
    const lastSounding = [...kept].reverse().find(beat => beat.graceType === model.GraceType.None);
    for (const note of lastSounding?.notes ?? []) {
      const next = note.tieDestination;
      if (next && !removed.includes(next.beat) && next.beat.voice.bar !== voice.bar) throw refusal('engine.tied_note_fill');
    }
  }
  for (const beat of removed) for (const note of [...beat.notes]) removeNote(note);
  voice.beats.splice(cut);
  if (voice.beats.length === 1 && voice.beats[0].isEmpty) voice.beats.splice(0);
  voice.beats.push(...added);
}

function appendBar(staff: model.Staff, master: model.MasterBar) {
  const bar = new Bar();
  bar.clef = staff.bars.at(-1)?.clef ?? (staff.isPercussion?model.Clef.Neutral:staff.tuning.length && staff.tuning[0] < 55 ? model.Clef.F4 : model.Clef.G2);
  const voice = new Voice();
  for (let i = 0; i < master.timeSignatureNumerator; i++) voice.addBeat(rest(master.timeSignatureDenominator));
  bar.addVoice(voice); staff.addBar(bar);
  const count=staff.bars[bar.index-1]?.voices.length ?? 1;
  for(let i=1;i<count;i++){const extra=new Voice();const carrier=new Beat();carrier.isEmpty=true;extra.addBeat(carrier);bar.addVoice(extra);}
}

/** A detached copy of `source` with fresh bar, voice, beat and note IDs, its lyrics and chord
 * sources, the links to restore between its notes, and free MIDI channels when any remain (percussion keeps the drum channel). */
function duplicateTrack(score:model.Score,source:model.Track,index:number):{copy:model.Track;links:ReturnType<typeof captureNoteLinks>} {
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings).tracks[index],noteIds=new Map<number,number>();
  for(const staff of copy.staves)for(const bar of staff.bars){
    bar.id=new Bar().id;
    for(const voice of bar.voices){voice.id=new Voice().id;for(const beat of voice.beats){beat.id=new Beat().id;for(const note of beat.notes){
      const oldId=note.id,slide=note.slideOutType;detachNote(note);if(slide>=model.SlideOutType.OutUp)note.slideOutType=slide;note.id=new Note().id;noteIds.set(oldId,note.id);
    }}}
  }
  // Only links with both ends in the source track are copied; they point between copied notes.
  const links=captureNoteLinks(score).filter(link=>noteIds.has(link.from)&&noteIds.has(link.to)).map(link=>({...link,from:noteIds.get(link.from)!,to:noteIds.get(link.to)!}));
  const lyrics=getLyricsSource(source);if(lyrics)setLyricsSource(copy,lyrics.value,lyrics.managed);
  source.staves.forEach((staff,index)=>{for(const [key,chord] of staff.chords??[]){const target=copy.staves[index]?.chords?.get(key);if(target)copyHarmonyChord(chord,target);}});
  copyTrackScaleDiagrams(source,copy);
  if(!copy.isPercussion){
    const used=new Set(score.tracks.flatMap(track=>[track.playbackInfo.primaryChannel,track.playbackInfo.secondaryChannel]));
    const free=Array.from({length:16},(_,index)=>index).filter(index=>index!==9&&!used.has(index));
    if(free.length){copy.playbackInfo.primaryChannel=free[0];copy.playbackInfo.secondaryChannel=free[1]??free[0];}
  }
  copy.score=score;
  return {copy,links};
}

/** Old track indices in their order after moving `track` to `to`. */
function movedOrder(count:number,track:number,to:number):number[] {
  const order=Array.from({length:count},(_,index)=>index);order.splice(to,0,...order.splice(track,1));return order;
}

function addTrack(score: model.Score, name: string, tuning: number[], program: number, tuningName?: string) {
  tuningValid(tuning);validateTuningName(tuningName);
  if (!integer(program) || program > 127) throw refusal('engine.invalid_midi_instrument');
  const used = new Set(score.tracks.flatMap(t => [t.playbackInfo.primaryChannel, t.playbackInfo.secondaryChannel]));
  const free = Array.from({length:16}, (_,i) => i).filter(i => i !== 9 && !used.has(i));
  if (!free.length) throw refusal('engine.no_midi_channel');
  const track = new Track(); track.name = name || 'Instrument'; track.shortName = track.name;
  track.playbackInfo.program = program;
  track.playbackInfo.primaryChannel = free[0]; track.playbackInfo.secondaryChannel = free[1] ?? free[0];
  const staff = new Staff(); staff.stringTuning.tunings = [...tuning]; staff.stringTuning.name = tuningName ?? defaultTuningName(tuning); staff.showTablature = true; staff.showStandardNotation = true;
  track.addStaff(staff); score.addTrack(track);
  for (const master of score.masterBars) appendBar(staff, master);
}

function initialScore(project: Project, canRedo: boolean): {score:model.Score;notice:string|null} {
  if (project.base.kind === 'file') {
    const bytes = Uint8Array.from(atob(project.base.bytesBase64), c => c.charCodeAt(0));
    if (isPowerTabBytes(bytes)) {const imported=importPowerTab(bytes,settings);return {score:imported.score,notice:imported.notice};}
    if (isTablEditBytes(bytes)) {const imported=importTablEdit(bytes,settings);return {score:imported.score,notice:imported.notice};}
    adoptAdmittedBase(project.base.sha256, bytes);
    return {score:loadInterchangeScore(bytes, settings, appliesFilePartialCapo(project, canRedo)),notice:null};
  }
  const score = new Score(); score.title = project.base.title; score.artist = project.base.artist;
  for (let i = 0; i < project.base.measureCount; i++) score.addMasterBar(new MasterBar());
  score.masterBars[0].tempoAutomations = [Automation.buildTempoAutomation(false, 0, project.base.tempo, 2)];
  addTrack(score, 'Guitar', project.base.tuning, 25);
  score.finish(settings);
  return {score,notice:null};
}

function trackAt(score: model.Score, index: number) {
  if (!integer(index) || !score.tracks[index]) throw refusal('engine.select_existing_track');
  return score.tracks[index];
}

function voiceAt(score: model.Score, target: BeatTarget) {
  if (!target || Object.values(target).some(n => !integer(n))) throw refusal('engine.invalid_beat_selection');
  const staff = trackAt(score, target.track).staves[target.staff];
  const bar = staff?.bars[target.bar]; const voice = bar?.voices[target.voice];
  if (!staff || !bar || !voice) throw refusal('engine.select_existing_measure_voice');
  return {staff, bar, voice};
}

export function describeSelection(score: model.Score, target: BeatTarget) {
  const location = voiceAt(score, target);
  const beat = location.voice.beats[target.beat]?.isEmpty ? undefined : location.voice.beats[target.beat];
  return {...location, beat, master: score.masterBars[target.bar]};
}

function capacity(score: model.Score, target: BeatTarget) {
  const {voice} = voiceAt(score, target);
  for (const beat of voice.beats) { tripleDotTiming(beat);beat.updateDurations(); }
  const duration = voice.beats.reduce((sum, b) => sum + (b.isEmpty || b.graceType !== model.GraceType.None ? 0 : b.playbackDuration), 0);
  const master = score.masterBars[target.bar];
  if (!master.isFreeTime && duration > master.calculateDuration(false)) throw refusal('engine.rhythm_overfill');
}

function tripleDotTiming(beat: model.Beat) {
  if (beat.dots !== 3) return;
  // 1.8.4 calculates only one and two dots. The public duration override
  // keeps its renderer, beat chain and MIDI generator on the same ticks.
  const base=Math.trunc(3840/(beat.duration < 0 ? 1/-beat.duration : beat.duration));
  let ticks=base+Math.trunc(base/2)+Math.trunc(base/4)+Math.trunc(base/8);
  if (beat.tupletDenominator > 0 && beat.tupletNumerator >= 0) ticks=Math.trunc(ticks*beat.tupletDenominator/beat.tupletNumerator);
  beat.overrideDisplayDuration=beat.isFullBarRest ? beat.voice.bar.masterBar.calculateDuration() : ticks;
}

function removeNote(note: model.Note) {
  detachNote(note);
  note.beat.removeNote(note);
}

function apply(score: model.Score, edit: EditCommand, editIndex=0) {
  switch (edit.type) {
    case 'fitVoice': {
      const {voice} = voiceAt(score, {track: edit.track, staff: edit.staff, bar: edit.bar, voice: edit.voice, beat: 0});
      fitVoiceToMeasure(score.masterBars[edit.bar], voice, edit.shorten === true);
      break;
    }
    case 'setNote': case 'removeNote': case 'setRest': case 'setDuration': case 'insertBeat': case 'deleteBeat': {
      const {staff, voice} = voiceAt(score, edit.target);
      const beat = voice.beats[edit.target.beat];
      if (edit.type === 'insertBeat') {
        if (voice.beats.length === 1 && voice.beats[0].isEmpty) voice.beats.splice(0);
        if (edit.target.beat > voice.beats.length || !supportedDurations.includes(edit.duration) || !integer(edit.dots) || edit.dots > 3) throw refusal('engine.invalid_beat_insertion');
        const inserted = rest(edit.duration, edit.dots); inserted.voice = voice;
        voice.beats.splice(edit.target.beat, 0, inserted); capacity(score, edit.target); break;
      }
      if (!beat) throw refusal('engine.select_existing_beat');
      if (edit.type === 'deleteBeat') { for (const note of [...beat.notes]) removeNote(note);voice.beats.splice(edit.target.beat, 1); break; }
      if (edit.type === 'setDuration') {
        if (!supportedDurations.includes(edit.duration) || !integer(edit.dots) || edit.dots > 3) throw refusal('engine.invalid_rhythm');
        beat.duration = edit.duration; beat.dots = edit.dots;beat.overrideDisplayDuration=undefined;capacity(score, edit.target); break;
      }
      if (edit.type === 'setRest') { for (const note of [...beat.notes]) removeNote(note); beat.isEmpty = false; break; }
      if (staff.isPercussion || !integer(edit.string,1) || edit.string > staff.tuning.length) throw refusal('engine.select_string_guitar_bass');
      const existing = beat.notes.find(n => n.string === edit.string);
      if (edit.type === 'removeNote') { if (existing) removeNote(existing); break; }
      const pitch = fretKey(staff, edit.string, edit.fret);
      if (!integer(edit.fret) || pitch < 0 || pitch > 127) throw refusal('engine.fret_outside_midi_range');
      if (!fretExists(staff, edit.string, edit.fret)) throw refusal('engine.banjo_drone_no_frets', { fret: getBanjoDrone(staff) });
      if (existing) {
        let first=existing;while(first.tieOrigin)first=first.tieOrigin;
        for (let note:model.Note|null=first;note;note=note.tieDestination) note.fret=edit.fret;
      }
      else { const note = new Note(); note.string = edit.string; note.fret = edit.fret; beat.addNote(note); }
      beat.isEmpty = false; capacity(score,edit.target); break;
    }
    case 'appendMeasure': {
      const previous = score.masterBars.at(-1)!; const master = new MasterBar();
      master.timeSignatureNumerator = previous.timeSignatureNumerator; master.timeSignatureDenominator = previous.timeSignatureDenominator;
      copyMasterTimeSignatureSource(previous,master);
      score.addMasterBar(master); for (const track of score.tracks) for (const staff of track.staves) appendBar(staff, master); break;
    }
    case 'removeMeasure': {
      if (!integer(edit.bar) || !score.masterBars[edit.bar] || score.masterBars.length === 1) throw refusal('engine.keep_at_least_one_measure');
      removeLyricsMeasure(score,edit.bar);
      const tempo = score.tempo, opening = score.masterBars[0].tempoAutomations.find(a => a.ratioPosition === 0); score.masterBars.splice(edit.bar,1);
      for(const track of score.tracks)track.lineBreaks=new Set([...(track.lineBreaks ?? [])].filter(index=>index!==edit.bar).map(index=>index>edit.bar?index-1:index));
      for (const track of score.tracks) for (const staff of track.staves) {
        for (const voice of staff.bars[edit.bar].voices) for (const beat of voice.beats) for (const note of [...beat.notes]) removeNote(note);
        staff.bars.splice(edit.bar,1);
      }
      if (edit.bar === 0 && !score.masterBars[0].tempoAutomations.length) {
        const inherited = Automation.buildTempoAutomation(false,0,tempo,2);
        if (opening && opening.value === tempo) setTempoUnit(inherited, tempoUnitOf(opening));
        score.masterBars[0].tempoAutomations = [inherited];
      }
      break;
    }
    case 'addTrack': addTrack(score,edit.name,edit.tuning,edit.program,edit.tuningName); break;
    case 'removeTrack': {
      const track=trackAt(score,edit.track); if (score.tracks.length === 1) throw refusal('engine.keep_at_least_one_track');
      for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)detachNote(note);
      remapStylesheetTracks(score.stylesheet,score.tracks.map((_,index)=>index===edit.track?null:index>edit.track?index-1:index));
      score.tracks.splice(edit.track,1); break;
    }
    case 'duplicateTrack': {
      const source=trackAt(score,edit.track);
      const before=captureNoteLinks(score),{copy,links}=duplicateTrack(score,source,edit.track);
      score.tracks.splice(edit.track+1,0,copy);restoreNoteLinks(score,[...before,...links]);
      duplicateStylesheetTrack(score.stylesheet,edit.track); break;
    }
    case 'moveTrack': {
      const count=score.tracks.length;trackAt(score,edit.track);
      if(!integer(edit.to)||edit.to>=count||edit.to===edit.track)throw refusal('engine.choose_different_track_position');
      const order=movedOrder(count,edit.track,edit.to);
      remapStylesheetTracks(score.stylesheet,order.map((_,index)=>order.indexOf(index)));
      score.tracks.splice(edit.to,0,...score.tracks.splice(edit.track,1)); break;
    }
    case 'setTuning': {
      tuningValid(edit.tuning); validateTuningName(edit.tuningName); const track = trackAt(score,edit.track);
      if (track.isPercussion || track.staves.some(s => s.tuning.length !== edit.tuning.length)) throw refusal('engine.retuning_keep_string_count');
      if (track.staves.some(s => getBanjoDrone(s) > 0 && !droneTuningOk(edit.tuning))) throw refusal('engine.banjo_drone_higher_pitch');
      if (edit.keepPitch) {
        refingerTrack(track, { tuning: edit.tuning });
      } else {
        for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
          if (!note.string) continue;
          const pitch=edit.tuning[edit.tuning.length-note.string]+note.fret+stringCapo(staff,note.string)+droneShift(staff,note.string,note.fret)-staff.transpositionPitch;
          if (pitch<0 || pitch>127) throw refusal('engine.tuning_puts_note_outside_midi');
        }
      }
      for (const staff of track.staves) { staff.stringTuning.tunings = [...edit.tuning]; if (edit.tuningName !== undefined) staff.stringTuning.name = edit.tuningName; else if (!staff.stringTuning.name) staff.stringTuning.name = defaultTuningName(edit.tuning); } break;
    }
    case 'setScoreInfo':
      if (!Number.isFinite(edit.tempo) || edit.tempo <= 0) throw refusal('engine.tempo_must_be_positive');
      if (edit.preserveOpeningMark !== undefined && typeof edit.preserveOpeningMark !== 'boolean') throw refusal('engine.invalid_score_info');
      score.title = edit.title; score.artist = edit.artist;
      if (edit.preserveOpeningMark) {
        // The mark keeps everything but its value; a score with no opening mark keeps having none.
        const opening = score.masterBars[0].tempoAutomations.find(a => a.ratioPosition === 0);
        if (opening) opening.value = edit.tempo;
        break;
      }
      {
        // The song tempo field shows quarter notes per minute; an opening tempo that already plays at that speed keeps the unit it is written in.
        const opening = score.masterBars[0].tempoAutomations.find(a => a.ratioPosition === 0);
        const fresh = Automation.buildTempoAutomation(false, 0, edit.tempo, 2);
        if (opening && opening.value === edit.tempo) setTempoUnit(fresh, tempoUnitOf(opening));
        score.masterBars[0].tempoAutomations = [fresh, ...score.masterBars[0].tempoAutomations.filter(a => a.ratioPosition !== 0)];
      }
      break;
    default: if(!applyAdvancedEdit(score,edit,editIndex)) throw refusal('engine.unknown_edit_command');
  }
}

export interface BuiltDocument {
  score:model.Score; settings:DocumentSettings; embeddedBacking:Uint8Array|null; importNotice?:string|null;
  embeddedBackingSettings?:Omit<BackingSettings,'assetId'>; sourceMixes?:Record<string,ChannelMix>;
  sourceBarCount?:number;
}

function removeBackingMeasure(backing:Pick<BackingSettings,'anchors'>|null|undefined,bar:number) {
  if(backing) backing.anchors=backing.anchors.filter(a=>a.bar!==bar).map(a=>({...a,bar:a.bar>bar?a.bar-1:a.bar}));
}

/**
 * A checkpoint: a detached copy of a document that was a real rebuild from the file and its first `index` edits (or was compared with one and found equal),
 * kept so that a later check replays only the edits after it instead of all of them.
 *
 * Why a replay from a checkpoint is a rebuild: the rebuild is a loop over the edits, `state = apply(state, edit)`, from the state the file gives, then a final
 * rebuild of the score. A checkpoint is that state after `index` edits, so replaying edits `index..n` from it is the same loop split at a point the
 * loop passed through. The state is the whole of a `BuiltDocument` (score, settings, identities, backing); the copy the replay starts from is the one `rebuild`
 * makes of a score (the serialization round trip with its links put back), which the loop itself does after most edits. What is not guaranteed by construction
 * is that this extra round trip changes nothing (finishing a track again is not always a no-op, which is why `inPlaceRefusal` knows a case), so it is tested:
 * the fuzz compares the replay from a checkpoint with the rebuild from scratch after every step (`engine.checkpoint.test.ts`), and a check that finds a
 * difference is decided by a rebuild from scratch, never by the replay alone.
 */
export interface Checkpoint {
  built:BuiltDocument;index:number;
  /** How many history entries (not commands: a sequence is one entry) the project had, for the controller's bound on how far back a take-back goes. */
  entries:number;
  /** What the first `index` edits and the base were, and whether the file's partial capo applied when the base was loaded: the checkpoint only fits a project that still has them. */
  prefix:string;base:string;partialCapo:boolean;
}
const baseKey=(project:ProjectInput):string=>project.base.kind==='file'?`file:${project.base.sha256}`:JSON.stringify(project.base);
/** A checkpoint of `built`, which must be the real rebuild of `project`'s edits (or equal to it) and must not be a document that is edited from now on: it is kept as it is. */
export function makeCheckpoint(project:ProjectInput,built:BuiltDocument,canRedo:boolean):Checkpoint {
  const normalized=validateProject(project),edits=projectCommands(normalized);
  return {built,index:edits.length,entries:normalized.edits.length,prefix:JSON.stringify(edits),base:baseKey(normalized),partialCapo:normalized.base.kind==='file'&&appliesFilePartialCapo(normalized,canRedo)};
}
/** Whether `project` still begins with the base and the edits the checkpoint holds (a checkpoint above the end of the history, or of another history, is not valid). */
export function checkpointFits(checkpoint:Checkpoint,project:ProjectInput,canRedo:boolean):boolean {
  const edits=projectCommands(project);
  if(checkpoint.index>edits.length||baseKey(project)!==checkpoint.base)return false;
  if(project.base.kind==='file'&&appliesFilePartialCapo(project,canRedo)!==checkpoint.partialCapo)return false;
  return JSON.stringify(edits.slice(0,checkpoint.index))===checkpoint.prefix;
}
/** A detached copy of a document: its score as `rebuild` makes it (so it shares no object with the original), its settings by value. */
export function cloneDocument(built:BuiltDocument):BuiltDocument {
  const steps=cloneDocumentSteps(built);
  for(;;){const step=steps.next();if(step.done)return step.value;}
}
function* cloneDocumentSteps(built:BuiltDocument):Generator<void,BuiltDocument> {
  const identities=built.score.tracks.map(trackIdentity),score=yield* rebuildSteps(built.score);
  score.tracks.forEach((track,index)=>trackIdentities.set(track,identities[index]));
  return {...built,score,settings:structuredClone(built.settings),embeddedBackingSettings:built.embeddedBackingSettings&&structuredClone(built.embeddedBackingSettings),sourceMixes:built.sourceMixes&&structuredClone(built.sourceMixes)};
}

/** `canRedo`: the document has undone edits, so it is not edit-free even when its list is empty. */
export function buildDocument(value: ProjectInput, canRedo = false): BuiltDocument {
  const steps = buildDocumentSteps(value, canRedo);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
/** `buildDocument` in steps: each `yield` is a point where the caller may let other work go first (the check that compares an edited document with a rebuild uses this so typing is not stalled by a rebuild). */
export function* buildDocumentSteps(value: ProjectInput, canRedo = false, from?: Checkpoint): Generator<void, BuiltDocument> {
  const project = validateProject(value); yield;
  // From a checkpoint the replay starts with the detached copy of the document the first `from.index` edits made, instead of the file; the rest is the same loop.
  let score:model.Score,sourceBarCount:number,identities:string[],documentSettings:DocumentSettings,embeddedBacking:Uint8Array|null,embeddedBackingSettings:Omit<BackingSettings,'assetId'>|undefined,sourceMixes:Record<string,ChannelMix>|undefined,notice:string|null|undefined,start=0;
  if(from) {
    const copy=yield* cloneDocumentSteps(from.built);yield;
    // The copy keeps the ids of the document it was made from, and the counters new objects take theirs from may have been set back since (another file was opened).
    raiseIdCounters(copy.score);
    score=copy.score;sourceBarCount=copy.sourceBarCount!;identities=copy.score.tracks.map(trackIdentity);documentSettings=copy.settings;embeddedBacking=copy.embeddedBacking;
    embeddedBackingSettings=copy.embeddedBackingSettings;sourceMixes=copy.sourceMixes;notice=copy.importNotice;start=from.index;
  } else {
    const initial = initialScore(project, canRedo); score = initial.score; yield;
    sourceBarCount=score.masterBars.length;
    identities=score.tracks.map((_,index)=>`base/${index}`);
    documentSettings=defaultDocumentSettings();
    embeddedBacking=score.backingTrack?.rawAudioFile?.slice() ?? null;
    const embeddedAnchors=score.masterBars.flatMap((bar,index)=>(bar.syncPoints ?? []).flatMap(point=>point.syncPointValue?[{
        bar:index,occurrence:point.syncPointValue.barOccurence,ratio:point.ratioPosition,audioMs:point.syncPointValue.millisecondOffset,
      }]:[]));
    const embeddedOffset=Math.max(0,...embeddedAnchors.map(anchor=>-anchor.audioMs));
    embeddedBackingSettings=embeddedBacking?{
      offsetMs:embeddedOffset,mix:defaultMix(),anchors:embeddedAnchors.map(anchor=>({...anchor,audioMs:anchor.audioMs+embeddedOffset})),
    }:undefined;
    score.tracks.forEach((track,index)=>{documentSettings.mixes[identities[index]]={...defaultMix(),mute:track.playbackInfo.isMute,solo:track.playbackInfo.isSolo};});
    sourceMixes=structuredClone(documentSettings.mixes);notice=initial.notice;
  }
  const history=projectCommands(project);
  for (let index=start;index<history.length;index++) {
    const edit=history[index];
    yield;
    if(isSettingsEdit(edit)) {applySettingsEdit(documentSettings,edit,score,identities);continue;}
    if(documentSettings.backing?.referenceSync)score=yield* rebuildSteps(score);
    const previous=documentSettings.backing?.referenceSync?referenceSyncTiming(documentSettings.backing,backingLocationsForScore(score)):null;
    if(edit.type==='pasteMusic'){
      const prepared=preparePasteMusic(yield* rebuildSteps(score),edit);score=yield* rebuildSteps(prepared.score);
      // Tracks a multitrack paste appended get identities of their own, so their mix and engraving settings never reuse another track's.
      for(let added=0;added<(prepared.addedTracks??0);added++)identities.push(`added/${index}/paste/${added}`);
      if(prepared.addedTracks)forgetTrackOrderedEntries(score);
      mapBackingMeasures(documentSettings.backing,prepared.barMap);mapBackingMeasures(embeddedBackingSettings,prepared.barMap);documentSettings.engraving=mapEngravingBars(documentSettings.engraving,prepared.barMap.oldToNew);
    }else if(edit.type==='importTracks'){
      const prepared=prepareImportTracks(yield* rebuildSteps(score),edit);score=yield* rebuildSteps(prepared.score);
      for(let added=0;added<prepared.addedTracks;added++)identities.push(`added/${index}/import/${added}`);
      if(prepared.addedTracks)forgetTrackOrderedEntries(score);
      mapBackingMeasures(documentSettings.backing,prepared.barMap);mapBackingMeasures(embeddedBackingSettings,prepared.barMap);documentSettings.engraving=mapEngravingBars(documentSettings.engraving,prepared.barMap.oldToNew);
    }else if(edit.type==='transposeHarmony')score=prepareHarmonyTranspose(yield* rebuildSteps(score),edit,index);
    else {
      if(!previous&&['setOttava','setCrescendo','setFermata','setSustainPedal','setSimile','eraseSelection','cutSelection','transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain','setSelectionStrokes','setSelectionTies','tieSelectionToEarlierPitch','insertMeasures','removeMeasures'].includes(edit.type))score=yield* rebuildSteps(score);
      const measureMap=edit.type==='insertMeasures'||edit.type==='removeMeasures'?planMeasureMap(score.masterBars.length,edit):null;
      if(measureMap)mapLyricsMeasures(score,measureMap);
      apply(score, edit,index);
      if(measureMap){mapBackingMeasures(documentSettings.backing,measureMap);mapBackingMeasures(embeddedBackingSettings,measureMap);documentSettings.engraving=mapEngravingBars(documentSettings.engraving,measureMap.oldToNew);}
      if (edit.type==='addTrack'||edit.type==='addPitchedTrack'||edit.type==='addPercussionTrack') identities.push(`added/${index}/${JSON.stringify(edit)}`);
      if (edit.type==='removeTrack') identities.splice(edit.track,1);
      if (edit.type==='moveTrack') identities.splice(edit.to,0,...identities.splice(edit.track,1));
      if (edit.type==='duplicateTrack') {identities.splice(edit.track+1,0,`added/${index}/${JSON.stringify(edit)}`);copyTrackSettings(documentSettings,identities[edit.track],identities[edit.track+1]);}
      if (['addTrack','addPitchedTrack','addPercussionTrack','removeTrack','moveTrack','duplicateTrack'].includes(edit.type)) forgetTrackOrderedEntries(score);
      if(edit.type==='removeMeasure') {removeBackingMeasure(documentSettings.backing,edit.bar);removeBackingMeasure(embeddedBackingSettings,edit.bar);documentSettings.engraving=mapEngravingBars(documentSettings.engraving,Array.from({length:score.masterBars.length+1},(_,bar)=>bar<edit.bar?bar:bar===edit.bar?null:bar-1));}
      if (!previous&&['insertBeat','deleteBeat','fitVoice','cutSelection','appendMeasure','removeMeasure','insertMeasures','removeMeasures','addTrack','addPitchedTrack','addPercussionTrack','removeTrack','moveTrack','duplicateTrack','addStaff','removeStaff','addVoice','removeVoice','copyVoice'].includes(edit.type)) {
        score = yield* rebuildSteps(score);
      }
    }
    assertDroneFrets(score);
    if(previous){score=yield* rebuildSteps(score);documentSettings.backing=adjustReferenceSyncBounds(documentSettings.backing!,previous,backingLocationsForScore(score));}
  }
  // Transient conversion rebuilds derived links and caches; native files store source bytes and commands.
  yield;score=yield* rebuildSteps(score);prepareScoreTimers(score);score.tracks.forEach((track,index)=>trackIdentities.set(track,identities[index]));
  validateEngravingTracks(score,identities,{...documentSettings.engraving,profiles:documentSettings.engraving.profiles.filter(entry=>identities.includes(entry.trackId))});
  const built={score,settings:documentSettings,embeddedBacking,embeddedBackingSettings,sourceMixes,sourceBarCount,importNotice:notice};
  validateBackingAnchors(score,effectiveAudioSettings(project,built).backing);return built;
}

export function replayDocumentSettings(value:ProjectInput,current:BuiltDocument):BuiltDocument {
  const project=validateProject(value);const next=defaultDocumentSettings();
  // A duplicated track's copied settings come from the full build, which tracks identities through track edits.
  if(projectCommands(project).some(edit=>edit.type==='pasteMusic'||edit.type==='importTracks'||edit.type==='duplicateTrack'||edit.type==='setBacking'&&edit.backing?.referenceSync))return {...buildDocument(project),score:current.score,embeddedBacking:current.embeddedBacking};
  const sourceBarCount=current.sourceBarCount??(project.base.kind==='blank'?project.base.measureCount:initialScore(project,false).score.masterBars.length);
  let barCount=sourceBarCount;
  next.mixes=structuredClone(current.sourceMixes ?? Object.fromEntries(current.score.tracks.map(track=>[trackIdentity(track),{...defaultMix(),mute:track.playbackInfo.isMute,solo:track.playbackInfo.isSolo}])));
  // Applied history already passed candidate validation. Its earlier backing anchors
  // refer to the measure layout at that point, before later deletions.
  for(const edit of projectCommands(project)) switch(edit.type) {
    case 'setTrackMix': next.mixes[edit.trackId]=structuredClone(edit.mix);break;
    case 'setTrackSound': next.sounds[edit.trackId]=completeSound(structuredClone(edit.sound));break;
    case 'setBacking': next.backing=structuredClone(edit.backing);break;
    case 'setPrintLayout': next.print=structuredClone(edit.layout);next.page=null;break;
    case 'setEngraving':next.engraving=structuredClone(edit.engraving);break;
    case 'setPageLayout':next.page=structuredClone(edit.layout);break;
    case 'setMaster':next.master=structuredClone(completeMaster(edit.master));break;
    case 'appendMeasure': barCount++;break;
    case 'removeMeasure': removeBackingMeasure(next.backing,edit.bar);next.engraving=mapEngravingBars(next.engraving,Array.from({length:barCount},(_,bar)=>bar<edit.bar?bar:bar===edit.bar?null:bar-1));barCount--;break;
    case 'insertMeasures': case 'removeMeasures': {
      const map=planMeasureMap(barCount,edit);mapBackingMeasures(next.backing,map);next.engraving=mapEngravingBars(next.engraving,map.oldToNew);
      barCount=map.oldToNew.filter(bar=>bar!==null).length+map.inserted.length;break;
    }
  }
  const built={score:current.score,settings:next,embeddedBacking:current.embeddedBacking,embeddedBackingSettings:current.embeddedBackingSettings,sourceMixes:current.sourceMixes,sourceBarCount,importNotice:current.importNotice};
  validateBackingAnchors(current.score,effectiveAudioSettings(project,built).backing);return built;
}

export function effectiveAudioSettings(project:ProjectInput,built:BuiltDocument):DocumentSettings {
  if(built.settings.backing || !built.embeddedBacking || projectCommands(project).some(edit=>edit.type==='setBacking')) return built.settings;
  const embedded=built.embeddedBackingSettings ?? {offsetMs:0,anchors:[],mix:defaultMix()};
  return {...built.settings,backing:{assetId:'embedded',...structuredClone(embedded)}};
}

export function buildScore(value:ProjectInput):model.Score {return buildDocument(value).score;}

/** `rebuildSteps` run to the end. */
function rebuild(score: model.Score) {
  const steps=rebuildSteps(score);
  for(;;){const step=steps.next();if(step.done)return step.value;}
}
/** What the serialization pass does to a score, with a point (`yield`) between writing it out and reading it back, so a check made in slices has none longer than half of it. */
function* rebuildSteps(score: model.Score): Generator<void,model.Score> {
  // alphaTab's beat chain requires a carrier even in an empty following voice.
  for (const track of score.tracks) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) {
    if (!voice.beats.length) { const empty=new Beat();empty.isEmpty=true;voice.addBeat(empty); }
    for (const beat of voice.beats) tripleDotTiming(beat);
  }
  const links=captureNoteLinks(score);
  const json=JsonConverter.scoreToJson(score);
  yield;
  const result=scoreFromJson(json, settings);
  restoreNoteLinks(result,links);
  copyGpInterchangeSource(score,result);
  reflowLyrics(result);
  return result;
}

/**
 * The last score edit built by previewEdit, kept for one reuse: note entry plans an edit by building it, and the
 * controller then records that same edit on the same project, so the second build is spared. Keyed by the project
 * object (projects are never changed in place) and the edit's JSON; taken at most once, so no two callers share a score.
 */
let lastBuilt:{project:ProjectInput;edit:string;built:Omit<ReturnType<typeof buildDocument>,'project'>}|null=null;
/** Drops a kept build, so a document the caller adopts as live state is never handed out again. */
export function forgetPreview() { lastBuilt=null; }
export function previewEdit(project: ProjectInput, edit: EditCommand, current?:BuiltDocument) {
  const normalized=validateProject(project);
  const next: Project = {...normalized, edits:[...normalized.edits,structuredClone(edit)]};
  validateProject(next);
  if(current && isSettingsEdit(edit)) {
    const nextSettings=structuredClone(current.settings);
    applySettingsEdit(nextSettings,edit,current.score,current.score.tracks.map(trackIdentity));
    const candidate={...current,project:next,settings:nextSettings};
    validateBackingAnchors(current.score,effectiveAudioSettings(next,candidate).backing);return candidate;
  }
  const key=JSON.stringify(edit),reused=lastBuilt?.project===project&&lastBuilt.edit===key?lastBuilt.built:null;lastBuilt=null;
  if(reused)return {...reused,project:next};
  const built=buildDocument(next);assertDiagramFrets(built.score,edit);
  lastBuilt={project,edit:key,built};
  return {...built,project:next};
}

/**
 * Editing a built document in place.
 *
 * `buildDocument` rebuilds a document from its file and every edit, which costs seconds on a long score. The edits a person makes
 * most (a note, a rest, a duration, a beat) touch one voice and nothing outside its track, so they are applied to the document
 * that is already built, and only that track's derived state (beat chain, timings, links) is worked out again. The result must be
 * the document a full rebuild gives, so it is only done for edits known to be safe this way, `verifyEditInPlace` checks it, and
 * everything else, or anything this refuses, takes the full rebuild.
 */
const inPlaceTypes=new Set<string>(['setNote','removeNote','setRest','setDuration','insertBeat','deleteBeat']);
const inPlaceSteps=(edit:EditCommand):SingleCommand[]|null=>{
  const steps:SingleCommand[]=edit.type==='sequence'?edit.commands as SingleCommand[]:[edit];
  if(!steps.length||steps.some(step=>!inPlaceTypes.has(step.type)||!('target' in step)||!step.target||typeof step.target!=='object'||step.target.track!==(steps[0] as {target:BeatTarget}).target.track))return null;
  return steps;
};
/** How a score came from another by an edit in place: its predecessor and the one track whose content changed. Lets a view of the score (the engraving projection) follow the edit without being rebuilt. */
export interface ScoreLineage {previous:model.Score;track:number;/** The edit applied, or null when the edit that made `previous` was taken back. */edit:EditCommand|null}
const lineages=new WeakMap<model.Score,ScoreLineage>();
export const scoreLineage=(score:model.Score):ScoreLineage|undefined=>lineages.get(score);
/**
 * How many edits back a lineage can be walked (a view that skipped some draws follows the edits in turn; `followProjection` takes at most eight). A lineage
 * names its predecessor, so one that is never cut keeps every score since the last full build alive, each with the journal and the rendered copy it made.
 */
export const LINEAGE_DEPTH=8;
function setLineage(next:model.Score,step:ScoreLineage):void {
  lineages.set(next,step);
  let at=step.previous;
  for(let depth=1;depth<LINEAGE_DEPTH;depth++){const earlier=lineages.get(at);if(!earlier)return;at=earlier.previous;}
  lineages.delete(at);
}
/** Why `edit` may not be applied to `current` in place (anything not known to be safe is refused and takes the full rebuild), or null when it may. */
export function inPlaceRefusal(current:BuiltDocument,edit:EditCommand):string|null {
  const steps=inPlaceSteps(edit);if(!steps)return 'edit type';
  const track=current.score.tracks[(steps[0] as {target:BeatTarget}).target.track];if(!track)return 'no such track';
  if(current.settings.backing?.referenceSync)return 'reference timing';
  // Lyrics that are laid out from their text are laid out again after an edit; the pedal markers are repaired by the rebuild.
  const lyrics=getLyricsSource(track);if(lyrics&&(lyrics.managed||!lyrics.value.visible))return 'managed lyrics';
  for(const staff of track.staves)for(const bar of staff.bars)if(bar.sustainPedals.length)return 'sustain pedals';
  // A pickup bar's length is what it holds, which moves every bar after it; a bar's fermatas are kept for all the tracks at once; a
  // free-time bar has no length to keep. Edits to such bars, and to a voice that holds a fermata, are rebuilt.
  for(const step of steps) {
    const place=(step as {target:BeatTarget}).target,master=current.score.masterBars[place.bar],voice=track.staves[place.staff]?.bars[place.bar]?.voices[place.voice];
    if(!master||!voice)return 'no such bar';
    if(master.isAnacrusis)return 'pickup bar';
    if(master.isFreeTime)return 'free-time bar';
    if(master.fermata!==null||voice.beats.some(beat=>beat.fermata))return 'fermata';
    if(changesRests(step,voice.beats[place.beat])&&flagNearby(track.staves[place.staff],place))return 'let ring or palm mute beside a rest';
  }
  // A beat that shows its running time has it worked out from the whole score's playback, which an edit would change for every beat after it.
  return showsTimers(current.score)?'timers':null;
}
/** Whether `edit` may be applied to `current` in place. */
export const canEditInPlace=(current:BuiltDocument,edit:EditCommand):boolean=>inPlaceRefusal(current,edit)===null;
/**
 * Whether a step can make a beat a rest or a note (or add or remove a beat), which is what moves the let ring and palm mute marks of the beats around it:
 * finishing hands them on to a rest from the beat before and takes them off the rests before a note that lacks them, from whatever the marks were already,
 * so their result depends on how many times the track was finished (a rebuild from the file does it twice, an edit in place once more each time).
 */
const changesRests=(step:SingleCommand,beat:model.Beat|undefined):boolean=>{
  if(step.type==='setDuration')return false;
  const notes=beat?.notes.length??0;
  // A note written on a beat that has notes, or one of several removed, leaves it a note; a rest made of a rest changes nothing.
  if(step.type==='setNote')return notes===0;
  if(step.type==='removeNote')return notes<=1;
  if(step.type==='setRest')return notes>0;
  return true;
};
/** Whether a beat in the run of rests around `place`, with the note before and the note after the run, carries a let ring or palm mute mark. */
function flagNearby(staff:model.Staff,place:BeatTarget):boolean {
  const lane=(bar:number)=>staff.bars[bar]?.voices[place.voice]?.beats??[];
  const marked=(beat:model.Beat)=>beat.isLetRing||beat.isPalmMute||beat.notes.some(note=>note.isLetRing||note.isPalmMute);
  const resting=(beat:model.Beat)=>beat.isRest||beat.isEmpty||beat.notes.length===0;
  let steps=0;
  // Backwards from the beat, through the rests, to the note before them.
  for(let bar=place.bar,index=place.beat;bar>=0&&steps<4000;){
    const beats=lane(bar);if(index<0){bar--;index=lane(bar).length-1;continue;}
    const beat=beats[index];steps++;if(!beat){bar--;index=lane(bar).length-1;continue;}
    if(marked(beat))return true;
    if(!(bar===place.bar&&index===place.beat)&&!resting(beat))break;
    index--;
  }
  // Forwards from the beat, likewise.
  for(let bar=place.bar,index=place.beat;bar<staff.bars.length&&steps<8000;){
    const beats=lane(bar);if(index>=beats.length){bar++;index=0;continue;}
    const beat=beats[index];steps++;
    if(marked(beat))return true;
    if(!(bar===place.bar&&index===place.beat)&&!resting(beat))break;
    index++;
  }
  return false;
}
const timerScores=new WeakMap<model.Score,boolean>();
function showsTimers(score:model.Score):boolean {
  let known=timerScores.get(score);
  if(known===undefined){known=score.tracks.some(track=>track.staves.some(staff=>staff.bars.some(bar=>bar.voices.some(voice=>voice.beats.some(beat=>beat.showTimer)))));timerScores.set(score,known);}
  return known;
}
/** Everything `rebuild` does to a score before and after its serialization, for one track whose beats changed. */
function settleTrack(track:model.Track) {
  const dynamics=new Map<model.Note,number>();
  // `rebuild` captures the links between notes before the serialization and puts them back after it, so what finishing works out for them
  // (a hammer-on re-pointed at a new note between its two) is undone; the same is done here, for the notes of this track.
  const alone={tracks:[track]} as unknown as model.Score,links=captureNoteLinks(alone);
  // The voices a staff has music in only ever grow while finishing, and in the order the bars first used them.
  for(const staff of track.staves)(staff as unknown as {_filledVoices:Set<number>})._filledVoices.clear();
  for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices) {
    if(!voice.beats.length){const empty=new Beat();empty.isEmpty=true;voice.addBeat(empty);}
    for(const beat of voice.beats){
      tripleDotTiming(beat);
      // What finishing only ever sets, never clears: a beat that lost its successor, or a lookup entry of a note that is gone.
      beat.previousBeat=null;beat.nextBeat=null;
      beat.isEffectSlurOrigin=false;beat.effectSlurOrigin=null;beat.effectSlurDestination=null;beat.noteValueLookup.clear();
      for(const [position,note] of beat.notes.entries()){note.index=position;dynamics.set(note,note.dynamics);note.hasEffectSlur=false;note.isEffectSlurOrigin=false;note.effectSlurOrigin=null;note.effectSlurDestination=null;(note as unknown as {effectSlur:unknown}).effectSlur=null;}
    }
  }
  // Finishing a track again works out what the serialization pass works out: the beat chain, timings, tie and slide derivations.
  track.finish(settings,null);
  restoreNoteLinks(alone,links);
  // Public Beat.finish assigns the beat's dynamics to every note; a note keeps its own, as it does through the serialization.
  for(const [note,value] of dynamics)note.dynamics=value;
}
/**
 * New notes, beats, bars and voices take the next value of a counter that every importer start sets back to zero, so after another score
 * was opened an edit in place would give a new object the id of one the document already holds. The counters are raised above the
 * highest id the score holds before an edit creates anything. A score's highest ids are found once and carried to its successors.
 */
type IdCeilings={note:number;beat:number;bar:number;voice:number};
const idCeilings=new WeakMap<model.Score,IdCeilings>();
const idCounters=model as unknown as {Note:{globalNoteId:number};Beat:{_globalBeatId:number};Bar:{_globalBarId:number};Voice:{_globalVoiceId:number}};
type CounterMark=[number,number,number,number];
const counterMark=():CounterMark=>[idCounters.Note.globalNoteId,idCounters.Beat._globalBeatId,idCounters.Bar._globalBarId,idCounters.Voice._globalVoiceId];
const counterMax=(a:CounterMark,b:CounterMark):CounterMark=>[Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
function raiseCounters(mark:CounterMark):void {
  idCounters.Note.globalNoteId=Math.max(idCounters.Note.globalNoteId,mark[0]);idCounters.Beat._globalBeatId=Math.max(idCounters.Beat._globalBeatId,mark[1]);
  idCounters.Bar._globalBarId=Math.max(idCounters.Bar._globalBarId,mark[2]);idCounters.Voice._globalVoiceId=Math.max(idCounters.Voice._globalVoiceId,mark[3]);
}
function raiseIdCounters(score:model.Score):void {
  let ceilings=idCeilings.get(score);
  if(!ceilings){
    ceilings={note:-1,beat:-1,bar:-1,voice:-1};
    for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars){
      ceilings.bar=Math.max(ceilings.bar,bar.id);
      for(const voice of bar.voices){ceilings.voice=Math.max(ceilings.voice,voice.id);for(const beat of voice.beats){ceilings.beat=Math.max(ceilings.beat,beat.id);for(const note of beat.notes)ceilings.note=Math.max(ceilings.note,note.id);}}
    }
    idCeilings.set(score,ceilings);
  }
  idCounters.Note.globalNoteId=Math.max(idCounters.Note.globalNoteId,ceilings.note+1);idCounters.Beat._globalBeatId=Math.max(idCounters.Beat._globalBeatId,ceilings.beat+1);
  idCounters.Bar._globalBarId=Math.max(idCounters.Bar._globalBarId,ceilings.bar+1);idCounters.Voice._globalVoiceId=Math.max(idCounters.Voice._globalVoiceId,ceilings.voice+1);
}
/** What an edit made, as the new highest ids of its score. */
function noteIdCeilings(score:model.Score):void {
  const ceilings=idCeilings.get(score);if(!ceilings)return;
  ceilings.note=Math.max(ceilings.note,idCounters.Note.globalNoteId-1);ceilings.beat=Math.max(ceilings.beat,idCounters.Beat._globalBeatId-1);
  ceilings.bar=Math.max(ceilings.bar,idCounters.Bar._globalBarId-1);ceilings.voice=Math.max(ceilings.voice,idCounters.Voice._globalVoiceId-1);
}
/**
 * The same document under a new identity: a score made of the same tracks and measures, so that everything that follows a score by its
 * identity (the engraving projection, the render, the playback plan) sees a change. The old shell stays what it was, but its tracks now
 * belong to the new one, so it is no longer shown.
 */
export function newScoreIdentity(old:model.Score):model.Score {
  const next=Object.assign(Object.create(Object.getPrototypeOf(old)),old) as model.Score;
  next.tracks=[...old.tracks];next.masterBars=[...old.masterBars];
  for(const item of next.tracks)item.score=next;
  for(const master of next.masterBars)master.score=next;
  copyGpInterchangeSource(old,next);
  const ceilings=idCeilings.get(old);if(ceilings)idCeilings.set(next,ceilings);
  return next;
}
function reviseScore(old:model.Score,track:number,edit:EditCommand):model.Score {
  const next=newScoreIdentity(old);setLineage(next,{previous:old,track,edit});timerScores.set(next,false);return next;
}
/**
 * What it takes to put a track back as it was before an edit applied in place: the beats of the voices the edit touched (their own fields and
 * their note lists), the fret of every note of the track (an edit to a tied note changes the whole chain), and the links between the notes.
 * What finishing works out (the beat chain, timings) is worked out again by `settleTrack` afterwards, as it is after an edit.
 */
function captureJournal(score:model.Score,trackIndex:number,steps:SingleCommand[]):()=>void {
  const track=score.tracks[trackIndex],alone={tracks:[track]} as unknown as model.Score,links=captureNoteLinks(alone);
  const voices=new Set<model.Voice>();
  for(const step of steps){const place=(step as {target:BeatTarget}).target;const voice=track.staves[place.staff]?.bars[place.bar]?.voices[place.voice];if(voice)voices.add(voice);}
  const frets=new Map<model.Note,number>();
  for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)frets.set(note,note.fret);
  const saved=[...voices].map(voice=>({
    voice,beats:voice.beats.slice(),
    beatFields:voice.beats.map(beat=>({beat,fields:{...beat,notes:beat.notes.slice(),noteStringLookup:new Map(beat.noteStringLookup),noteValueLookup:new Map(beat.noteValueLookup)} as Record<string,unknown>,notes:beat.notes.map(note=>({note,fields:{...note} as Record<string,unknown>}))})),
  }));
  return ()=>{
    for(const item of saved){
      item.voice.beats=item.beats.slice();
      for(const beatState of item.beatFields){Object.assign(beatState.beat,beatState.fields);beatState.beat.notes=(beatState.fields.notes as model.Note[]).slice();for(const noteState of beatState.notes)Object.assign(noteState.note,noteState.fields);}
    }
    for(const [note,fret] of frets)note.fret=fret;
    restoreNoteLinks(alone,links);
    settleTrack(track);
  };
}
/** How many edits applied in place can be taken back one after the other without a rebuild (each keeps the track's frets and links as they were). */
const JOURNAL_DEPTH=24;
interface Journal {restore:()=>void;older:Journal|null;track:number}
const journals=new WeakMap<model.Score,Journal>();
/** How many edits applied in place can be taken back from `score` one after the other (for tests of what is kept alive). */
export function journalDepth(score:model.Score):number {let depth=0;for(let at=journals.get(score)??null;at;at=at.older)depth++;return depth;}
/** Whether the last edit that made this document's score can be taken back without a rebuild. */
export const canUndoInPlace=(score:model.Score):boolean=>journals.has(score);
/**
 * Takes back the edit that made `current`'s score (applied in place), on the same tracks, under a new identity. Throws when there is nothing to take back.
 * The edit before it, if it was also applied in place, can be taken back in turn.
 */
export function undoInPlace(current:BuiltDocument):BuiltDocument {
  const score=undoScore(current.score);
  return {...current,score};
}
/** Takes back the edit that made `score` and returns the same tracks under a new identity (the journal of the edit before it goes with it). */
function undoScore(score:model.Score):model.Score {
  const journal=journals.get(score);if(!journal)throw new Error('There is no edit to take back in place.');
  raiseIdCounters(score);
  journal.restore();
  noteIdCeilings(score);journals.delete(score);
  const next=newScoreIdentity(score);
  if(journal.older)journals.set(next,journal.older);
  setLineage(next,{previous:score,track:journal.track,edit:null});timerScores.set(next,false);
  return next;
}
/** The rendered copy of a document, with the edit that was applied to the document applied to it (returns the copy under a new identity; the copy can then take the edit back in place too). */
export function editCopyInPlace(copy:model.Score,edit:EditCommand,index=0):model.Score {
  const steps=inPlaceSteps(edit);if(!steps)throw new Error('This edit cannot be applied in place.');
  const track=(steps[0] as {target:BeatTarget}).target.track;
  raiseIdCounters(copy);
  const restore=captureJournal(copy,track,steps);
  for(const step of steps){apply(copy,step,index);settleTrack(copy.tracks[track]);}
  noteIdCeilings(copy);
  const next=newScoreIdentity(copy),journal:Journal={restore,older:journals.get(copy)??null,track};journals.set(next,journal);journals.delete(copy);
  let oldest:Journal=journal;for(let depth=1;depth<JOURNAL_DEPTH&&oldest.older;depth++)oldest=oldest.older;oldest.older=null;
  return next;
}
/** The rendered copy with the edit that made it taken back (null when it holds nothing to take back). */
export function undoCopyInPlace(copy:model.Score):model.Score|null {return journals.has(copy)?undoScore(copy):null;}
/**
 * Applies `edit` to the score of `current` in place and returns the document with a new score identity (the old one is no longer
 * valid, and must not be shown). Throws what the edit refuses with, after which the score is in an unknown state: the caller
 * rebuilds the document from its project.
 */
export function editInPlace(current:BuiltDocument,edit:EditCommand,index:number):BuiltDocument {
  validateParityCommand(edit);
  const steps=inPlaceSteps(edit);if(!steps||!canEditInPlace(current,edit))throw new Error('This edit cannot be applied in place.');
  const score=current.score,track=(steps[0] as {target:BeatTarget}).target.track;
  raiseIdCounters(score);
  const restore=captureJournal(score,track,steps);
  for(const step of steps) {
    apply(score,step,index);assertDroneFrets(score);
    settleTrack(score.tracks[track]);
  }
  noteIdCeilings(score);
  const next=reviseScore(score,track,edit),journal:Journal={restore,older:journals.get(score)??null,track};journals.set(next,journal);
  // The next score holds this journal as its predecessor's: the shell that is no longer shown keeps nothing of its own.
  journals.delete(score);
  // Only the newest edits keep what it takes to take them back.
  let oldest:Journal=journal;for(let depth=1;depth<JOURNAL_DEPTH&&oldest.older;depth++)oldest=oldest.older;oldest.older=null;
  return {...current,score:next};
}
/** A detached copy of the beats of `voice` with what applying a note, rest, duration or beat edit reads: durations, tuplets, grace type, and each note's string and fret. It carries no links to other notes, so applying an edit to it reaches nothing outside it. */
function scratchVoice(voice:model.Voice):model.Voice {
  const copy=new Voice();copy.bar=voice.bar;copy.index=voice.index;
  for(const beat of voice.beats) {
    const next=new Beat();
    next.duration=beat.duration;next.dots=beat.dots;next.isEmpty=beat.isEmpty;next.graceType=beat.graceType;
    next.tupletNumerator=beat.tupletNumerator;next.tupletDenominator=beat.tupletDenominator;next.overrideDisplayDuration=beat.overrideDisplayDuration;
    copy.addBeat(next);
    for(const note of beat.notes){const made=new Note();made.string=note.string;made.fret=note.fret;made.isDead=note.isDead;next.addNote(made);}
  }
  return copy;
}
/**
 * Whether `edit` applies to the document: the same checks, and the same refusals, as applying it, made on detached copies of the
 * voices it touches so that the document itself is not changed. Throws what the edit is refused with.
 */
export function checkEditInPlace(current:BuiltDocument,edit:EditCommand,index:number):void {
  validateParityCommand(edit);
  const steps=inPlaceSteps(edit);if(!steps||!canEditInPlace(current,edit))throw new Error('This edit cannot be applied in place.');
  const score=current.score,swapped:{bar:model.Bar;position:number;original:model.Voice}[]=[],scratches=new Set<model.Voice>();
  try {
    for(const step of steps) {
      const {bar,voice}=voiceAt(score,(step as {target:BeatTarget}).target);
      if(!scratches.has(voice)){const position=bar.voices.indexOf(voice),copy=scratchVoice(voice);swapped.push({bar,position,original:voice});bar.voices[position]=copy;scratches.add(copy);}
      apply(score,step,index);assertDroneFrets(score);
    }
  } finally {for(const item of swapped)item.bar.voices[item.position]=item.original;}
}
/**
 * The document built for a project that is the current state of an open document, found by the project object (a project is never changed in place).
 * Lets a question that only asks whether edits would apply (`editsFitLive`) be answered on the open document instead of building a new one.
 */
const liveDocuments=new WeakMap<object,BuiltDocument>();
export function registerLiveDocument(project:object,document:BuiltDocument):void {liveDocuments.set(project,document);}
/**
 * Whether the commands, applied one after another to the project's document, would all be accepted: true or false when that can be told from the
 * open document (checked on copies of the voices they touch, with the refusals of applying them), null when it cannot (the caller builds the document).
 */
export function editsFitLive(project:ProjectInput,commands:EditCommand[]):boolean|null {
  const live=liveDocuments.get(project);if(!live||!commands.length)return null;
  // A sequence holds two to eight note-entry steps and no beat deletion: anything else is not a question this can answer.
  if(commands.length>MAX_SEQUENCE_COMMANDS||commands.some(command=>command.type==='deleteBeat'||command.type==='sequence'))return null;
  const edit:EditCommand=commands.length===1?commands[0]:{type:'sequence',commands:commands as never};
  if(!canEditInPlace(live,edit))return null;
  try{checkEditInPlace(live,edit,projectCommands(project).length);return true;}catch{return false;}
}
/** What the edits did so far: in place, by a full rebuild, rebuilt after an in-place edit was refused or failed, and compared with a full rebuild. */
export const editStats={inPlace:0,full:0,healed:0,verified:0,mismatches:0};
/** The counters and the sampled check are reachable from outside (`globalThis.__tabplayerEditStats`, `__tabplayerCheckEdits`) only in development, in tests and in the desktop test build; a release build offers neither. */
const developerHooks=(()=>{const env=(import.meta as {env?:{DEV?:boolean;MODE?:string;VITE_DESKTOP_TEST?:string}}).env;return !!(env?.DEV||env?.MODE==='test'||env?.VITE_DESKTOP_TEST==='1');})();
if(developerHooks)(globalThis as {__tabplayerEditStats?:typeof editStats}).__tabplayerEditStats=editStats;
/**
 * How often an edit made in place is compared with a full rebuild (every n-th; 0 never). The comparison costs as much as the
 * rebuild it replaces, so it is on for tests and development builds, and a person or a test can turn it on in a running app with
 * `globalThis.__tabplayerCheckEdits=n`. A difference is reported to the console and the rebuilt document replaces the edited one.
 */
export const editCheck={every:(import.meta as {env?:{DEV?:boolean}}).env?.DEV?25:0,count:0};
/** How long after the last edit the document edited in place is compared with a rebuild, in every build (0 turns it off: the unit tests start it themselves). */
export const idleVerification={afterMs:(import.meta as {env?:{MODE?:string}}).env?.MODE==='test'?0:2000};
export function shouldCheckEdit():boolean {
  const override=developerHooks?(globalThis as {__tabplayerCheckEdits?:number}).__tabplayerCheckEdits:undefined,every=typeof override==='number'?override:editCheck.every;
  return every>0&&++editCheck.count%every===0;
}
/** How two documents differ (their scores as `describeScore` sees them, then their settings), as a readable path, or null when they are the same. Repeated ids in `built` count as a difference. */
export function compareDocuments(built:BuiltDocument,full:BuiltDocument):string|null {
  const repeated=duplicateIds(built.score);if(repeated)return `duplicate ids: ${repeated}`;
  const difference=firstDifference(describeScore(built.score),describeScore(full.score));
  if(difference)return `score ${difference}`;
  const settingsDifference=firstDifference(JSON.parse(JSON.stringify(built.settings)),JSON.parse(JSON.stringify(full.settings)));
  return settingsDifference?`settings ${settingsDifference}`:null;
}
/** The document a full rebuild gives for `project`, compared with `built`: null when they are the same, otherwise where they first differ. */
export function verifyEditInPlace(project:ProjectInput,built:BuiltDocument,canRedo=false):string|null {
  return compareWithRebuild(project,built,canRedo).problem;
}
/** `verifyEditInPlace` that also hands back the document it rebuilt (a real rebuild from scratch, in one piece). */
export function compareWithRebuild(project:ProjectInput,built:BuiltDocument,canRedo=false):{problem:string|null;rebuilt:BuiltDocument|null} {
  const repeated=duplicateIds(built.score);if(repeated)return {problem:`duplicate ids: ${repeated}`,rebuilt:null};
  const rebuilt=buildDocument(project,canRedo);
  return {problem:compareDocuments(built,rebuilt),rebuilt};
}

/**
 * `verifyEditInPlace` that lets other work go first between its steps (`pause`) and gives up when `cancelled()` says the document moved on.
 * Resolves null when cancelled, otherwise the difference found (null when the documents are the same) and the document rebuilt from the project, from the file
 * and every edit, or, given a checkpoint that fits, from the checkpoint and the edits after it.
 */
export async function verifyEditStepwise(project:ProjectInput,built:BuiltDocument,canRedo:boolean,pause:()=>Promise<void>,cancelled:()=>boolean,from?:Checkpoint):Promise<{problem:string|null;rebuilt:BuiltDocument}|null> {
  const build=buildDocumentSteps(project,canRedo,from);let step=build.next();
  // Opening another file sets the global id counters back to zero. The rebuild's own objects must never share an id, so at each resume the counters
  // are put back to where this rebuild had taken them (never lowered below what it reached).
  let reached=counterMark();
  while(!step.done){
    reached=counterMax(reached,counterMark());
    await pause();if(cancelled())return null;
    raiseCounters(reached);step=build.next();
  }
  const rebuilt=step.value,repeated=duplicateIds(built.score);
  // A rebuild that holds a repeated id is a disturbed one: the check is called off, it never stands for a repair.
  if(duplicateIds(rebuilt.score))return null;
  const described=describeScoreSteps(built.score),expected=describeScoreSteps(rebuilt.score);
  let one=described.next(),other=expected.next();
  while(!one.done||!other.done){await pause();if(cancelled())return null;if(!one.done)one=described.next();if(!other.done)other=expected.next();}
  const comparing=firstDifferenceSteps(one.value,other.value);let compared=comparing.next();
  while(!compared.done){await pause();if(cancelled())return null;compared=comparing.next();}
  const difference=compared.value;
  const settingsDifference=difference?null:firstDifference(JSON.parse(JSON.stringify(built.settings)),JSON.parse(JSON.stringify(rebuilt.settings)));
  return {rebuilt,problem:repeated?`duplicate ids: ${repeated}`:difference?`score ${difference}`:settingsDifference?`settings ${settingsDifference}`:null};
}

export function exportGp(score: model.Score): Uint8Array { return exportGpInterchange(score, settings); }
