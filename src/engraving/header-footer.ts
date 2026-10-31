import type { model } from '@coderline/alphatab';

export interface PageBand {left:string;center:string;right:string}
export interface PageBands {header:PageBand;footer:PageBand}
/** GP8 stylesheet header/footer: separate bands for the first page and the other pages. */
export interface HeaderFooter {first:PageBands;other:PageBands}
export const scoreFieldNames=['TITLE','SUBTITLE','ARTIST','ALBUM','WORDS','MUSIC','COPYRIGHT','TABBER','INSTRUCTIONS','NOTICES'] as const;
export type HeaderFields=Record<typeof scoreFieldNames[number],string>;
const fieldNames=new Set<string>([...scoreFieldNames,'PAGE','PAGES']);
const slots=['left','center','right'] as const;

/** Reproduces the established page: the title top left and "page / pages" centered at the foot. */
export const defaultHeaderFooter=():HeaderFooter=>{
  const bands=():PageBands=>({header:{left:'%TITLE%',center:'',right:''},footer:{left:'',center:'%PAGE% / %PAGES%',right:''}});
  return {first:bands(),other:bands()};
};

export function headerFieldsOf(score:model.Score):HeaderFields {
  return {TITLE:score.title,SUBTITLE:score.subTitle,ARTIST:score.artist,ALBUM:score.album,WORDS:score.words,MUSIC:score.music,COPYRIGHT:score.copyright,TABBER:score.tab,INSTRUCTIONS:score.instructions,NOTICES:score.notices};
}

const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const tokens=/%%|%([^%]*)%|%/g;

export function validateHeaderFooter(value:unknown):asserts value is HeaderFooter {
  if(!exact(value,['first','other']))throw new Error('Invalid header and footer fields.');
  for(const [page,pageName] of [['first','First page'],['other','Other pages']] as const) {
    const bands=value[page];
    if(!exact(bands,['header','footer']))throw new Error('Invalid header and footer fields.');
    for(const band of ['header','footer'] as const) {
      const texts=bands[band];
      if(!exact(texts,slots)||!slots.every(slot=>typeof texts[slot]==='string'))throw new Error('Invalid header and footer fields.');
      for(const slot of slots) {
        const text=texts[slot] as string,where=`${pageName} ${band} ${slot}`;
        if([...text].length>200)throw new Error(`${where}: use at most 200 characters.`);
        if(/[\u0000-\u001f\u007f-\u009f]/.test(text))throw new Error(`${where}: use a single line of text.`);
        if(/[\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))throw new Error(`${where}: remove characters that cannot be printed.`);
        for(const match of text.matchAll(tokens)) {
          if(match[0]==='%%')continue;
          if(match[1]===undefined)throw new Error(`${where}: Use %% for a percent sign or a field such as %TITLE%.`);
          if(!fieldNames.has(match[1]))throw new Error(`${where}: unknown field %${match[1]}%.`);
        }
      }
    }
  }
}

export function fillHeaderField(template:string,fields:HeaderFields,page:number,pages:number):string {
  return template.replace(tokens,(token,name:string|undefined)=>token==='%%'?'%':name==='PAGE'?String(page):name==='PAGES'?String(pages):fields[name as keyof HeaderFields]??token);
}
