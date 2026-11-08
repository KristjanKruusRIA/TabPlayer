import { NotationElement } from '@coderline/alphatab';

/** Which alphaTab element fonts each text role drives. Every one of the 36 `elementFonts` appears exactly once (a test enumerates them). */
export type ElementRole='titleBlock'|'chordNames'|'staffText'|'lyrics'|'trackNames'|'barNumbers'|'markers';
export const roleElements:Record<ElementRole,readonly NotationElement[]>={
  titleBlock:[NotationElement.ScoreTitle,NotationElement.ScoreSubTitle,NotationElement.ScoreArtist,NotationElement.ScoreAlbum,NotationElement.ScoreWords,NotationElement.ScoreMusic,NotationElement.ScoreWordsAndMusic,NotationElement.ScoreCopyright],
  chordNames:[NotationElement.EffectChordNames,NotationElement.ChordDiagrams,NotationElement.ChordDiagramFretboardNumbers],
  staffText:[NotationElement.EffectText,NotationElement.EffectDirections,NotationElement.EffectBeatTimer,NotationElement.EffectFingering,NotationElement.EffectCapo,NotationElement.EffectFreeTime,NotationElement.EffectTap,NotationElement.EffectPalmMute,NotationElement.EffectLetRing,NotationElement.EffectBeatBarre,NotationElement.EffectTripletFeel,NotationElement.EffectHarmonics,NotationElement.EffectPickSlide,NotationElement.EffectRasgueado,NotationElement.EffectWhammyBar,NotationElement.EffectHammerOnPullOffText,NotationElement.EffectSlideText,NotationElement.ScoreBendSlur,NotationElement.GuitarTuning],
  lyrics:[NotationElement.EffectLyrics],
  trackNames:[NotationElement.TrackNames],
  barNumbers:[NotationElement.BarNumber,NotationElement.RepeatCount],
  markers:[NotationElement.EffectMarker,NotationElement.EffectAlternateEndings],
};

/** The four fret and staff number fonts, which belong to the Tab numbers role. */
export const TAB_NUMBER_FONTS=['tablatureFont','graceFont','numberedNotationFont','numberedNotationGraceFont'] as const;
