import { exporter, importer, model, Settings } from '@coderline/alphatab';
import type { BeatTarget, EditCommand, Project } from './project';

const settings = new Settings();
const { Score, Track, Staff, Bar, Voice, Beat, Note, MasterBar, Automation, JsonConverter } = model;
const integer = (value: number, minimum = 0) => Number.isInteger(value) && value >= minimum;

function tuningValid(tuning: number[]) {
  if (!Array.isArray(tuning) || !tuning.length || tuning.some(n => !integer(n) || n > 127)) throw new Error('Use MIDI tuning pitches from 0 to 127.');
}

export function validateProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('Invalid project.');
  const p = value as Project;
  if (p.format !== 'TabPlayer' || p.schemaVersion !== 1) throw new Error('Unsupported project version.');
  if (p.engineVersion !== '1.8.4') throw new Error('This project requires a different engine version.');
  if (!p.base || !['blank', 'file'].includes(p.base.kind) || !Array.isArray(p.edits)) throw new Error('Invalid project contents.');
  if (p.base.kind === 'blank') {
    tuningValid(p.base.tuning);
    if (!integer(p.base.measureCount, 1) || !Number.isFinite(p.base.tempo) || p.base.tempo <= 0) throw new Error('Invalid new-score settings.');
  } else if (typeof p.base.bytesBase64 !== 'string' || typeof p.base.filename !== 'string' || !/^[a-f0-9]{64}$/i.test(p.base.sha256)) {
    throw new Error('Invalid original score data.');
  }
  return structuredClone(p);
}

function rest(duration: number, dots = 0) {
  const beat = new Beat(); beat.duration = duration; beat.dots = dots; beat.isEmpty = false;
  return beat;
}

function appendBar(staff: model.Staff, master: model.MasterBar) {
  const bar = new Bar();
  bar.clef = staff.tuning.length && staff.tuning[0] < 55 ? model.Clef.F4 : model.Clef.G2;
  const voice = new Voice();
  for (let i = 0; i < master.timeSignatureNumerator; i++) voice.addBeat(rest(master.timeSignatureDenominator));
  bar.addVoice(voice); staff.addBar(bar);
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
    return importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
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
  const beat = location.voice.beats[target.beat];
  return {...location, beat, master: score.masterBars[target.bar]};
}

function capacity(score: model.Score, target: BeatTarget) {
  const {voice} = voiceAt(score, target);
  for (const beat of voice.beats) beat.updateDurations();
  const duration = voice.beats.reduce((sum, b) => sum + (b.isEmpty || b.graceType !== model.GraceType.None ? 0 : b.playbackDuration), 0);
  const master = score.masterBars[target.bar];
  if (!master.isFreeTime && duration > master.calculateDuration(false)) throw new Error('That rhythm would overfill this measure. Shorten or remove another beat first.');
}

function apply(score: model.Score, edit: EditCommand) {
  switch (edit.type) {
    case 'setNote': case 'removeNote': case 'setRest': case 'setDuration': case 'insertBeat': case 'deleteBeat': {
      const {staff, voice} = voiceAt(score, edit.target);
      const beat = voice.beats[edit.target.beat];
      if (edit.type === 'insertBeat') {
        if (edit.target.beat > voice.beats.length || ![1,2,4,8,16,32,64].includes(edit.duration) || !integer(edit.dots) || edit.dots > 3) throw new Error('Invalid beat insertion.');
        const inserted = rest(edit.duration, edit.dots); inserted.voice = voice;
        voice.beats.splice(edit.target.beat, 0, inserted); capacity(score, edit.target); break;
      }
      if (!beat) throw new Error('Select an existing beat.');
      if (edit.type === 'deleteBeat') { voice.beats.splice(edit.target.beat, 1); break; }
      if (edit.type === 'setDuration') {
        if (![1,2,4,8,16,32,64].includes(edit.duration) || !integer(edit.dots) || edit.dots > 3) throw new Error('Invalid rhythm.');
        beat.duration = edit.duration; beat.dots = edit.dots; capacity(score, edit.target); break;
      }
      if (edit.type === 'setRest') { for (const note of [...beat.notes]) beat.removeNote(note); beat.isEmpty = false; break; }
      if (staff.isPercussion || !integer(edit.string,1) || edit.string > staff.tuning.length) throw new Error('Select a string on a guitar or bass track.');
      const existing = beat.notes.find(n => n.string === edit.string);
      if (edit.type === 'removeNote') { if (existing) beat.removeNote(existing); break; }
      const pitch = staff.tuning[staff.tuning.length-edit.string] + edit.fret + staff.capo - staff.transpositionPitch;
      if (!integer(edit.fret) || pitch < 0 || pitch > 127) throw new Error('That fret is outside the playable MIDI pitch range.');
      if (existing) existing.fret = edit.fret;
      else { const note = new Note(); note.string = edit.string; note.fret = edit.fret; beat.addNote(note); }
      beat.isEmpty = false; break;
    }
    case 'appendMeasure': {
      const previous = score.masterBars.at(-1)!; const master = new MasterBar();
      master.timeSignatureNumerator = previous.timeSignatureNumerator; master.timeSignatureDenominator = previous.timeSignatureDenominator;
      score.addMasterBar(master); for (const track of score.tracks) for (const staff of track.staves) appendBar(staff, master); break;
    }
    case 'removeMeasure': {
      if (!integer(edit.bar) || !score.masterBars[edit.bar] || score.masterBars.length === 1) throw new Error('Keep at least one measure.');
      const tempo = score.tempo; score.masterBars.splice(edit.bar,1);
      for (const track of score.tracks) for (const staff of track.staves) staff.bars.splice(edit.bar,1);
      if (edit.bar === 0 && !score.masterBars[0].tempoAutomations.length) score.masterBars[0].tempoAutomations = [Automation.buildTempoAutomation(false,0,tempo,2)];
      break;
    }
    case 'addTrack': addTrack(score,edit.name,edit.tuning,edit.program); break;
    case 'removeTrack': trackAt(score,edit.track); if (score.tracks.length === 1) throw new Error('Keep at least one track.'); score.tracks.splice(edit.track,1); break;
    case 'setTuning': {
      tuningValid(edit.tuning); const track = trackAt(score,edit.track);
      if (track.isPercussion || track.staves.some(s => s.tuning.length !== edit.tuning.length)) throw new Error('Retuning must keep the current string count.');
      for (const staff of track.staves) staff.stringTuning.tunings = [...edit.tuning]; break;
    }
    case 'setScoreInfo':
      if (!Number.isFinite(edit.tempo) || edit.tempo <= 0) throw new Error('Tempo must be positive.');
      score.title = edit.title; score.artist = edit.artist;
      score.masterBars[0].tempoAutomations = [Automation.buildTempoAutomation(false,0,edit.tempo,2), ...score.masterBars[0].tempoAutomations.filter(a => a.ratioPosition !== 0)]; break;
    default: throw new Error('Unknown edit command in project.');
  }
}

export function buildScore(value: Project): model.Score {
  const project = validateProject(value); let score = initialScore(project);
  for (const edit of project.edits) {
    apply(score, edit);
    if (['insertBeat','deleteBeat','appendMeasure','removeMeasure','addTrack','removeTrack'].includes(edit.type)) {
      score = JsonConverter.jsonToScore(JsonConverter.scoreToJson(score), settings);
    }
  }
  // Transient conversion rebuilds derived links and caches; native files store source bytes and commands.
  return JsonConverter.jsonToScore(JsonConverter.scoreToJson(score), settings);
}

export function previewEdit(project: Project, edit: EditCommand) {
  const next: Project = {...project, edits:[...project.edits,structuredClone(edit)]};
  return {project:next, score:buildScore(next)};
}

export function exportGp(score: model.Score): Uint8Array { return new exporter.Gp7Exporter().export(score, settings); }
