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
import { assertDiagramFrets, assertDroneFrets, droneShift, droneTuningOk, fretExists, fretKey, getBanjoDrone } from './editor/banjo-drone';
import { adoptAdmittedBase } from './interchange/archive-gate';
import { copyGpInterchangeSource, exportGpInterchange, forgetTrackOrderedEntries, loadInterchangeScore } from './interchange/gp';
import { reflowLyrics,removeLyricsMeasure } from './editor/lyrics';
import { prepareScoreTimers } from './editor/timers';
import { voiceTicks } from './editor/score-errors';
import { planMeasureMap,mapBackingMeasures } from './editor/measures';
import { mapLyricsMeasures } from './editor/lyrics-measures';
import { preparePasteMusic } from './editor/clipboard-paste';
import { duplicateStylesheetTrack,remapStylesheetTracks,validateEngravingTracks } from './engraving/projection';
import { mapBarWidths } from './engraving/bar-widths';
import { prepareHarmonyTranspose } from './harmony/transpose';
import { copyMasterTimeSignatureSource } from './editor/time-signature-source';

const settings = new Settings();
const { Score, Track, Staff, Bar, Voice, Beat, Note, MasterBar, Automation, JsonConverter } = model;
const integer = (value: number, minimum = 0) => Number.isInteger(value) && value >= minimum;
const supportedDurations=[-4,-2,1,2,4,8,16,32,64,128,256];
const trackIdentities=new WeakMap<model.Track,string>();
export const trackIdentity=(track:model.Track)=>trackIdentities.get(track) ?? `base/${track.index}`;

function tuningValid(tuning: number[]) {
  if (!Array.isArray(tuning) || !tuning.length || tuning.some(n => !integer(n) || n > 127)) throw new Error('Use MIDI tuning pitches from 0 to 127.');
}

export function validateProject(value: unknown): Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project.');
  const input = value as ProjectInput;
  if (input.format !== 'TabPlayer' || ![1,2,3].includes(input.schemaVersion)) throw new Error('Unsupported project version.');
  const hasLock=Object.hasOwn(input,'lock'),hasPartialCapo=Object.hasOwn(input,'partialCapo');
  const fields=['format','schemaVersion','engineVersion','base','edits',...(input.schemaVersion>=2?['assets']:[]),...(input.schemaVersion===3?['baselineEdits']:[]),...(hasLock?['lock']:[]),...(hasPartialCapo?['partialCapo']:[])];
  if(Object.keys(input).length!==fields.length || fields.some(field=>!Object.hasOwn(input,field)))throw new Error('Invalid project fields.');
  const p:Project={...structuredClone(input),schemaVersion:3,assets:input.schemaVersion===1?{}:structuredClone(input.assets),baselineEdits:input.schemaVersion===3?structuredClone(input.baselineEdits):[]};
  if(hasLock){const lock=(input as {lock?:unknown}).lock;if(!lock||typeof lock!=='object'||Array.isArray(lock)||Object.keys(lock).length!==1||(lock as {kind?:unknown}).kind!=='finalized')throw new Error('Invalid project lock.');}
  if(hasPartialCapo&&((input as {partialCapo?:unknown}).partialCapo!==true||input.base?.kind!=='file'))throw new Error('Invalid partial capo marker.');
  if (p.engineVersion !== '1.8.4') throw new Error('This project requires a different engine version.');
  if (!p.base || !['blank', 'file'].includes(p.base.kind) || !Array.isArray(p.edits) || !Array.isArray(p.baselineEdits)) throw new Error('Invalid project contents.');
  const baseFields=p.base.kind==='blank'?['kind','title','artist','tempo','tuning','measureCount']:['kind','filename','bytesBase64','sha256'];
  if(Object.keys(p.base).length!==baseFields.length || baseFields.some(field=>!Object.hasOwn(p.base,field)))throw new Error('Invalid project base fields.');
  if (p.base.kind === 'blank') {
    tuningValid(p.base.tuning);
    if (typeof p.base.title!=='string' || typeof p.base.artist!=='string' || !integer(p.base.measureCount, 1) || !Number.isFinite(p.base.tempo) || p.base.tempo <= 0) throw new Error('Invalid new-score settings.');
  } else if (typeof p.base.bytesBase64 !== 'string' || typeof p.base.filename !== 'string' || !/^[a-f0-9]{64}$/i.test(p.base.sha256)) {
    throw new Error('Invalid original score data.');
  }
  if(!p.assets || typeof p.assets!=='object' || Array.isArray(p.assets)) throw new Error('Invalid project asset metadata.');
  for(const [id,asset] of Object.entries(p.assets)) {
    if(!/^[a-f0-9]{64}$/i.test(id) || !asset || Object.keys(asset).some(key=>!['filename','mediaType','byteLength'].includes(key)) || typeof asset.filename!=='string' || typeof asset.mediaType!=='string' || !integer(asset.byteLength)) throw new Error('Invalid project asset metadata.');
  }
  for(const edit of projectCommands(p)) {
    validateParityCommand(edit);
    if(edit.type==='setBacking' && edit.backing && !p.assets[edit.backing.assetId]) throw new Error('Backing audio asset is missing.');
  }
  return structuredClone(p);
}

function rest(duration: number, dots = 0) {
  const beat = new Beat(); beat.duration = duration; beat.dots = dots; beat.isEmpty = false;
  return beat;
}

/** Standard rest lengths in ticks, longest first: a whole to a 64th, each plain, dotted or double dotted. */
const restLengths=[1,2,4,8,16,32,64].flatMap(duration=>[0,1,2].map(dots=>({duration,dots,ticks:3840/duration*(2**(dots+1)-1)/2**dots}))).sort((a,b)=>b.ticks-a.ticks);

/** Makes a voice fill its measure exactly. Beats past the barline go (the one that crosses it included), then the
 * remainder is written as the fewest standard rests. A tuplet remainder that no standard rest can write is refused. */
function fitVoiceToMeasure(master: model.MasterBar, voice: model.Voice) {
  if (master.isFreeTime) throw new Error('A free-time measure has no length to fill.');
  const expected = master.calculateDuration(false);
  let total = voiceTicks(voice, expected);
  if (!total) throw new Error('This voice is unused; there is nothing to fill.');
  if (total[0] === expected * total[1]) throw new Error('This voice is already complete.');
  while (total[0] > expected * total[1]) {
    const last = voice.beats.pop()!; for (const note of [...last.notes]) removeNote(note);
    total = voiceTicks(voice, expected);
    if (!total) { voice.beats.length = 0; total = [0, 1]; }
  }
  const missing = expected * total[1] - total[0];
  if (missing % total[1]) throw new Error('The missing time cannot be written as standard rests.');
  let left = missing / total[1];
  const added: model.Beat[] = [];
  while (left > 0) {
    const length = restLengths.find(candidate => candidate.ticks <= left);
    if (!length) throw new Error('The missing time cannot be written as standard rests.');
    const inserted = rest(length.duration, length.dots); inserted.voice = voice; added.push(inserted); left -= length.ticks;
  }
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
  if (!integer(program) || program > 127) throw new Error('Invalid MIDI instrument.');
  const used = new Set(score.tracks.flatMap(t => [t.playbackInfo.primaryChannel, t.playbackInfo.secondaryChannel]));
  const free = Array.from({length:16}, (_,i) => i).filter(i => i !== 9 && !used.has(i));
  if (!free.length) throw new Error('No MIDI channel is available for another instrument.');
  const track = new Track(); track.name = name || 'Instrument'; track.shortName = track.name;
  track.playbackInfo.program = program;
  track.playbackInfo.primaryChannel = free[0]; track.playbackInfo.secondaryChannel = free[1] ?? free[0];
  const staff = new Staff(); staff.stringTuning.tunings = [...tuning]; staff.stringTuning.name = tuningName ?? defaultTuningName(tuning); staff.showTablature = true; staff.showStandardNotation = true;
  track.addStaff(staff); score.addTrack(track);
  for (const master of score.masterBars) appendBar(staff, master);
}

function initialScore(project: Project, canRedo: boolean): model.Score {
  if (project.base.kind === 'file') {
    const bytes = Uint8Array.from(atob(project.base.bytesBase64), c => c.charCodeAt(0));
    adoptAdmittedBase(project.base.sha256, bytes);
    return loadInterchangeScore(bytes, settings, appliesFilePartialCapo(project, canRedo));
  }
  const score = new Score(); score.title = project.base.title; score.artist = project.base.artist;
  for (let i = 0; i < project.base.measureCount; i++) score.addMasterBar(new MasterBar());
  score.masterBars[0].tempoAutomations = [Automation.buildTempoAutomation(false, 0, project.base.tempo, 2)];
  addTrack(score, 'Guitar', project.base.tuning, 25);
  score.finish(settings);
  return score;
}

function trackAt(score: model.Score, index: number) {
  if (!integer(index) || !score.tracks[index]) throw new Error('Select an existing track.');
  return score.tracks[index];
}

function voiceAt(score: model.Score, target: BeatTarget) {
  if (!target || Object.values(target).some(n => !integer(n))) throw new Error('Invalid beat selection.');
  const staff = trackAt(score, target.track).staves[target.staff];
  const bar = staff?.bars[target.bar]; const voice = bar?.voices[target.voice];
  if (!staff || !bar || !voice) throw new Error('Select an existing measure and voice.');
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
  if (!master.isFreeTime && duration > master.calculateDuration(false)) throw new Error('That rhythm would overfill this measure. Shorten or remove another beat first.');
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
        if (edit.target.beat > voice.beats.length || !supportedDurations.includes(edit.duration) || !integer(edit.dots) || edit.dots > 3) throw new Error('Invalid beat insertion.');
        const inserted = rest(edit.duration, edit.dots); inserted.voice = voice;
        voice.beats.splice(edit.target.beat, 0, inserted); capacity(score, edit.target); break;
      }
      if (!beat) throw new Error('Select an existing beat.');
      if (edit.type === 'deleteBeat') { for (const note of [...beat.notes]) removeNote(note);voice.beats.splice(edit.target.beat, 1); break; }
      if (edit.type === 'setDuration') {
        if (!supportedDurations.includes(edit.duration) || !integer(edit.dots) || edit.dots > 3) throw new Error('Invalid rhythm.');
        beat.duration = edit.duration; beat.dots = edit.dots;beat.overrideDisplayDuration=undefined;capacity(score, edit.target); break;
      }
      if (edit.type === 'setRest') { for (const note of [...beat.notes]) removeNote(note); beat.isEmpty = false; break; }
      if (staff.isPercussion || !integer(edit.string,1) || edit.string > staff.tuning.length) throw new Error('Select a string on a guitar or bass track.');
      const existing = beat.notes.find(n => n.string === edit.string);
      if (edit.type === 'removeNote') { if (existing) removeNote(existing); break; }
      const pitch = fretKey(staff, edit.string, edit.fret);
      if (!integer(edit.fret) || pitch < 0 || pitch > 127) throw new Error('That fret is outside the playable MIDI pitch range.');
      if (!fretExists(staff, edit.string, edit.fret)) throw new Error(`The banjo drone string has no frets 1 to ${getBanjoDrone(staff)}.`);
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
      if (!integer(edit.bar) || !score.masterBars[edit.bar] || score.masterBars.length === 1) throw new Error('Keep at least one measure.');
      removeLyricsMeasure(score,edit.bar);
      const tempo = score.tempo; score.masterBars.splice(edit.bar,1);
      for(const track of score.tracks)track.lineBreaks=new Set([...(track.lineBreaks ?? [])].filter(index=>index!==edit.bar).map(index=>index>edit.bar?index-1:index));
      for (const track of score.tracks) for (const staff of track.staves) {
        for (const voice of staff.bars[edit.bar].voices) for (const beat of voice.beats) for (const note of [...beat.notes]) removeNote(note);
        staff.bars.splice(edit.bar,1);
      }
      if (edit.bar === 0 && !score.masterBars[0].tempoAutomations.length) score.masterBars[0].tempoAutomations = [Automation.buildTempoAutomation(false,0,tempo,2)];
      break;
    }
    case 'addTrack': addTrack(score,edit.name,edit.tuning,edit.program,edit.tuningName); break;
    case 'removeTrack': {
      const track=trackAt(score,edit.track); if (score.tracks.length === 1) throw new Error('Keep at least one track.');
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
      if(!integer(edit.to)||edit.to>=count||edit.to===edit.track)throw new Error('Choose a different track position.');
      const order=movedOrder(count,edit.track,edit.to);
      remapStylesheetTracks(score.stylesheet,order.map((_,index)=>order.indexOf(index)));
      score.tracks.splice(edit.to,0,...score.tracks.splice(edit.track,1)); break;
    }
    case 'setTuning': {
      tuningValid(edit.tuning); validateTuningName(edit.tuningName); const track = trackAt(score,edit.track);
      if (track.isPercussion || track.staves.some(s => s.tuning.length !== edit.tuning.length)) throw new Error('Retuning must keep the current string count.');
      if (track.staves.some(s => getBanjoDrone(s) > 0 && !droneTuningOk(edit.tuning))) throw new Error('The banjo drone is string 1, which must be tuned higher than string 2.');
      for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
        if (!note.string) continue;
        const pitch=edit.tuning[edit.tuning.length-note.string]+note.fret+stringCapo(staff,note.string)+droneShift(staff,note.string,note.fret)-staff.transpositionPitch;
        if (pitch<0 || pitch>127) throw new Error('That tuning puts an existing note outside the MIDI pitch range.');
      }
      for (const staff of track.staves) { staff.stringTuning.tunings = [...edit.tuning]; if (edit.tuningName !== undefined) staff.stringTuning.name = edit.tuningName; else if (!staff.stringTuning.name) staff.stringTuning.name = defaultTuningName(edit.tuning); } break;
    }
    case 'setScoreInfo':
      if (!Number.isFinite(edit.tempo) || edit.tempo <= 0) throw new Error('Tempo must be positive.');
      score.title = edit.title; score.artist = edit.artist;
      score.masterBars[0].tempoAutomations = [Automation.buildTempoAutomation(false,0,edit.tempo,2), ...score.masterBars[0].tempoAutomations.filter(a => a.ratioPosition !== 0)]; break;
    default: if(!applyAdvancedEdit(score,edit,editIndex)) throw new Error('Unknown edit command in project.');
  }
}

export interface BuiltDocument {
  score:model.Score; settings:DocumentSettings; embeddedBacking:Uint8Array|null;
  embeddedBackingSettings?:Omit<BackingSettings,'assetId'>; sourceMixes?:Record<string,ChannelMix>;
  sourceBarCount?:number;
}

function removeBackingMeasure(backing:Pick<BackingSettings,'anchors'>|null|undefined,bar:number) {
  if(backing) backing.anchors=backing.anchors.filter(a=>a.bar!==bar).map(a=>({...a,bar:a.bar>bar?a.bar-1:a.bar}));
}

/** `canRedo`: the document has undone edits, so it is not edit-free even when its list is empty. */
export function buildDocument(value: ProjectInput, canRedo = false): BuiltDocument {
  const project = validateProject(value); let score = initialScore(project, canRedo);
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
      mapBackingMeasures(documentSettings.backing,prepared.barMap);mapBackingMeasures(embeddedBackingSettings,prepared.barMap);documentSettings.engraving=mapBarWidths(documentSettings.engraving,prepared.barMap.oldToNew);
    }else if(edit.type==='transposeHarmony')score=prepareHarmonyTranspose(rebuild(score),edit,index);
    else {
      if(!previous&&['setOttava','setCrescendo','setFermata','setSustainPedal','setSimile','eraseSelection','transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain','setSelectionStrokes','setSelectionTies','insertMeasures','removeMeasures'].includes(edit.type))score=rebuild(score);
      const measureMap=edit.type==='insertMeasures'||edit.type==='removeMeasures'?planMeasureMap(score.masterBars.length,edit):null;
      if(measureMap)mapLyricsMeasures(score,measureMap);
      apply(score, edit,index);
      if(measureMap){mapBackingMeasures(documentSettings.backing,measureMap);mapBackingMeasures(embeddedBackingSettings,measureMap);documentSettings.engraving=mapBarWidths(documentSettings.engraving,measureMap.oldToNew);}
      if (edit.type==='addTrack'||edit.type==='addPitchedTrack'||edit.type==='addPercussionTrack') identities.push(`added/${index}/${JSON.stringify(edit)}`);
      if (edit.type==='removeTrack') identities.splice(edit.track,1);
      if (edit.type==='moveTrack') identities.splice(edit.to,0,...identities.splice(edit.track,1));
      if (edit.type==='duplicateTrack') {identities.splice(edit.track+1,0,`added/${index}/${JSON.stringify(edit)}`);copyTrackSettings(documentSettings,identities[edit.track],identities[edit.track+1]);}
      if (['addTrack','addPitchedTrack','addPercussionTrack','removeTrack','moveTrack','duplicateTrack'].includes(edit.type)) forgetTrackOrderedEntries(score);
      if(edit.type==='removeMeasure') {removeBackingMeasure(documentSettings.backing,edit.bar);removeBackingMeasure(embeddedBackingSettings,edit.bar);documentSettings.engraving=mapBarWidths(documentSettings.engraving,Array.from({length:score.masterBars.length+1},(_,bar)=>bar<edit.bar?bar:bar===edit.bar?null:bar-1));}
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
  const built={score,settings:documentSettings,embeddedBacking,embeddedBackingSettings,sourceMixes,sourceBarCount};
  validateBackingAnchors(score,effectiveAudioSettings(project,built).backing);return built;
}

export function replayDocumentSettings(value:ProjectInput,current:BuiltDocument):BuiltDocument {
  const project=validateProject(value);const next=defaultDocumentSettings();
  // A duplicated track's copied settings come from the full build, which tracks identities through track edits.
  if(projectCommands(project).some(edit=>edit.type==='pasteMusic'||edit.type==='duplicateTrack'||edit.type==='setBacking'&&edit.backing?.referenceSync))return {...buildDocument(project),score:current.score,embeddedBacking:current.embeddedBacking};
  const sourceBarCount=current.sourceBarCount??(project.base.kind==='blank'?project.base.measureCount:initialScore(project,false).masterBars.length);
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
    case 'removeMeasure': removeBackingMeasure(next.backing,edit.bar);next.engraving=mapBarWidths(next.engraving,Array.from({length:barCount},(_,bar)=>bar<edit.bar?bar:bar===edit.bar?null:bar-1));barCount--;break;
    case 'insertMeasures': case 'removeMeasures': {
      const map=planMeasureMap(barCount,edit);mapBackingMeasures(next.backing,map);next.engraving=mapBarWidths(next.engraving,map.oldToNew);
      barCount=map.oldToNew.filter(bar=>bar!==null).length+map.inserted.length;break;
    }
  }
  const built={score:current.score,settings:next,embeddedBacking:current.embeddedBacking,embeddedBackingSettings:current.embeddedBackingSettings,sourceMixes:current.sourceMixes,sourceBarCount};
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
  const built=buildDocument(next);assertDiagramFrets(built.score,edit);
  return {project:next,...built};
}

export function exportGp(score: model.Score): Uint8Array { return exportGpInterchange(score, settings); }
