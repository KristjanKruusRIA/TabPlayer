import { hasFace,textFonts,musicFonts } from './font-catalog';
import type { MusicFontId,TextFontId } from './font-catalog';
import type { EngravingOverrides } from './types';
import { TAB_SCALE_RANGE,TEXT_SCALE_RANGE } from './typography';

export type { MusicFontId,TextFontId };
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

/** `engraving` carrying `fonts`, leaving the field out while it is the default so older documents and unchanged choices stay identical. */
export function withFonts(engraving:EngravingOverrides,fonts:EngravingFonts):EngravingOverrides {
  const {fonts:_dropped,...rest}=structuredClone(engraving);void _dropped;
  const next=normalizeFonts(fonts);
  return next?{...rest,fonts:structuredClone(next)}:rest;
}
