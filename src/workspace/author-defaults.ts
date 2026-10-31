/** Author details a new score starts with, like GP8's My info preferences; opened files keep their own. */
export const authorDefaultFields=['artist','words','music','tab','copyright'] as const;
export type AuthorDefaults=Record<typeof authorDefaultFields[number],string>;
export const emptyAuthorDefaults:AuthorDefaults=Object.freeze({artist:'',words:'',music:'',tab:'',copyright:''});
/** Matches the native limit for each default. */
export const authorDefaultsLimit=1000;
/** Cuts to the limit without splitting a character; lone surrogates would make the native call refuse every New. */
export function clipAuthorText(text:string):string {
  let clipped=text.slice(0,authorDefaultsLimit);if(/[\uD800-\uDBFF]$/.test(clipped))clipped=clipped.slice(0,-1);
  return clipped.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD');
}

const key='tabplayer.authorDefaults';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
export function readAuthorDefaults(storage:PreferenceStorage|undefined=browserStorage()):AuthorDefaults {
  try{
    const value:unknown=JSON.parse(storage?.getItem(key)??'null');
    if(!value||typeof value!=='object'||Array.isArray(value))return {...emptyAuthorDefaults};
    const record=value as Record<string,unknown>;
    return Object.fromEntries(authorDefaultFields.map(field=>[field,typeof record[field]==='string'?clipAuthorText(record[field]):''])) as AuthorDefaults;
  }catch{return {...emptyAuthorDefaults};}
}
/** The defaults saved in this run; they still apply when storage refuses them. */
let session:AuthorDefaults|null=null;
export const newScoreDefaults=():AuthorDefaults=>session??readAuthorDefaults();
/** Returns false when storage refuses the write. */
export function writeAuthorDefaults(defaults:AuthorDefaults,storage:PreferenceStorage|undefined=browserStorage()):boolean {
  session=Object.fromEntries(authorDefaultFields.map(field=>[field,clipAuthorText(defaults[field])])) as AuthorDefaults;
  try{
    if(!storage)return false;
    storage.setItem(key,JSON.stringify(session));
    return true;
  }catch{return false;}
}
