import type { model } from '@coderline/alphatab';
import { percussionChoices, standardPercussionCatalog, type PercussionChoice } from '../editor/percussion-catalog';

/**
 * Everything a drum staff can play, as hardware. Every standard articulation belongs to exactly one piece, by its element name;
 * `keys` says what a sounding pitch lights. Pitches several instruments share, such as the three cowbells' 56, light only one.
 */
export interface Instrument {id:string;label:string;elements:readonly string[];keys:readonly number[]}
export interface DrumPiece extends Instrument {x:number;y:number;r:number;/** Degrees the surface leans. */tilt:number;/** Paint order, back to front. */z:number}

const piece=(id:string,label:string,elements:readonly string[],keys:readonly number[],x:number,y:number,r:number,tilt:number,z:number):DrumPiece=>({id,label,elements,keys,x,y,r,tilt,z});
export const drumPieces:readonly DrumPiece[]=[
  piece('splash','Splash',['Splash'],[55],48,58,28,-6,1),
  piece('crash','Crash',['Crash High'],[49],140,50,56,-7,2),
  piece('crash-2','Crash 2',['Crash Medium'],[57],268,38,50,-5,3),
  piece('reverse','Reverse',['Reverse Cymbal'],[],384,30,38,4,4),
  piece('ride','Ride',['Ride'],[51,53],506,46,66,6,5),
  piece('china','China',['China'],[52],636,52,48,-5,6),
  piece('ride-2','Ride 2',['Ride Cymbal 2'],[59],770,72,58,6,7),
  piece('high-tom','High tom',['Tom Very High'],[50],236,98,30,6,8),
  piece('hi-mid-tom','Hi-mid tom',['Tom High'],[48],310,88,34,4,9),
  piece('low-mid-tom','Low-mid tom',['Tom Medium'],[47],392,86,38,-2,10),
  piece('low-tom','Low tom',['Tom Low'],[45],476,92,42,-4,11),
  piece('kick','Kick',['Acoustic Kick Drum'],[35],300,176,66,0,12),
  piece('kick-2','Kick 2',['Kick Drum'],[36],426,178,66,0,13),
  piece('high-floor-tom','High floor',['Tom Very Low'],[43],566,158,50,-3,14),
  piece('snare','Snare',['Snare','Sticks'],[38,37],176,168,42,-4,15),
  piece('hi-hat','Hi-hat',['Charley'],[42,46,44],84,140,44,-4,16),
  piece('floor-tom','Low floor',['Very Low Floor Tom'],[41],668,180,58,-3,17),
];
export const percussionInstruments:readonly Instrument[]=[
  {id:'cowbell-low',label:'Cowbell low',elements:['Cowbell Low'],keys:[]},
  {id:'cowbell',label:'Cowbell',elements:['Cowbell Medium'],keys:[56]},
  {id:'cowbell-high',label:'Cowbell high',elements:['Cowbell High'],keys:[]},
  {id:'woodblock-low',label:'Block low',elements:['Woodblock Low'],keys:[77]},
  {id:'woodblock-high',label:'Block high',elements:['Woodblock High'],keys:[76]},
  {id:'tambourine',label:'Tambourine',elements:['Tambourine'],keys:[54]},
  {id:'triangle',label:'Triangle',elements:['Triangle'],keys:[80,81]},
  {id:'bongo-high',label:'Bongo high',elements:['Bongo High'],keys:[60]},
  {id:'bongo-low',label:'Bongo low',elements:['Bongo Low'],keys:[61]},
  {id:'conga-high',label:'Conga high',elements:['Conga High'],keys:[63,62]},
  {id:'conga-low',label:'Conga low',elements:['Conga Low'],keys:[64]},
  {id:'timbale-high',label:'Timbale high',elements:['Timbale High'],keys:[65]},
  {id:'timbale-low',label:'Timbale low',elements:['Timbale Low'],keys:[66]},
  {id:'agogo-high',label:'Agogo high',elements:['Agogo High'],keys:[67]},
  {id:'agogo-low',label:'Agogo low',elements:['Agogo Low'],keys:[68]},
  {id:'surdo',label:'Surdo',elements:['Surdo'],keys:[86,87]},
  {id:'cuica',label:'Cuica',elements:['Cuica'],keys:[78,79]},
  {id:'vibraslap',label:'Vibraslap',elements:['Vibraslap'],keys:[58]},
  {id:'guiro',label:'Guiro',elements:['Guiro'],keys:[73,74]},
  {id:'cabasa',label:'Cabasa',elements:['Cabasa'],keys:[69]},
  {id:'shaker',label:'Shaker',elements:['Shaker'],keys:[82]},
  {id:'maraca-left',label:'Maraca left',elements:['Left Maraca'],keys:[70]},
  {id:'maraca-right',label:'Maraca right',elements:['Right Maraca'],keys:[]},
  {id:'claves',label:'Claves',elements:['Claves'],keys:[75]},
  {id:'castanets',label:'Castanets',elements:['Castanets'],keys:[85]},
  {id:'bell-tree',label:'Bell tree',elements:['Bell Tree'],keys:[]},
  {id:'jingle-bell',label:'Jingle bell',elements:['Jingle Bell','Tinkle Bell'],keys:[]},
  {id:'whistle-high',label:'Whistle high',elements:['Whistle High'],keys:[71]},
  {id:'whistle-low',label:'Whistle low',elements:['Whistle Low'],keys:[72]},
  {id:'grancassa',label:'Grancassa',elements:['Grancassa'],keys:[]},
  {id:'piatti',label:'Piatti',elements:['Piatti'],keys:[]},
  {id:'electric-snare',label:'Electric snare',elements:['Electric Snare'],keys:[40]},
  {id:'hand-clap',label:'Hand clap',elements:['Hand Clap'],keys:[39]},
  {id:'golpe',label:'Golpe',elements:['Golpe'],keys:[]},
  {id:'metronome',label:'Metronome',elements:['Metronome'],keys:[]},
];
export const kitOrder=(pieces:readonly DrumPiece[])=>[...pieces].sort((a,b)=>a.z-b.z);
const standardElement=new Map(standardPercussionCatalog.map(entry=>[entry.id,entry.element]));
/** The hits this instrument offers on a track: its standard articulations, and any of the track's own that land on its pitches. */
export function instrumentHits(track:model.Track,instrument:Instrument):PercussionChoice[] {
  const custom=track.percussionArticulations.length;
  return percussionChoices(track).filter((choice,index,all)=>all.findIndex(other=>other.id===choice.id)===index).filter(choice=>choice.id<custom?instrument.keys.includes(choice.outputMidiNumber):instrument.elements.includes(standardElement.get(choice.id)??''));
}
