import { Settings } from '@coderline/alphatab';
import type { MessageKey } from '../i18n';
import { READ_ENTRY_LIMIT } from '../interchange/archive';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import { gpLosses } from '../interchange/gp-losses';
import { probeScoreBytes,type Probe } from './probe';

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
export interface BatchWritten{relative:string;renamed:boolean;note?:string|null}
/** Native file access. The window never names a path: folders are picked natively and files are addressed by scan index. */
export interface BatchBridge{
  pickFolder(role:'source'|'destination'):Promise<string|null>;
  scan(kinds:BatchKind[]):Promise<BatchScan>;
  read(index:number):Promise<Uint8Array>;
  write(index:number,bytes:Uint8Array,keepFolders:boolean):Promise<BatchWritten>;
  /** Forgets the picked folders and the scan, as when the dialog closes. */
  reset():Promise<void>;
}
export type BatchStatus='Converted'|'Failed'|'Skipped'|'Not converted';
export type BatchDetail=
  |{code:'converted';tracks:number;bars:number;savedAs:string;renamed:boolean;losses:string[];note?:string|null}
  |{code:'cancelled'}
  |{code:'skipped';reason:string}
  |{code:'failed';message:string};
export interface BatchRow{relative:string;status:BatchStatus;detail:BatchDetail}

/** Said whenever a limit left files out: a rerun would redo the same first files, so the user must narrow the choice. */
export const TRUNCATED_NOTE='The folder holds more than one run can convert, so some files are not listed. Choose a subfolder, or fewer file types, to convert the rest.';
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`;

/** The window parses under the cap the probe read with, so a file cannot pass one and overrun the other. */
const readSettings=()=>{const settings=new Settings();settings.importer.maxDecodingBufferSize=READ_ENTRY_LIMIT;return settings;};

/** Reads a legacy or MusicXML score and writes it in the current GP format, through the same code as opening and exporting. */
export function convertScoreBytes(bytes:Uint8Array):{bytes:Uint8Array;tracks:number;bars:number;losses:string[];detail:string} {
  const settings=readSettings(),score=loadInterchangeScore(bytes,settings);
  if(!score.tracks.length||!score.masterBars.length)throw new Error('The file holds no music.');
  // Writing and reading back are held to what Open accepts, not the input's cap: a dense score of a few MiB writes a
  // larger uncompressed score.gpif and is not a damaged file.
  const losses=gpLosses(score),output=exportGpInterchange(score,new Settings());
  // A file is reported converted only when the result reads back with the same shape.
  const check=loadInterchangeScore(output,new Settings());
  if(check.tracks.length!==score.tracks.length||check.masterBars.length!==score.masterBars.length)throw new Error('The converted file did not read back as the same score.');
  return {bytes:output,tracks:score.tracks.length,bars:score.masterBars.length,losses,detail:`${plural(score.tracks.length,'track')}, ${plural(score.masterBars.length,'bar')}${losses.length?`; left out of the Guitar Pro file: ${losses.slice(0,3).join('; ')}${losses.length>3?`; and ${losses.length-3} more`:''}`:''}`};
}

export function formatBatchDetail(detail:BatchDetail|string,t:(key:MessageKey,params?:Record<string,string|number>)=>string):string {
  if(typeof detail==='string')return detail;
  switch(detail.code){
    case 'cancelled':
      return t('batch.detail_cancelled');
    case 'skipped':
      return detail.reason;
    case 'failed':
      return detail.message;
    case 'converted':{
      const trackPart=t(detail.tracks===1?'batch.track_count_one':'batch.track_count_other',{count:detail.tracks});
      const barPart=t(detail.bars===1?'batch.bar_count_one':'batch.bar_count_other',{count:detail.bars});
      let scoreClause=`${trackPart}, ${barPart}`;
      if(detail.losses&&detail.losses.length>0){
        scoreClause+=`; ${t('batch.detail_losses',{losses:detail.losses.slice(0,3).join('; ')})}`;
        if(detail.losses.length>3){
          scoreClause+=`; ${t('batch.detail_losses_more',{count:detail.losses.length-3})}`;
        }
      }
      let savedClause=t('batch.detail_saved_as',{path:detail.savedAs});
      if(detail.renamed){
        savedClause+=` ${t('batch.detail_name_taken')}`;
      }
      savedClause+='.';
      return `${scoreClause}. ${savedClause}${detail.note?` ${detail.note}`:''}`;
    }
  }
}

const yieldToUi=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

/**
 * Converts the scanned files one at a time. A file that fails is reported and the next one follows.
 * `cancelled` is checked before each file, so a file under way always finishes; files not reached are reported.
 */
export async function runBatch(options:{bridge:BatchBridge;scan:BatchScan;keepFolders:boolean;cancelled:()=>boolean;onProgress:(done:number,total:number)=>void;probe?:Probe;signal?:AbortSignal}):Promise<BatchRow[]> {
  const {bridge,scan,keepFolders,cancelled,onProgress,signal,probe=probeScoreBytes}=options,rows:BatchRow[]=scan.skipped.map(skip=>({relative:skip.relative,status:'Skipped',detail:{code:'skipped',reason:skip.reason}}));
  for(const [position,file] of scan.files.entries()){
    if(cancelled()){rows.push(...scan.files.slice(position).map(rest=>({relative:rest.relative,status:'Not converted' as const,detail:{code:'cancelled' as const}})));break;}
    onProgress(position,scan.files.length);await yieldToUi();
    try{
      const original=await bridge.read(file.index),checked=await probe(original,{signal});
      // A check ended by Cancel is not a failure of the file.
      if(!checked.ok&&cancelled()){rows.push(...scan.files.slice(position).map(rest=>({relative:rest.relative,status:'Not converted' as const,detail:{code:'cancelled' as const}})));break;}
      // The importer can spin or exhaust memory on a damaged file, so it only runs on this thread once a Worker has read the file.
      if(!checked.ok)throw new Error(checked.error);
      const converted=convertScoreBytes(original),written=await bridge.write(file.index,converted.bytes,keepFolders);
      rows.push({relative:file.relative,status:'Converted',detail:{code:'converted',tracks:converted.tracks,bars:converted.bars,savedAs:written.relative,renamed:written.renamed,losses:converted.losses,note:written.note}});
    }catch(error){rows.push({relative:file.relative,status:'Failed',detail:{code:'failed',message:message(error)}});}
  }
  onProgress(scan.files.length,scan.files.length);
  return rows.sort((a,b)=>a.relative.localeCompare(b.relative));
}

/** How many rows ended in each state. The dialog words these in the chosen language; `summarize` is the English form. */
export function batchCounts(rows:BatchRow[]):{converted:number;failed:number;skipped:number;notConverted:number} {
  const count=(status:BatchStatus)=>rows.filter(row=>row.status===status).length;
  return {converted:count('Converted'),failed:count('Failed'),skipped:count('Skipped'),notConverted:count('Not converted')};
}

export function summarize(rows:BatchRow[],scan:BatchScan):string {
  const counts=batchCounts(rows);
  const parts=[`${counts.converted} converted`,`${counts.failed} failed`];
  if(counts.skipped)parts.push(`${counts.skipped} skipped`);
  if(counts.notConverted)parts.push(`${counts.notConverted} not converted`);
  return `${parts.join(', ')}.${scan.truncated?` ${TRUNCATED_NOTE}`:''}`;
}
