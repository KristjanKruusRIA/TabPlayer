import { model,Settings } from '@coderline/alphatab';
import { FALLBACK_FAMILIES,fontStack,hasFace,textFonts,musicFonts } from './font-catalog';
import type { MusicFontId,TextFontId } from './font-catalog';
import { roleElements,TAB_NUMBER_FONTS } from './role-elements';
import type { EngravingOverrides,EngravingTypography } from './types';
import { scaled,TAB_SCALE_RANGE,TEXT_SCALE_RANGE } from './typography';

export type { MusicFontId,TextFontId };
export { FALLBACK_FAMILIES,roleElements,TAB_NUMBER_FONTS };
export type FontRole='titleBlock'|'pageHeader'|'pageFooter'|'chordNames'|'staffText'|'lyrics'|'trackNames'|'barNumbers'|'markers'|'tabNumbers';
export const FONT_ROLES:readonly FontRole[]=['titleBlock','pageHeader','pageFooter','chordNames','staffText','lyrics','trackNames','barNumbers','markers','tabNumbers'];

/** One role's choices; an absent key keeps the element's own default. `bold` and `italic` need a chosen `font`. */
export interface RoleFont {font?:TextFontId;size?:number;bold?:boolean;italic?:boolean}
/** Absent `music` means Bravura; absent `roles` or a role means the role keeps today's look. The field is omitted whenever it is the default. */
export interface EngravingFonts {music?:MusicFontId;roles?:Partial<Record<FontRole,RoleFont>>}

const ROLE_KEYS:readonly (keyof RoleFont)[]=['font','size','bold','italic'];
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value:Record<string,unknown>,allowed:readonly string[],message:string)=>{if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error(message);};
const isTextFont=(value:unknown):value is TextFontId=>typeof value==='string'&&Object.hasOwn(textFonts,value);
const isMusicFont=(value:unknown):value is MusicFontId=>typeof value==='string'&&Object.hasOwn(musicFonts,value);
const isRole=(value:string):value is FontRole=>(FONT_ROLES as readonly string[]).includes(value);

/** The size range for a role, shared with the typography scales (tab numbers keep the narrower one). */
export function sizeRange(role:FontRole):{min:number;max:number} {
  const range=role==='tabNumbers'?TAB_SCALE_RANGE:TEXT_SCALE_RANGE;
  return {min:range.min,max:range.max};
}

function validateRole(role:FontRole,value:unknown):void {
  if(!isObject(value))throw new Error('Invalid role font.');
  exactKeys(value,ROLE_KEYS,'Unknown role font field.');
  if(Object.keys(value).length===0)throw new Error('A role font must set at least one field.');
  const {font,size,bold,italic}=value;
  if(Object.hasOwn(value,'font')&&!isTextFont(font))throw new Error('Unknown text font.');
  if(Object.hasOwn(value,'size')){
    const range=sizeRange(role);
    if(typeof size!=='number'||!Number.isFinite(size)||size<range.min||size>range.max)throw new Error(`Font size must be between ${range.min*100}% and ${range.max*100}%.`);
  }
  for(const flag of ['bold','italic'] as const)if(Object.hasOwn(value,flag)){
    if(typeof value[flag]!=='boolean')throw new Error(`Invalid ${flag} choice.`);
    if(!Object.hasOwn(value,'font'))throw new Error(`${flag==='bold'?'Bold':'Italic'} needs a chosen font.`);
  }
  if(isTextFont(font)&&!hasFace(font,bold===true,italic===true))throw new Error('This font has no such face.');
}

/** Throws unless `value` is a well-formed `EngravingFonts`. Rust refuses exactly the same inputs (tests/fixtures/engraving-fonts-cases.json). */
export function validateFonts(value:unknown):asserts value is EngravingFonts {
  if(!isObject(value))throw new Error('Invalid fonts.');
  exactKeys(value,['music','roles'],'Unknown fonts field.');
  if(Object.hasOwn(value,'music')&&!isMusicFont(value.music))throw new Error('Unknown music font.');
  if(Object.hasOwn(value,'roles')){
    const roles=value.roles;
    if(!isObject(roles))throw new Error('Invalid role fonts.');
    for(const key of Object.keys(roles)){if(!isRole(key))throw new Error('Unknown font role.');validateRole(key,roles[key]);}
  }
}

/** The fonts with every default made explicit; copies, so a caller can edit the result freely. */
export function fontsOf(engraving:Pick<EngravingOverrides,'fonts'>):{music:MusicFontId;roles:Partial<Record<FontRole,RoleFont>>} {
  const fonts=engraving.fonts,roles:Partial<Record<FontRole,RoleFont>>={};
  for(const role of FONT_ROLES){const entry=fonts?.roles?.[role];if(entry)roles[role]={...entry};}
  return {music:fonts?.music??'bravura',roles};
}

/** `fonts` reduced to what is actually chosen, or undefined when nothing is. Undefined keys, empty role entries and flags without a font vanish. */
function normalizeFonts(fonts:EngravingFonts|undefined):EngravingFonts|undefined {
  if(!fonts)return undefined;
  const roles:Partial<Record<FontRole,RoleFont>>={};
  for(const role of FONT_ROLES){
    const entry=fonts.roles?.[role];if(!entry)continue;
    const next:RoleFont={};
    if(entry.font!==undefined)next.font=entry.font;
    if(entry.size!==undefined)next.size=entry.size;
    // A flag only means something beside a font, and `false` is a choice (a role's element may be bold or italic by default).
    if(entry.font!==undefined){if(entry.bold!==undefined)next.bold=entry.bold;if(entry.italic!==undefined)next.italic=entry.italic;}
    if(Object.keys(next).length>0)roles[role]=next;
  }
  const result:EngravingFonts={};
  if(fonts.music!==undefined&&fonts.music!=='bravura')result.music=fonts.music;
  if(Object.keys(roles).length>0)result.roles=roles;
  return Object.keys(result).length>0?result:undefined;
}

export const isDefaultFonts=(fonts:EngravingFonts|undefined)=>normalizeFonts(fonts)===undefined;

/** `engraving` without the Page header and footer roles, which only style the page overlay and never change the notation (a render key must not see them). */
export function withoutPageFonts(engraving:EngravingOverrides):EngravingOverrides {
  const roles=engraving.fonts?.roles;
  if(!roles||(roles.pageHeader===undefined&&roles.pageFooter===undefined))return engraving;
  const {pageHeader:_header,pageFooter:_footer,...rest}=roles;void _header;void _footer;
  return withFonts(engraving,{...engraving.fonts,roles:rest});
}

/** `engraving` drawn with Bravura: the music font choice dropped, every role choice kept. It is what the screen falls back to when the chosen music font cannot be loaded. */
export function withoutMusicFont(engraving:EngravingOverrides):EngravingOverrides {
  const fonts=engraving.fonts;
  if(!fonts||fonts.music===undefined)return engraving;
  const {music:_music,...rest}=fonts;void _music;
  return withFonts(engraving,rest);
}

/** `engraving` carrying `fonts`, leaving the field out while it is the default so older documents and unchanged choices stay identical. */
export function withFonts(engraving:EngravingOverrides,fonts:EngravingFonts):EngravingOverrides {
  const {fonts:_dropped,...rest}=structuredClone(engraving);void _dropped;
  const next=normalizeFonts(fonts);
  return next?{...rest,fonts:structuredClone(next)}:rest;
}

/**
 * The weight and slant a chosen font draws an element with: the role's own flag when it has one, else the element's default.
 * A slant the font has no face for is dropped (Noto Sans Mono has no italic), because only bundled faces exist on both sides.
 */
export function effectiveStyle(entry:RoleFont&{font:TextFontId},defaultBold:boolean,defaultItalic:boolean):{bold:boolean;italic:boolean} {
  const bold=entry.bold??defaultBold,wanted=entry.italic??defaultItalic;
  return {bold,italic:wanted&&hasFace(entry.font,bold,true)};
}

/** The (bold, italic) each of a role's elements has before any role choice, one per distinct style. */
const defaultStyles=new Map<FontRole,Array<{bold:boolean;italic:boolean}>>();
export function roleDefaultStyles(role:FontRole):Array<{bold:boolean;italic:boolean}> {
  const cached=defaultStyles.get(role);if(cached)return cached.map(style=>({...style}));
  const resources=new Settings().display.resources;
  const fonts=role==='pageHeader'||role==='pageFooter'?[]:role==='tabNumbers'?TAB_NUMBER_FONTS.map(key=>resources[key]):roleElements[role].map(element=>resources.elementFonts.get(element)!);
  const found:Array<{bold:boolean;italic:boolean}>=[];
  // The page header and footer are TabPlayer's own text: regular and upright until the role says otherwise.
  for(const style of fonts.length?fonts.map(font=>({bold:font.isBold,italic:font.isItalic})):[{bold:false,italic:false}])if(!found.some(known=>known.bold===style.bold&&known.italic===style.italic))found.push(style);
  defaultStyles.set(role,found);
  return found.map(style=>({...style}));
}

const groupScale=(role:FontRole,typography:EngravingTypography)=>role==='tabNumbers'?typography.tabScale:role==='titleBlock'?typography.titleScale:typography.textScale;

/**
 * Applies the chosen text roles to alphaTab's element fonts. Call it after `configureTypography`, which rebuilds every
 * font from the renderer defaults: a role that is absent keeps that result, so a later call without fonts restores it.
 * A chosen font gets `[alias, ...FALLBACK_FAMILIES]`; a role size replaces the group scale and a size-only role keeps the
 * typography family and style.
 */
export function configureRoleFonts(settings:Settings,fonts:EngravingFonts|undefined,typography:EngravingTypography):void {
  const roles=fonts?.roles;if(!roles)return;
  const defaults=new Settings().display.resources,resources=settings.display.resources;
  const restyle=(current:model.Font,original:model.Font,entry:RoleFont):model.Font=>{
    const next=current.withSize(scaled(original.size,entry.size??null));
    if(entry.font===undefined)return next;
    const {bold,italic}=effectiveStyle({...entry,font:entry.font},original.isBold,original.isItalic);
    next.families=fontStack(textFonts[entry.font].alias);
    next.style=italic?model.FontStyle.Italic:model.FontStyle.Plain;next.weight=bold?model.FontWeight.Bold:model.FontWeight.Regular;
    return next;
  };
  // A role without its own size takes the group scale that configureTypography already applied.
  const sized=(current:model.Font,original:model.Font,role:FontRole,entry:RoleFont)=>restyle(current,original,{...entry,size:entry.size??groupScale(role,typography)??undefined});
  for(const role of FONT_ROLES){
    const entry=roles[role];if(!entry)continue;
    if(role==='tabNumbers')for(const key of TAB_NUMBER_FONTS)resources[key]=sized(resources[key],defaults[key],role,entry);
    else if(role!=='pageHeader'&&role!=='pageFooter')for(const element of roleElements[role]){
      const current=resources.elementFonts.get(element),original=defaults.elementFonts.get(element);
      if(current&&original)resources.elementFonts.set(element,sized(current,original,role,entry));
    }
  }
}

/** How the page header or footer text is drawn. `family` is the alias, or null for the default Noto stack; `scale` null means no role size. */
export interface PageRoleFont {family:string|null;bold:boolean;italic:boolean;scale:number|null}
export function pageRoleFont(fonts:EngravingFonts|undefined,role:'pageHeader'|'pageFooter'):PageRoleFont {
  const entry=fonts?.roles?.[role],scale=entry?.size??null;
  if(!entry||entry.font===undefined)return {family:null,bold:false,italic:false,scale};
  const {bold,italic}=effectiveStyle({...entry,font:entry.font},false,false);
  return {family:textFonts[entry.font].alias,bold,italic,scale};
}
