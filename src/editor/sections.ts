import type { model } from '@coderline/alphatab';

export interface SectionStart {bar:number;name:string}

/** Measures that start a named section, in score order; a blank label names nothing. */
export function listSections(score:model.Score):SectionStart[] {
  return score.masterBars.flatMap(master=>{const name=master.section?.text?.trim();return name?[{bar:master.index,name}]:[];});
}
/** Index of the section a measure is in, or -1 before the first one. */
export function sectionAt(sections:readonly SectionStart[],bar:number):number {
  let found=-1;sections.forEach((section,index)=>{if(section.bar<=bar)found=index;});return found;
}
/** The first measure of the nearest section before or after a measure, or null at either end. */
export function neighbourSection(sections:readonly SectionStart[],bar:number,direction:'previous'|'next'):number|null {
  if(direction==='next')return sections.find(section=>section.bar>bar)?.bar??null;
  return [...sections].reverse().find(section=>section.bar<bar)?.bar??null;
}
