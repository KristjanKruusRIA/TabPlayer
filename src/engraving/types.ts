import type { HeaderFooter } from './header-footer';

export type InheritBool=boolean|null;
export type NamePolicy='inherit'|'hidden'|'firstSystem'|'allSystems';
export type TrackProfile='source'|'standard'|'tablature'|'standardTab'|'slash'|'numbered';

export type TextFamily='inherit'|'sans'|'serif'|'mono';
/** Text face and size scales (1 = the renderer's size, null = unchanged). Music symbols always use the bundled Bravura. */
export interface EngravingTypography {
  family:TextFamily;
  /** Staff text, chord names, track names, bar numbers and other annotations. */
  textScale:number|null;
  /** The score title block and copyright. */
  titleScale:number|null;
  /** Fret numbers, grace-note fret numbers and numbered-notation digits; these keep the default family. */
  tabScale:number|null;
}

export interface EngravingOverrides {
  stylesheet:{
    hideDynamics:InheritBool;
    brackets:'inherit'|'none'|'staves'|'similar';
    extendBarLines:InheritBool;systemSeparators:InheritBool;
    tuning:InheritBool;
    chords:'inherit'|'hidden'|'top'|'inline'|'both';
    singleNames:NamePolicy;multiNames:NamePolicy;
    firstNames:'inherit'|'full'|'short';otherNames:'inherit'|'full'|'short';
    firstNameDirection:'inherit'|'horizontal'|'vertical';
    otherNameDirection:'inherit'|'horizontal'|'vertical';
    barNumbers:'inherit'|'all'|'firstSystem'|'hidden';
    multiRests:'inherit'|'off'|'on';
    hideEmptyStaves:InheritBool;hideEmptyFirstSystem:InheritBool;
    singleStaffBrackets:InheritBool;
  };
  notation:{
    tabRhythm:'inherit'|'auto'|'hidden'|'beams'|'connected';
    fingering:'inherit'|'score'|'piano'|'above'|'abovePiano';
    smallGraceTab:InheritBool;extendBendArrows:InheritBool;
    extendLineEffects:InheritBool;parenthesizeTiedBends:InheritBool;
    showTiedBendNumbers:InheritBool;showDiveWhammyZeros:InheritBool;
  };
  systemSpacing:number|null;
  profiles:Array<{trackId:string;profile:TrackProfile}>;
  /** Absent means the default typography; documents saved before typography existed have no such field. */
  typography?:EngravingTypography;
}

export interface PageLayout {
  widthMm:number;heightMm:number;
  marginsMm:{top:number;right:number;bottom:number;left:number};
  scale:number;profile:'document'|'ScoreTab'|'Score'|'Tab';
  /** Absent means the established title header and page-number footer. */
  headerFooter?:HeaderFooter;
}

export type EngravingCommand=
  |{type:'setEngraving';engraving:EngravingOverrides}
  |{type:'setPageLayout';layout:PageLayout};
