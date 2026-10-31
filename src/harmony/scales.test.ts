import { describe,expect,it } from 'vitest';
import type { ScalePattern } from '../editor/harmony-types';
import { matchScales,scalePatterns,scalePitches } from './scales';

const expected:Array<[string,number[]]>=[
  ['major',[0,2,4,5,7,9,11]],['dorian',[0,2,3,5,7,9,10]],['phrygian',[0,1,3,5,7,8,10]],
  ['lydian',[0,2,4,6,7,9,11]],['mixolydian',[0,2,4,5,7,9,10]],['natural-minor',[0,2,3,5,7,8,10]],
  ['locrian',[0,1,3,5,6,8,10]],['harmonic-minor',[0,2,3,5,7,8,11]],['melodic-minor',[0,2,3,5,7,9,11]],
  ['major-pentatonic',[0,2,4,7,9]],['minor-pentatonic',[0,3,5,7,10]],['minor-blues',[0,3,5,6,7,10]],
  ['whole-tone',[0,2,4,6,8,10]],['chromatic',[0,1,2,3,4,5,6,7,8,9,10,11]],
  ['octatonic-half-whole',[0,1,3,4,6,7,9,10]],['octatonic-whole-half',[0,2,3,5,6,8,9,11]],
];
describe('scale theory',()=>{
  it('offers sixteen exact mathematical patterns with aliases and an ascending melodic-minor label',()=>{
    expect(scalePatterns.map(pattern=>[pattern.id,pattern.intervals])).toEqual(expected);expect(scalePatterns[0].tags).toContain('ionian');expect(scalePatterns[5].tags).toContain('aeolian');expect(scalePatterns[8].name.toLowerCase()).toContain('ascending');
    for(const [,intervals] of expected){const steps=intervals.map((interval,index)=>(intervals[index+1]??12)-interval);expect(steps.reduce((sum,step)=>sum+step,0)).toBe(12);}
  });
  it.each(expected)('produces literal %s pitches in each of twelve roots',(id,intervals)=>{
    const pattern=scalePatterns.find(value=>value.id===id)!;const before=structuredClone(pattern);
    for(let root=0;root<12;root++)expect(scalePitches(root,pattern.intervals,4)).toEqual([...intervals.map(interval=>48+root+interval),60+root]);expect(pattern).toEqual(before);
    expect(scalePitches(7,[0,2,4,7,9],9)).toEqual([115,117,119,122,124,127]);
  });
  it('rejects malformed custom intervals and pitches beyond the final MIDI boundary',()=>{
    for(const intervals of [[],[0],[2,4],[0,2,2],[0,4,2],[0,-1],[0,12],[0,1.5],[0,NaN]]){const before=[...intervals];expect(()=>scalePitches(0,intervals,4)).toThrow();expect(intervals).toEqual(before);}
    for(const root of [-1,12,0.5,NaN])expect(()=>scalePitches(root,[0,2],4)).toThrow();for(const octave of [-1,10,4.5,NaN])expect(()=>scalePitches(0,[0,2],octave)).toThrow();
    expect(()=>scalePitches(8,[0,2],9)).toThrow();expect(scalePitches(0,[0,11],0)).toEqual([0,11,12]);
  });
  it('ranks distinct selected classes by matched count, extras and stable pattern/root order',()=>{
    const custom:ScalePattern[]=[{id:'wide',name:'Wide',intervals:[0,2,4,5,7,9,11],tags:[]},{id:'triad',name:'Triad',intervals:[0,4,7],tags:[]},{id:'other',name:'Other',intervals:[0,4,7],tags:[]}];
    const pitches=[67,60,64,72],before=structuredClone({pitches,custom}),matches=matchScales(pitches,custom);
    expect(matches.slice(0,3)).toEqual([{patternId:'triad',root:0,matched:3,total:3,extra:0},{patternId:'other',root:0,matched:3,total:3,extra:0},{patternId:'wide',root:0,matched:3,total:3,extra:4}]);
    const firstPartial=matches.findIndex(match=>match.matched<3);expect(matches.slice(0,firstPartial).every(match=>match.matched===3)).toBe(true);expect({pitches,custom}).toEqual(before);
    const equal=matchScales([60],[{id:'whole',name:'Whole',intervals:[0,2,4,6,8,10],tags:[]}]);expect(equal.slice(0,6).map(match=>match.root)).toEqual([0,2,4,6,8,10]);
    expect(matchScales([],custom)).toEqual([]);expect(matchScales([60],[])).toEqual([]);for(const pitch of [-1,128,60.5,NaN])expect(()=>matchScales([pitch])).toThrow();
  });
});
