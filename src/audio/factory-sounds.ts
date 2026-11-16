import { defaultEffects } from '../document-settings';
import type { EffectBlock, FxSettings, TrackSound } from '../edit-types';

/** The kinds of playing the factory sounds are grouped by. */
export const factoryCategories=['Clean guitar','Crunch','Lead and high gain','Ambient','Acoustic','Bass'] as const;
export type FactoryCategory=typeof factoryCategories[number];
type Patch={[Block in EffectBlock]?:Partial<FxSettings[Block]>};
interface FactoryDefinition {id:string;name:string;category:FactoryCategory;description:string;presetId:TrackSound['presetId'];effects:Patch;
  /** The order the signal passes through the blocks, when it is not the default one: every block once. */
  order?:EffectBlock[]}
/** A named sound for a kind of playing, built on one of the presets. Its blocks start from their defaults and are
 * switched on where it names them. It sets the effects only: the track keeps its instrument. */
export type FactorySound=Omit<FactoryDefinition,'effects'|'order'>;

const definitions:readonly FactoryDefinition[]=[
  {id:'jazz-clean',name:'Warm jazz clean',category:'Clean guitar',presetId:'clean',description:'Round, dark clean tone with a little room.',effects:{
    amp:{model:'clean',drive:.05,bassDb:2,trebleDb:-5,presenceDb:-3},cabinet:{model:'open'},reverb:{model:'room',room:.3,mix:.1}}},
  {id:'funk-clean',name:'Funk clean',category:'Clean guitar',presetId:'clean',description:'Squeezed, bright clean tone with an auto-wah for rhythm parts.',effects:{
    compressor:{thresholdDb:-26,ratio:6,attackMs:5,releaseMs:80,makeupDb:5},wah:{mode:'auto',sensitivity:.6,resonance:.6,mix:.8},
    amp:{model:'clean',drive:.15,gainDb:12,trebleDb:3,presenceDb:3},cabinet:{model:'open'}}},
  {id:'chorus-clean',name:'Eighties chorus clean',category:'Clean guitar',presetId:'clean',description:'Wide chorus with a dotted-eighth echo and a hall.',effects:{
    compressor:{thresholdDb:-20,ratio:3,makeupDb:3},amp:{model:'clean',drive:.1,trebleDb:2},cabinet:{model:'open'},
    chorus:{rateHz:.8,depthMs:6,mix:.35},delay:{model:'digital',quarterNotes:.75,feedback:.3,mix:.2},reverb:{model:'hall',room:.6,mix:.18}}},
  {id:'country-chime',name:'Country chime',category:'Clean guitar',presetId:'clean',description:'Snappy, bright clean tone with a short slapback and spring.',effects:{
    compressor:{thresholdDb:-22,ratio:4,attackMs:2,makeupDb:4},amp:{model:'clean',drive:.2,gainDb:2,midDb:-2,trebleDb:4,presenceDb:2},cabinet:{model:'open'},
    delay:{model:'tape',quarterNotes:.25,feedback:0,mix:.25},reverb:{model:'spring',room:.4,mix:.15}}},
  {id:'surf-tremolo',name:'Surf tremolo',category:'Clean guitar',presetId:'clean',description:'Pulsing tremolo through a drippy spring reverb.',effects:{
    amp:{model:'clean',drive:.25,gainDb:4,trebleDb:3},cabinet:{model:'open'},tremolo:{rateHz:6,depth:.6,shape:'sine'},reverb:{model:'spring',room:.6,damping:.3,mix:.35}}},
  {id:'blues-crunch',name:'Blues crunch',category:'Crunch',presetId:'crunch',description:'An overdrive pushing a crunchy amp, with a mid bump.',effects:{
    drive:{model:'overdrive',drive:.4,tone:.7},amp:{model:'crunch',drive:.25,gainDb:-2,midDb:2},cabinet:{model:'combo'},reverb:{model:'room',room:.4,mix:.15}}},
  {id:'classic-rock',name:'Classic rock rhythm',category:'Crunch',presetId:'crunch',description:'Full crunch for power chords and riffs.',effects:{
    amp:{model:'crunch',drive:.45,gainDb:-1,midDb:1},cabinet:{model:'closed'},reverb:{model:'room',room:.3,mix:.12}}},
  {id:'phaser-crunch',name:'Phased crunch',category:'Crunch',presetId:'crunch',description:'Light crunch with a slow phaser swirl.',effects:{
    amp:{model:'crunch',drive:.3,gainDb:4},cabinet:{model:'closed'},phaser:{rateHz:.4,depth:.7,feedback:.4,stages:4,mix:.5},reverb:{model:'room',mix:.12}}},
  {id:'rock-lead',name:'Rock lead',category:'Lead and high gain',presetId:'lead',description:'Singing lead with an analog echo and a hall.',effects:{
    drive:{model:'overdrive',drive:.3,levelDb:2},amp:{model:'lead',drive:.45,gainDb:1,midDb:1},cabinet:{model:'closed'},
    delay:{model:'analog',quarterNotes:.75,feedback:.35,mix:.2},reverb:{model:'hall',room:.6,mix:.2}}},
  {id:'metal-rhythm',name:'Metal rhythm',category:'Lead and high gain',presetId:'lead',description:'Tight, modern high gain: a bass-cut boost ahead of the amp, a closed four-by-twelve, and plenty of upper-mid bite.',
    // The boost (the EQ with a bass cut and a mid hump) stands ahead of the pedal and amp, which a sound's own order allows.
    order:['microphone','gate','compressor','wah','octaver','pitch','eq','drive','amp','cabinet','graphicEq','vibrato','phaser','flanger','chorus','tremolo','delay','reverb'],effects:{
    gate:{thresholdDb:-50,releaseMs:60},eq:{lowDb:-10,midDb:9,highDb:0,midHz:1000},drive:{model:'overdrive',drive:.1,tone:.8,levelDb:3},
    amp:{model:'metal',drive:.45,gainDb:-4.2,lowEndOct:.5,bassDb:2,presenceDb:4},
    // One of the closed four-by-twelve responses the app bundles; a machine without it plays the closed cabinet model instead.
    cabinet:{model:'closed',ir:{id:'04eae0ad866f1badc2d7f2bdc5da06a2',name:'bundled closed four-by-twelve',levelDb:0}},
    graphicEq:{gainsDb:[-12,6,6,.92,-5.17,.21,2.3,-8.08,3,-12],levelDb:0}}},
  {id:'fuzz-lead',name:'Fuzz lead',category:'Lead and high gain',presetId:'crunch',description:'Thick fuzz with a tape echo.',effects:{
    drive:{model:'fuzz',drive:.8,tone:.7},amp:{model:'crunch',drive:.2,gainDb:.5,bassDb:-3},cabinet:{model:'closed'},delay:{model:'tape',quarterNotes:.5,feedback:.4,mix:.25}}},
  {id:'octave-lead',name:'Octave-up lead',category:'Lead and high gain',presetId:'lead',description:'Lead doubled an octave up, with an echo.',effects:{
    pitch:{semitones:12,mix:.4},amp:{model:'lead',drive:.4,gainDb:0},cabinet:{model:'closed'},delay:{model:'digital',quarterNotes:.75,feedback:.3,mix:.2}}},
  {id:'ambient-swell',name:'Ambient wash',category:'Ambient',presetId:'clean',description:'Long synced echoes and a huge hall for pads and swells.',effects:{
    compressor:{thresholdDb:-24,ratio:3,makeupDb:3},amp:{model:'clean',drive:.1,gainDb:6,trebleDb:-2},cabinet:{model:'open'},chorus:{rateHz:.3,depthMs:8,mix:.3,syncQuarterNotes:16},
    delay:{model:'digital',quarterNotes:1.5,feedback:.6,mix:.35},reverb:{model:'hall',room:.95,damping:.3,mix:.45}}},
  {id:'shimmer',name:'Octave shimmer',category:'Ambient',presetId:'clean',description:'An octave-up layer feeding a long hall.',effects:{
    pitch:{semitones:12,mix:.25},amp:{model:'clean',drive:.1,gainDb:2.5},cabinet:{model:'open'},delay:{model:'digital',quarterNotes:1,feedback:.5,mix:.3},reverb:{model:'hall',room:.95,damping:.2,mix:.5}}},
  {id:'acoustic-room',name:'Acoustic in a room',category:'Acoustic',presetId:'gm',description:'Room microphone, gentle compression and a small room.',effects:{
    microphone:{placement:'room',output:'stereo'},compressor:{thresholdDb:-18,ratio:2.5,attackMs:15,makeupDb:2},eq:{lowDb:-2,highDb:2},reverb:{model:'room',room:.35,mix:.15}}},
  {id:'acoustic-close',name:'Close-miked acoustic',category:'Acoustic',presetId:'gm',description:'Close microphone with the boom tamed for strumming.',effects:{
    microphone:{placement:'close',output:'stereo'},compressor:{thresholdDb:-20,ratio:3,attackMs:10,makeupDb:3},graphicEq:{gainsDb:[-3,-2,-2,0,0,0,1,2,2,1],levelDb:0},reverb:{model:'plate',room:.4,mix:.1}}},
  {id:'finger-bass',name:'Finger bass',category:'Bass',presetId:'bass',description:'Warm, even finger-style bass.',effects:{
    compressor:{thresholdDb:-20,ratio:4,makeupDb:3},amp:{model:'bass',drive:.15,gainDb:-4.5,bassDb:3,trebleDb:-2},cabinet:{model:'bass'}}},
  {id:'slap-bass',name:'Slap bass',category:'Bass',presetId:'bass',description:'Hard compression with scooped mids and bright top.',effects:{
    compressor:{thresholdDb:-24,ratio:8,attackMs:2,releaseMs:60,makeupDb:5},graphicEq:{gainsDb:[0,4,2,0,-4,-3,2,4,5,2],levelDb:-2},amp:{model:'bass',drive:.1},cabinet:{model:'bass'}}},
  {id:'driven-bass',name:'Driven bass',category:'Bass',presetId:'bass',description:'A growling upper band over clean, tight lows.',effects:{
    compressor:{thresholdDb:-20,ratio:3,makeupDb:2},amp:{model:'bassDrive',drive:.4,gainDb:.5},cabinet:{model:'bassStack'}}},
  {id:'octave-bass',name:'Octave-down bass',category:'Bass',presetId:'bass',description:'An octave below doubling a driven bass.',effects:{
    octaver:{octaveDown:.7,twoOctavesDown:0,direct:.6},amp:{model:'bass',drive:.4,gainDb:-5},cabinet:{model:'bass'},eq:{highDb:-4}}},
];

/** Factory sounds as an earlier version defined them, for naming the settings a project copied before a sound was retuned. They are not
 * offered to apply. */
const earlierDefinitions:readonly FactoryDefinition[]=[
  {id:'metal-rhythm',name:'Metal rhythm (earlier version)',category:'Lead and high gain',presetId:'lead',description:'The Metal rhythm as first released, before it was retuned (THE-217).',effects:{
    gate:{thresholdDb:-50,releaseMs:60},drive:{model:'overdrive',drive:.2,tone:.6},amp:{model:'metal',drive:.55,gainDb:-2},cabinet:{model:'closed'}}},
];
function build(definition:FactoryDefinition,voiceId:string|null):TrackSound {
  const effects=defaultEffects() as unknown as Record<string,Record<string,unknown>>;
  for(const [block,patch] of Object.entries(definition.effects))effects[block]={...effects[block],...patch,enabled:true};
  if(definition.order)(effects as unknown as {order:EffectBlock[]}).order=[...definition.order];
  return {voiceId,presetId:definition.presetId,effects:effects as unknown as FxSettings};
}
/** The earlier versions that have a name, for the mixer. */
export const earlierFactorySounds:readonly FactorySound[]=earlierDefinitions.map(({effects:_effects,order:_order,...sound})=>sound);
/** The settings of the earlier version of factory sound `id`, or null when it has none. */
export function earlierFactorySound(id:string):TrackSound|null {
  const definition=earlierDefinitions.find(entry=>entry.id===id);
  return definition?build(definition,null):null;
}
export const factorySounds:readonly FactorySound[]=definitions.map(({effects:_effects,order:_order,...sound})=>sound);
/** The factory sound `id` for a track with `voiceId`, or null when there is none. */
export function factorySound(id:string,voiceId:string|null=null):TrackSound|null {
  const definition=definitions.find(entry=>entry.id===id);
  return definition?build(definition,voiceId):null;
}
