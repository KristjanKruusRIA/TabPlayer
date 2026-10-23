import type { model } from '@coderline/alphatab';
import type { DocumentSettings, FxSettings, SettingsEdit, TrackSound, ChannelMix, PrintLayout, BackingSettings } from './edit-types';
import {defaultEngraving,validateEngravingTracks} from './engraving/projection';
import {validatePageLayout} from './engraving/page';

/** A duplicated track starts with its source's sound, mix and engraving profile; later changes are separate. */
export function copyTrackSettings(settings:DocumentSettings,source:string,copy:string):void {
  if(settings.sounds[source])settings.sounds[copy]=completeSound(structuredClone(settings.sounds[source]));
  if(settings.mixes[source])settings.mixes[copy]=structuredClone(settings.mixes[source]);
  const profile=settings.engraving.profiles.find(entry=>entry.trackId===source);
  if(profile)settings.engraving={...settings.engraving,profiles:[...settings.engraving.profiles,{...profile,trackId:copy}]};
}
export type { DocumentSettings, FxSettings, TrackSound, ChannelMix, PrintLayout, SyncAnchor, BackingSettings, ReferenceSyncBounds } from './edit-types';

export const defaultMix = (): ChannelMix => ({gain:1,pan:0,mute:false,solo:false});
export const defaultEffects = (): FxSettings => ({
  gate:{enabled:false,thresholdDb:-60,releaseMs:100},
  compressor:{enabled:false,thresholdDb:-18,ratio:4,attackMs:10,releaseMs:100,makeupDb:0},
  amp:{enabled:false,model:'clean',drive:.1,gainDb:0},cabinet:{enabled:false,model:'open'},
  eq:{enabled:false,lowDb:0,midDb:0,highDb:0,midHz:1000},chorus:{enabled:false,rateHz:1,depthMs:5,mix:.15},
  delay:{enabled:false,quarterNotes:1,feedback:.25,mix:.15},reverb:{enabled:false,model:'room',room:.5,damping:.5,mix:.12},
  vibrato:{enabled:false,rateHz:5,depthCents:20},phaser:{enabled:false,rateHz:.5,depth:.7,feedback:.3,stages:4,mix:.5},
  flanger:{enabled:false,rateHz:.25,depthMs:2,feedback:.5,mix:.5},tremolo:{enabled:false,rateHz:5,depth:.5,shape:'sine'},
  wah:{enabled:false,mode:'manual',position:.5,resonance:.5,sensitivity:.5,mix:1},
  octaver:{enabled:false,octaveDown:.5,twoOctavesDown:0,direct:1},pitch:{enabled:false,semitones:12,mix:1},drive:{enabled:false,model:'overdrive',drive:.5,tone:.5,levelDb:0},
});
/** Adds the effect blocks a sound saved before them lacks, switched off at their defaults, and reads a reverb saved
 * before its models as the room. */
export const completeSound = (sound: TrackSound): TrackSound => {
  const effects={...defaultEffects(),...sound.effects},reverb=effects.reverb as Partial<FxSettings['reverb']>|undefined;
  if(reverb&&typeof reverb==='object'&&!Array.isArray(reverb)&&reverb.model===undefined)effects.reverb={...reverb,model:'room'} as FxSettings['reverb'];
  return {...sound,effects};
};
const range=(low:number,high:number)=>({low,high}),one=(...values:(string|number)[])=>({one:values}),unit=range(0,1);
type FieldRule=ReturnType<typeof range>|ReturnType<typeof one>;
/** Every effect field and its accepted values, as the native FxSettings::validate checks them. */
const effectRules:Record<keyof FxSettings,Record<string,FieldRule>>={
  gate:{thresholdDb:range(-96,0),releaseMs:range(1,1000)},
  compressor:{thresholdDb:range(-60,0),ratio:range(1,20),attackMs:range(.1,200),releaseMs:range(1,2000),makeupDb:range(0,24)},
  amp:{model:one('clean','crunch','lead','bass'),drive:unit,gainDb:range(-24,24)},cabinet:{model:one('open','closed','bass')},
  eq:{lowDb:range(-24,24),midDb:range(-24,24),highDb:range(-24,24),midHz:range(200,5000)},
  chorus:{rateHz:range(.1,8),depthMs:range(0,20),mix:unit},
  wah:{mode:one('manual','auto'),position:unit,resonance:unit,sensitivity:unit,mix:unit},
  octaver:{octaveDown:unit,twoOctavesDown:unit,direct:unit},pitch:{semitones:range(-24,24),mix:unit},
  drive:{model:one('overdrive','distortion','fuzz'),drive:unit,tone:unit,levelDb:range(-24,12)},
  flanger:{rateHz:range(.05,5),depthMs:range(0,10),feedback:range(-.9,.9),mix:unit},
  phaser:{rateHz:range(.05,5),depth:unit,feedback:range(0,.9),stages:one(2,4,6,8),mix:unit},
  tremolo:{rateHz:range(.1,20),depth:unit,shape:one('sine','square')},vibrato:{rateHz:range(1,14),depthCents:range(0,100)},
  delay:{quarterNotes:one(.125,.25,.5,1,2,4),feedback:range(0,.9),mix:unit},reverb:{model:one('room','hall','plate','spring'),room:unit,damping:unit,mix:unit},
};
const fits=(value:unknown,rule:FieldRule)=>'one' in rule?rule.one.includes(value as string|number):typeof value==='number'&&Number.isFinite(value)&&value>=rule.low&&value<=rule.high;
/** Why a sound cannot be applied, or null. It is checked as completed with any blocks it lacks, against the native rules. */
export function soundProblem(sound: TrackSound): string|null {
  if (!sound||typeof sound!=='object'||Object.keys(sound).sort().join()!=='effects,presetId,voiceId'||!sound.effects||typeof sound.effects!=='object') return 'Invalid sound.';
  if (!['gm','clean','crunch','lead','bass'].includes(sound.presetId)) return 'Invalid sound preset.';
  if (sound.voiceId!==null && !['gm','green-guitar','black-guitar','darkblack-bass','babyblue-bass'].includes(sound.voiceId)) return 'Unknown instrument voice.';
  const {effects}=completeSound(sound);
  if (!effects||typeof effects!=='object'||Object.keys(effects).some(block=>!Object.hasOwn(effectRules,block))) return 'Invalid effect parameter.';
  for (const [block,rules] of Object.entries(effectRules)) {
    const settings=(effects as unknown as Record<string,Record<string,unknown>>)[block];
    if (!settings||typeof settings!=='object'||typeof settings.enabled!=='boolean'||Object.keys(settings).length!==Object.keys(rules).length+1) return 'Invalid effect parameter.';
    for (const [field,rule] of Object.entries(rules)) if (!Object.hasOwn(settings,field)||!fits(settings[field],rule)) return 'Invalid effect parameter.';
  }
  return null;
}
export const defaultPrintLayout = (): PrintLayout => ({paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'ScoreTab'});
export const defaultDocumentSettings = (): DocumentSettings => ({sounds:{},mixes:{},backing:null,print:defaultPrintLayout(),engraving:defaultEngraving(),page:null});

export function validateMix(mix: ChannelMix) {
  if (!mix || !Number.isFinite(mix.gain) || mix.gain<0 || mix.gain>1 || !Number.isFinite(mix.pan) || Math.abs(mix.pan)>1 || typeof mix.mute!=='boolean' || typeof mix.solo!=='boolean') throw new Error('Invalid mixer settings.');
}

export function validateBackingSettings(value:unknown):asserts value is BackingSettings {
  const exact=(candidate:unknown,keys:readonly string[]):candidate is Record<string,unknown>=>!!candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&Object.keys(candidate).length===keys.length&&keys.every(key=>Object.hasOwn(candidate,key));
  if(!value||typeof value!=='object'||!exact(value,['assetId','offsetMs','anchors','mix',...Object.hasOwn(value,'referenceSync')?['referenceSync']:[],...Object.hasOwn(value,'processing')?['processing']:[]]))throw new Error('Invalid backing settings fields.');
  if(typeof value.assetId!=='string'||!value.assetId.length||typeof value.offsetMs!=='number'||!Number.isFinite(value.offsetMs)||!Array.isArray(value.anchors)||!exact(value.mix,['gain','pan','mute','solo']))throw new Error('Invalid backing settings.');
  validateMix(value.mix as unknown as ChannelMix);
  const processing=value.processing;
  if(Object.hasOwn(value,'processing')&&processing!==null) {
    if(!exact(processing,['semitones','cents','filter'])||typeof processing.semitones!=='number'||!Number.isInteger(processing.semitones)||Math.abs(processing.semitones)>12||typeof processing.cents!=='number'||!Number.isInteger(processing.cents)||Math.abs(processing.cents)>100||typeof processing.filter!=='string'||!['none','bassEnhance','bassAttenuation','mediumEnhance','mediumAttenuation','highEnhance','highAttenuation'].includes(processing.filter))throw new Error('Invalid backing processing settings.');
  }
  const bounds=value.referenceSync;
  let entry:number|null=null,exit:number|null=null;
  if(bounds!==undefined&&bounds!==null) {
    if(!exact(bounds,['entryAudioMs','exitAudioMs'])||typeof bounds.entryAudioMs!=='number'||typeof bounds.exitAudioMs!=='number'||!Number.isFinite(bounds.entryAudioMs)||!Number.isFinite(bounds.exitAudioMs))throw new Error('Invalid reference synchronization bounds.');
    entry=bounds.entryAudioMs-value.offsetMs;exit=bounds.exitAudioMs-value.offsetMs;
    if(!Number.isFinite(entry)||entry<0||!Number.isFinite(exit)||exit<=entry||!Number.isFinite(exit-entry))throw new Error('Invalid reference synchronization source bounds.');
  }else if(Object.hasOwn(value,'referenceSync')&&bounds===undefined)throw new Error('Invalid reference synchronization bounds.');
  for(const anchor of value.anchors) {
    if(!exact(anchor,['bar','occurrence','ratio','audioMs'])||typeof anchor.bar!=='number'||!Number.isInteger(anchor.bar)||anchor.bar<0||anchor.bar>0xffffffff||typeof anchor.occurrence!=='number'||!Number.isInteger(anchor.occurrence)||anchor.occurrence<0||anchor.occurrence>0xffffffff||typeof anchor.ratio!=='number'||!Number.isFinite(anchor.ratio)||anchor.ratio<0||anchor.ratio>1||typeof anchor.audioMs!=='number'||!Number.isFinite(anchor.audioMs))throw new Error('Invalid backing synchronization anchor.');
    const source=anchor.audioMs-value.offsetMs;
    if(entry===null?anchor.audioMs<0:!Number.isFinite(source)||source<=entry||source>=exit!)throw new Error('Invalid backing synchronization source position.');
  }
}

export function applySettingsEdit(settings: DocumentSettings, edit: SettingsEdit, score: model.Score, trackIds: readonly string[]) {
  switch (edit.type) {
    case 'setTrackMix':
      if (!trackIds.includes(edit.trackId)) throw new Error('Select an existing track.');
      validateMix(edit.mix); settings.mixes[edit.trackId]=structuredClone(edit.mix); break;
    case 'setTrackSound':
      if (!trackIds.includes(edit.trackId)) throw new Error('Select an existing track.');
      {
        const problem=soundProblem(edit.sound);if(problem)throw new Error(problem);
        settings.sounds[edit.trackId]=structuredClone(completeSound(edit.sound)); break;
      }
    case 'setBacking': {
      const backing=edit.backing;
      if(backing) {
        validateBackingSettings(backing);
        for(const anchor of backing.anchors) if(!score.masterBars[anchor.bar]) throw new Error('Invalid backing synchronization anchor.');
      }
      settings.backing=structuredClone(backing); break;
    }
    case 'setPrintLayout': {
      const p=edit.layout;
      if(!['A4','Letter'].includes(p.paper) || !['portrait','landscape'].includes(p.orientation) || !['ScoreTab','Score','Tab'].includes(p.profile) || !Number.isFinite(p.marginMm) || p.marginMm<0 || !Number.isFinite(p.scale) || p.scale<=0) throw new Error('Invalid print layout.');
      settings.print=structuredClone(p);settings.page=null;break;
    }
    case 'setEngraving':validateEngravingTracks(score,trackIds,edit.engraving);settings.engraving=structuredClone(edit.engraving);break;
    case 'setPageLayout':validatePageLayout(edit.layout);settings.page=structuredClone(edit.layout);break;
  }
}
