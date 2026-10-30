import { Settings } from '@coderline/alphatab';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';

export type BatchKind='gp345'|'gpx'|'gp'|'musicxml';
/** The file types the dialog offers. `on` marks the legacy formats chosen by default. */
export const batchKinds:{id:BatchKind;label:string;on:boolean}[]=[
  {id:'gp345',label:'Guitar Pro 3, 4 and 5 (.gp3 .gp4 .gp5)',on:true},
  {id:'gpx',label:'Guitar Pro 6 (.gpx)',on:true},
  {id:'gp',label:'Guitar Pro 7 and 8 (.gp), written again in the current format',on:false},
  {id:'musicxml',label:'MusicXML (.xml .musicxml .mxl)',on:false},
];
export interface BatchEntry{index:number;relative:string;bytes:number}
export interface BatchSkip{relative:string;reason:string}
export interface BatchScan{files:BatchEntry[];skipped:BatchSkip[];truncated:boolean;totalBytes:number}
export interface BatchWritten{relative:string;renamed:boolean}
/** Native file access. The window never names a path: folders are picked natively and files are addressed by scan index. */
export interface BatchBridge{
  pickFolder(role:'source'|'destination'):Promise<string|null>;
  scan(kinds:BatchKind[]):Promise<BatchScan>;
  read(index:number):Promise<Uint8Array>;
  write(index:number,bytes:Uint8Array,keepFolders:boolean):Promise<BatchWritten>;
}
export type BatchStatus='Converted'|'Failed'|'Skipped'|'Not converted';
export interface BatchRow{relative:string;status:BatchStatus;detail:string}

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`;

/** Reads a legacy or MusicXML score and writes it in the current GP format, through the same code as opening and exporting. */
export function convertScoreBytes(bytes:Uint8Array):{bytes:Uint8Array;detail:string} {
  const settings=new Settings(),score=loadInterchangeScore(bytes,settings);
  if(!score.tracks.length||!score.masterBars.length)throw new Error('The file holds no music.');
  const output=exportGpInterchange(score,settings);
  // A file is reported converted only when the result reads back with the same shape.
  const check=loadInterchangeScore(output,new Settings());
  if(check.tracks.length!==score.tracks.length||check.masterBars.length!==score.masterBars.length)throw new Error('The converted file did not read back as the same score.');
  return {bytes:output,detail:`${plural(score.tracks.length,'track')}, ${plural(score.masterBars.length,'bar')}`};
}

const yieldToUi=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

/**
 * Converts the scanned files one at a time. A file that fails is reported and the next one follows.
 * `cancelled` is checked before each file, so a file under way always finishes; files not reached are reported.
 */
export async function runBatch(options:{bridge:BatchBridge;scan:BatchScan;keepFolders:boolean;cancelled:()=>boolean;onProgress:(done:number,total:number)=>void}):Promise<BatchRow[]> {
  const {bridge,scan,keepFolders,cancelled,onProgress}=options,rows:BatchRow[]=scan.skipped.map(skip=>({relative:skip.relative,status:'Skipped',detail:skip.reason}));
  for(const [position,file] of scan.files.entries()){
    if(cancelled()){rows.push(...scan.files.slice(position).map(rest=>({relative:rest.relative,status:'Not converted' as const,detail:'Cancelled before this file.'})));break;}
    onProgress(position,scan.files.length);await yieldToUi();
    try{
      const converted=convertScoreBytes(await bridge.read(file.index)),written=await bridge.write(file.index,converted.bytes,keepFolders);
      rows.push({relative:file.relative,status:'Converted',detail:`${converted.detail}. Saved as ${written.relative}${written.renamed?' because the name was taken':''}.`});
    }catch(error){rows.push({relative:file.relative,status:'Failed',detail:message(error)});}
  }
  onProgress(scan.files.length,scan.files.length);
  return rows.sort((a,b)=>a.relative.localeCompare(b.relative));
}

export function summarize(rows:BatchRow[],scan:BatchScan):string {
  const count=(status:BatchStatus)=>rows.filter(row=>row.status===status).length;
  const parts=[`${count('Converted')} converted`,`${count('Failed')} failed`];
  if(count('Skipped'))parts.push(`${count('Skipped')} skipped`);
  if(count('Not converted'))parts.push(`${count('Not converted')} not converted`);
  return `${parts.join(', ')}.${scan.truncated?' The folder holds more matching files than the limit allows, so run it again for the rest.':''}`;
}
