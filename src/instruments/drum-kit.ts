import { model } from '@coderline/alphatab';
import { percussionChoices, resolvePercussionArticulation, standardPercussionCatalog, type PercussionChoice } from '../editor/percussion-catalog';

/**
 * Everything a drum staff can play, as hardware. Every articulation belongs to exactly one piece, by its element name (a track's own
 * table is read the same way, and only an element nobody knows falls back to its sounding pitch). `keys` says what a sounding pitch lights
 * during playback, where only the pitch is known; pitches several instruments share, such as the three cowbells' 56, light only one.
 * `hit` is the id of the standard articulation pressing the piece enters, chosen by intent and not by key order.
 */
export interface Instrument {id:string;label:string;elements:readonly string[];keys:readonly number[];hit:number}
export interface DrumPiece extends Instrument {x:number;y:number;r:number;/** Degrees the surface leans. */tilt:number;/** Paint order, back to front. */z:number}

const piece=(id:string,label:string,elements:readonly string[],keys:readonly number[],hit:number,x:number,y:number,r:number,tilt:number,z:number):DrumPiece=>({id,label,elements,keys,hit,x,y,r,tilt,z});
export const drumPieces:readonly DrumPiece[]=[
  piece('splash','Splash',['Splash'],[55],55,48,58,28,-6,1),
  piece('crash','Crash',['Crash High'],[49],49,140,50,56,-7,2),
  piece('crash-2','Crash 2',['Crash Medium'],[57],57,268,38,50,-5,3),
  piece('reverse','Reverse',['Reverse Cymbal'],[],30,384,30,38,4,4),
  piece('ride','Ride',['Ride'],[51,53],51,506,46,66,6,5),
  piece('china','China',['China'],[52],52,636,52,48,-5,6),
  piece('ride-2','Ride 2',['Ride Cymbal 2'],[59],126,770,72,58,6,7),
  piece('high-tom','High tom',['Tom Very High'],[50],50,236,98,30,6,8),
  piece('hi-mid-tom','Hi-mid tom',['Tom High'],[48],48,310,88,34,4,9),
  piece('low-mid-tom','Low-mid tom',['Tom Medium'],[47],47,392,86,38,-2,10),
  piece('low-tom','Low tom',['Tom Low'],[45],45,476,92,42,-4,11),
  piece('kick','Kick',['Acoustic Kick Drum'],[35],35,300,176,66,0,12),
  piece('kick-2','Kick 2',['Kick Drum'],[36],36,426,178,66,0,13),
  piece('high-floor-tom','High floor',['Tom Very Low'],[43],43,566,158,50,-3,14),
  piece('snare','Snare',['Snare','Sticks'],[38,37],38,176,168,42,-4,15),
  piece('hi-hat','Hi-hat',['Charley'],[42,46,44],42,84,140,44,-4,16),
  piece('floor-tom','Low floor',['Very Low Floor Tom'],[41],41,668,180,58,-3,17),
];
export const percussionInstruments:readonly Instrument[]=[
  {id:'cowbell-low',label:'Cowbell low',elements:['Cowbell Low'],keys:[],hit:99},
  {id:'cowbell',label:'Cowbell',elements:['Cowbell Medium'],keys:[56],hit:56},
  {id:'cowbell-high',label:'Cowbell high',elements:['Cowbell High'],keys:[],hit:102},
  {id:'woodblock-low',label:'Block low',elements:['Woodblock Low'],keys:[77],hit:77},
  {id:'woodblock-high',label:'Block high',elements:['Woodblock High'],keys:[76],hit:76},
  {id:'tambourine',label:'Tambourine',elements:['Tambourine'],keys:[54],hit:54},
  {id:'triangle',label:'Triangle',elements:['Triangle'],keys:[80,81],hit:81},
  {id:'bongo-high',label:'Bongo high',elements:['Bongo High'],keys:[60],hit:60},
  {id:'bongo-low',label:'Bongo low',elements:['Bongo Low'],keys:[61],hit:61},
  {id:'conga-high',label:'Conga high',elements:['Conga High'],keys:[63,62],hit:63},
  {id:'conga-low',label:'Conga low',elements:['Conga Low'],keys:[64],hit:64},
  {id:'timbale-high',label:'Timbale high',elements:['Timbale High'],keys:[65],hit:65},
  {id:'timbale-low',label:'Timbale low',elements:['Timbale Low'],keys:[66],hit:66},
  {id:'agogo-high',label:'Agogo high',elements:['Agogo High'],keys:[67],hit:67},
  {id:'agogo-low',label:'Agogo low',elements:['Agogo Low'],keys:[68],hit:68},
  {id:'surdo',label:'Surdo',elements:['Surdo'],keys:[86,87],hit:86},
  {id:'cuica',label:'Cuica',elements:['Cuica'],keys:[78,79],hit:79},
  {id:'vibraslap',label:'Vibraslap',elements:['Vibraslap'],keys:[58],hit:58},
  {id:'guiro',label:'Guiro',elements:['Guiro'],keys:[73,74],hit:73},
  {id:'cabasa',label:'Cabasa',elements:['Cabasa'],keys:[69],hit:69},
  {id:'shaker',label:'Shaker',elements:['Shaker'],keys:[82],hit:82},
  {id:'maraca-left',label:'Maraca left',elements:['Left Maraca'],keys:[70],hit:70},
  {id:'maraca-right',label:'Maraca right',elements:['Right Maraca'],keys:[],hit:119},
  {id:'claves',label:'Claves',elements:['Claves'],keys:[75],hit:75},
  {id:'castanets',label:'Castanets',elements:['Castanets'],keys:[85],hit:85},
  {id:'bell-tree',label:'Bell tree',elements:['Bell Tree'],keys:[],hit:84},
  {id:'jingle-bell',label:'Jingle bell',elements:['Jingle Bell','Tinkle Bell'],keys:[],hit:83},
  {id:'whistle-high',label:'Whistle high',elements:['Whistle High'],keys:[71],hit:71},
  {id:'whistle-low',label:'Whistle low',elements:['Whistle Low'],keys:[72],hit:72},
  {id:'grancassa',label:'Grancassa',elements:['Grancassa'],keys:[],hit:114},
  {id:'piatti',label:'Piatti',elements:['Piatti'],keys:[],hit:115},
  {id:'electric-snare',label:'Electric snare',elements:['Electric Snare'],keys:[40],hit:40},
  {id:'hand-clap',label:'Hand clap',elements:['Hand Clap'],keys:[39],hit:39},
  {id:'golpe',label:'Golpe',elements:['Golpe'],keys:[],hit:124},
  {id:'metronome',label:'Metronome',elements:['Metronome'],keys:[],hit:33},
];
export const kitOrder=(pieces:readonly DrumPiece[])=>[...pieces].sort((a,b)=>a.z-b.z);
const everything=[...drumPieces,...percussionInstruments], byElement=new Map(everything.flatMap(item=>item.elements.map(element=>[element,item]))), byKey=new Map(everything.flatMap(item=>item.keys.map(key=>[key,item])));
const standardById=new Map(standardPercussionCatalog.map(entry=>[entry.id,entry]));
/** Who owns an articulation: the instrument that names its element, and only when nobody does, the one that sounds its pitch. */
export const instrumentOf=(elementType:string,outputMidiNumber:number):Instrument|undefined=>byElement.get(elementType)??byKey.get(outputMidiNumber);
/** The instrument an articulation id of this track plays on, read from the track's own table where it has one. */
export function ownerOf(track:model.Track,id:number):Instrument|undefined {
  const articulation=resolvePercussionArticulation(track,id);
  return articulation?instrumentOf(articulation.elementType,articulation.outputMidiNumber):undefined;
}
export interface InstrumentHit extends PercussionChoice {/** A short name for the row of hits, such as "rim shot". */name:string}
const techniqueNames=new Map<model.MusicFontSymbol,string>([[model.MusicFontSymbol.PictEdgeOfCymbal,'edge'],[model.MusicFontSymbol.ArticStaccatoAbove,'choke'],[model.MusicFontSymbol.NoteheadParenthesis,'mute'],[model.MusicFontSymbol.StringsUpBow,'return'],[model.MusicFontSymbol.StringsDownBow,'roll']]);
const labelName=(label:string)=>{const match=/^(.*?) \((.*)\)( \d+)?$/.exec(label);return match?`${/^Pedal/.test(match[1])&&match[2]==='hit'?'pedal':match[2]}${match[3]??''}`:label;};
/** A track's own articulation named like the standard one it copies, else by its technique. */
function customName(articulation:model.InstrumentArticulation) {
  const same=standardPercussionCatalog.find(entry=>entry.element===articulation.elementType&&entry.outputMidiNumber===articulation.outputMidiNumber&&entry.symbols[0]===articulation.noteHeadDefault&&(entry.symbols[3]??model.MusicFontSymbol.None)===articulation.techniqueSymbol);
  return same?labelName(same.label):techniqueNames.get(articulation.techniqueSymbol)??'hit';
}
/** The hits this instrument offers on a track, the track's own first, each with a name that is unique among them. */
export function instrumentHits(track:model.Track,instrument:Instrument):InstrumentHit[] {
  const custom=track.percussionArticulations.length, seen=new Map<string,number>();
  return percussionChoices(track).filter((choice,index,all)=>all.findIndex(other=>other.id===choice.id)===index&&ownerOf(track,choice.id)===instrument).map(choice=>{
    const base=choice.id<custom?customName(track.percussionArticulations[choice.id]):labelName(choice.label), count=(seen.get(base)??0)+1;
    seen.set(base,count);return {...choice,name:count>1?`${base} ${count}`:base};
  });
}

/** The articulation pressing a piece enters. The track's own hits win over the standard ones, and among them the closest to the
 *  piece's standard plain hit by sound, notehead and technique wins, so a ride's middle beats its edge and bell. */
export function defaultArticulation(track:model.Track,instrument:Instrument):number|null {
  const hits=instrumentHits(track,instrument), custom=track.percussionArticulations.length, wanted=standardById.get(instrument.hit);
  if(!hits.length) return null;
  const own=hits.filter(hit=>hit.id<custom), pool=own.length?own:hits, none=model.MusicFontSymbol.None;
  const score=(hit:InstrumentHit)=>{
    const articulation=resolvePercussionArticulation(track,hit.id);
    if(!articulation||!wanted) return 0;
    return (articulation.outputMidiNumber===wanted.outputMidiNumber?4:0)+(articulation.noteHeadDefault===wanted.symbols[0]?2:0)+(articulation.techniqueSymbol===(wanted.symbols[3]??none)?1:0);
  };
  return pool.reduce((best,hit)=>score(hit)>score(best)?hit:best).id;
}
