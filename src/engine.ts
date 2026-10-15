import { model, Settings } from '@coderline/alphatab';
import type { BeatTarget, EditCommand, Project, ProjectInput } from './project';
import { isSettingsEdit } from './edit-types';
import type { BackingSettings, ChannelMix, DocumentSettings } from './edit-types';
import { defaultDocumentSettings, defaultMix, applySettingsEdit } from './document-settings';
import { applyAdvancedEdit } from './editor/advanced';
import { captureNoteLinks, restoreNoteLinks, detachNote } from './editor/links';
import { validateBackingAnchors } from './audio/plan';
import { scoreFromJson } from './model-clone';
import { validateParityCommand } from './parity-commands';
import { copyGpInterchangeSource, exportGpInterchange, loadInterchangeScore } from './interchange/gp';
import { reflowLyrics,removeLyricsMeasure } from './editor/lyrics';
import { prepareScoreTimers } from './editor/timers';
import { planMeasureMap,mapBackingMeasures } from './editor/measures';
import { mapLyricsMeasures } from './editor/lyrics-measures';
import { preparePasteMusic } from './editor/clipboard-paste';
import { remapStylesheetTracks,validateEngravingTracks } from './engraving/projection';
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
  if (!value || typeof value !== 'object') throw new Error('Invalid project.');
  const input = value as ProjectInput;
  if (input.format !== 'TabPlayer' || ![1,2].includes(input.schemaVersion)) throw new Error('Unsupported project version.');
  const p:Project={...structuredClone(input),schemaVersion:2,assets:input.schemaVersion===1?{}:structuredClone(input.assets)};
  if (p.engineVersion !== '1.8.4') throw new Error('This project requires a different engine version.');
  if (!p.base || !['blank', 'file'].includes(p.base.kind) || !Array.isArray(p.edits)) throw new Error('Invalid project contents.');
  if (p.base.kind === 'blank') {
    tuningValid(p.base.tuning);
    if (!integer(p.base.measureCount, 1) || !Number.isFinite(p.base.tempo) || p.base.tempo <= 0) throw new Error('Invalid new-score settings.');
  } else if (typeof p.base.bytesBase64 !== 'string' || typeof p.base.filename !== 'string' || !/^[a-f0-9]{64}$/i.test(p.base.sha256)) {
    throw new Error('Invalid original score data.');
  }
  if(!p.assets || typeof p.assets!=='object' || Array.isArray(p.assets)) throw new Error('Invalid project asset metadata.');
  for(const [id,asset] of Object.entries(p.assets)) {
    if(!/^[a-f0-9]{64}$/i.test(id) || !asset || Object.keys(asset).some(key=>!['filename','mediaType','byteLength'].includes(key)) || typeof asset.filename!=='string' || typeof asset.mediaType!=='string' || !integer(asset.byteLength)) throw new Error('Invalid project asset metadata.');
  }
  for(const edit of p.edits) {
    validateParityCommand(edit);
    if(edit.type==='setBacking' && edit.backing && !p.assets[edit.backing.assetId]) throw new Error('Backing audio asset is missing.');
  }
  return structuredClone(p);
}

function rest(duration: number, dots = 0) {
  const beat = new Beat(); beat.duration = duration; beat.dots = dots; beat.isEmpty = false;
  return beat;
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

function addTrack(score: model.Score, name: string, tuning: number[], program: number) {
  tuningValid(tuning);
  if (!integer(program) || program > 127) throw new Error('Invalid MIDI instrument.');
  const used = new Set(score.tracks.flatMap(t => [t.playbackInfo.primaryChannel, t.playbackInfo.secondaryChannel]));
  const free = Array.from({length:16}, (_,i) => i).filter(i => i !== 9 && !used.has(i));
  if (!free.length) throw new Error('No MIDI channel is available for another instrument.');
  const track = new Track(); track.name = name || 'Instrument'; track.shortName = track.name;
  track.playbackInfo.program = program;
  track.playbackInfo.primaryChannel = free[0]; track.playbackInfo.secondaryChannel = free[1] ?? free[0];
  const staff = new Staff(); staff.stringTuning.tunings = [...tuning]; staff.showTablature = true; staff.showStandardNotation = true;
  track.addStaff(staff); score.addTrack(track);
  for (const master of score.masterBars) appendBar(staff, master);
}

function initialScore(project: Project): model.Score {
  if (project.base.kind === 'file') {
    const bytes = Uint8Array.from(atob(project.base.bytesBase64), c => c.charCodeAt(0));
    return loadInterchangeScore(bytes, settings);
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
      const pitch = staff.tuning[staff.tuning.length-edit.string] + edit.fret + staff.capo - staff.transpositionPitch;
      if (!integer(edit.fret) || pitch < 0 || pitch > 127) throw new Error('That fret is outside the playable MIDI pitch range.');
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
    case 'addTrack': addTrack(score,edit.name,edit.tuning,edit.program); break;
    case 'removeTrack': {
      const track=trackAt(score,edit.track); if (score.tracks.length === 1) throw new Error('Keep at least one track.');
      for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)detachNote(note);
      remapStylesheetTracks(score.stylesheet,score.tracks.map((_,index)=>index===edit.track?null:index>edit.track?index-1:index));
      score.tracks.splice(edit.track,1); break;
    }
    case 'setTuning': {
      tuningValid(edit.tuning); const track = trackAt(score,edit.track);
      if (track.isPercussion || track.staves.some(s => s.tuning.length !== edit.tuning.length)) throw new Error('Retuning must keep the current string count.');
      for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
        if (!note.string) continue;
        const pitch=edit.tuning[edit.tuning.length-note.string]+note.fret+staff.capo-staff.transpositionPitch;
        if (pitch<0 || pitch>127) throw new Error('That tuning puts an existing note outside the MIDI pitch range.');
      }
      for (const staff of track.staves) staff.stringTuning.tunings = [...edit.tuning]; break;
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

export function buildDocument(value: ProjectInput): BuiltDocument {
  const project = validateProject(value); let score = initialScore(project);
  const sourceBarCount=score.masterBars.length;
  const identities=score.tracks.map((_,index)=>`base/${index}`);
  const documentSettings=defaultDocumentSettings();
  const embeddedBacking=score.backingTrack?.rawAudioFile?.slice() ?? null;
  const embeddedBackingSettings=embeddedBacking?{
    offsetMs:0,mix:defaultMix(),anchors:score.masterBars.flatMap((bar,index)=>(bar.syncPoints ?? []).flatMap(point=>point.syncPointValue?[{
      bar:index,occurrence:point.syncPointValue.barOccurence,ratio:point.ratioPosition,audioMs:point.syncPointValue.millisecondOffset,
    }]:[])),
  }:undefined;
  score.tracks.forEach((track,index)=>{documentSettings.mixes[identities[index]]={...defaultMix(),mute:track.playbackInfo.isMute,solo:track.playbackInfo.isSolo};});
  const sourceMixes=structuredClone(documentSettings.mixes);
  for (const [index,edit] of project.edits.entries()) {
    if(isSettingsEdit(edit)) {applySettingsEdit(documentSettings,edit,score,identities);continue;}
    if(edit.type==='pasteMusic'){
      const prepared=preparePasteMusic(rebuild(score),edit);score=rebuild(prepared.score);
      mapBackingMeasures(documentSettings.backing,prepared.barMap);mapBackingMeasures(embeddedBackingSettings,prepared.barMap);continue;
    }
    if(edit.type==='transposeHarmony'){score=prepareHarmonyTranspose(rebuild(score),edit,index);continue;}
    if(['setOttava','setCrescendo','setFermata','setSimile','eraseSelection','transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain','insertMeasures','removeMeasures'].includes(edit.type))score=rebuild(score);
    const measureMap=edit.type==='insertMeasures'||edit.type==='removeMeasures'?planMeasureMap(score.masterBars.length,edit):null;
    if(measureMap)mapLyricsMeasures(score,measureMap);
    apply(score, edit,index);
    if(measureMap){mapBackingMeasures(documentSettings.backing,measureMap);mapBackingMeasures(embeddedBackingSettings,measureMap);}
    if (edit.type==='addTrack'||edit.type==='addPitchedTrack'||edit.type==='addPercussionTrack') identities.push(`added/${index}/${JSON.stringify(edit)}`);
    if (edit.type==='removeTrack') identities.splice(edit.track,1);
    if(edit.type==='removeMeasure') {removeBackingMeasure(documentSettings.backing,edit.bar);removeBackingMeasure(embeddedBackingSettings,edit.bar);}
    if (['insertBeat','deleteBeat','appendMeasure','removeMeasure','insertMeasures','removeMeasures','addTrack','addPitchedTrack','addPercussionTrack','removeTrack','addStaff','removeStaff','addVoice','removeVoice','copyVoice'].includes(edit.type)) {
      score = rebuild(score);
    }
  }
  // Transient conversion rebuilds derived links and caches; native files store source bytes and commands.
  score=rebuild(score);prepareScoreTimers(score);score.tracks.forEach((track,index)=>trackIdentities.set(track,identities[index]));
  validateEngravingTracks(score,identities,{...documentSettings.engraving,profiles:documentSettings.engraving.profiles.filter(entry=>identities.includes(entry.trackId))});
  const built={score,settings:documentSettings,embeddedBacking,embeddedBackingSettings,sourceMixes,sourceBarCount};
  validateBackingAnchors(score,effectiveAudioSettings(project,built).backing);return built;
}

export function replayDocumentSettings(value:ProjectInput,current:BuiltDocument):BuiltDocument {
  const project=validateProject(value);const next=defaultDocumentSettings();
  if(project.edits.some(edit=>edit.type==='pasteMusic'))return {...buildDocument(project),score:current.score,embeddedBacking:current.embeddedBacking};
  const sourceBarCount=current.sourceBarCount??(project.base.kind==='blank'?project.base.measureCount:initialScore(project).masterBars.length);
  let barCount=sourceBarCount;
  next.mixes=structuredClone(current.sourceMixes ?? Object.fromEntries(current.score.tracks.map(track=>[trackIdentity(track),{...defaultMix(),mute:track.playbackInfo.isMute,solo:track.playbackInfo.isSolo}])));
  // Applied history already passed candidate validation. Its earlier backing anchors
  // refer to the measure layout at that point, before later deletions.
  for(const edit of project.edits) switch(edit.type) {
    case 'setTrackMix': next.mixes[edit.trackId]=structuredClone(edit.mix);break;
    case 'setTrackSound': next.sounds[edit.trackId]=structuredClone(edit.sound);break;
    case 'setBacking': next.backing=structuredClone(edit.backing);break;
    case 'setPrintLayout': next.print=structuredClone(edit.layout);next.page=null;break;
    case 'setEngraving':next.engraving=structuredClone(edit.engraving);break;
    case 'setPageLayout':next.page=structuredClone(edit.layout);break;
    case 'appendMeasure': barCount++;break;
    case 'removeMeasure': removeBackingMeasure(next.backing,edit.bar);barCount--;break;
    case 'insertMeasures': case 'removeMeasures': {
      const map=planMeasureMap(barCount,edit);mapBackingMeasures(next.backing,map);
      barCount=map.oldToNew.filter(bar=>bar!==null).length+map.inserted.length;break;
    }
  }
  const built={score:current.score,settings:next,embeddedBacking:current.embeddedBacking,embeddedBackingSettings:current.embeddedBackingSettings,sourceMixes:current.sourceMixes,sourceBarCount};
  validateBackingAnchors(current.score,effectiveAudioSettings(project,built).backing);return built;
}

export function effectiveAudioSettings(project:ProjectInput,built:BuiltDocument):DocumentSettings {
  if(built.settings.backing || !built.embeddedBacking || project.edits.some(edit=>edit.type==='setBacking')) return built.settings;
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
  return {project:next,...buildDocument(next)};
}

export function exportGp(score: model.Score): Uint8Array { return exportGpInterchange(score, settings); }
