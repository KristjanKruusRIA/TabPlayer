import { describe,expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import type { ChordFormulaId,ChordRecipe,HarmonyChord } from '../editor/harmony-types';
import { chordTones,findChordShapes,formatChordName,recognizeChords } from './chords';

const recipe=(formula:ChordFormulaId='major'):ChordRecipe=>({root:{step:0,alteration:0},formula,alterations:[],omissions:[],bass:null});
const formulas:Array<[ChordFormulaId,number[],string]>=[
  ['major',[0,4,7],'C'],['minor',[0,3,7],'Cm'],['dim',[0,3,6],'Cdim'],['aug',[0,4,8],'Caug'],
  ['sus2',[0,2,7],'Csus2'],['sus4',[0,5,7],'Csus4'],['power',[0,7],'C5'],
  ['6',[0,4,7,9],'C6'],['m6',[0,3,7,9],'Cm6'],['7',[0,4,7,10],'C7'],['maj7',[0,4,7,11],'Cmaj7'],
  ['m7',[0,3,7,10],'Cm7'],['mMaj7',[0,3,7,11],'CmMaj7'],['m7b5',[0,3,6,10],'Cm7b5'],['dim7',[0,3,6,9],'Cdim7'],
  ['9',[0,4,7,10,2],'C9'],['maj9',[0,4,7,11,2],'Cmaj9'],['m9',[0,3,7,10,2],'Cm9'],
  ['11',[0,4,7,10,2,5],'C11'],['m11',[0,3,7,10,2,5],'Cm11'],['13',[0,4,7,10,2,5,9],'C13'],['7sus4',[0,5,7,10],'C7sus4'],
];
function staff(tuning=[64,59,55,50,45,40],capo=0,transposition=0) {
  const value=new model.Staff();value.stringTuning.tunings=[...tuning];value.capo=capo;value.transpositionPitch=transposition;value.displayTranspositionPitch=24;return value;
}
const pcs=(pitches:number[])=>[...new Set(pitches.map(pitch=>((pitch%12)+12)%12))].sort((a,b)=>a-b);
function checkShape(shape:HarmonyChord,tuning:number[],capo:number,transposition:number,want:number[],maxFret:number,maxSpan:number,bass:number|null=null) {
  expect(shape.frets).toHaveLength(tuning.length);expect(shape.fingers).toHaveLength(tuning.length);
  const notes=shape.frets.flatMap((fret,index)=>fret<0?[]:[tuning[index]+capo-transposition+fret]);
  expect(notes.every(pitch=>Number.isInteger(pitch)&&pitch>=0&&pitch<=127)).toBe(true);expect(pcs(notes)).toEqual(want);
  if(bass!==null)expect(Math.min(...notes)%12).toBe(bass);
  expect(shape.frets.every(fret=>Number.isInteger(fret)&&fret>=-1&&fret<=maxFret)).toBe(true);
  const positive=shape.frets.filter(fret=>fret>0);expect((positive.length?Math.max(...positive)-Math.min(...positive):0)).toBeLessThanOrEqual(maxSpan);
  expect(shape.firstFret).toBeGreaterThanOrEqual(1);expect(positive.every(fret=>fret>=shape.firstFret&&fret<=shape.firstFret+4)).toBe(true);
  const used=new Set<number>();
  for(let index=0;index<shape.frets.length;index++){
    if(shape.frets[index]<=0){expect(shape.fingers[index]).toBe(-2);continue;}
    const finger=shape.fingers[index];expect(finger).toBeGreaterThanOrEqual(1);expect(finger).toBeLessThanOrEqual(4);used.add(finger);
    const positions=shape.fingers.flatMap((value,i)=>value===finger?[i]:[]);
    if(positions.length>1){expect(positions.every(i=>shape.frets[i]===shape.frets[index])).toBe(true);
      expect(shape.frets.slice(positions[0],positions.at(-1)!+1).every(fret=>fret>=shape.frets[index])).toBe(true);expect(shape.barreFrets).toContain(shape.frets[index]);}
  }
  expect(used.size).toBeLessThanOrEqual(4);expect(new Set(shape.barreFrets).size).toBe(shape.barreFrets.length);
  for(const fret of shape.barreFrets){const positions=shape.frets.flatMap((value,index)=>value===fret?[index]:[]);expect(positions.length).toBeGreaterThan(1);expect(shape.frets.slice(positions[0],positions.at(-1)!+1).every(value=>value>=fret)).toBe(true);}
}

describe('chord theory',()=>{
  it.each(formulas)('derives the literal %s tone set and name',(formula,intervals,name)=>{
    const value=recipe(formula),before=structuredClone(value);expect(chordTones(value).map(tone=>tone.pitchClass)).toEqual(intervals);expect(formatChordName(value)).toBe(name);expect(value).toEqual(before);
  });
  it('applies explicit alterations and omissions without adding a slash bass to formula tones',()=>{
    const value=recipe('7');value.alterations=[{degree:9,shift:-1}];value.omissions=[5];value.bass={step:2,alteration:0};
    expect(chordTones(value)).toEqual([{degree:1,pitchClass:0},{degree:3,pitchClass:4},{degree:7,pitchClass:10},{degree:9,pitchClass:1}]);expect(formatChordName(value)).toBe('C7(b9,no5)/E');
    value.root={step:1,alteration:-1};value.bass={step:4,alteration:1};expect(formatChordName(value)).toBe('Db7(b9,no5)/G#');expect(pcs(chordTones(value).map(tone=>tone.pitchClass))).toEqual([1,2,5,11]);
    const noRoot=recipe();noRoot.omissions=[1];noRoot.bass={step:0,alteration:0};expect(chordTones(noRoot)).toEqual([{degree:3,pitchClass:4},{degree:5,pitchClass:7}]);
    const deduplicated=recipe('minor');deduplicated.alterations=[{degree:9,shift:1}];expect(chordTones(deduplicated)).toEqual([{degree:1,pitchClass:0},{degree:3,pitchClass:3},{degree:5,pitchClass:7}]);
  });
  it('orders modifiers deterministically without rewriting the recipe',()=>{
    const value=recipe('13');value.alterations=[{degree:13,shift:-1},{degree:5,shift:1},{degree:9,shift:-1}];value.omissions=[11,3];const before=structuredClone(value);
    expect(formatChordName(value)).toBe('C13(#5,b9,b13,no3,no11)');expect(value).toEqual(before);
    const spell=recipe();spell.root={step:6,alteration:2};spell.bass={step:2,alteration:-2};expect(formatChordName(spell)).toBe('B##/Ebb');expect(chordTones(spell).map(tone=>tone.pitchClass)).toEqual([1,5,8]);
  });
  it('rejects contradictory alterations, duplicate or absent omissions, and empty formulas',()=>{
    const invalid:ChordRecipe[]=[];
    for(const formula of ['dim','aug','m7b5','dim7'] as const)invalid.push({...recipe(formula),alterations:[{degree:5,shift:1}]});
    invalid.push({...recipe(),omissions:[3,3]},{...recipe(),omissions:[7]},{...recipe(),omissions:[1,3,5]},
      {...recipe(),alterations:[{degree:9,shift:1},{degree:9,shift:-1}]},{...recipe('power'),alterations:[{degree:5,shift:1}],omissions:[3]},
      {...recipe(),root:{step:7,alteration:0}},{...recipe(),bass:{step:0,alteration:3}});
    for(const value of invalid){const before=structuredClone(value);expect(()=>chordTones(value)).toThrow();expect(()=>formatChordName(value)).toThrow();expect(value).toEqual(before);}
  });
  it('recognizes exact pitch sets with bass, ambiguity and preferred-root ordering',()=>{
    expect(recognizeChords([48,52,55],null).map(match=>match.name)).toEqual(['C']);expect(recognizeChords([52,55,60],null).map(match=>match.name)).toEqual(['C/E']);
    const pitches=[69,60,64,67,60],before=[...pitches],matches=recognizeChords(pitches,null);expect(matches[0].name).toBe('C6');expect(matches.map(match=>match.name)).toContain('Am7/C');expect(matches[0]).toMatchObject({bass:60,pitchClasses:[0,4,7,9]});
    expect(recognizeChords(pitches,{step:5,alteration:0})[0].name).toBe('Am7/C');expect(pitches).toEqual(before);
    expect(recognizeChords([60,67],null).map(match=>match.name)).toEqual(['C5']);expect(recognizeChords([60,64],null)).toEqual([]);expect(recognizeChords([],null)).toEqual([]);
    expect(recognizeChords([49,53,56],{step:1,alteration:-1})[0].name).toBe('Db');
    for(const pitch of [-1,128,NaN,60.5])expect(()=>recognizeChords([pitch],null)).toThrow();
  });
});

describe('bounded chord shapes',()=>{
  it.each([
    {label:'standard',tuning:[64,59,55,50,45,40],capo:0,offset:0},
    {label:'drop D',tuning:[64,59,55,50,45,38],capo:0,offset:0},
    {label:'capo and sounding offset',tuning:[64,59,55,50,45,40],capo:2,offset:12},
    {label:'one string',tuning:[60],capo:0,offset:0},
    {label:'nonmonotonic nine strings',tuning:[64,59,55,50,45,35,40,30,25],capo:0,offset:0},
    {label:'nonmonotonic twelve strings',tuning:[64,59,55,50,45,35,40,30,25,60,48,36],capo:1,offset:-2},
  ])('covers exact literal sounding tones on $label',({tuning,capo,offset})=>{
    const destination=staff(tuning,capo,offset),value=recipe(),before=JSON.stringify(destination),search={maxFret:12,maxSpan:4,limit:12};
    if(tuning.length===1)value.omissions=[3,5];
    const recipeBefore=structuredClone(value);
    const expected=tuning.length===1?[0]:[0,4,7],result=findChordShapes(destination,value,search);expect(result.length).toBeGreaterThan(0);expect(result.length).toBeLessThanOrEqual(12);
    for(const shape of result){checkShape(shape,tuning,capo,offset,expected,12,4);expect(shape).toMatchObject({name:'C'+(tuning.length===1?'(no3,no5)':''),nameMode:'theory',recipe:value,showName:true,showDiagram:true,showFingering:true});}
    expect(new Set(result.map(shape=>shape.frets.join(','))).size).toBe(result.length);expect(findChordShapes(destination,value,search)).toEqual(result);expect(JSON.stringify(destination)).toBe(before);
    expect(value).toEqual(recipeBefore);
    const rank=(shape:HarmonyChord)=>{const positive=shape.frets.filter(fret=>fret>0);return [shape.frets.filter(fret=>fret<0).length,positive.length?Math.max(...positive)-Math.min(...positive):0,positive.length?Math.max(...positive):0,positive.reduce((sum,fret)=>sum+fret,0),...shape.frets];};
    for(let i=1;i<result.length;i++){const a=rank(result[i-1]),b=rank(result[i]),first=a.findIndex((value,index)=>value!==b[index]);expect(first<0||a[first]<b[first]).toBe(true);}
  });
  it('adds an outside slash bass and keeps it the actual lowest sounding note',()=>{
    const destination=staff([60,64,67,54]),value=recipe();value.bass={step:3,alteration:1};
    const result=findChordShapes(destination,value,{maxFret:1,maxSpan:0,limit:12});expect(result).toHaveLength(1);expect(result[0].frets).toEqual([0,0,0,0]);checkShape(result[0],[60,64,67,54],0,0,[0,4,6,7],1,0,6);
    value.omissions=[1];value.bass={step:0,alteration:0};const rootBass=findChordShapes(staff([64,67,60]),value,{maxFret:1,maxSpan:0,limit:12});expect(rootBass[0].frets).toEqual([0,0,0]);
  });
  it('uses separate fingers for Fdim7 positions separated by an open string',()=>{
    // Standard high-to-low tuning: F65, B59, Ab56, D50. A fret1 barre would incorrectly fret B.
    const value=recipe('dim7');value.root={step:3,alteration:0};const result=findChordShapes(staff(),value,{maxFret:1,maxSpan:0,limit:12});
    const literal=result.find(shape=>shape.frets.join(',')==='1,0,1,0,-1,-1');expect(literal).toBeDefined();expect(literal!.fingers).toEqual([1,-2,2,-2,-2,-2]);expect(literal!.barreFrets).toEqual([]);
    for(const shape of result)checkShape(shape,[64,59,55,50,45,40],0,0,[2,5,8,11],1,0);
  });
  it('shares a finger only across compatible played strings and assigns fingers by fret then string',()=>{
    const value=recipe();value.omissions=[3,5];
    const blocked=findChordShapes(staff([59,61,59]),value,{maxFret:1,maxSpan:0,limit:12});expect(blocked[0].frets).toEqual([1,-1,1]);expect(blocked[0].fingers).toEqual([1,-2,2]);expect(blocked[0].barreFrets).toEqual([]);
    const compatible=findChordShapes(staff([59,58,59]),value,{maxFret:2,maxSpan:1,limit:12});expect(compatible[0].frets).toEqual([1,2,1]);expect(compatible[0].fingers).toEqual([1,2,1]);expect(compatible[0].barreFrets).toEqual([1]);
    const open=findChordShapes(staff([59,60,59]),value,{maxFret:1,maxSpan:0,limit:12});expect(open[0].frets).toEqual([1,0,1]);expect(open[0].fingers).toEqual([1,-2,2]);
    const lower=findChordShapes(staff([58,59,58]),value,{maxFret:2,maxSpan:1,limit:12});expect(lower[0].frets).toEqual([2,1,2]);expect(lower[0].fingers).toEqual([2,1,3]);expect(lower[0].barreFrets).toEqual([]);
  });
  it('discards shapes requiring five separate finger units even at one fret',()=>{
    const value=recipe();value.omissions=[3,5];const tuning=[59,61,59,61,59,61,59,61,59],result=findChordShapes(staff(tuning),value,{maxFret:1,maxSpan:0,limit:12});
    expect(result.length).toBeGreaterThan(0);for(const shape of result){expect(shape.frets.filter(fret=>fret>0).length).toBeLessThanOrEqual(4);checkShape(shape,tuning,0,0,[0],1,0);}
  });
  it('returns no bounded result and rejects invalid search/context without source mutation',()=>{
    const destination=staff([60]),before=JSON.stringify(destination);expect(findChordShapes(destination,recipe(),{maxFret:1,maxSpan:0,limit:12})).toEqual([]);expect(JSON.stringify(destination)).toBe(before);
    for(const search of [{maxFret:0,maxSpan:4,limit:12},{maxFret:128,maxSpan:4,limit:12},{maxFret:24,maxSpan:5,limit:12},{maxFret:24,maxSpan:-1,limit:12},{maxFret:24,maxSpan:4,limit:0},{maxFret:24,maxSpan:4,limit:13}])expect(()=>findChordShapes(destination,recipe(),search)).toThrow();
    for(const tuning of [[],Array(13).fill(60),[128],[-1]])expect(()=>findChordShapes(staff(tuning),recipe(),{maxFret:24,maxSpan:4,limit:12})).toThrow();
    destination.isPercussion=true;expect(()=>findChordShapes(destination,recipe(),{maxFret:24,maxSpan:4,limit:12})).toThrow();
    const boundary=recipe();boundary.omissions=[3,5];expect(findChordShapes(staff([127]),boundary,{maxFret:127,maxSpan:4,limit:12})).toEqual([]);
  });
});
