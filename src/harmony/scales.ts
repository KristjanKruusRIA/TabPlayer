import type { ScaleMatch,ScalePattern } from '../editor/harmony-types';

export const scalePatterns:readonly ScalePattern[]=[
  {id:'major',name:'Major / Ionian',intervals:[0,2,4,5,7,9,11],tags:['major','ionian','mode']},
  {id:'dorian',name:'Dorian',intervals:[0,2,3,5,7,9,10],tags:['minor','mode']},
  {id:'phrygian',name:'Phrygian',intervals:[0,1,3,5,7,8,10],tags:['minor','mode']},
  {id:'lydian',name:'Lydian',intervals:[0,2,4,6,7,9,11],tags:['major','mode']},
  {id:'mixolydian',name:'Mixolydian',intervals:[0,2,4,5,7,9,10],tags:['major','mode']},
  {id:'natural-minor',name:'Natural minor / Aeolian',intervals:[0,2,3,5,7,8,10],tags:['minor','aeolian','mode']},
  {id:'locrian',name:'Locrian',intervals:[0,1,3,5,6,8,10],tags:['diminished','mode']},
  {id:'harmonic-minor',name:'Harmonic minor',intervals:[0,2,3,5,7,8,11],tags:['minor']},
  {id:'melodic-minor',name:'Melodic minor, ascending',intervals:[0,2,3,5,7,9,11],tags:['minor','ascending']},
  {id:'major-pentatonic',name:'Major pentatonic',intervals:[0,2,4,7,9],tags:['major','pentatonic']},
  {id:'minor-pentatonic',name:'Minor pentatonic',intervals:[0,3,5,7,10],tags:['minor','pentatonic']},
  {id:'minor-blues',name:'Minor blues',intervals:[0,3,5,6,7,10],tags:['minor','blues']},
  {id:'whole-tone',name:'Whole tone',intervals:[0,2,4,6,8,10],tags:['symmetric']},
  {id:'chromatic',name:'Chromatic',intervals:[0,1,2,3,4,5,6,7,8,9,10,11],tags:['symmetric']},
  {id:'octatonic-half-whole',name:'Octatonic half-whole',intervals:[0,1,3,4,6,7,9,10],tags:['symmetric','diminished']},
  {id:'octatonic-whole-half',name:'Octatonic whole-half',intervals:[0,2,3,5,6,8,9,11],tags:['symmetric','diminished']},
];
const integer=(value:number,min:number,max:number)=>Number.isInteger(value)&&value>=min&&value<=max;
function validateIntervals(intervals:readonly number[]) {
  if(intervals.length<2||intervals.length>12||intervals[0]!==0||intervals.some((interval,index)=>!integer(interval,0,11)||(index>0&&interval<=intervals[index-1])))throw new Error('Scale intervals must be sorted, unique semitones from 0 to 11, including 0 and at least two notes.');
}
export function scalePitches(root:number,intervals:readonly number[],octave:number):number[] {
  if(!integer(root,0,11)||!integer(octave,0,9))throw new Error('Choose a scale root from 0 to 11 and octave from 0 to 9.');
  validateIntervals(intervals);const tonic=12*octave+root,pitches=[...intervals.map(interval=>tonic+interval),tonic+12];
  if(pitches.some(pitch=>!integer(pitch,0,127)))throw new Error('The scale exceeds the MIDI pitch range.');return pitches;
}
export function matchScales(pitches:readonly number[],patterns:readonly ScalePattern[]=scalePatterns):ScaleMatch[] {
  if(pitches.some(pitch=>!integer(pitch,0,127)))throw new Error('Selected pitches must be MIDI pitches from 0 to 127.');
  for(const pattern of patterns)validateIntervals(pattern.intervals);
  if(pitches.length===0)return [];
  const selected=new Set(pitches.map(pitch=>pitch%12)),matches:Array<ScaleMatch&{order:number}>=[];
  for(let order=0;order<patterns.length;order++)for(let root=0;root<12;root++){
    const pattern=patterns[order],matched=pattern.intervals.filter(interval=>selected.has((root+interval)%12)).length;
    matches.push({patternId:pattern.id,root,matched,total:selected.size,extra:pattern.intervals.length-matched,order});
  }
  return matches.sort((a,b)=>b.matched-a.matched||a.extra-b.extra||a.order-b.order||a.root-b.root).map(({order:_,...match})=>match);
}
