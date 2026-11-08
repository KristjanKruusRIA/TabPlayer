import { defaultEngraving } from './projection';
import type { EngravingOverrides,EngravingTypography } from './types';
import { withTypography } from './typography';

/**
 * Built-in notation styles. A preset is a starting point for the Engraving form: loading one replaces the
 * stylesheet, notation and typography choices, never the system spacing, the fonts or the staff profiles, and nothing
 * reaches the document until Apply engraving.
 */
export interface NotationPreset {
  id:'classic'|'jazz'|'rock';name:string;description:string;
  stylesheet:Partial<EngravingOverrides['stylesheet']>;notation:Partial<EngravingOverrides['notation']>;typography:EngravingTypography;
}
export const notationPresets:readonly NotationPreset[]=[
  {id:'classic',name:'Classic',description:'Serif text, larger title, numbered first bar of each system, grouped staves.',
    stylesheet:{barNumbers:'firstSystem',brackets:'staves',multiRests:'on',chords:'top'},notation:{tabRhythm:'hidden',fingering:'score'},
    typography:{family:'serif',textScale:null,titleScale:1.25,tabScale:null}},
  {id:'jazz',name:'Jazz',description:'Larger serif text, chord names above and inline, every bar numbered, empty staves hidden.',
    stylesheet:{barNumbers:'all',chords:'both',multiRests:'on',hideEmptyStaves:true},notation:{tabRhythm:'hidden',fingering:'score'},
    typography:{family:'serif',textScale:1.15,titleScale:1.4,tabScale:null}},
  {id:'rock',name:'Rock',description:'Sans-serif text, larger fret numbers, beamed tab rhythm, extended bends and line effects.',
    stylesheet:{barNumbers:'all',chords:'inline',multiRests:'off',brackets:'similar'},notation:{tabRhythm:'beams',fingering:'score',extendBendArrows:true,extendLineEffects:true},
    typography:{family:'sans',textScale:null,titleScale:null,tabScale:1.15}},
];
/** `current` with the preset's choices; everything the preset does not name goes back to Source/default. */
export function presetApplied(preset:NotationPreset,current:EngravingOverrides):EngravingOverrides {
  const base=defaultEngraving();
  const loaded=withTypography({stylesheet:{...base.stylesheet,...preset.stylesheet},notation:{...base.notation,...preset.notation},systemSpacing:current.systemSpacing,profiles:structuredClone(current.profiles)},preset.typography);
  return current.fonts?{...loaded,fonts:structuredClone(current.fonts)}:loaded;
}
