import { EngravingSettings } from '@coderline/alphatab';
import type { SmuflMetadata } from '@coderline/alphatab';
import { faceFor,musicFonts,textFonts } from './font-catalog';
import type { MusicFontId,TextFace } from './font-catalog';
import { mergeSmuflMetadata } from './smufl';
import { effectiveStyle,FONT_ROLES,roleDefaultStyles } from './fonts';
import type { EngravingFonts } from './fonts';

/** One face registered under one family name. Role faces use the role font's alias; Noto Sans Regular also goes in under its real name. */
interface Registration {family:string;face:TextFace}
const key=({family,face}:Registration)=>`${family}|${face.file}`;

/**
 * Every face the chosen roles draw with: one per distinct weight and slant among the role's elements, plus the font's regular upright face, under the font's alias,
 * plus Noto Sans Regular under its real family, which the fallback chain starts with (P17). A role with no chosen font needs
 * nothing, and a face the font does not have (Noto Sans Mono italic) is never asked for.
 */
function registrations(fonts:EngravingFonts|undefined):Registration[] {
  const list=new Map<string,Registration>();
  for(const role of FONT_ROLES){
    const entry=fonts?.roles?.[role];if(!entry||entry.font===undefined)continue;
    const family=textFonts[entry.font].alias;
    for(const style of roleDefaultStyles(role)){
      const {bold,italic}=effectiveStyle({...entry,font:entry.font},style.bold,style.italic),face=faceFor(entry.font,bold,italic);
      if(face){const registration={family,face};list.set(key(registration),registration);}
    }
    // alphaTab measures `11px <alias>` at normal weight and slant, once per family for the session: the plain face must be there
    // even when every element of the role is bold or italic, or the width table would hold bold or italic widths.
    const upright=faceFor(entry.font,false,false);
    if(upright){const registration={family,face:upright};list.set(key(registration),registration);}
  }
  const regular=faceFor('notoSans',false,false);
  if(list.size&&regular){const registration={family:textFonts.notoSans.family,face:regular};list.set(key(registration),registration);}
  return [...list.values()];
}

/** The font files the chosen roles need, each once, in a stable order; empty when no role has a font. */
export function neededFaces(fonts:EngravingFonts|undefined):TextFace[] {
  const files=new Map<string,TextFace>();
  for(const {face} of registrations(fonts))if(!files.has(face.file))files.set(face.file,face);
  return [...files.values()];
}

const memo=new Map<string,Promise<void>>();
const loaded=new Set<string>();
function loadFace(registration:Registration):Promise<void> {
  const id=key(registration);
  let pending=memo.get(id);
  if(!pending){
    const {family,face}=registration;
    pending=(async()=>{
      const font=new FontFace(family,`url(/export-fonts/${face.file})`,{weight:face.bold?'700':'400',style:face.italic?'italic':'normal'});
      await font.load();
      document.fonts.add(font);loaded.add(id);
    })().catch(error=>{memo.delete(id);throw error;});
    memo.set(id,pending);
  }
  return pending;
}

/** Whether a chosen role still has a face to load. False means a render needs no wait, which is every document without role fonts. */
export function roleFacesPending(fonts:EngravingFonts|undefined):boolean {
  return registrations(fonts).some(registration=>!loaded.has(key(registration)));
}

/**
 * Loads the faces the chosen roles need, once per face. A failure clears that face's memo so the next call retries, and is
 * reported by file name instead of thrown: the render then goes on with the next face in the stack.
 */
export async function loadRoleFaces(fonts:EngravingFonts|undefined):Promise<{failed:string[]}> {
  const wanted=registrations(fonts);
  if(!wanted.length||typeof document==='undefined'||typeof FontFace==='undefined')return {failed:[]};
  const failed=new Set<string>();
  await Promise.all(wanted.map(registration=>loadFace(registration).catch(()=>{failed.add(registration.face.file);})));
  return {failed:[...failed]};
}

/** A music font ready for the screen: the CSS family stack, the merged SMuFL metadata (null for Bravura, alphaTab's own) and the symbols drawn from Bravura. */
export interface MusicFontData {id:MusicFontId;families:readonly string[];metadata:SmuflMetadata|null;substituted:string[]}

/** The app-owned alias the screen draws Bravura glyphs with when the chosen font lacks them (no digit token, unlike alphaTab's own `alphaTab<N>`). */
const BRAVURA_ALIAS='TabPlayer Bravura';
const bravuraData:MusicFontData={id:'bravura',families:[musicFonts.bravura.family],metadata:null,substituted:[]};
const musicMemo=new Map<MusicFontId,Promise<MusicFontData>>(),musicLoaded=new Map<MusicFontId,MusicFontData>();
let bravuraAlias:Promise<void>|undefined;

async function registerFace(family:string,file:string):Promise<void> {
  if(typeof document==='undefined'||typeof FontFace==='undefined')throw new Error('Fonts cannot be loaded here.');
  const font=new FontFace(family,`url(/export-fonts/${file})`);
  await font.load();document.fonts.add(font);
}
function loadBravuraAlias():Promise<void> {
  if(!bravuraAlias)bravuraAlias=registerFace(BRAVURA_ALIAS,musicFonts.bravura.file).catch(error=>{bravuraAlias=undefined;throw error;});
  return bravuraAlias;
}
async function readMetadata(file:string):Promise<SmuflMetadata> {
  const response=await fetch(`/export-fonts/${file}`);
  if(!response.ok)throw new Error(`Music font metadata ${file} could not be loaded.`);
  const value=await response.json() as Partial<SmuflMetadata>|null;
  if(!value||typeof value!=='object'||!value.engravingDefaults||typeof value.glyphsWithAnchors!=='object'||!value.glyphsWithAnchors)throw new Error(`Music font metadata ${file} is not SMuFL metadata.`);
  return value as SmuflMetadata;
}

/** The music font as already loaded, or null while it still has to be fetched. Bravura is always available. */
export function loadedMusicFont(id:MusicFontId):MusicFontData|null {
  return id==='bravura'?bravuraData:musicLoaded.get(id)??null;
}
/** Whether choosing this music font still needs a load: false for Bravura and for a font already loaded, so those renders stay synchronous. */
export function musicFontPending(id:MusicFontId):boolean {return loadedMusicFont(id)===null;}

/**
 * Loads a music font once: its SMuFL metadata, its face, and the Bravura alias face the screen falls back to for symbols the font lacks,
 * then merges the metadata against Bravura's so alphaTab never skips a glyph. A failure clears the memo so the next call retries.
 */
export function loadMusicFont(id:MusicFontId):Promise<MusicFontData> {
  if(id==='bravura')return Promise.resolve(bravuraData);
  let pending=musicMemo.get(id);
  if(!pending){
    const font=musicFonts[id];
    pending=(async()=>{
      const [chosen]=await Promise.all([readMetadata(font.metadata!),registerFace(font.family,font.file),loadBravuraAlias()]);
      const {metadata,substituted}=mergeSmuflMetadata(chosen,EngravingSettings.bravuraMetadata);
      const data:MusicFontData={id,families:[font.family,BRAVURA_ALIAS],metadata,substituted};
      musicLoaded.set(id,data);return data;
    })().catch(error=>{musicMemo.delete(id);throw error;});
    musicMemo.set(id,pending);
  }
  return pending;
}
