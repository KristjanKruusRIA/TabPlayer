import type { model } from '@coderline/alphatab';
import { getTimeSignatureExportIntent,initializeTimeSignatureSource } from '../editor/time-signature-source';
import { readGpStylesheetSymbol,writeGpStylesheetSymbol } from './stylesheet-wire';
import { readLegacyStylesheetSymbol,writeLegacyStylesheetSymbol } from './stylesheet-legacy';

const currentPath='Content/Stylesheets/score.gpss',legacyPath='Content/BinaryStylesheet';

export function readStylesheetTimeSignatures(score:model.Score,entries:Readonly<Record<string,Uint8Array>>):void {
  const current=entries[currentPath],legacy=entries[legacyPath];
  const imported=current!==undefined?readGpStylesheetSymbol(current):
    legacy!==undefined?readLegacyStylesheetSymbol(legacy):null;
  initializeTimeSignatureSource(score,imported);
}

export function writeStylesheetTimeSignatures(score:model.Score,entries:Readonly<Record<string,Uint8Array>>):Record<string,Uint8Array> {
  const intent=getTimeSignatureExportIntent(score),output={...entries};
  if(!intent.changed)return output;
  const enabled=intent.value!;
  for(const [path,bytes] of Object.entries(entries)) {
    if(!/^Content\/Stylesheets\/scoreview[1-9][0-9]*\.gpss$/.test(path))continue;
    let view:boolean|null;
    try {view=readGpStylesheetSymbol(bytes);}
    catch(error) {
      throw new Error(`GP export cannot inspect imported view style ${path}: ${error instanceof Error?error.message:String(error)}`);
    }
    if(view!==null&&view!==enabled) {
      throw new Error(`GP export cannot change common/cut styling: imported view style conflicts with the changed full-score choice (${path}).`);
    }
  }
  const legacy=entries[legacyPath];
  if(legacy===undefined)throw new Error(`GP export requires generated legacy stylesheet ${legacyPath} for changed common/cut choices.`);
  if(entries[currentPath]!==undefined)output[currentPath]=writeGpStylesheetSymbol(entries[currentPath],enabled);
  output[legacyPath]=writeLegacyStylesheetSymbol(legacy,enabled);
  return output;
}
