import { defaultEffects } from '../document-settings';
import type { EffectBlock, TrackSound } from '../edit-types';

/** The sound a preset names; `gm` is no effects at all. */
export function soundPreset(presetId:TrackSound['presetId'],voiceId:string|null=null):TrackSound {
  const effects=defaultEffects();
  if(presetId!=='gm'){effects.amp.enabled=true;effects.cabinet.enabled=true;effects.amp.model=presetId;}
  if(presetId==='crunch'){effects.amp.drive=.4;effects.cabinet.model='closed';effects.eq.enabled=true;effects.eq.midDb=2;}
  if(presetId==='lead'){effects.amp.drive=.75;effects.cabinet.model='closed';effects.delay.enabled=true;effects.reverb.enabled=true;}
  if(presetId==='bass'){effects.amp.drive=.2;effects.cabinet.model='bass';effects.compressor.enabled=true;effects.compressor.makeupDb=3;effects.eq.enabled=true;effects.eq.lowDb=3;effects.eq.highDb=-2;}
  return {voiceId,presetId,effects};
}
export type NumericControl={key:string;label:string;min:number;max:number;step:number};
/** The graphic EQ's bands, an octave apart, as their centres are named. */
export const graphicBands=['31','63','125','250','500','1k','2k','4k','8k','16k'];
export const presetIds=['gm','clean','crunch','lead','bass'] as const;
export const presetName=(id:string)=>id==='gm'?'Bypass':id[0].toUpperCase()+id.slice(1);
export const ampModels=['clean','crunch','lead','metal','bass','bassDrive'] as const,cabinetModels=['open','closed','combo','bass','bassStack'] as const;
export const modelName=(model:string)=>model.replace(/[A-Z]/g,letter=>` ${letter.toLowerCase()}`);
export const blockNames:Record<EffectBlock,string>={microphone:'Microphone',gate:'Gate',compressor:'Compressor',wah:'Wah',octaver:'Octaver',pitch:'Pitch shift',drive:'Drive',amp:'Amp',cabinet:'Cabinet',eq:'EQ',graphicEq:'Graphic EQ',vibrato:'Vibrato',phaser:'Phaser',flanger:'Flanger',chorus:'Chorus',tremolo:'Tremolo',delay:'Delay',reverb:'Reverb'};
export const parameters:Record<EffectBlock,NumericControl[]>={
  // The sound bank's recording comes before the pedals.
  microphone:[],
  gate:[{key:'thresholdDb',label:'Threshold (dB)',min:-96,max:0,step:1},{key:'releaseMs',label:'Release (ms)',min:1,max:1000,step:1}],
  compressor:[{key:'thresholdDb',label:'Threshold (dB)',min:-60,max:0,step:1},{key:'ratio',label:'Ratio',min:1,max:20,step:.1},{key:'attackMs',label:'Attack (ms)',min:.1,max:200,step:.1},{key:'releaseMs',label:'Release (ms)',min:1,max:2000,step:1},{key:'makeupDb',label:'Makeup (dB)',min:0,max:24,step:.1}],
  wah:[{key:'position',label:'Pedal position',min:0,max:1,step:.01},{key:'resonance',label:'Resonance',min:0,max:1,step:.01},{key:'sensitivity',label:'Sensitivity',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  octaver:[{key:'octaveDown',label:'Octave down',min:0,max:1,step:.01},{key:'twoOctavesDown',label:'Two octaves down',min:0,max:1,step:.01},{key:'direct',label:'Direct',min:0,max:1,step:.01}],
  pitch:[{key:'semitones',label:'Semitones',min:-24,max:24,step:1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  drive:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'tone',label:'Tone',min:0,max:1,step:.01},{key:'levelDb',label:'Level (dB)',min:-24,max:12,step:.5}],
  amp:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'gainDb',label:'Gain (dB)',min:-24,max:24,step:.1},{key:'bassDb',label:'Bass (dB)',min:-12,max:12,step:.5},{key:'midDb',label:'Mid (dB)',min:-12,max:12,step:.5},{key:'trebleDb',label:'Treble (dB)',min:-12,max:12,step:.5},{key:'presenceDb',label:'Presence (dB)',min:-12,max:12,step:.5}],cabinet:[],
  eq:[{key:'lowDb',label:'Low (dB)',min:-24,max:24,step:.1},{key:'midDb',label:'Mid (dB)',min:-24,max:24,step:.1},{key:'highDb',label:'High (dB)',min:-24,max:24,step:.1},{key:'midHz',label:'Mid frequency (Hz)',min:200,max:5000,step:10}],
  graphicEq:[{key:'levelDb',label:'Level (dB)',min:-12,max:12,step:.5}],
  // Listed in the native processing order.
  vibrato:[{key:'rateHz',label:'Rate (Hz)',min:1,max:14,step:.1},{key:'depthCents',label:'Depth (cents)',min:0,max:100,step:1}],
  phaser:[{key:'rateHz',label:'Rate (Hz)',min:.05,max:5,step:.05},{key:'depth',label:'Depth',min:0,max:1,step:.01},{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  flanger:[{key:'rateHz',label:'Rate (Hz)',min:.05,max:5,step:.05},{key:'depthMs',label:'Depth (ms)',min:0,max:10,step:.1},{key:'feedback',label:'Feedback',min:-.9,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  chorus:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:8,step:.1},{key:'depthMs',label:'Depth (ms)',min:0,max:20,step:.1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  tremolo:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:20,step:.1},{key:'depth',label:'Depth',min:0,max:1,step:.01}],
  delay:[{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  reverb:[{key:'room',label:'Room',min:0,max:1,step:.01},{key:'damping',label:'Damping',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
};
