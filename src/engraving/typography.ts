import { NotationElement,Settings } from '@coderline/alphatab';
import type { EngravingOverrides,EngravingTypography,TextFamily } from './types';
import { roleElements,TAB_NUMBER_FONTS } from './role-elements';

/** The scale ranges Rust enforces too. Text and titles scale the renderer's own sizes; tab numbers stay inside the staff lines. */
export const TEXT_SCALE_RANGE={min:.5,max:2} as const;
export const TAB_SCALE_RANGE={min:.75,max:1.5} as const;

/** The only SMuFL music font shipped with the app. It is shown, not chosen: alphaTab draws every music symbol from it. */
export const MUSIC_FONT_NAME='Bravura';

export const textFamilies:ReadonlyArray<readonly [Exclude<TextFamily,'inherit'>,string]>=[['sans','Sans-serif'],['serif','Serif'],['mono','Monospace']];
/** Each stack ends in a generic family, so any glyph the named face lacks falls back to a system face rather than a blank box. */
const stacks:Record<Exclude<TextFamily,'inherit'>,string[]>={sans:['Arial','sans-serif'],serif:['Georgia','serif'],mono:['Consolas','Courier New','monospace']};

export const defaultTypography=():EngravingTypography=>({family:'inherit',textScale:null,titleScale:null,tabScale:null});
export const typographyOf=(engraving:Pick<EngravingOverrides,'typography'>):EngravingTypography=>({...defaultTypography(),...engraving.typography});
export const isDefaultTypography=(typography:EngravingTypography)=>typography.family==='inherit'&&typography.textScale===null&&typography.titleScale===null&&typography.tabScale===null;
/** `engraving` carrying `typography`, leaving the field out while it is the default so documents saved before typography stay identical. */
export function withTypography(engraving:EngravingOverrides,typography:EngravingTypography):EngravingOverrides {
  const {typography:_dropped,...rest}=structuredClone(engraving);void _dropped;
  return isDefaultTypography(typography)?rest:{...rest,typography:{...typography}};
}

const inRange=(value:unknown,range:{min:number;max:number})=>value===null||(typeof value==='number'&&Number.isFinite(value)&&value>=range.min&&value<=range.max);
export function validateTypography(value:unknown):asserts value is EngravingTypography {
  const keys=Object.keys(defaultTypography());
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid typography fields.');
  const typography=value as Record<string,unknown>;
  if(typeof typography.family!=='string'||!['inherit',...textFamilies.map(([id])=>id)].includes(typography.family))throw new Error('Invalid typography font.');
  if(!inRange(typography.textScale,TEXT_SCALE_RANGE)||!inRange(typography.titleScale,TEXT_SCALE_RANGE))throw new Error('Text sizes must be between 50% and 200%.');
  if(!inRange(typography.tabScale,TAB_SCALE_RANGE))throw new Error('Tab number size must be between 75% and 150%.');
}

const titleElements=new Set<NotationElement>(roleElements.titleBlock);
/** `size` times `scale` (null is 1), rounded to a tenth of a pixel. */
export const scaled=(size:number,scale:number|null)=>Math.round(size*(scale??1)*10)/10;
/**
 * Rebuilds every text font from the renderer defaults, then applies `typography`. Always starting from the defaults
 * means a reused Settings never keeps a previous choice. Layout measures the final fonts and spaces the notation to
 * match; only export checks that text stays inside the page (see `assertTextFits`).
 */
export function configureTypography(settings:Settings,typography:EngravingTypography):void {
  validateTypography(typography);
  const defaults=new Settings().display.resources,resources=settings.display.resources;
  const families=typography.family==='inherit'?null:stacks[typography.family];
  for(const [element,font] of defaults.elementFonts){
    const next=font.withSize(scaled(font.size,titleElements.has(element)?typography.titleScale:typography.textScale));
    if(families)next.families=[...families];
    resources.elementFonts.set(element,next);
  }
  // Fret and staff numbers keep the default family: the chosen family may have old-style digits that sit unevenly on the lines.
  for(const key of TAB_NUMBER_FONTS)resources[key]=defaults[key].withSize(scaled(defaults[key].size,typography.tabScale));
}

/** The smallest tab digit, in screen pixels, that stays legible. */
export const MIN_TAB_DIGIT_PX=7.5;
/** Measured in the app (THE-56): the smallest drawn tab digit is 12 px tall at 100% zoom with the default 14 px tablature font. */
export const MIN_DIGIT_HEIGHT_RATIO=12/14;
/**
 * The lowest zoom percent at which the smallest tab digit is still `MIN_TAB_DIGIT_PX` tall, from the tablature font
 * size the renderer uses (its default scaled by the Tab numbers scale). A larger tab font gives a lower floor.
 * Kept within the 25 to 100 percent zoom range.
 */
export function tabDigitFloorPercent(tabScale:number|null):number {
  const digitAt100=scaled(new Settings().display.resources.tablatureFont.size,tabScale)*MIN_DIGIT_HEIGHT_RATIO;
  return Math.min(100,Math.max(25,Math.ceil(100*MIN_TAB_DIGIT_PX/digitAt100)));
}
