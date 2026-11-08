// Bundled fonts for the D12 font roles. Keep this file erasable TypeScript (no enums, no parameter properties):
// scripts/font-coverage.test.mjs imports it directly through Node's type stripping.
import coverage from './font-coverage.json' with {type:'json'};

export type TextFontId='notoSans'|'notoSerif'|'notoSansMono';
export type MusicFontId='bravura'|'petaluma'|'leland';
export interface TextFace {file:string;bold:boolean;italic:boolean}
export interface TextFont {alias:string;family:string;label:string;faces:readonly TextFace[]}
export interface MusicFont {family:string;file:string;metadata:string|null}

export const textFonts:Record<TextFontId,TextFont>={
  notoSans:{alias:'TabPlayer Sans',family:'Noto Sans',label:'Noto Sans',faces:[
    {file:'NotoSans-Regular.ttf',bold:false,italic:false},{file:'NotoSans-Bold.ttf',bold:true,italic:false},
    {file:'NotoSans-Italic.ttf',bold:false,italic:true},{file:'NotoSans-BoldItalic.ttf',bold:true,italic:true}]},
  notoSerif:{alias:'TabPlayer Serif',family:'Noto Serif',label:'Noto Serif',faces:[
    {file:'NotoSerif-Regular.ttf',bold:false,italic:false},{file:'NotoSerif-Bold.ttf',bold:true,italic:false},
    {file:'NotoSerif-Italic.ttf',bold:false,italic:true},{file:'NotoSerif-BoldItalic.ttf',bold:true,italic:true}]},
  // Noto Sans Mono has no italic face upstream; italic is refused for it on both sides.
  notoSansMono:{alias:'TabPlayer Mono',family:'Noto Sans Mono',label:'Noto Sans Mono',faces:[
    {file:'NotoSansMono-Regular.ttf',bold:false,italic:false},{file:'NotoSansMono-Bold.ttf',bold:true,italic:false}]},
};

export const musicFonts:Record<MusicFontId,MusicFont>={
  bravura:{family:'Bravura',file:'Bravura.otf',metadata:null},
  petaluma:{family:'Petaluma',file:'Petaluma.otf',metadata:'petaluma_metadata.json'},
  leland:{family:'Leland',file:'Leland.otf',metadata:'leland_metadata.json'},
};

/** Bundled files that are export fallbacks, not choosable fonts (they have a `sources.json` entry but no catalog role). */
export const fallbackFiles:readonly string[]=['NotoSansCJKjp-Regular.otf','NotoEmoji.ttf'];

/** The faces every text stack falls back through, in order: the chosen face's own glyph gaps, CJK, then emoji. Real family names, never aliases. */
export const FALLBACK_FAMILIES=['Noto Sans','Noto Sans CJK JP','Noto Emoji'] as const;
/** A text font stack: the role's alias first (when a font is chosen), then the fallback faces. */
export const fontStack=(alias:string|null):string[]=>alias?[alias,...FALLBACK_FAMILIES]:[...FALLBACK_FAMILIES];

/** The one face of `font` with exactly this weight and slant, or undefined when it is not bundled. */
export function faceFor(font:TextFontId,bold:boolean,italic:boolean):TextFace|undefined {
  return textFonts[font].faces.find(face=>face.bold===bold&&face.italic===italic);
}

export function hasFace(font:TextFontId,bold:boolean,italic:boolean):boolean {
  return faceFor(font,bold,italic)!==undefined;
}

const ranges:Readonly<Record<string,ReadonlyArray<readonly [number,number]>>>=coverage as unknown as Record<string,ReadonlyArray<readonly [number,number]>>;

/** Whether the bundled text face `file` has a glyph for `codePoint` (from the generated `font-coverage.json`). */
export function covers(file:string,codePoint:number):boolean {
  const list=Object.hasOwn(ranges,file)?ranges[file]:undefined;
  if(!list)return false;
  let low=0,high=list.length-1;
  while(low<=high) {
    const middle=(low+high)>>1;
    if(codePoint<list[middle][0])high=middle-1;
    else if(codePoint>list[middle][1])low=middle+1;
    else return true;
  }
  return false;
}

/** A bundled font file as a person would name it ("Noto Serif Italic"); a file the catalog does not know keeps its file name. */
export function fileLabel(file:string):string {
  for(const font of Object.values(textFonts)){
    const face=font.faces.find(candidate=>candidate.file===file);
    if(face)return `${font.label} ${face.bold&&face.italic?'Bold Italic':face.bold?'Bold':face.italic?'Italic':'Regular'}`;
  }
  for(const font of Object.values(musicFonts))if(font.file===file||font.metadata===file)return font.family;
  return file;
}
