// Pure SMuFL helpers shared by the music font loader and the Node coverage gate.
// Keep this module free of runtime imports (type-only imports are erased): scripts/font-coverage.test.mjs loads it with Node's type stripping.

import type { SmuflMetadata } from '@coderline/alphatab';

export interface SmuflGlyphBox {bBoxNE:readonly [number,number];bBoxSW:readonly [number,number]}
export interface SmuflMetadataLike {glyphBBoxes?:Readonly<Record<string,SmuflGlyphBox>>}

/** alphaTab names two tab clefs differently from SMuFL (`EngravingSettings.smuflNameToGlyphNameMapping`). Key: alphaTab name. */
export const ALPHATAB_GLYPH_ALIASES:Readonly<Record<string,string>>={FourStringTabClef:'4stringTabClef',SixStringTabClef:'6stringTabClef'};

/** The SMuFL name of a glyph key, so alphaTab's `FourStringTabClef` and SMuFL's `4stringTabClef` count as one symbol. */
export function canonicalGlyphName(name:string):string {
  return Object.hasOwn(ALPHATAB_GLYPH_ALIASES,name)?ALPHATAB_GLYPH_ALIASES[name]:name;
}

/** The SMuFL name of one `MusicFontSymbol` member name (alphaTab capitalises the first letter of the SMuFL name). */
export function smuflNameOfSymbol(symbol:string):string {
  return Object.hasOwn(ALPHATAB_GLYPH_ALIASES,symbol)?ALPHATAB_GLYPH_ALIASES[symbol]:symbol.charAt(0).toLowerCase()+symbol.slice(1);
}

function drawn(box:SmuflGlyphBox|undefined):boolean {
  return !!box&&[...box.bBoxNE,...box.bBoxSW].some(value=>value!==0);
}

/** Canonical names of every glyph alphaTab draws with Bravura: each name with a non-zero bbox (alphaTab skips a zero bbox). */
export function neededGlyphs(bravuraMetadata:SmuflMetadataLike):string[] {
  const names=new Set<string>();
  for(const [name,box] of Object.entries(bravuraMetadata.glyphBBoxes??{}))if(drawn(box))names.add(canonicalGlyphName(name));
  return [...names].sort();
}

/** The keys of `record` grouped by the symbol they name, so a SMuFL key and its alphaTab alias are found as one. */
function keysBySymbol(record:Readonly<Record<string,unknown>>|undefined):Map<string,string[]> {
  const index=new Map<string,string[]>();
  for(const key of Object.keys(record??{})){const name=canonicalGlyphName(key),list=index.get(name);if(list)list.push(key);else index.set(name,[key]);}
  return index;
}

/**
 * `chosen` with every glyph alphaTab draws and `chosen` lacks (no box, or an all-zero box that alphaTab skips) taken from `base` (Bravura):
 * its box and its anchors. A glyph keeps one key: any key the chosen font has for it is removed and Bravura's key is inserted (for example
 * `FourStringTabClef` where the font had `4stringTabClef`; alphaTab maps both names), so the two spellings never both appear. `substituted` lists the SMuFL names that were filled. Neither input is changed.
 */
export function mergeSmuflMetadata(chosen:SmuflMetadata,base:SmuflMetadata,needed:readonly string[]=neededGlyphs(base)):{metadata:SmuflMetadata;substituted:string[]} {
  const present=new Set(neededGlyphs(chosen)),baseBoxes=keysBySymbol(base.glyphBBoxes),baseAnchors=keysBySymbol(base.glyphsWithAnchors);
  const chosenBoxes=keysBySymbol(chosen.glyphBBoxes),chosenAnchors=keysBySymbol(chosen.glyphsWithAnchors);
  const boxes={...chosen.glyphBBoxes},anchors={...chosen.glyphsWithAnchors},substituted:string[]=[];
  for(const name of new Set(needed.map(canonicalGlyphName))){
    if(present.has(name))continue;
    const boxKey=baseBoxes.get(name)?.[0];if(boxKey===undefined)continue;
    for(const key of chosenBoxes.get(name)??[])delete boxes[key];
    boxes[boxKey]=base.glyphBBoxes![boxKey];
    const anchorKey=baseAnchors.get(name)?.[0];
    if(anchorKey!==undefined){
      for(const key of chosenAnchors.get(name)??[])delete anchors[key];
      anchors[anchorKey]=base.glyphsWithAnchors[anchorKey];
    }
    substituted.push(name);
  }
  return {metadata:{...chosen,glyphBBoxes:boxes,glyphsWithAnchors:anchors},substituted};
}
