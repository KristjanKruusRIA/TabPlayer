import type { model } from '@coderline/alphatab';
import type { ExportSelection } from './types';

/** GP8 names an export after the score title unless the template is changed. */
export const DEFAULT_FILE_NAME='%T';
export const FILE_NAME_TOKENS='%T title, %t track name, %n track number, %N track count, %d date, %h time';
export interface FileNameContext { title:string;trackName:string;trackNumber:number;trackCount:number;now:Date }

const pad=(value:number)=>String(value).padStart(2,'0');
/** Windows device names, tested on the part before the first dot as the native check does. */
const RESERVED=/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
/** Path and control characters, plus invisible direction and format marks that can disguise a file type. */
// eslint-disable-next-line no-control-regex
const UNSAFE=/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
/** 200 UTF-8 bytes leaves room for an extension and page number within the usual 255-byte limit. */
const MAX_BYTES=200;
const encoder=new TextEncoder();
function clip(name:string){
  let bytes=0,kept='';
  for(const point of name){bytes+=encoder.encode(point).length;if(bytes>MAX_BYTES)break;kept+=point;}
  return kept.replace(/[\s.]+$/,'');
}

/** Expands GP8's tokens, then makes the name safe to save on Windows, macOS and Linux. */
export function expandFileName(template:string,{title,trackName,trackNumber,trackCount,now}:FileNameContext):string {
  const tokens:Record<string,string>={
    '%':'%',T:title.trim()||'Untitled',t:trackName.trim()||`Track ${trackNumber}`,n:String(trackNumber),N:String(trackCount),
    d:`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`,h:`${pad(now.getHours())}-${pad(now.getMinutes())}`,
  };
  const expanded=template.replace(/%(.)/gs,(match,token:string)=>tokens[token]??match);
  let name=clip(expanded.replace(UNSAFE,'-').replace(/^[\s.]+/,''));
  if(RESERVED.test(name.split('.')[0]))name=clip(`_${name}`);
  return name||'TabPlayer-export';
}

/** The saved name: the extension is appended unless the name already ends with it, as the native side does. */
export function withExtension(name:string,extension:string){
  return !extension||name.toLowerCase().endsWith(`.${extension}`)?name:`${name}.${extension}`;
}

/** Track tokens describe the first selected track; %N counts every track in the score. */
export function fileNameContext(score:model.Score,selection:ExportSelection,now:Date):FileNameContext {
  const index=Math.min(...selection.tracks),track=score.tracks[index];
  return {title:score.title,trackName:track?.name??'',trackNumber:index+1,trackCount:score.tracks.length,now};
}
