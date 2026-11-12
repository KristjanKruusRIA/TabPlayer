import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { exportGpInterchange,loadInterchangeScore } from './gp';
import { readLegacyStylesheetSymbol } from './stylesheet-legacy';

// THE-60 characterisation of the GP common/cut limit. GPIF has no per-bar "common time" field; the display is one
// global stylesheet boolean, so only a uniform choice can be written. The stylesheet members below are literal
// bytes written out here, not produced by our writer. stylesheet.test.ts and stylesheet-replay.test.ts already
// cover: the writer-level mixed/inherited refusals on a hand-built model, the same refusals reached through
// native project replay, view-style conflicts, and the unchanged-export preservation of members. What they do
// not do is drive the public load -> edit -> exportGpInterchange path from literal bytes by editing the model
// directly, or export a model that never came from a file; that is what this file adds.
const settings=new Settings(),current='Content/Stylesheets/score.gpss',legacy='Content/BinaryStylesheet';
const commonShown=Uint8Array.of(0x5a,4,0x2a,2,8,1),numericShown=Uint8Array.of(0x5a,4,0x2a,2,8,0),optionAbsent=Uint8Array.of(0x08,1);
const legacyFlag=(value:boolean)=>Uint8Array.of(0,0,0,1,24,...strToU8('Staff/drawTimeSignatureC'),0,Number(value));
const mixed='GP export cannot represent mixed common/cut and numeric measure choices. Export a uniform measure range or use consistent choices.';
const inherited='GP export cannot resolve inherited common/cut choices for every selected measure. Set each selected 4/4 or 2/2 measure explicitly before exporting changed choices.';
/** Four 4/4 bars written by alphaTab, with the stylesheet members replaced by the given literal bytes. */
function archive(flag:Uint8Array,legacyValue:boolean|null) {
  const entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings));
  entries[current]=flag.slice();
  if(legacyValue===null)delete entries[legacy];else entries[legacy]=legacyFlag(legacyValue);
  return zipSync(entries);
}
const flags=(score:model.Score)=>score.masterBars.map(master=>master.timeSignatureCommon);
function refusal(score:model.Score):string {
  try{exportGpInterchange(score,settings);}catch(error){return (error as Error).message;}
  return 'did not throw';
}

it('characterizes the common/cut limit: two 4/4 bars, one shown common and one numeric, are refused with the exact message on export from a file',()=>{
  const input=archive(commonShown,true),before=input.slice(),score=loadInterchangeScore(input,settings);
  expect(flags(score)).toEqual([true,true,true,true]);
  score.masterBars[1].timeSignatureCommon=false;
  expect(refusal(score)).toBe(mixed);
  // The refusal is not sticky: nothing was modified, so restoring the bar exports again with the source styles unchanged.
  expect(input).toEqual(before);
  score.masterBars[1].timeSignatureCommon=true;
  const out=unzipSync(exportGpInterchange(score,settings));
  expect(out[current]).toEqual(commonShown);expect(out[legacy]).toEqual(legacyFlag(true));
});

it('characterizes the common/cut limit: a model that never came from a file with some 4/4 bars common and others numeric is refused, not silently written',()=>{
  const score=music();
  score.masterBars.forEach((master,index)=>{master.timeSignatureCommon=index<2;});
  expect(score.masterBars.every(master=>master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4)).toBe(true);
  // Observed: with no source stylesheet every eligible bar still has to agree, so the same mixed message is thrown.
  expect(refusal(score)).toBe(mixed);
  expect(flags(score)).toEqual([true,true,false,false]);
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

it('characterizes inherited defaults: changing one bar next to inherited bars is refused with the exact message until every bar is set',()=>{
  const input=archive(optionAbsent,true),before=input.slice(),score=loadInterchangeScore(input,settings);
  score.masterBars[0].timeSignatureCommon=true;
  expect(refusal(score)).toBe(inherited);
  expect(input).toEqual(before);
  // Setting every eligible bar resolves the inheritance: the explicit value is appended after the original option bytes.
  for(const master of score.masterBars)master.timeSignatureCommon=true;
  const out=unzipSync(exportGpInterchange(score,settings));
  expect(out[current]).toEqual(Uint8Array.of(8,1,0x5a,4,0x2a,2,8,1));expect(out[legacy]).toEqual(legacyFlag(true));
});

it('characterizes inherited defaults: an explicit numeric stylesheet is not treated as inherited, so one bar changed next to it is a mixed refusal',()=>{
  const score=loadInterchangeScore(archive(numericShown,false),settings);
  expect(flags(score)).toEqual([false,false,false,false]);
  score.masterBars[0].timeSignatureCommon=true;
  expect(refusal(score)).toBe(mixed);
});
