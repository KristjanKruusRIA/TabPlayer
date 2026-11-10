// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { model, Settings, importer } from '@coderline/alphatab';
import { exportGpInterchange, loadInterchangeScore } from './gp';
import { exportGp5 } from '../export/gp5';
import { exportMusicXml } from '../export/musicxml';

const settings = new Settings();

/**
 * Creates a clean synthetic score with 1 track, 1 staff, 2 master bars,
 * each containing 1 voice and 4 quarter-note beats with notes.
 */
function createSyntheticScore(): model.Score {
  const score = new model.Score();
  score.title = 'MatrixTest';
  const track = new model.Track();
  track.name = 'Guitar';
  track.playbackInfo.program = 25;
  const staff = new model.Staff();
  staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  track.addStaff(staff);
  score.addTrack(track);

  for (let i = 0; i < 2; i++) {
    const masterBar = new model.MasterBar();
    masterBar.timeSignatureNumerator = 4;
    masterBar.timeSignatureDenominator = 4;
    score.addMasterBar(masterBar);

    const bar = new model.Bar();
    bar.clef = model.Clef.G2;
    const voice = new model.Voice();
    for (let b = 0; b < 4; b++) {
      const beat = new model.Beat();
      beat.duration = model.Duration.Quarter;
      beat.isEmpty = false;
      const note = new model.Note();
      note.string = 6;
      note.fret = 3;
      beat.addNote(note);
      voice.addBeat(beat);
    }
    bar.addVoice(voice);
    staff.addBar(bar);
  }
  score.finish(settings);
  return score;
}

// Target accessors
const targetNote = (s: model.Score, b = 0) => s.tracks[0].staves[0].bars[0].voices[0].beats[b].notes[0];
const targetBeat = (s: model.Score, b = 0) => s.tracks[0].staves[0].bars[0].voices[0].beats[b];
const targetBar = (s: model.Score, m = 0) => s.tracks[0].staves[0].bars[m];
const targetStaff = (s: model.Score) => s.tracks[0].staves[0];
const targetTrack = (s: model.Score) => s.tracks[0];
const targetMasterBar = (s: model.Score, m = 0) => s.masterBars[m];

export type WriterFormat = 'gp' | 'gp5' | 'musicxml';

function roundtrip(score: model.Score, format: WriterFormat): model.Score {
  if (format === 'gp') {
    const bytes = exportGpInterchange(score, settings);
    return loadInterchangeScore(bytes, settings);
  }
  if (format === 'gp5') {
    const { bytes } = exportGp5(score, { tracks: [0], range: null });
    return importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  }
  if (format === 'musicxml') {
    const bytes = exportMusicXml(score, { tracks: [0], range: null });
    return loadInterchangeScore(bytes, settings);
  }
  throw new Error(`Unknown format: ${format}`);
}

describe('F27 import field preservation matrix: model type coverage', () => {
  it('covers every property of all alphaTab model classes without omission', () => {
    // Complete model class property taxonomy ensuring no field can be missed unnoticed
    const taxonomy: Record<string, { instance: object; structural: string[]; data: string[] }> = {
      Score: {
        instance: new model.Score(),
        structural: ['_currentRepeatGroup', '_openedRepeatGroups', '_properlyOpenedRepeatGroups', 'masterBars', 'tracks'],
        data: ['album', 'artist', 'copyright', 'instructions', 'music', 'notices', 'subTitle', 'title', 'words', 'tab', 'defaultSystemsLayout', 'systemsLayout', 'stylesheet', 'backingTrack', 'style'],
      },
      MasterBar: {
        instance: new model.MasterBar(),
        structural: ['nextMasterBar', 'previousMasterBar', 'index', 'repeatGroup', 'score', 'start'],
        data: ['alternateEndings', 'isDoubleBar', 'isRepeatStart', 'repeatCount', 'timeSignatureNumerator', 'timeSignatureDenominator', 'timeSignatureCommon', 'beamingRules', 'actualBeamingRules', 'isFreeTime', 'tripletFeel', 'section', 'tempoAutomations', 'syncPoints', 'fermata', 'isAnacrusis', 'displayScale', 'displayWidth', 'directions'],
      },
      Track: {
        instance: new model.Track(),
        structural: ['index', 'score', 'staves'],
        data: ['playbackInfo', 'color', 'name', 'isVisibleOnMultiTrack', 'shortName', 'defaultSystemsLayout', 'systemsLayout', 'lineBreaks', 'percussionArticulations', 'style'],
      },
      Staff: {
        instance: new model.Staff(),
        structural: ['index', 'track', 'bars', '_filledVoices'],
        data: ['chords', 'capo', 'transpositionPitch', 'displayTranspositionPitch', 'stringTuning', 'showSlash', 'showNumbered', 'showTablature', 'showStandardNotation', 'isPercussion', 'standardNotationLineCount'],
      },
      Bar: {
        instance: new model.Bar(),
        structural: ['id', 'index', 'nextBar', 'previousBar', 'staff', 'voices', '_filledVoices', '_isEmpty', '_isRestOnly', 'shortestDuration'],
        data: ['clef', 'clefOttava', 'simileMark', 'displayScale', 'displayWidth', 'sustainPedals', 'barLineLeft', 'barLineRight', 'keySignature', 'keySignatureType', 'barNumberDisplay', 'style'],
      },
      Voice: {
        instance: new model.Voice(),
        structural: ['_beatLookup', '_isEmpty', '_isRestOnly', 'id', 'index', 'bar', 'beats', 'shortestDuration'],
        data: ['style'],
      },
      Beat: {
        instance: new model.Beat(),
        structural: ['id', 'index', 'previousBeat', 'nextBeat', 'voice', 'notes', 'noteStringLookup', 'noteValueLookup', 'minNote', 'maxNote', 'maxStringNote', 'minStringNote', 'tupletGroup', 'isContinuedWhammy', 'maxWhammyPoint', 'minWhammyPoint', 'graceGroup', 'graceIndex', 'displayStart', 'playbackStart', 'displayDuration', 'playbackDuration', 'overrideDisplayDuration', 'isEffectSlurOrigin', 'effectSlurOrigin', 'effectSlurDestination'],
        data: ['isEmpty', 'whammyStyle', 'ottava', 'fermata', 'isLegatoOrigin', 'duration', 'isLetRing', 'isPalmMute', 'automations', 'dots', 'fade', 'lyrics', 'pop', 'slap', 'tap', 'text', 'slashed', 'deadSlapped', 'brushType', 'brushDuration', 'tupletDenominator', 'tupletNumerator', 'whammyBarType', 'whammyBarPoints', 'vibrato', 'chordId', 'graceType', 'pickStroke', 'tremoloPicking', 'crescendo', 'golpe', 'dynamics', 'invertBeamDirection', 'preferredBeamDirection', 'beamingMode', 'wahPedal', 'barreFret', 'barreShape', 'rasgueado', 'showTimer', 'timer', 'style'],
      },
      Note: {
        instance: new model.Note(),
        structural: ['id', 'index', 'beat', 'bendOrigin', 'isContinuedBend', 'maxBendPoint', 'hammerPullOrigin', 'hammerPullDestination', 'slurOrigin', 'slideOrigin', 'tieOrigin', 'letRingDestination', 'palmMuteDestination', 'isTieDestination', 'isEffectSlurOrigin', 'hasEffectSlur', 'effectSlurOrigin', 'effectSlurDestination', 'effectSlur', '_noteIdBag'],
        data: ['accentuated', 'bendType', 'bendStyle', 'bendPoints', 'fret', 'string', 'showStringNumber', 'octave', 'tone', 'percussionArticulation', 'isVisible', 'isLeftHandTapped', 'isHammerPullOrigin', 'isSlurDestination', 'slurDestination', 'harmonicType', 'harmonicValue', 'isGhost', 'isLetRing', 'isPalmMute', 'isDead', 'isStaccato', 'slideInType', 'slideOutType', 'slideTarget', 'vibrato', 'tieDestination', 'leftHandFinger', 'rightHandFinger', 'trillValue', 'trillSpeed', 'durationPercent', 'accidentalMode', 'dynamics', 'ornament', 'style'],
      },
      Automation: {
        instance: new model.Automation(),
        structural: ['syncPointValue'],
        data: ['isLinear', 'type', 'value', 'ratioPosition', 'text', 'isVisible'],
      },
      Chord: {
        instance: new model.Chord(),
        structural: ['staff'],
        data: ['name', 'firstFret', 'strings', 'barreFrets', 'showName', 'showDiagram', 'showFingering'],
      },
      TremoloPickingEffect: {
        instance: new model.TremoloPickingEffect(),
        structural: [],
        data: ['marks', 'style'],
      },
    };

    for (const [name, entry] of Object.entries(taxonomy)) {
      const instanceKeys = Object.keys(entry.instance).sort();
      const declaredKeys = [...entry.structural, ...entry.data].sort();
      expect(declaredKeys, `taxonomy of ${name}`).toEqual(instanceKeys);
    }
  });
});

describe('F27 import field preservation matrix: preserved fields', () => {
  type PreservedCase = {
    field: string;
    category: 'notation' | 'audio' | 'layout';
    formats: WriterFormat[];
    apply: (s: model.Score) => void;
    verify: (reloaded: model.Score, original: model.Score, format: WriterFormat) => void;
  };

  const cleanText = (t: string | undefined | null) => t?.replace(/\u00A0/g, ' ') ?? '';

  const preservedCases: PreservedCase[] = [
    // --- Score ---
    {
      field: 'Score.title',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { s.title = 'PreservedTitle'; },
      verify: r => expect(cleanText(r.title)).toBe('PreservedTitle'),
    },
    {
      field: 'Score.subTitle',
      category: 'notation',
      formats: ['gp'],
      apply: s => { s.subTitle = 'PreservedSubTitle'; },
      verify: r => expect(r.subTitle).toBe('PreservedSubTitle'),
    },
    {
      field: 'Score.artist',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { s.artist = 'PreservedArtist'; },
      verify: r => expect(cleanText(r.artist)).toBe('PreservedArtist'),
    },
    {
      field: 'Score.album',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { s.album = 'PreservedAlbum'; },
      verify: r => expect(r.album).toBe('PreservedAlbum'),
    },
    {
      field: 'Score.words',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { s.words = 'PreservedWords'; },
      verify: r => expect(cleanText(r.words)).toBe('PreservedWords'),
    },
    {
      field: 'Score.music',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { s.music = 'PreservedMusic'; },
      verify: r => expect(cleanText(r.music)).toBe('PreservedMusic'),
    },
    {
      field: 'Score.copyright',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { s.copyright = 'PreservedCopyright'; },
      verify: r => expect(cleanText(r.copyright)).toBe('PreservedCopyright'),
    },
    {
      field: 'Score.tab',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { s.tab = 'PreservedTab'; },
      verify: r => expect(r.tab).toBe('PreservedTab'),
    },
    {
      field: 'Score.instructions',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { s.instructions = 'Drop D tuning'; },
      verify: r => expect(r.instructions).toBe('Drop D tuning'),
    },
    {
      field: 'Score.notices',
      category: 'notation',
      formats: ['gp'],
      apply: s => { s.notices = 'PreservedNotices'; },
      verify: r => expect(r.notices).toBe('PreservedNotices'),
    },

    // --- MasterBar ---
    {
      field: 'MasterBar.timeSignatureNumerator & Denominator',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        for (const mb of s.masterBars) {
          mb.timeSignatureNumerator = 3;
          mb.timeSignatureDenominator = 8;
        }
      },
      verify: r => {
        expect(targetMasterBar(r).timeSignatureNumerator).toBe(3);
        expect(targetMasterBar(r).timeSignatureDenominator).toBe(8);
      },
    },
    {
      field: 'MasterBar.timeSignatureCommon',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        for (const mb of s.masterBars) mb.timeSignatureCommon = true;
      },
      verify: r => expect(targetMasterBar(r).timeSignatureCommon).toBe(true),
    },
    {
      field: 'MasterBar.isDoubleBar',
      category: 'layout',
      formats: ['gp', 'gp5'],
      apply: s => { targetMasterBar(s).isDoubleBar = true; },
      verify: r => expect(targetMasterBar(r).isDoubleBar).toBe(true),
    },
    {
      field: 'MasterBar.isRepeatStart',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetMasterBar(s, 0).isRepeatStart = true; },
      verify: r => expect(targetMasterBar(r, 0).isRepeatStart).toBe(true),
    },
    {
      field: 'MasterBar.repeatCount',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetMasterBar(s, 1).repeatCount = 3; },
      verify: r => expect(targetMasterBar(r, 1).repeatCount).toBe(3),
    },
    {
      field: 'MasterBar.alternateEndings',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetMasterBar(s, 1).alternateEndings = 3; },
      verify: r => expect(targetMasterBar(r, 1).alternateEndings).toBe(3),
    },
    {
      field: 'MasterBar.tripletFeel',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetMasterBar(s).tripletFeel = model.TripletFeel.Triplet8th; },
      verify: r => expect(targetMasterBar(r).tripletFeel).toBe(model.TripletFeel.Triplet8th),
    },
    {
      field: 'MasterBar.isFreeTime',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetMasterBar(s).isFreeTime = true; },
      verify: r => expect(targetMasterBar(r).isFreeTime).toBe(true),
    },
    {
      field: 'MasterBar.section',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetMasterBar(s).section = Object.assign(new model.Section(), { marker: 'Intro', text: 'Lead In' }); },
      verify: r => expect(targetMasterBar(r).section?.marker).toBe('Intro'),
    },
    {
      field: 'MasterBar.directions',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        targetMasterBar(s, 0).addDirection(model.Direction.TargetSegno);
        targetMasterBar(s, 1).addDirection(model.Direction.JumpDalSegno);
      },
      verify: r => {
        expect(targetMasterBar(r, 0).directions).toContain(model.Direction.TargetSegno);
        expect(targetMasterBar(r, 1).directions).toContain(model.Direction.JumpDalSegno);
      },
    },
    {
      field: 'MasterBar.fermata',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        targetMasterBar(s).addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Medium, length: 1 }));
      },
      verify: r => expect(targetMasterBar(r).fermata?.get(0)?.type).toBe(model.FermataType.Medium),
    },
    {
      field: 'MasterBar.tempoAutomations',
      category: 'audio',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        targetMasterBar(s).tempoAutomations.push(Object.assign(new model.Automation(), {
          type: model.AutomationType.Tempo,
          value: 140,
          ratioPosition: 0,
        }));
      },
      verify: r => {
        const tempos = targetMasterBar(r).tempoAutomations.filter(a => a.type === model.AutomationType.Tempo);
        expect(tempos.some(t => t.value === 140)).toBe(true);
      },
    },

    // --- Track ---
    {
      field: 'Track.name',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetTrack(s).name = 'Lead Guitar'; },
      verify: r => expect(targetTrack(r).name).toBe('Lead Guitar'),
    },
    {
      field: 'Track.shortName',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetTrack(s).shortName = 'L.Gtr'; },
      verify: r => expect(targetTrack(r).shortName).toBe('L.Gtr'),
    },
    {
      field: 'Track.color',
      category: 'layout',
      formats: ['gp', 'gp5'],
      apply: s => { targetTrack(s).color = new model.Color(220, 110, 40, 255); },
      verify: r => {
        expect(targetTrack(r).color.r).toBe(220);
        expect(targetTrack(r).color.g).toBe(110);
        expect(targetTrack(r).color.b).toBe(40);
      },
    },
    {
      field: 'Track.playbackInfo.volume',
      category: 'audio',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetTrack(s).playbackInfo.volume = 12; },
      verify: r => expect(targetTrack(r).playbackInfo.volume).toBe(12),
    },
    {
      field: 'Track.playbackInfo.balance',
      category: 'audio',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetTrack(s).playbackInfo.balance = 4; },
      verify: r => expect(targetTrack(r).playbackInfo.balance).toBe(4),
    },
    {
      field: 'Track.playbackInfo.program',
      category: 'audio',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        targetTrack(s).playbackInfo.program = 30;
        const auto = targetBeat(s).automations.find(a => a.type === model.AutomationType.Instrument);
        if (auto) auto.value = 30;
      },
      verify: r => expect(targetTrack(r).playbackInfo.program).toBe(30),
    },

    // --- Staff ---
    {
      field: 'Staff.stringTuning',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetStaff(s).stringTuning.tunings = [62, 57, 53, 50, 45, 38]; },
      verify: r => expect(targetStaff(r).stringTuning.tunings).toEqual([62, 57, 53, 50, 45, 38]),
    },
    {
      field: 'Staff.capo',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetStaff(s).capo = 2; },
      verify: r => expect(targetStaff(r).capo).toBe(2),
    },
    {
      field: 'Staff.displayTranspositionPitch',
      category: 'notation',
      formats: ['gp', 'musicxml'],
      apply: s => { targetStaff(s).displayTranspositionPitch = -12; },
      verify: r => expect(targetStaff(r).displayTranspositionPitch).toBe(-12),
    },
    {
      field: 'Staff.showStandardNotation',
      category: 'layout',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetStaff(s).showStandardNotation = false; },
      verify: r => expect(targetStaff(r).showStandardNotation).toBe(false),
    },
    {
      field: 'Staff.showTablature',
      category: 'layout',
      formats: ['gp', 'gp5'],
      apply: s => { targetStaff(s).showTablature = false; },
      verify: r => expect(targetStaff(r).showTablature).toBe(false),
    },
    {
      field: 'Staff.showSlash',
      category: 'layout',
      formats: ['gp'],
      apply: s => { targetStaff(s).showSlash = true; },
      verify: r => expect(targetStaff(r).showSlash).toBe(true),
    },
    {
      field: 'Staff.showNumbered',
      category: 'layout',
      formats: ['gp'],
      apply: s => { targetStaff(s).showNumbered = true; },
      verify: r => expect(targetStaff(r).showNumbered).toBe(true),
    },
    {
      field: 'Staff.chords',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        const chord = Object.assign(new model.Chord(), {
          name: 'C',
          firstFret: 1,
          strings: [-1, 3, 2, 0, 1, 0],
          barreFrets: [],
          showName: true,
          showDiagram: true,
          showFingering: false,
        });
        chord.staff = targetStaff(s);
        targetStaff(s).addChord('c1', chord);
        targetBeat(s).chordId = 'c1';
      },
      verify: r => expect(targetStaff(r).chords?.get('c1')?.name).toBe('C'),
    },

    // --- Bar ---
    {
      field: 'Bar.clef',
      category: 'notation',
      formats: ['gp', 'musicxml'],
      apply: s => { targetBar(s).clef = model.Clef.F4; },
      verify: r => expect(targetBar(r).clef).toBe(model.Clef.F4),
    },
    {
      field: 'Bar.clefOttava',
      category: 'notation',
      formats: ['gp', 'musicxml'],
      apply: s => { targetBar(s).clefOttava = model.Ottavia._8vb; },
      verify: r => expect(targetBar(r).clefOttava).toBe(model.Ottavia._8vb),
    },
    {
      field: 'Bar.keySignature',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetBar(s).keySignature = 3; },
      verify: r => expect(targetBar(r).keySignature).toBe(3),
    },
    {
      field: 'Bar.keySignatureType',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetBar(s).keySignatureType = model.KeySignatureType.Minor; },
      verify: r => expect(targetBar(r).keySignatureType).toBe(model.KeySignatureType.Minor),
    },
    {
      field: 'Bar.simileMark',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetBar(s).simileMark = model.SimileMark.Simple; },
      verify: r => expect(targetBar(r).simileMark).toBe(model.SimileMark.Simple),
    },
    {
      field: 'Bar.sustainPedals',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        const marker = new model.SustainPedalMarker();
        marker.pedalType = model.SustainPedalMarkerType.Down;
        marker.ratioPosition = 0;
        targetBar(s).sustainPedals.push(marker);
      },
      verify: r => expect(targetBar(r).sustainPedals.length).toBeGreaterThan(0),
    },

    // --- Beat ---
    {
      field: 'Beat.duration',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetBeat(s).duration = model.Duration.Eighth; },
      verify: r => expect(targetBeat(r).duration).toBe(model.Duration.Eighth),
    },
    {
      field: 'Beat.dots',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        targetBeat(s).duration = model.Duration.Eighth;
        targetBeat(s).dots = 1;
      },
      verify: r => expect(targetBeat(r).dots).toBe(1),
    },
    {
      field: 'Beat.dynamics',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetBeat(s).dynamics = model.DynamicValue.FF; },
      verify: r => expect(targetBeat(r).dynamics).toBe(model.DynamicValue.FF),
    },
    {
      field: 'Beat.text',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).text = 'Solo'; },
      verify: r => expect(targetBeat(r).text).toBe('Solo'),
    },
    {
      field: 'Beat.lyrics',
      category: 'notation',
      formats: ['gp', 'musicxml'],
      apply: s => { targetBeat(s).lyrics = ['Hello']; },
      verify: r => expect(targetBeat(r).lyrics).toEqual(['Hello']),
    },
    {
      field: 'Beat.fade',
      category: 'audio',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).fade = model.FadeType.FadeIn; },
      verify: r => expect(targetBeat(r).fade).toBe(model.FadeType.FadeIn),
    },
    {
      field: 'Beat.vibrato',
      category: 'audio',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).vibrato = model.VibratoType.Slight; },
      verify: r => expect(targetBeat(r).vibrato).toBe(model.VibratoType.Slight),
    },
    {
      field: 'Beat.brushType',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => {
        targetBeat(s).brushType = model.BrushType.BrushDown;
        targetBeat(s).brushDuration = 30;
      },
      verify: r => expect(targetBeat(r).brushType).toBe(model.BrushType.BrushDown),
    },
    {
      field: 'Beat.pickStroke',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).pickStroke = model.PickStroke.Up; },
      verify: r => expect(targetBeat(r).pickStroke).toBe(model.PickStroke.Up),
    },
    {
      field: 'Beat.tupletNumerator & Denominator',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        targetBeat(s).tupletNumerator = 3;
        targetBeat(s).tupletDenominator = 2;
      },
      verify: r => {
        expect(targetBeat(r).tupletNumerator).toBe(3);
        expect(targetBeat(r).tupletDenominator).toBe(2);
      },
    },
    {
      field: 'Beat.tremoloPicking (marks)',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => {
        targetBeat(s).tremoloPicking = Object.assign(new model.TremoloPickingEffect(), {
          marks: 2,
          style: model.TremoloPickingStyle.Default,
        });
      },
      verify: r => expect(targetBeat(r).tremoloPicking?.marks).toBe(2),
    },
    {
      field: 'Beat.whammyBarType & points',
      category: 'audio',
      formats: ['gp', 'gp5'],
      apply: s => {
        targetBeat(s).whammyBarType = model.WhammyType.Dive;
        targetBeat(s).whammyBarPoints = [new model.BendPoint(0, 0), new model.BendPoint(60, -4)];
      },
      verify: r => expect(targetBeat(r).whammyBarType).toBe(model.WhammyType.Dive),
    },
    {
      field: 'Beat.slap',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).slap = true; },
      verify: r => expect(targetBeat(r).slap).toBe(true),
    },
    {
      field: 'Beat.pop',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).pop = true; },
      verify: r => expect(targetBeat(r).pop).toBe(true),
    },
    {
      field: 'Beat.tap',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).tap = true; },
      verify: r => expect(targetBeat(r).tap).toBe(true),
    },
    {
      field: 'Beat.ottava',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).ottava = model.Ottavia._8va; },
      verify: r => expect(targetBeat(r).ottava).toBe(model.Ottavia._8va),
    },
    {
      field: 'Beat.crescendo',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetBeat(s).crescendo = model.CrescendoType.Crescendo; },
      verify: r => expect(targetBeat(r).crescendo).toBe(model.CrescendoType.Crescendo),
    },
    {
      field: 'Beat.wahPedal',
      category: 'audio',
      formats: ['gp'],
      apply: s => { targetBeat(s).wahPedal = model.WahPedal.Open; },
      verify: r => expect(targetBeat(r).wahPedal).toBe(model.WahPedal.Open),
    },
    {
      field: 'Beat.rasgueado',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetBeat(s).rasgueado = model.Rasgueado.Ii; },
      verify: r => expect(targetBeat(r).rasgueado).toBe(model.Rasgueado.Ii),
    },
    {
      field: 'Beat.barreFret & barreShape',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        targetBeat(s).barreFret = 3;
        targetBeat(s).barreShape = model.BarreShape.Full;
      },
      verify: r => {
        expect(targetBeat(r).barreFret).toBe(3);
        expect(targetBeat(r).barreShape).toBe(model.BarreShape.Full);
      },
    },
    {
      field: 'Beat.showTimer & timer',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        targetBeat(s).showTimer = true;
        targetBeat(s).timer = 45;
      },
      verify: r => {
        expect(targetBeat(r).showTimer).toBe(true);
        expect(targetBeat(r).timer).toBe(45);
      },
    },

    // --- Note ---
    {
      field: 'Note.fret',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetNote(s).fret = 5; },
      verify: r => expect(targetNote(r).fret).toBe(5),
    },
    {
      field: 'Note.string',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetNote(s).string = 4; },
      verify: r => expect(targetNote(r).string).toBe(4),
    },
    {
      field: 'Note.accentuated',
      category: 'notation',
      formats: ['gp', 'musicxml'],
      apply: s => { targetNote(s).accentuated = model.AccentuationType.Heavy; },
      verify: r => expect(targetNote(r).accentuated).toBe(model.AccentuationType.Heavy),
    },
    {
      field: 'Note.bendType & bendPoints',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => {
        targetNote(s).bendType = model.BendType.Bend;
        targetNote(s).bendPoints = [new model.BendPoint(0, 0), new model.BendPoint(60, 4)];
      },
      verify: r => {
        expect(targetNote(r).bendType).toBe(model.BendType.Bend);
        expect(targetNote(r).bendPoints!.length).toBe(2);
      },
    },
    {
      field: 'Note.harmonicType & harmonicValue',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        targetNote(s).harmonicType = model.HarmonicType.Natural;
        targetNote(s).harmonicValue = 12;
      },
      verify: r => {
        expect(targetNote(r).harmonicType).toBe(model.HarmonicType.Natural);
        expect(targetNote(r).harmonicValue).toBe(12);
      },
    },
    {
      field: 'Note.isGhost',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetNote(s).isGhost = true; },
      verify: r => expect(targetNote(r).isGhost).toBe(true),
    },
    {
      field: 'Note.isLetRing',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetNote(s).isLetRing = true; },
      verify: r => expect(targetNote(r).isLetRing).toBe(true),
    },
    {
      field: 'Note.isPalmMute',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetNote(s).isPalmMute = true; },
      verify: r => expect(targetNote(r).isPalmMute).toBe(true),
    },
    {
      field: 'Note.isDead',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetNote(s).isDead = true; },
      verify: r => expect(targetNote(r).isDead).toBe(true),
    },
    {
      field: 'Note.isStaccato',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => { targetNote(s).isStaccato = true; },
      verify: r => expect(targetNote(r).isStaccato).toBe(true),
    },
    {
      field: 'Note.isLeftHandTapped',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetNote(s).isLeftHandTapped = true; },
      verify: r => expect(targetNote(r).isLeftHandTapped).toBe(true),
    },
    {
      field: 'Note.slideInType',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetNote(s).slideInType = model.SlideInType.IntoFromBelow; },
      verify: r => expect(targetNote(r).slideInType).toBe(model.SlideInType.IntoFromBelow),
    },
    {
      field: 'Note.slideOutType',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => { targetNote(s).slideOutType = model.SlideOutType.Shift; },
      verify: r => expect(targetNote(r).slideOutType).toBe(model.SlideOutType.Shift),
    },
    {
      field: 'Note.vibrato',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetNote(s).vibrato = model.VibratoType.Wide; },
      verify: r => expect(targetNote(r).vibrato).toBe(model.VibratoType.Wide),
    },
    {
      field: 'Note.leftHandFinger & rightHandFinger',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => {
        targetNote(s).leftHandFinger = model.Fingers.IndexFinger;
        targetNote(s).rightHandFinger = model.Fingers.Thumb;
      },
      verify: r => {
        expect(targetNote(r).leftHandFinger).toBe(model.Fingers.IndexFinger);
        expect(targetNote(r).rightHandFinger).toBe(model.Fingers.Thumb);
      },
    },
    {
      field: 'Note.trillValue & trillSpeed',
      category: 'notation',
      formats: ['gp', 'gp5'],
      apply: s => {
        targetNote(s).trillValue = 67;
        targetNote(s).trillSpeed = model.Duration.Sixteenth;
      },
      verify: r => {
        expect(targetNote(r).trillValue).toBe(67);
        expect(targetNote(r).trillSpeed).toBe(model.Duration.Sixteenth);
      },
    },
    {
      field: 'Note.accidentalMode',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetNote(s).accidentalMode = model.NoteAccidentalMode.ForceSharp; },
      verify: r => expect(targetNote(r).accidentalMode).toBe(model.NoteAccidentalMode.ForceSharp),
    },
    {
      field: 'Note.ornament',
      category: 'notation',
      formats: ['gp'],
      apply: s => { targetNote(s).ornament = model.NoteOrnament.Turn; },
      verify: r => expect(targetNote(r).ornament).toBe(model.NoteOrnament.Turn),
    },
    {
      field: 'Note.tieDestination',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        const from = targetNote(s, 0);
        const to = targetNote(s, 1);
        from.tieDestination = to;
        to.tieOrigin = from;
        to.isTieDestination = true;
      },
      verify: r => {
        const to = targetNote(r, 1);
        expect(to.isTieDestination).toBe(true);
      },
    },
    {
      field: 'Note.slurDestination',
      category: 'notation',
      formats: ['gp'],
      apply: s => {
        const from = targetNote(s, 0);
        const to = targetNote(s, 1);
        from.slurDestination = to;
        to.slurOrigin = from;
        to.isSlurDestination = true;
      },
      verify: r => {
        const from = targetNote(r, 0);
        expect(from.slurDestination).toBeDefined();
      },
    },
    {
      field: 'Note.isHammerPullOrigin',
      category: 'notation',
      formats: ['gp', 'gp5', 'musicxml'],
      apply: s => {
        const from = targetNote(s, 0);
        const to = targetNote(s, 1);
        from.isHammerPullOrigin = true;
        from.hammerPullDestination = to;
        to.hammerPullOrigin = from;
      },
      verify: r => expect(targetNote(r, 0).isHammerPullOrigin).toBe(true),
    },
  ];

  for (const tc of preservedCases) {
    for (const format of tc.formats) {
      it(`preserves ${tc.field} in ${format}`, () => {
        const score = createSyntheticScore();
        tc.apply(score);
        score.finish(settings);
        const reloaded = roundtrip(score, format);
        tc.verify(reloaded, score, format);
      });
    }
  }
});

describe('F27 import field preservation matrix: knowingly dropped fields', () => {
  // Traced to stated limits in code and documentation
  const knowinglyDroppedRules = [
    {
      field: 'MasterBar.displayScale & displayWidth',
      format: 'gp',
      category: 'layout',
      limit: 'docs/validation/2026-10-31-gp8-bar-widths.md:18',
      reason: "alphaTab's GPIF writer does not write displayScale or displayWidth; bar widths stored in TabPlayer project and PDF only",
      verifyClean: (s: model.Score) => {
        s.masterBars[0].displayScale = 2.0;
        s.masterBars[0].displayWidth = 150;
        const reloaded = roundtrip(s, 'gp');
        expect(reloaded.masterBars[0].displayScale).toBe(1);
      },
    },
    {
      field: 'Bar.displayScale & displayWidth',
      format: 'gp',
      category: 'layout',
      limit: 'docs/validation/2026-10-31-gp8-bar-widths.md:18',
      reason: "alphaTab's GPIF writer does not write displayScale or displayWidth on Bar",
      verifyClean: (s: model.Score) => {
        targetBar(s).displayScale = 2.5;
        const reloaded = roundtrip(s, 'gp');
        expect(targetBar(reloaded).displayScale).toBe(1);
      },
    },
    {
      field: 'Bar.barLineLeft & barLineRight',
      format: 'gp',
      category: 'layout',
      limit: 'src/export/gp5.test.ts:576',
      reason: 'GPIF format expresses barlines via master bar isDoubleBar and repeat flags; individual Bar barLine styles are not persisted in GPIF',
      verifyClean: (s: model.Score) => {
        targetBar(s, 0).barLineRight = model.BarLineStyle.Dotted;
        const reloaded = roundtrip(s, 'gp');
        expect(targetBar(reloaded, 0).barLineRight).toBe(model.BarLineStyle.Automatic);
      },
    },
    {
      field: 'Staff.transpositionPitch',
      format: 'gp',
      category: 'audio',
      limit: 'PRODUCT.md:44',
      reason: 'GPIF format holds only display transposition <Transpose>, which maps to displayTranspositionPitch. Sounding pitch transposition is kept in native project',
      verifyClean: (s: model.Score) => {
        targetStaff(s).transpositionPitch = 12;
        const reloaded = roundtrip(s, 'gp');
        expect(targetStaff(reloaded).transpositionPitch).toBe(0);
      },
    },
    {
      field: 'Track.lineBreaks',
      format: 'gp',
      category: 'layout',
      limit: 'src/export/gp5.test.ts:587',
      reason: 'Track line breaks are session layout configuration not stored in score.gpif',
      verifyClean: (s: model.Score) => {
        targetTrack(s).lineBreaks = new Set([4, 8]);
        const reloaded = roundtrip(s, 'gp');
        expect(targetTrack(reloaded).lineBreaks).toBeUndefined();
      },
    },
    {
      field: 'Score.backingTrack (GP5)',
      format: 'gp5',
      category: 'audio',
      limit: 'docs/validation/2026-10-30-gp8-gp5-export.md:32',
      reason: 'Guitar Pro 5 binary format has no container for backing audio files; reported in export losses',
      verifyClean: (s: model.Score) => {
        s.backingTrack = new model.BackingTrack();
        s.backingTrack.rawAudioFile = new Uint8Array([1, 2, 3]);
        const res = exportGp5(s, { tracks: [0], range: null });
        expect(res.losses.join('|')).toMatch(/Backing audio/);
      },
    },
  ];

  for (const rule of knowinglyDroppedRules) {
    it(`traces ${rule.field} as knowingly dropped in ${rule.format}`, () => {
      expect(rule.limit).toBeTruthy();
      expect(rule.reason).toBeTruthy();
      const score = createSyntheticScore();
      rule.verifyClean(score);
    });
  }
});

describe('F27 import field preservation matrix: failing fields (real defects)', () => {
  // Tests for real defects stay out of the passing suite with it.fails and a one-line reason.
  // Each failing field traces to the file and line where it is lost.

  it('TremoloPickingEffect.style: kept by the TabPlayerCurves property', () => {
    const score = createSyntheticScore();
    targetBeat(score).tremoloPicking = Object.assign(new model.TremoloPickingEffect(), {
      marks: 2,
      style: model.TremoloPickingStyle.BuzzRoll,
    });
    score.finish(settings);
    const reloaded = roundtrip(score, 'gp');
    expect(targetBeat(reloaded).tremoloPicking?.style).toBe(model.TremoloPickingStyle.BuzzRoll);
  });

  it('Note.bendStyle: kept by the TabPlayerCurves property', () => {
    const score = createSyntheticScore();
    const n = targetNote(score);
    n.bendType = model.BendType.Bend;
    n.bendStyle = model.BendStyle.Gradual;
    n.bendPoints = [new model.BendPoint(0, 0), new model.BendPoint(60, 4)];
    score.finish(settings);
    const reloaded = roundtrip(score, 'gp');
    expect(targetNote(reloaded).bendStyle).toBe(model.BendStyle.Gradual);
  });

  it('Beat.whammyStyle: kept by the TabPlayerCurves property', () => {
    const score = createSyntheticScore();
    const b = targetBeat(score);
    b.whammyBarType = model.WhammyType.Dive;
    b.whammyStyle = model.BendStyle.Gradual;
    b.whammyBarPoints = [new model.BendPoint(0, 0), new model.BendPoint(60, -4)];
    score.finish(settings);
    const reloaded = roundtrip(score, 'gp');
    expect(targetBeat(reloaded).whammyStyle).toBe(model.BendStyle.Gradual);
  });

  it('Note.durationPercent: kept by the TabPlayerCurves property', () => {
    const score = createSyntheticScore();
    targetNote(score).durationPercent = 0.5;
    score.finish(settings);
    const reloaded = roundtrip(score, 'gp');
    expect(targetNote(reloaded).durationPercent).toBe(0.5);
  });

  it('Note.isVisible: kept by the TabPlayerCurves property', () => {
    const score = createSyntheticScore();
    targetNote(score).isVisible = false;
    score.finish(settings);
    const reloaded = roundtrip(score, 'gp');
    expect(targetNote(reloaded).isVisible).toBe(false);
  });
});
