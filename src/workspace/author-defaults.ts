import { preferenceSaved,registerPreferenceGroup } from './native-preferences';

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
const readRecord=(record:Record<string,unknown>):AuthorDefaults=>Object.fromEntries(authorDefaultFields.map(field=>[field,typeof record[field]==='string'?clipAuthorText(record[field]):''])) as AuthorDefaults;
export function readAuthorDefaults(storage:PreferenceStorage|undefined=browserStorage()):AuthorDefaults {
  try{
    const value:unknown=JSON.parse(storage?.getItem(key)??'null');
    if(!value||typeof value!=='object'||Array.isArray(value))return {...emptyAuthorDefaults};
    return readRecord(value as Record<string,unknown>);
  }catch{return {...emptyAuthorDefaults};}
}
/** The defaults saved in this run; they still apply when storage refuses them. */
let session:AuthorDefaults|null=null;
export const newScoreDefaults=():AuthorDefaults=>session??readAuthorDefaults();
/** Test isolation only: forgets the defaults saved in this run. */
export const forgetSessionAuthorDefaults=()=>{session=null;};
const clipped=(defaults:AuthorDefaults):AuthorDefaults=>Object.fromEntries(authorDefaultFields.map(field=>[field,clipAuthorText(defaults[field])])) as AuthorDefaults;
function keepAuthorDefaults(value:AuthorDefaults,storage:PreferenceStorage|undefined):boolean {
  try{
    if(!storage)return false;
    storage.setItem(key,JSON.stringify(value));
    return true;
  }catch{return false;}
}
/** Returns false when storage refuses the write. */
export function writeAuthorDefaults(defaults:AuthorDefaults,storage:PreferenceStorage|undefined=browserStorage()):boolean {
  session=clipped(defaults);
  const kept=keepAuthorDefaults(session,storage);
  preferenceSaved('newScore',session,storage);
  return kept;
}
/** The browser copy is the first paint; the app's native settings keep it across a reset of the browser profile. `null` while nothing was ever saved. */
registerPreferenceGroup<AuthorDefaults>({name:'newScore',
  repair:value=>value&&typeof value==='object'&&!Array.isArray(value)?readRecord(value as Record<string,unknown>):null,
  browser:(storage=browserStorage())=>{try{const value:unknown=JSON.parse(storage?.getItem(key)??'null');return value&&typeof value==='object'&&!Array.isArray(value)?readRecord(value as Record<string,unknown>):null;}catch{return null;}},
  keep:(value,storage=browserStorage())=>{session=null;keepAuthorDefaults(clipped(value),storage);},
  same:(a,b)=>authorDefaultFields.every(field=>a[field]===b[field])});
