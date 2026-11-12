import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { exportGpInterchange,loadInterchangeScore } from './gp';
import { readLegacyStylesheetSymbol } from './stylesheet-legacy';
import { planTimeSignatureExport } from '../editor/time-signature-source';

// THE-60 characterisation of the GP common/cut limit. GPIF has no per-bar "common time" field; the display is one
// global stylesheet boolean, so only one choice can be written: the one more explicit bars make (a tie goes to
// numeric), and bars that chose otherwise or had no choice are counted by planTimeSignatureExport for the warning.
// The stylesheet members below are literal bytes written out here, not produced by our writer. stylesheet.test.ts
// and stylesheet-replay.test.ts already cover: the writer-level choices on a hand-built model, the same choices
// reached through native project replay, view-style conflicts, and the unchanged-export preservation of members. What they do
// not do is drive the public load -> edit -> exportGpInterchange path from literal bytes by editing the model
// directly, or export a model that never came from a file; that is what this file adds.
const settings=new Settings(),current='Content/Stylesheets/score.gpss',legacy='Content/BinaryStylesheet';
const commonShown=Uint8Array.of(0x5a,4,0x2a,2,8,1),numericShown=Uint8Array.of(0x5a,4,0x2a,2,8,0),optionAbsent=Uint8Array.of(0x08,1);
const legacyFlag=(value:boolean)=>Uint8Array.of(0,0,0,1,24,...strToU8('Staff/drawTimeSignatureC'),0,Number(value));
/** Four 4/4 bars written by alphaTab, with the stylesheet members replaced by the given literal bytes. */
function archive(flag:Uint8Array,legacyValue:boolean|null) {
  const entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings));
  entries[current]=flag.slice();
  if(legacyValue===null)delete entries[legacy];else entries[legacy]=legacyFlag(legacyValue);
  return zipSync(entries);
}
const flags=(score:model.Score)=>score.masterBars.map(master=>master.timeSignatureCommon);

it('characterizes the common/cut limit: one numeric bar among common bars of a file is exported with the source stylesheet unchanged and counted',()=>{
  const input=archive(commonShown,true),before=input.slice(),score=loadInterchangeScore(input,settings);
  expect(flags(score)).toEqual([true,true,true,true]);
  score.masterBars[1].timeSignatureCommon=false;
  // Three common bars against one numeric: the file's own choice wins, so nothing is rewritten, and the numeric bar will show the symbol.
  expect(planTimeSignatureExport(score)).toEqual({changed:false,value:null,differing:[1],inherited:[]});
  const out=unzipSync(exportGpInterchange(score,settings));
  expect(out[current]).toEqual(commonShown);expect(out[legacy]).toEqual(legacyFlag(true));
  expect(input).toEqual(before);
});

it('characterizes the common/cut limit: a model that never came from a file with some 4/4 bars common and others numeric is written with the tie broken to numeric',()=>{
  const score=music();
  score.masterBars.forEach((master,index)=>{master.timeSignatureCommon=index<2;});
  expect(score.masterBars.every(master=>master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4)).toBe(true);
  expect(planTimeSignatureExport(score)).toEqual({changed:true,value:false,differing:[0,1],inherited:[]});
  // The generated legacy member is alphaTab's full stylesheet, so its flag is read back; no current member is invented.
  const out=unzipSync(exportGpInterchange(score,settings));
  expect(readLegacyStylesheetSymbol(out[legacy])).toBe(false);expect(out[current]).toBeUndefined();
  expect(flags(score)).toEqual([true,true,false,false]);
  // Three common bars against one numeric: common.
  score.masterBars[2].timeSignatureCommon=true;
  expect(readLegacyStylesheetSymbol(unzipSync(exportGpInterchange(score,settings))[legacy])).toBe(true);
});

it('characterizes the common/cut limit: a model that never came from a file writes a uniform choice into the generated legacy stylesheet only',()=>{
  const numeric=music(),common=music();
  for(const master of common.masterBars)master.timeSignatureCommon=true;
  const asNumeric=unzipSync(exportGpInterchange(numeric,settings)),asCommon=unzipSync(exportGpInterchange(common,settings));
  expect(asNumeric[current]).toBeUndefined();expect(asCommon[current]).toBeUndefined();
  // The generated legacy member is alphaTab's full stylesheet, so its flag is read back rather than compared byte for byte.
  expect(readLegacyStylesheetSymbol(asNumeric[legacy])).toBe(false);expect(readLegacyStylesheetSymbol(asCommon[legacy])).toBe(true);
});

it('characterizes inherited defaults: a file whose stylesheet leaves the option absent exports that member and the legacy member byte for byte',()=>{
  const input=archive(optionAbsent,true),score=loadInterchangeScore(input,settings),out=unzipSync(exportGpInterchange(score,settings));
  // The absent option is inherited from the reading application, so the bars show numerically even though the legacy member says common.
  expect(flags(score)).toEqual([false,false,false,false]);
  expect(out[current]).toEqual(optionAbsent);expect(out[legacy]).toEqual(legacyFlag(true));
  expect(out[current]).toEqual(unzipSync(input)[current]);
});

it('characterizes inherited defaults: changing one bar next to inherited bars writes that choice and counts the bars that had none',()=>{
  const input=archive(optionAbsent,true),before=input.slice(),score=loadInterchangeScore(input,settings);
  score.masterBars[0].timeSignatureCommon=true;
  expect(planTimeSignatureExport(score)).toEqual({changed:true,value:true,differing:[],inherited:[1,2,3]});
  const one=unzipSync(exportGpInterchange(score,settings));
  expect(one[current]).toEqual(Uint8Array.of(8,1,0x5a,4,0x2a,2,8,1));expect(one[legacy]).toEqual(legacyFlag(true));
  expect(input).toEqual(before);
  // Setting every eligible bar resolves the inheritance: the explicit value is appended after the original option bytes.
  for(const master of score.masterBars)master.timeSignatureCommon=true;
  const out=unzipSync(exportGpInterchange(score,settings));
  expect(out[current]).toEqual(Uint8Array.of(8,1,0x5a,4,0x2a,2,8,1));expect(out[legacy]).toEqual(legacyFlag(true));
});

it('characterizes inherited defaults: an explicit numeric stylesheet is not treated as inherited, so one bar changed next to it is counted as differing',()=>{
  const score=loadInterchangeScore(archive(numericShown,false),settings);
  expect(flags(score)).toEqual([false,false,false,false]);
  score.masterBars[0].timeSignatureCommon=true;
  expect(planTimeSignatureExport(score)).toEqual({changed:false,value:null,differing:[0],inherited:[]});
});
