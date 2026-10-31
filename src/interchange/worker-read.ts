import { importer,Settings } from '@coderline/alphatab';
// @ts-expect-error TS5097: the compiler is not configured for extensions, and Node needs one to run this file from source.
import { validateArchive } from './archive.ts';

/**
 * What a Worker does before the window may parse a file: the validator, then the stock reader under the same cap.
 * Only ever call this off the window thread, under a deadline: the stock reader can spin on a damaged file.
 */
export function readInWorker(bytes:Uint8Array,entryLimit:number):{tracks:number;bars:number} {
  validateArchive(bytes,entryLimit);
  const settings=new Settings();settings.importer.maxDecodingBufferSize=entryLimit;
  const score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
  return {tracks:score.tracks.length,bars:score.masterBars.length};
}
