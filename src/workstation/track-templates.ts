import { model } from '@coderline/alphatab';
import { soundPreset } from '../audio/sound-model';
import type { Gp8Status } from '../audio/soundbank-store';
import type { TrackSound } from '../edit-types';
import { midiPrograms } from '../midi-programs';
import { formatTuning } from '../tuning';
import { tuningPresets, type PresetInstrument } from '../tuning-presets';

export type TrackCategoryId = 'stringed' | 'orchestra' | 'drums' | 'midi';
export type TrackKind = 'stringed' | 'pitched' | 'percussion';
export type TemplateGlyph = 'guitar' | 'bass' | 'ukulele' | 'strings' | 'keys' | 'brass' | 'drums' | 'vocal' | 'note';

export interface SoundOption {
  id: string;
  label: string;
  program: number;
  sound?: TrackSound;
}

export interface TrackTemplate {
  id: string;
  category: TrackCategoryId;
  subCategoryId: string;
  subCategoryLabel: string;
  listLabel: string;
  defaultName: string;
  defaultShortName: string;
  defaultColor: string;
  kind: TrackKind;
  glyph: TemplateGlyph;
  program: number;
  presetId?: TrackSound['presetId'];
  drumKit?: number;
  /** Default notation flags. */
  showTab: boolean;
  showNotation: boolean;
  showSlash: boolean;
  grandStaff: boolean;
  /** Stringed defaults (upper/lower). */
  instrument?: PresetInstrument;
  tuningId?: string;
  lowerInstrument?: PresetInstrument;
  lowerTuningId?: string;
  /** Pitched defaults (upper/lower). */
  clef?: number;
  lowerClef?: number;
  /** Curated sound preset/bank ids for this template. */
  curatedGp8Sets?: readonly string[];
}

export interface SubCategoryGroup {
  id: string;
  label: string;
  items: TrackTemplate[];
}

const presetById = (id: string) => tuningPresets.find(p => p.id === id);

export function templateTuningPitches(tuningId?: string): number[] {
  const found = tuningId ? presetById(tuningId) : undefined;
  return [...(found?.tuning ?? [64, 59, 55, 50, 45, 40])];
}

export function templateTuningLabel(tuningId?: string): string {
  return (tuningId ? presetById(tuningId)?.name : undefined) ?? '';
}

export function templateTuningNotes(tuningId?: string): string {
  return formatTuning(templateTuningPitches(tuningId));
}

const stringed = (spec: {
  id: string;
  subCategoryId: string;
  subCategoryLabel: string;
  listLabel: string;
  defaultName: string;
  defaultShortName: string;
  defaultColor: string;
  program: number;
  instrument: PresetInstrument;
  tuningId: string;
  presetId?: TrackSound['presetId'];
  glyph?: TemplateGlyph;
  curatedGp8Sets?: readonly string[];
}): TrackTemplate => ({
  ...spec,
  category: 'stringed',
  kind: 'stringed',
  glyph: spec.glyph ?? (spec.instrument === 'bass' ? 'bass' : spec.instrument === 'ukulele' || spec.instrument === 'banjo' || spec.instrument === 'mandolin' || spec.instrument === 'shamisen' ? 'ukulele' : 'guitar'),
  showTab: true,
  showNotation: true,
  showSlash: false,
  grandStaff: false,
  lowerInstrument: spec.instrument,
  lowerTuningId: spec.tuningId,
});

const pitched = (spec: {
  id: string;
  subCategoryId: string;
  subCategoryLabel: string;
  listLabel: string;
  defaultName: string;
  defaultShortName: string;
  defaultColor: string;
  program: number;
  glyph: TemplateGlyph;
  clef?: number;
  grandStaff?: boolean;
  lowerClef?: number;
  curatedGp8Sets?: readonly string[];
}): TrackTemplate => ({
  ...spec,
  category: 'orchestra',
  kind: 'pitched',
  showTab: false,
  showNotation: true,
  showSlash: false,
  grandStaff: !!spec.grandStaff,
  clef: spec.clef ?? model.Clef.G2,
  lowerClef: spec.lowerClef ?? model.Clef.F4,
});

const percussion = (spec: {
  id: string;
  subCategoryId: string;
  subCategoryLabel: string;
  listLabel: string;
  defaultName: string;
  defaultShortName: string;
  defaultColor: string;
  drumKit?: number;
  curatedGp8Sets?: readonly string[];
}): TrackTemplate => ({
  ...spec,
  category: 'drums',
  kind: 'percussion',
  glyph: 'drums',
  program: 0,
  showTab: false,
  showNotation: true,
  showSlash: false,
  grandStaff: false,
});

const STRINGED_TEMPLATES: readonly TrackTemplate[] = [
  // Acoustic Guitar
  stringed({ id: 'str-ac-steel', subCategoryId: 'acoustic-guitar', subCategoryLabel: 'Acoustic Guitar', listLabel: 'Steel', defaultName: 'Acoustic Guitar', defaultShortName: 'ac.guit.', defaultColor: '#d96b43', program: 25, instrument: 'guitar', tuningId: 'guitar-6-standard-e', curatedGp8Sets: ['D-Steel', 'Jumbo-Steel', 'Blues-Steel', 'Peacock-Steel'] }),
  stringed({ id: 'str-ac-nylon', subCategoryId: 'acoustic-guitar', subCategoryLabel: 'Acoustic Guitar', listLabel: 'Nylon', defaultName: 'Nylon Guitar', defaultShortName: 'nyl.g.', defaultColor: '#e0824a', program: 24, instrument: 'guitar', tuningId: 'guitar-6-standard-e', curatedGp8Sets: ['Concerto-Nylon', 'Modern-Nylon', 'Flamenco-Guitar', 'Reso-Nylon'] }),
  stringed({ id: 'str-ac-12', subCategoryId: 'acoustic-guitar', subCategoryLabel: 'Acoustic Guitar', listLabel: '12-String', defaultName: '12-String Acoustic', defaultShortName: '12-str.', defaultColor: '#c95d3a', program: 25, instrument: 'guitar', tuningId: 'guitar-6-standard-e', curatedGp8Sets: ['12-Steel', 'D-Steel'] }),
  stringed({ id: 'str-ac-dobro', subCategoryId: 'acoustic-guitar', subCategoryLabel: 'Acoustic Guitar', listLabel: 'Dobro', defaultName: 'Dobro', defaultShortName: 'dobro', defaultColor: '#cc7a3d', program: 25, instrument: 'guitar', tuningId: 'guitar-6-open-g', curatedGp8Sets: ['Dobro-Tricone', 'D-Steel'] }),
  // Electric Guitar
  stringed({ id: 'str-el-overdrive', subCategoryId: 'electric-guitar', subCategoryLabel: 'Electric Guitar', listLabel: 'Overdrive', defaultName: 'Electric Guitar', defaultShortName: 'el.guit.', defaultColor: '#d9534f', program: 29, instrument: 'guitar', tuningId: 'guitar-6-standard-e', presetId: 'crunch', curatedGp8Sets: ['Classic-Guitar', 'Strat-Guitar', 'Tele-Guitar', 'Gold-Guitar'] }),
  stringed({ id: 'str-el-distortion', subCategoryId: 'electric-guitar', subCategoryLabel: 'Electric Guitar', listLabel: 'Distortion', defaultName: 'Distortion Guitar', defaultShortName: 'dist.g.', defaultColor: '#c43e54', program: 30, instrument: 'guitar', tuningId: 'guitar-6-standard-e', presetId: 'lead', curatedGp8Sets: ['Metal-Guitar', 'Satch-Guitar', 'Classic-Guitar', 'Custom-Guitar'] }),
  stringed({ id: 'str-el-clean', subCategoryId: 'electric-guitar', subCategoryLabel: 'Electric Guitar', listLabel: 'Clean', defaultName: 'Clean Guitar', defaultShortName: 'cln.g.', defaultColor: '#4f8fe6', program: 27, instrument: 'guitar', tuningId: 'guitar-6-standard-e', presetId: 'clean', curatedGp8Sets: ['Strat-Guitar', 'Tele-Guitar', 'Standard-Guitar', 'Dano-Guitar'] }),
  stringed({ id: 'str-el-jazz', subCategoryId: 'electric-guitar', subCategoryLabel: 'Electric Guitar', listLabel: 'Jazz', defaultName: 'Jazz Guitar', defaultShortName: 'jazz g.', defaultColor: '#7a6fd9', program: 26, instrument: 'guitar', tuningId: 'guitar-6-standard-e', presetId: 'clean', curatedGp8Sets: ['Jazz-Guitar', 'ES-Guitar', 'L4-Guitar', 'Manouche-Guitar'] }),
  stringed({ id: 'str-el-12', subCategoryId: 'electric-guitar', subCategoryLabel: 'Electric Guitar', listLabel: '12-String', defaultName: 'Electric 12-String', defaultShortName: 'el.12', defaultColor: '#5a9bd4', program: 27, instrument: 'guitar', tuningId: 'guitar-6-standard-e', presetId: 'clean', curatedGp8Sets: ['Rick12-Guitar', 'Rick6-Guitar', 'Strat-Guitar'] }),
  // Bass
  stringed({ id: 'str-bass-finger', subCategoryId: 'bass', subCategoryLabel: 'Bass', listLabel: 'Electric Bass', defaultName: 'Bass', defaultShortName: 'el.b.', defaultColor: '#3d7ac7', program: 33, instrument: 'bass', tuningId: 'bass-4-standard-e', presetId: 'bass', curatedGp8Sets: ['Jazz-Bass', 'Pre-Bass', 'Modern-Bass', 'Music-Bass'] }),
  stringed({ id: 'str-bass-pick', subCategoryId: 'bass', subCategoryLabel: 'Bass', listLabel: 'Picked Bass', defaultName: 'Picked Bass', defaultShortName: 'p.b.', defaultColor: '#386db5', program: 34, instrument: 'bass', tuningId: 'bass-4-standard-e', presetId: 'bass', curatedGp8Sets: ['Pre-Bass', 'Rick-Bass', 'Jazz-Bass'] }),
  stringed({ id: 'str-bass-acoustic', subCategoryId: 'bass', subCategoryLabel: 'Bass', listLabel: 'Acoustic Bass', defaultName: 'Acoustic Bass', defaultShortName: 'ac.b.', defaultColor: '#3e8e7e', program: 32, instrument: 'bass', tuningId: 'bass-4-standard-e', curatedGp8Sets: ['Acoustic-Bass', 'Upright-Bass'] }),
  stringed({ id: 'str-bass-fretless', subCategoryId: 'bass', subCategoryLabel: 'Bass', listLabel: 'Fretless Bass', defaultName: 'Fretless Bass', defaultShortName: 'frtl.b.', defaultColor: '#4a90a4', program: 35, instrument: 'bass', tuningId: 'bass-4-standard-e', presetId: 'bass', curatedGp8Sets: ['Fretless-Bass', 'Fretless-JB', 'Jazz-Bass'] }),
  stringed({ id: 'str-bass-slap', subCategoryId: 'bass', subCategoryLabel: 'Bass', listLabel: 'Slap Bass', defaultName: 'Slap Bass', defaultShortName: 'slap b.', defaultColor: '#556cd6', program: 36, instrument: 'bass', tuningId: 'bass-4-standard-e', presetId: 'bass', curatedGp8Sets: ['Jazz-Bass', 'Modern-Bass', 'Sting-Bass'] }),
  stringed({ id: 'str-bass-synth', subCategoryId: 'bass', subCategoryLabel: 'Bass', listLabel: 'Synth Bass', defaultName: 'Synth Bass', defaultShortName: 'syn.b.', defaultColor: '#7d56c2', program: 38, instrument: 'bass', tuningId: 'bass-4-standard-e', curatedGp8Sets: ['FMSyn-Bass', 'OB-Bass', 'Lately-Bass', 'TB-Bass'] }),
  // Other
  stringed({ id: 'str-other-ukulele', subCategoryId: 'other-stringed', subCategoryLabel: 'Other', listLabel: 'Ukulele', defaultName: 'Ukulele', defaultShortName: 'uke.', defaultColor: '#e86c6a', program: 24, instrument: 'ukulele', tuningId: 'ukulele-4-standard-c', curatedGp8Sets: ['CC-Ukulele'] }),
  stringed({ id: 'str-other-banjo', subCategoryId: 'other-stringed', subCategoryLabel: 'Other', listLabel: 'Banjo', defaultName: 'Banjo', defaultShortName: 'bnj.', defaultColor: '#d99b38', program: 105, instrument: 'banjo', tuningId: 'banjo-5-open-g', curatedGp8Sets: ['5-Banjo'] }),
  stringed({ id: 'str-other-mandolin', subCategoryId: 'other-stringed', subCategoryLabel: 'Other', listLabel: 'Mandolin', defaultName: 'Mandolin', defaultShortName: 'mand.', defaultColor: '#c97b54', program: 25, instrument: 'mandolin', tuningId: 'mandolin-4-standard', curatedGp8Sets: ['American-Mandolin'] }),
  stringed({ id: 'str-other-shamisen', subCategoryId: 'other-stringed', subCategoryLabel: 'Other', listLabel: 'Shamisen', defaultName: 'Shamisen', defaultShortName: 'sham.', defaultColor: '#d66580', program: 106, instrument: 'shamisen', tuningId: 'shamisen-3-honchoshi', curatedGp8Sets: ['5-Banjo'] }),
];

const ORCHESTRA_TEMPLATES: readonly TrackTemplate[] = [
  // Bowed Strings
  pitched({ id: 'orch-violin', subCategoryId: 'bowed-strings', subCategoryLabel: 'Bowed Strings', listLabel: 'Violin', defaultName: 'Violin', defaultShortName: 'vln.', defaultColor: '#c9883b', program: 40, glyph: 'strings', clef: model.Clef.G2, curatedGp8Sets: ['Violin-Solo', 'Violin-Solo-Pizz', 'Violin1-Ensemble'] }),
  pitched({ id: 'orch-viola', subCategoryId: 'bowed-strings', subCategoryLabel: 'Bowed Strings', listLabel: 'Viola', defaultName: 'Viola', defaultShortName: 'vla.', defaultColor: '#b87635', program: 41, glyph: 'strings', clef: model.Clef.C3, curatedGp8Sets: ['Viola-Solo', 'Viola-Ensemble'] }),
  pitched({ id: 'orch-cello', subCategoryId: 'bowed-strings', subCategoryLabel: 'Bowed Strings', listLabel: 'Cello', defaultName: 'Cello', defaultShortName: 'vc.', defaultColor: '#a66332', program: 42, glyph: 'strings', clef: model.Clef.F4, curatedGp8Sets: ['Cello-Solo', 'Cello-Ensemble'] }),
  pitched({ id: 'orch-contrabass', subCategoryId: 'bowed-strings', subCategoryLabel: 'Bowed Strings', listLabel: 'Contrabass', defaultName: 'Contrabass', defaultShortName: 'cb.', defaultColor: '#91522b', program: 43, glyph: 'strings', clef: model.Clef.F4, curatedGp8Sets: ['Contrabass-Solo', 'Contrabass-Ensemble'] }),
  pitched({ id: 'orch-strings-ens', subCategoryId: 'bowed-strings', subCategoryLabel: 'Bowed Strings', listLabel: 'Strings Ensemble', defaultName: 'Strings Ensemble', defaultShortName: 'str.', defaultColor: '#d49a4a', program: 48, glyph: 'strings', clef: model.Clef.G2, curatedGp8Sets: ['Violin1-Ensemble', 'Viola-Ensemble', 'Cello-Ensemble'] }),
  // Keyboards
  pitched({ id: 'orch-piano', subCategoryId: 'keyboards', subCategoryLabel: 'Keyboards', listLabel: 'Piano', defaultName: 'Piano', defaultShortName: 'pno.', defaultColor: '#48a868', program: 0, glyph: 'keys', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['German-APiano', 'Eastern-APiano', 'Upright-APiano'] }),
  pitched({ id: 'orch-epiano', subCategoryId: 'keyboards', subCategoryLabel: 'Keyboards', listLabel: 'Electric Piano', defaultName: 'Electric Piano', defaultShortName: 'el.pno.', defaultColor: '#52b788', program: 4, glyph: 'keys', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['MarkI-EPiano', '200A-EPiano', 'CP-EPiano', 'DXPiano1-Key'] }),
  pitched({ id: 'orch-harpsichord', subCategoryId: 'keyboards', subCategoryLabel: 'Keyboards', listLabel: 'Harpsichord', defaultName: 'Harpsichord', defaultShortName: 'hpd.', defaultColor: '#3d9970', program: 6, glyph: 'keys', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['Harpsichord-Key'] }),
  pitched({ id: 'orch-clavinet', subCategoryId: 'keyboards', subCategoryLabel: 'Keyboards', listLabel: 'Clavinet', defaultName: 'Clavinet', defaultShortName: 'clv.', defaultColor: '#2f8f7b', program: 7, glyph: 'keys', clef: model.Clef.G2, curatedGp8Sets: ['AddClavinet-Key', 'Harpsichord-Key'] }),
  pitched({ id: 'orch-organ', subCategoryId: 'keyboards', subCategoryLabel: 'Keyboards', listLabel: 'Organ', defaultName: 'Organ', defaultShortName: 'org.', defaultColor: '#66a352', program: 16, glyph: 'keys', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['Ballad-Organ', 'Jazz-Organ', 'Rock-Organ', 'Full-Organ'] }),
  pitched({ id: 'orch-accordion', subCategoryId: 'keyboards', subCategoryLabel: 'Keyboards', listLabel: 'Accordion', defaultName: 'Accordion', defaultShortName: 'acc.', defaultColor: '#58a082', program: 21, glyph: 'keys', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['Accordion', 'Accordion-Jazz', 'Bandoneon'] }),
  // Plucked Strings
  pitched({ id: 'orch-harp', subCategoryId: 'plucked-strings', subCategoryLabel: 'Plucked Strings', listLabel: 'Harp', defaultName: 'Harp', defaultShortName: 'hp.', defaultColor: '#d9a94e', program: 46, glyph: 'strings', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['Harp-Solo'] }),
  // Woodwinds
  pitched({ id: 'orch-piccolo', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Piccolo', defaultName: 'Piccolo', defaultShortName: 'picc.', defaultColor: '#9b72cf', program: 72, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Piccolo-Solo', 'Flute-Solo'] }),
  pitched({ id: 'orch-flute', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Flute', defaultName: 'Flute', defaultShortName: 'fl.', defaultColor: '#8d65c7', program: 73, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Flute-Solo', 'Flute-Ensemble'] }),
  pitched({ id: 'orch-recorder', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Recorder', defaultName: 'Recorder', defaultShortName: 'rec.', defaultColor: '#a27ad6', program: 74, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Recorder-Solo'] }),
  pitched({ id: 'orch-oboe', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Oboe', defaultName: 'Oboe', defaultShortName: 'ob.', defaultColor: '#7e57bd', program: 68, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Oboe-Solo', 'Oboe-Ensemble'] }),
  pitched({ id: 'orch-english-horn', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'English Horn', defaultName: 'English Horn', defaultShortName: 'e.hn.', defaultColor: '#724ca3', program: 69, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['EnglishHorn-Solo'] }),
  pitched({ id: 'orch-clarinet', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Clarinet', defaultName: 'Clarinet', defaultShortName: 'cl.', defaultColor: '#8c69c9', program: 71, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Clarinet-Solo', 'Clarinet-Ensemble'] }),
  pitched({ id: 'orch-bassoon', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Bassoon', defaultName: 'Bassoon', defaultShortName: 'bsn.', defaultColor: '#6b4799', program: 70, glyph: 'note', clef: model.Clef.F4, curatedGp8Sets: ['Bassoon-Solo', 'Bassoon-Ensemble'] }),
  pitched({ id: 'orch-soprano-sax', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Soprano Sax', defaultName: 'Soprano Sax', defaultShortName: 's.sax.', defaultColor: '#b57ab8', program: 64, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Soprano-Sax'] }),
  pitched({ id: 'orch-alto-sax', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Alto Sax', defaultName: 'Alto Sax', defaultShortName: 'a.sax.', defaultColor: '#a86aad', program: 65, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Alto-Sax'] }),
  pitched({ id: 'orch-tenor-sax', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Tenor Sax', defaultName: 'Tenor Sax', defaultShortName: 't.sax.', defaultColor: '#9b5ba3', program: 66, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Tenor-Sax'] }),
  pitched({ id: 'orch-bari-sax', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Baritone Sax', defaultName: 'Baritone Sax', defaultShortName: 'b.sax.', defaultColor: '#8a4c94', program: 67, glyph: 'note', clef: model.Clef.F4, curatedGp8Sets: ['Baritone-Sax'] }),
  pitched({ id: 'orch-harmonica', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Harmonica', defaultName: 'Harmonica', defaultShortName: 'harm.', defaultColor: '#a682c9', program: 22, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Harmonica', 'Full Harmonica'] }),
  pitched({ id: 'orch-bagpipe', subCategoryId: 'woodwinds', subCategoryLabel: 'Woodwinds', listLabel: 'Bagpipe', defaultName: 'Bagpipe', defaultShortName: 'bagp.', defaultColor: '#936fb8', program: 109, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Bagpipe'] }),
  // Brass
  pitched({ id: 'orch-trumpet', subCategoryId: 'brass', subCategoryLabel: 'Brass', listLabel: 'Trumpet', defaultName: 'Trumpet', defaultShortName: 'tpt.', defaultColor: '#d9ae38', program: 56, glyph: 'brass', clef: model.Clef.G2, curatedGp8Sets: ['Trumpet-Solo', 'Trumpet-Sordino-Solo', 'Trumpet-Ensemble'] }),
  pitched({ id: 'orch-trombone', subCategoryId: 'brass', subCategoryLabel: 'Brass', listLabel: 'Trombone', defaultName: 'Trombone', defaultShortName: 'tbn.', defaultColor: '#c99c2e', program: 57, glyph: 'brass', clef: model.Clef.F4, curatedGp8Sets: ['Trombone-Solo', 'Trombone-Ensemble'] }),
  pitched({ id: 'orch-french-horn', subCategoryId: 'brass', subCategoryLabel: 'Brass', listLabel: 'French Horn', defaultName: 'French Horn', defaultShortName: 'hn.', defaultColor: '#e0be4a', program: 60, glyph: 'brass', clef: model.Clef.G2, curatedGp8Sets: ['FrenchHorn-Solo', 'FrenchHorn-Ensemble'] }),
  pitched({ id: 'orch-tuba', subCategoryId: 'brass', subCategoryLabel: 'Brass', listLabel: 'Tuba', defaultName: 'Tuba', defaultShortName: 'tba.', defaultColor: '#b88c28', program: 58, glyph: 'brass', clef: model.Clef.F4, curatedGp8Sets: ['BassTuba-Solo'] }),
  pitched({ id: 'orch-brass-sec', subCategoryId: 'brass', subCategoryLabel: 'Brass', listLabel: 'Brass Section', defaultName: 'Brass Section', defaultShortName: 'brs.', defaultColor: '#d4a635', program: 61, glyph: 'brass', clef: model.Clef.G2, curatedGp8Sets: ['Trumpet-Ensemble', 'Expressive-Brass', 'Modern-Brass'] }),
  // Vocals
  pitched({ id: 'orch-voice', subCategoryId: 'vocals', subCategoryLabel: 'Vocals', listLabel: 'Voice', defaultName: 'Vocals', defaultShortName: 'voc.', defaultColor: '#d96ca8', program: 53, glyph: 'vocal', clef: model.Clef.G2, curatedGp8Sets: ['Vocal-Pad', 'MetaChoir-Pad'] }),
  pitched({ id: 'orch-choir', subCategoryId: 'vocals', subCategoryLabel: 'Vocals', listLabel: 'Choir', defaultName: 'Choir', defaultShortName: 'chr.', defaultColor: '#c95b98', program: 52, glyph: 'vocal', clef: model.Clef.G2, curatedGp8Sets: ['MetaChoir-Pad', 'Vocal-Pad'] }),
  // Synths
  pitched({ id: 'orch-synth-lead', subCategoryId: 'synths', subCategoryLabel: 'Synths', listLabel: 'Synth Lead', defaultName: 'Synth Lead', defaultShortName: 'lead', defaultColor: '#40b3c9', program: 80, glyph: 'keys', clef: model.Clef.G2, curatedGp8Sets: ['Classic-Lead', 'Dist-Lead', 'Brassy-Lead', 'Dave-Lead'] }),
  pitched({ id: 'orch-synth-pad', subCategoryId: 'synths', subCategoryLabel: 'Synths', listLabel: 'Synth Pad', defaultName: 'Synth Pad', defaultShortName: 'pad', defaultColor: '#6488ea', program: 89, glyph: 'keys', clef: model.Clef.G2, curatedGp8Sets: ['Warm-Pad', 'Lush-Pad', 'OBStrings-Pad'] }),
  pitched({ id: 'orch-synth-fx', subCategoryId: 'synths', subCategoryLabel: 'Synths', listLabel: 'Synth FX', defaultName: 'Synth FX', defaultShortName: 'fx', defaultColor: '#5580c9', program: 96, glyph: 'keys', clef: model.Clef.G2, curatedGp8Sets: ['Harpy-Seq', 'Complex-Pad'] }),
  // Pitched Percussion
  pitched({ id: 'orch-vibraphone', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Vibraphone', defaultName: 'Vibraphone', defaultShortName: 'vib.', defaultColor: '#8cb352', program: 11, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Vibraphone-Tuned'] }),
  pitched({ id: 'orch-marimba', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Marimba', defaultName: 'Marimba', defaultShortName: 'mrmb.', defaultColor: '#7fa648', program: 12, glyph: 'note', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['Xylophone-Tuned', 'Vibraphone-Tuned'] }),
  pitched({ id: 'orch-xylophone', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Xylophone', defaultName: 'Xylophone', defaultShortName: 'xyl.', defaultColor: '#96bd5b', program: 13, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Xylophone-Tuned'] }),
  pitched({ id: 'orch-glock', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Glockenspiel', defaultName: 'Glockenspiel', defaultShortName: 'glk.', defaultColor: '#a0c462', program: 9, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Celesta-Tuned', 'Vibraphone-Tuned'] }),
  pitched({ id: 'orch-celesta', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Celesta', defaultName: 'Celesta', defaultShortName: 'cel.', defaultColor: '#739940', program: 8, glyph: 'keys', grandStaff: true, clef: model.Clef.G2, lowerClef: model.Clef.F4, curatedGp8Sets: ['Celesta-Tuned'] }),
  pitched({ id: 'orch-timpani', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Timpani', defaultName: 'Timpani', defaultShortName: 'timp.', defaultColor: '#658c38', program: 47, glyph: 'drums', clef: model.Clef.F4, curatedGp8Sets: ['TimpaniLo-Tuned', 'TimpaniHi-Tuned'] }),
  pitched({ id: 'orch-tubular-bells', subCategoryId: 'pitched-perc', subCategoryLabel: 'Pitched Percussion', listLabel: 'Tubular Bells', defaultName: 'Tubular Bells', defaultShortName: 'bells', defaultColor: '#82a84d', program: 14, glyph: 'note', clef: model.Clef.G2, curatedGp8Sets: ['Vibraphone-Tuned'] }),
];

const DRUMS_TEMPLATES: readonly TrackTemplate[] = [
  percussion({ id: 'drums-kit', subCategoryId: 'drums', subCategoryLabel: 'Drums', listLabel: 'Drumkit', defaultName: 'Drums', defaultShortName: 'dr.', defaultColor: '#7d8a99', curatedGp8Sets: ['Drumkit-Custom', 'Drumkit-Master', 'Drumkit-Fab'] }),
  percussion({ id: 'drums-room', subCategoryId: 'drums', subCategoryLabel: 'Drums', listLabel: 'Room Kit', defaultName: 'Room Drums', defaultShortName: 'dr.', defaultColor: '#728296', drumKit: 8, curatedGp8Sets: ['Drumkit-Oak', 'Drumkit-Master'] }),
  percussion({ id: 'drums-jazz', subCategoryId: 'drums', subCategoryLabel: 'Drums', listLabel: 'Jazz Kit', defaultName: 'Jazz Drums', defaultShortName: 'dr.', defaultColor: '#6b7c93', drumKit: 32, curatedGp8Sets: ['Drumkit-Vintage', 'Drumkit-Star'] }),
  percussion({ id: 'drums-brush', subCategoryId: 'drums', subCategoryLabel: 'Drums', listLabel: 'Brush Kit', defaultName: 'Brush Drums', defaultShortName: 'dr.', defaultColor: '#8792a1', drumKit: 40, curatedGp8Sets: ['Drumkit-Vintage'] }),
  percussion({ id: 'drums-percussion', subCategoryId: 'percussions', subCategoryLabel: 'Percussions', listLabel: 'Percussion', defaultName: 'Percussion', defaultShortName: 'perc.', defaultColor: '#8f7e6a', curatedGp8Sets: ['Kit-Percu', 'Kit-Latino', 'Kit-Samba', 'Kit-Africa'] }),
];

const GM_FAMILIES: ReadonlyArray<{ id: string; label: string; color: string; start: number }> = [
  { id: 'gm-piano', label: 'Piano', color: '#48a868', start: 0 },
  { id: 'gm-chromatic', label: 'Chromatic Percussion', color: '#8cb352', start: 8 },
  { id: 'gm-organ', label: 'Organ', color: '#66a352', start: 16 },
  { id: 'gm-guitar', label: 'Guitar', color: '#d9534f', start: 24 },
  { id: 'gm-bass', label: 'Bass', color: '#3d7ac7', start: 32 },
  { id: 'gm-strings', label: 'Strings', color: '#c9883b', start: 40 },
  { id: 'gm-ensemble', label: 'Ensemble', color: '#d49a4a', start: 48 },
  { id: 'gm-brass', label: 'Brass', color: '#d9ae38', start: 56 },
  { id: 'gm-reed', label: 'Reed', color: '#a86aad', start: 64 },
  { id: 'gm-pipe', label: 'Pipe', color: '#8d65c7', start: 72 },
  { id: 'gm-synth-lead', label: 'Synth Lead', color: '#40b3c9', start: 80 },
  { id: 'gm-synth-pad', label: 'Synth Pad', color: '#6488ea', start: 88 },
  { id: 'gm-synth-fx', label: 'Synth Effects', color: '#5580c9', start: 96 },
  { id: 'gm-ethnic', label: 'Ethnic', color: '#c97b54', start: 104 },
  { id: 'gm-percussive', label: 'Percussive', color: '#8f7e6a', start: 112 },
  { id: 'gm-sfx', label: 'Sound Effects', color: '#7d8a99', start: 120 },
];

function gmShortName(name: string): string {
  const clean = name.replace(/\s*\([^)]*\)/g, '').trim();
  const words = clean.split(/\s+/);
  if (words.length === 1) return `${clean.slice(0, 4).toLowerCase()}.`;
  return `${words[0].slice(0, 3).toLowerCase()}.${words[1].slice(0, 3).toLowerCase()}.`;
}

function gmTemplate(family: typeof GM_FAMILIES[number], program: number): TrackTemplate {
  const label = midiPrograms[program];
  const shortName = gmShortName(label);
  if (program >= 24 && program <= 31) {
    return {
      id: `midi-${program}`,
      category: 'midi',
      subCategoryId: family.id,
      subCategoryLabel: family.label,
      listLabel: `${program + 1}. ${label}`,
      defaultName: label,
      defaultShortName: shortName,
      defaultColor: family.color,
      kind: 'stringed',
      glyph: 'guitar',
      program,
      presetId: program === 29 ? 'crunch' : program === 30 ? 'lead' : program >= 26 && program <= 28 ? 'clean' : 'gm',
      showTab: true,
      showNotation: true,
      showSlash: false,
      grandStaff: false,
      instrument: 'guitar',
      tuningId: 'guitar-6-standard-e',
      lowerInstrument: 'guitar',
      lowerTuningId: 'guitar-6-standard-e',
    };
  }
  if (program >= 32 && program <= 39) {
    return {
      id: `midi-${program}`,
      category: 'midi',
      subCategoryId: family.id,
      subCategoryLabel: family.label,
      listLabel: `${program + 1}. ${label}`,
      defaultName: label,
      defaultShortName: shortName,
      defaultColor: family.color,
      kind: 'stringed',
      glyph: 'bass',
      program,
      presetId: program >= 33 && program <= 37 ? 'bass' : 'gm',
      showTab: true,
      showNotation: true,
      showSlash: false,
      grandStaff: false,
      instrument: 'bass',
      tuningId: 'bass-4-standard-e',
      lowerInstrument: 'bass',
      lowerTuningId: 'bass-4-standard-e',
    };
  }
  if (program === 105 || program === 106) {
    const inst: PresetInstrument = program === 105 ? 'banjo' : 'shamisen';
    const tuningId = program === 105 ? 'banjo-5-open-g' : 'shamisen-3-honchoshi';
    return {
      id: `midi-${program}`,
      category: 'midi',
      subCategoryId: family.id,
      subCategoryLabel: family.label,
      listLabel: `${program + 1}. ${label}`,
      defaultName: label,
      defaultShortName: shortName,
      defaultColor: family.color,
      kind: 'stringed',
      glyph: 'ukulele',
      program,
      showTab: true,
      showNotation: true,
      showSlash: false,
      grandStaff: false,
      instrument: inst,
      tuningId,
      lowerInstrument: inst,
      lowerTuningId: tuningId,
    };
  }
  const grand = (program >= 0 && program <= 6) || program === 8 || program === 12 || (program >= 16 && program <= 21) || program === 46;
  const bassClef = [42, 43, 47, 57, 58, 67, 70].includes(program);
  const glyph: TemplateGlyph = program <= 23 || (program >= 80 && program <= 95) ? 'keys' : program >= 40 && program <= 51 ? 'strings' : program >= 56 && program <= 63 ? 'brass' : program >= 52 && program <= 54 ? 'vocal' : 'note';
  return {
    id: `midi-${program}`,
    category: 'midi',
    subCategoryId: family.id,
    subCategoryLabel: family.label,
    listLabel: `${program + 1}. ${label}`,
    defaultName: label,
    defaultShortName: shortName,
    defaultColor: family.color,
    kind: 'pitched',
    glyph,
    program,
    showTab: false,
    showNotation: true,
    showSlash: false,
    grandStaff: grand,
    clef: program === 41 ? model.Clef.C3 : bassClef ? model.Clef.F4 : model.Clef.G2,
    lowerClef: model.Clef.F4,
  };
}

const MIDI_TEMPLATES: readonly TrackTemplate[] = [
  ...GM_FAMILIES.flatMap(family => Array.from({ length: 8 }, (_, offset) => gmTemplate(family, family.start + offset))),
  { id: 'midi-perc-std', category: 'midi', subCategoryId: 'gm-drums-ch10', subCategoryLabel: 'Percussion (Ch. 10)', listLabel: 'Standard Kit', defaultName: 'Drums', defaultShortName: 'dr.', defaultColor: '#7d8a99', kind: 'percussion', glyph: 'drums', program: 0, showTab: false, showNotation: true, showSlash: false, grandStaff: false },
  { id: 'midi-perc-room', category: 'midi', subCategoryId: 'gm-drums-ch10', subCategoryLabel: 'Percussion (Ch. 10)', listLabel: 'Room Kit', defaultName: 'Room Drums', defaultShortName: 'dr.', defaultColor: '#728296', kind: 'percussion', glyph: 'drums', program: 0, drumKit: 8, showTab: false, showNotation: true, showSlash: false, grandStaff: false },
  { id: 'midi-perc-jazz', category: 'midi', subCategoryId: 'gm-drums-ch10', subCategoryLabel: 'Percussion (Ch. 10)', listLabel: 'Jazz Kit', defaultName: 'Jazz Drums', defaultShortName: 'dr.', defaultColor: '#6b7c93', kind: 'percussion', glyph: 'drums', program: 0, drumKit: 32, showTab: false, showNotation: true, showSlash: false, grandStaff: false },
  { id: 'midi-perc-brush', category: 'midi', subCategoryId: 'gm-drums-ch10', subCategoryLabel: 'Percussion (Ch. 10)', listLabel: 'Brush Kit', defaultName: 'Brush Drums', defaultShortName: 'dr.', defaultColor: '#8792a1', kind: 'percussion', glyph: 'drums', program: 0, drumKit: 40, showTab: false, showNotation: true, showSlash: false, grandStaff: false },
];

export const ALL_TRACK_TEMPLATES: readonly TrackTemplate[] = [
  ...STRINGED_TEMPLATES,
  ...ORCHESTRA_TEMPLATES,
  ...DRUMS_TEMPLATES,
  ...MIDI_TEMPLATES,
];

export function subCategoriesForCategory(category: TrackCategoryId): SubCategoryGroup[] {
  const groups: SubCategoryGroup[] = [];
  const byId = new Map<string, SubCategoryGroup>();
  for (const tpl of ALL_TRACK_TEMPLATES) {
    if (tpl.category !== category) continue;
    let group = byId.get(tpl.subCategoryId);
    if (!group) {
      group = { id: tpl.subCategoryId, label: tpl.subCategoryLabel, items: [] };
      byId.set(tpl.subCategoryId, group);
      groups.push(group);
    }
    group.items.push(tpl);
  }
  return groups;
}

export function defaultTemplate(): TrackTemplate {
  return STRINGED_TEMPLATES.find(t => t.id === 'str-el-overdrive') ?? STRINGED_TEMPLATES[0];
}

export function soundOptionsForTemplate(template: TrackTemplate, gp8Status: Gp8Status): SoundOption[] {
  const options: SoundOption[] = [];
  const seen = new Set<string>();
  const push = (option: SoundOption) => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    options.push(option);
  };

  const preset = template.presetId ?? 'gm';
  const kitPatch = template.kind === 'percussion' && template.drumKit !== undefined ? { drumKit: template.drumKit } : {};
  const makeTone = (voiceId: string | null, presetId: TrackSound['presetId'] = preset): TrackSound | undefined => {
    if (voiceId === null && presetId === 'gm' && template.drumKit === undefined) return undefined;
    return { ...soundPreset(presetId, voiceId), ...kitPatch };
  };

  if (template.category === 'midi' && template.kind !== 'percussion') {
    // MIDI category offers direct access to every GM program sound, defaulting to the selected program.
    push({ id: `gm-prog:${template.program}`, label: `${template.program + 1}. ${midiPrograms[template.program]}`, program: template.program, sound: makeTone(null, preset) });
    for (let p = 0; p < midiPrograms.length; p++) {
      if (p === template.program) continue;
      push({ id: `gm-prog:${p}`, label: `${p + 1}. ${midiPrograms[p]}`, program: p, sound: makeTone(null, 'gm') });
    }
    return options;
  }

  if (gp8Status.available) {
    const setsById = new Map(gp8Status.sets.map(s => [s.id, s]));
    const matchingKind = gp8Status.sets.filter(s => template.kind === 'percussion' ? s.isPercussion : !s.isPercussion);
    for (const setId of template.curatedGp8Sets ?? []) {
      const info = setsById.get(setId);
      if (!info) continue;
      push({ id: `gp8:${info.id}`, label: info.name, program: template.program, sound: makeTone(`gp8:${info.id}`, preset) });
    }
    if (options.length === 0) {
      // Automatic fallback when curated GP8 set ids weren't matched.
      push({ id: 'auto', label: template.listLabel, program: template.program, sound: makeTone(null, preset) });
    }
    for (const info of matchingKind) {
      push({ id: `gp8:${info.id}`, label: info.name, program: template.program, sound: makeTone(`gp8:${info.id}`, preset) });
    }
  } else {
    // Built-in tone / GM selection when GP8 soundbank isn't installed.
    if (template.subCategoryId === 'electric-guitar') {
      push({ id: `preset:${template.id}`, label: template.listLabel, program: template.program, sound: makeTone(null, preset) });
      for (const [id, label, prog, pId] of [
        ['tone:clean', 'Clean', 27, 'clean'],
        ['tone:overdrive', 'Overdrive', 29, 'crunch'],
        ['tone:distortion', 'Distortion', 30, 'lead'],
        ['tone:jazz', 'Jazz', 26, 'clean'],
      ] as const) {
        push({ id, label, program: prog, sound: makeTone(null, pId) });
      }
    } else if (template.kind === 'percussion') {
      push({ id: `kit:${template.drumKit ?? 0}`, label: template.listLabel, program: 0, sound: makeTone(null, 'gm') });
      for (const [id, label, kit] of [
        ['kit:0', 'Drumkit (Standard)', undefined],
        ['kit:8', 'Room Kit', 8],
        ['kit:32', 'Jazz Kit', 32],
        ['kit:40', 'Brush Kit', 40],
      ] as const) {
        push({ id, label, program: 0, sound: kit !== undefined ? { ...soundPreset('gm', null), drumKit: kit } : undefined });
      }
    } else {
      push({ id: 'default', label: template.listLabel, program: template.program, sound: makeTone(null, preset) });
    }
  }

  push({ id: 'gm', label: `${template.program + 1}. ${midiPrograms[template.program]} (MIDI)`, program: template.program, sound: template.drumKit !== undefined ? { ...soundPreset('gm', 'gm'), drumKit: template.drumKit } : soundPreset('gm', 'gm') });
  return options;
}
