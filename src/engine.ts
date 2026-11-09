import { getMessage, getResolvedLanguage, type MessageKey } from './i18n';
import { model, Settings } from '@coderline/alphatab';
import type { BeatTarget, EditCommand, Project, ProjectInput } from './project';
import { appliesFilePartialCapo,projectCommands } from './project';
import { isSettingsEdit } from './edit-types';
import type { BackingSettings, ChannelMix, DocumentSettings } from './edit-types';
import { defaultDocumentSettings, defaultMix, applySettingsEdit, copyTrackSettings, completeSound, completeMaster } from './document-settings';
import { getLyricsSource, setLyricsSource } from './editor/lyrics-source';
import { copyHarmonyChord } from './harmony/chord-source';
import { copyTrackScaleDiagrams } from './harmony/scale-diagram';
import { applyAdvancedEdit } from './editor/advanced';
import { captureNoteLinks, restoreNoteLinks, detachNote } from './editor/links';
import { backingLocationsForScore,validateBackingAnchors } from './audio/plan';
import { adjustReferenceSyncBounds,referenceSyncTiming } from './audio/reference-sync';
import { scoreFromJson } from './model-clone';
import { validateParityCommand } from './parity-commands';
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
 * is removed, not split. A last note tied into the next measure, or a remainder no standard rest can write, is refused. */
function fitVoiceToMeasure(master: model.MasterBar, voice: model.Voice) {
  if (master.isFreeTime) throw refusal('engine.free_time_fill');
  const expected = master.calculateDuration(false), whole = voiceTicks(voice, expected);
  if (!whole) throw refusal('engine.voice_unused_fill');
  if (whole[0] === expected * whole[1]) throw refusal('engine.voice_complete_fill');
  const cut = whole[0] > expected * whole[1] ? trimStart(voice, expected) : voice.beats.length;
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
      fitVoiceToMeasure(score.masterBars[edit.bar], voice);
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

/** `canRedo`: the document has undone edits, so it is not edit-free even when its list is empty. */
export function buildDocument(value: ProjectInput, canRedo = false): BuiltDocument {
  const project = validateProject(value); const initial = initialScore(project, canRedo); let score = initial.score;
  const sourceBarCount=score.masterBars.length;
  const identities=score.tracks.map((_,index)=>`base/${index}`);
  const documentSettings=defaultDocumentSettings();
  const embeddedBacking=score.backingTrack?.rawAudioFile?.slice() ?? null;
  const embeddedAnchors=score.masterBars.flatMap((bar,index)=>(bar.syncPoints ?? []).flatMap(point=>point.syncPointValue?[{
      bar:index,occurrence:point.syncPointValue.barOccurence,ratio:point.ratioPosition,audioMs:point.syncPointValue.millisecondOffset,
    }]:[]));
  const embeddedOffset=Math.max(0,...embeddedAnchors.map(anchor=>-anchor.audioMs));
  const embeddedBackingSettings=embeddedBacking?{
    offsetMs:embeddedOffset,mix:defaultMix(),anchors:embeddedAnchors.map(anchor=>({...anchor,audioMs:anchor.audioMs+embeddedOffset})),
  }:undefined;
  score.tracks.forEach((track,index)=>{documentSettings.mixes[identities[index]]={...defaultMix(),mute:track.playbackInfo.isMute,solo:track.playbackInfo.isSolo};});
  const sourceMixes=structuredClone(documentSettings.mixes);
  for (const [index,edit] of projectCommands(project).entries()) {
    if(isSettingsEdit(edit)) {applySettingsEdit(documentSettings,edit,score,identities);continue;}
    if(documentSettings.backing?.referenceSync)score=rebuild(score);
    const previous=documentSettings.backing?.referenceSync?referenceSyncTiming(documentSettings.backing,backingLocationsForScore(score)):null;
    if(edit.type==='pasteMusic'){
      const prepared=preparePasteMusic(rebuild(score),edit);score=rebuild(prepared.score);
      mapBackingMeasures(documentSettings.backing,prepared.barMap);mapBackingMeasures(embeddedBackingSettings,prepared.barMap);documentSettings.engraving=mapEngravingBars(documentSettings.engraving,prepared.barMap.oldToNew);
    }else if(edit.type==='transposeHarmony')score=prepareHarmonyTranspose(rebuild(score),edit,index);
    else {
      if(!previous&&['setOttava','setCrescendo','setFermata','setSustainPedal','setSimile','eraseSelection','transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain','setSelectionStrokes','setSelectionTies','tieSelectionToEarlierPitch','insertMeasures','removeMeasures'].includes(edit.type))score=rebuild(score);
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
      if (!previous&&['insertBeat','deleteBeat','fitVoice','appendMeasure','removeMeasure','insertMeasures','removeMeasures','addTrack','addPitchedTrack','addPercussionTrack','removeTrack','moveTrack','duplicateTrack','addStaff','removeStaff','addVoice','removeVoice','copyVoice'].includes(edit.type)) {
        score = rebuild(score);
      }
    }
    assertDroneFrets(score);
    if(previous){score=rebuild(score);documentSettings.backing=adjustReferenceSyncBounds(documentSettings.backing!,previous,backingLocationsForScore(score));}
  }
  // Transient conversion rebuilds derived links and caches; native files store source bytes and commands.
  score=rebuild(score);prepareScoreTimers(score);score.tracks.forEach((track,index)=>trackIdentities.set(track,identities[index]));
  validateEngravingTracks(score,identities,{...documentSettings.engraving,profiles:documentSettings.engraving.profiles.filter(entry=>identities.includes(entry.trackId))});
  const built={score,settings:documentSettings,embeddedBacking,embeddedBackingSettings,sourceMixes,sourceBarCount,importNotice:initial.notice};
  validateBackingAnchors(score,effectiveAudioSettings(project,built).backing);return built;
}

export function replayDocumentSettings(value:ProjectInput,current:BuiltDocument):BuiltDocument {
  const project=validateProject(value);const next=defaultDocumentSettings();
  // A duplicated track's copied settings come from the full build, which tracks identities through track edits.
  if(projectCommands(project).some(edit=>edit.type==='pasteMusic'||edit.type==='duplicateTrack'||edit.type==='setBacking'&&edit.backing?.referenceSync))return {...buildDocument(project),score:current.score,embeddedBacking:current.embeddedBacking};
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

function rebuild(score: model.Score) {
  // alphaTab's beat chain requires a carrier even in an empty following voice.
  for (const track of score.tracks) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) {
    if (!voice.beats.length) { const empty=new Beat();empty.isEmpty=true;voice.addBeat(empty); }
    for (const beat of voice.beats) tripleDotTiming(beat);
  }
  const links=captureNoteLinks(score);
  const result=scoreFromJson(JsonConverter.scoreToJson(score), settings);
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

export function exportGp(score: model.Score): Uint8Array { return exportGpInterchange(score, settings); }
