import { unzipSync } from 'fflate';

/**
 * All entries of a score archive together. The per-entry cap alone lets a crafted archive list many entries that
 * each fit it; no real score or MusicXML container comes near this.
 */
export const ARCHIVE_TOTAL_LIMIT=256*1024*1024;

/** Refuses an archive whose central directory declares more than the total limit, before anything is inflated. */
export function assertArchiveSize(bytes:Uint8Array):void {
  let total=0;
  // A filter that rejects every entry makes fflate read the directory and inflate nothing.
  unzipSync(bytes,{filter:entry=>{
    total+=entry.originalSize;
    if(!(total<=ARCHIVE_TOTAL_LIMIT))throw new Error(`ZIP entries exceed the ${ARCHIVE_TOTAL_LIMIT/(1024*1024)} MiB total limit.`);
    return false;
  }});
}
