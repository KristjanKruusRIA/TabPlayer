import { getMessage, getResolvedLanguage, type SupportedLanguage, type MessageKey } from '../i18n';
import { defaultEffects } from '../document-settings';
import type { EffectBlock, FxSettings, PickupPosition, TrackSound } from '../edit-types';
import { getSoundbankStatus, type Gp8SetInfo, type Gp8Status } from './soundbank-store';

/** The sound a preset names; `gm` is no effects at all. */
export function soundPreset(presetId:TrackSound['presetId'],voiceId:string|null=null):TrackSound {
  const effects=defaultEffects();
  if(presetId!=='gm'){effects.amp.enabled=true;effects.cabinet.enabled=true;effects.amp.model=presetId;}
  if(presetId==='crunch'){effects.amp.drive=.4;effects.cabinet.model='closed';effects.eq.enabled=true;effects.eq.midDb=2;}
  if(presetId==='lead'){effects.amp.drive=.75;effects.cabinet.model='closed';effects.delay.enabled=true;effects.reverb.enabled=true;}
  if(presetId==='bass'){effects.amp.drive=.2;effects.cabinet.model='bass';effects.compressor.enabled=true;effects.compressor.makeupDb=3;effects.eq.enabled=true;effects.eq.lowDb=3;effects.eq.highDb=-2;}
  return {voiceId,presetId,effects};
}
export type NumericControl={key:string;label:string;min:number;max:number;step:number;/** One line that says what the control does, shown as its tooltip. */hint?:string};
/** The graphic EQ's bands, an octave apart, as their centres are named. */
export const graphicBands=['31','63','125','250','500','1k','2k','4k','8k','16k'];
export const presetIds=['gm','clean','crunch','lead','bass'] as const;

export function localizedBlockName(block: EffectBlock, lang?: SupportedLanguage): string {
  const language = lang ?? getResolvedLanguage();
  return getMessage(language, `block.${block}` as MessageKey) || blockNames[block];
}

export function localizedPresetName(id: string, lang?: SupportedLanguage): string {
  const language = lang ?? getResolvedLanguage();
  const map: Record<string, MessageKey> = {
    gm: 'sound.preset_bypass',
    clean: 'sound.preset_clean',
    crunch: 'sound.preset_crunch',
    lead: 'sound.preset_lead',
    bass: 'sound.preset_bass',
  };
  const key = map[id];
  return key ? getMessage(language, key) : (id === 'gm' ? 'Bypass' : id[0].toUpperCase() + id.slice(1));
}

export function localizedAmpModelName(model: string, lang?: SupportedLanguage): string {
  const language = lang ?? getResolvedLanguage();
  const map: Record<string, MessageKey> = {
    clean: 'sound.amp_clean',
    crunch: 'sound.amp_crunch',
    lead: 'sound.amp_lead',
    metal: 'sound.amp_metal',
    bass: 'sound.amp_bass',
    bassDrive: 'sound.amp_bass_drive',
  };
  const key = map[model];
  return key ? getMessage(language, key) : modelName(model);
}

export function localizedCabinetModelName(model: string, lang?: SupportedLanguage): string {
  const language = lang ?? getResolvedLanguage();
  const map: Record<string, MessageKey> = {
    open: 'sound.cab_open',
    closed: 'sound.cab_closed',
    combo: 'sound.cab_combo',
    bass: 'sound.cab_bass',
    bassStack: 'sound.cab_bass_stack',
  };
  const key = map[model];
  return key ? getMessage(language, key) : modelName(model);
}

/** The tooltip of a control that has one, in the language. */
export function localizedParamHint(key: string, defaultHint: string|undefined, lang?: SupportedLanguage): string|undefined {
  if(key!=='lowEndOct')return defaultHint;
  return getMessage(lang ?? getResolvedLanguage(), 'param.low_end_oct_hint');
}

export function localizedParamLabel(block: EffectBlock, key: string, defaultLabel: string, lang?: SupportedLanguage): string {
  const language = lang ?? getResolvedLanguage();
  const map: Record<string, MessageKey> = {
    thresholdDb: 'param.threshold_db',
    releaseMs: 'param.release_ms',
    ratio: 'param.ratio',
    attackMs: 'param.attack_ms',
    makeupDb: 'param.makeup_db',
    position: 'param.pedal_position',
    resonance: 'param.resonance',
    sensitivity: 'param.sensitivity',
    mix: 'param.mix',
    octaveDown: 'param.octave_down',
    twoOctavesDown: 'param.two_octaves_down',
    direct: 'param.direct',
    semitones: 'param.semitones',
    drive: 'param.drive',
    tone: 'param.tone',
    levelDb: 'param.level_db',
    gainDb: 'param.gain_db',
    bassDb: 'param.bass_db',
    midDb: 'param.mid_db',
    trebleDb: 'param.treble_db',
    presenceDb: 'param.presence_db',
    lowEndOct: 'param.low_end_oct',
    lowDb: 'param.low_db',
    highDb: 'param.high_db',
    midHz: 'param.mid_hz',
    rateHz: 'param.rate_hz',
    depthCents: 'param.depth_cents',
    depth: 'param.depth',
    depthMs: 'param.depth_ms',
    feedback: 'param.feedback',
    room: 'param.room',
    damping: 'param.damping',
  };
  const msgKey = map[key];
  return msgKey ? getMessage(language, msgKey) : defaultLabel;
}

export const presetName=(id:string)=>id==='gm'?'Bypass':id[0].toUpperCase()+id.slice(1);
export const ampModels=['clean','crunch','lead','metal','bass','bassDrive'] as const,cabinetModels=['open','closed','combo','bass','bassStack'] as const;
/** The amp models that take `lowEndOct`: the metal preamp. The others ignore it: clean and bass have no preamp stages, the crunch and lead were not tuned for it (a held note's lows fall past an octave), and the bass drive's low end goes around its stages, tuned against its cuts. */
export const lowEndModels=['metal'] as const;
/** The controls of `block` that do something for its current model, so a knob that is inert is not shown; its stored value stays. */
export function visibleParameters(block:EffectBlock,effects:FxSettings):NumericControl[] {
  if(block==='amp'&&!(lowEndModels as readonly string[]).includes(effects.amp.model))return parameters.amp.filter(p=>p.key!=='lowEndOct');
  return parameters[block];
}
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
  amp:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'gainDb',label:'Gain (dB)',min:-24,max:24,step:.1},{key:'bassDb',label:'Bass (dB)',min:-12,max:12,step:.5},{key:'midDb',label:'Mid (dB)',min:-12,max:12,step:.5},{key:'trebleDb',label:'Treble (dB)',min:-12,max:12,step:.5},{key:'presenceDb',label:'Presence (dB)',min:-12,max:12,step:.5},{key:'lowEndOct',label:'Low tune (oct)',min:0,max:1,step:.25,hint:"Extends the amp's low end for a guitar tuned low: moves the preamp's low cut down by this many octaves."}],cabinet:[],
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

/** The recorded and sampled sources a track can play through. `null` in a sound means Automatic. */
export type LegacyVoiceId='green-guitar'|'black-guitar'|'darkblack-bass'|'babyblue-bass';
export type VoiceId='gm'|LegacyVoiceId|string;
export const voiceIds:readonly VoiceId[]=['gm'];
export const legacyVoiceIds:readonly LegacyVoiceId[]=['green-guitar','black-guitar','darkblack-bass','babyblue-bass'];
export const legacyVoiceToGp8Set:Record<LegacyVoiceId,string>={
  'green-guitar':'Strat-Guitar',
  'black-guitar':'Metal-Guitar',
  'darkblack-bass':'Jazz-Bass',
  'babyblue-bass':'Pre-Bass',
};
export const voiceNames:Record<string,string>={
  gm:'General MIDI',
  'green-guitar':'Green Guitar',
  'black-guitar':'Black Guitar',
  'darkblack-bass':'Darkblack Bass',
  'babyblue-bass':'Babyblue Bass',
};

const PITCHED_GM_DEFAULT_SETS:Readonly<Record<number,readonly string[]>>={
  0:['German-APiano','Eastern-APiano'],
  1:['Eastern-APiano','German-APiano'],
  2:['CP-EPiano','MarkI-EPiano'],
  3:['Upright-APiano','German-APiano'],
  4:['MarkI-EPiano','200A-EPiano'],
  5:['200A-EPiano','MarkI-EPiano'],
  6:['Harpsichord-Key'],
  7:['AddClavinet-Key','Harpsichord-Key'],
  8:['Celesta-Tuned'],
  9:['Vibraphone-Tuned','Celesta-Tuned'],
  10:['Vibraphone-Tuned','Celesta-Tuned'],
  11:['Vibraphone-Tuned','Celesta-Tuned'],
  12:['Xylophone-Tuned','Vibraphone-Tuned'],
  13:['Xylophone-Tuned','Vibraphone-Tuned'],
  14:['Xylophone-Tuned','Vibraphone-Tuned'],
  15:['Xylophone-Tuned','Vibraphone-Tuned'],
  16:['Ballad-Organ','Full-Organ'],
  17:['Jazz-Organ','Full-Organ'],
  18:['Rock-Organ','Full-Organ'],
  19:['Full-Organ','Ballad-Organ'],
  20:['Full-Organ','Ballad-Organ'],
  21:['Accordion','Bandoneon'],
  22:['Harmonica'],
  23:['Bandoneon','Accordion'],
  24:['Concerto-Nylon'],
  25:['D-Steel'],
  26:['Jazz-Guitar','ES-Guitar','L4-Guitar'],
  27:['Strat-Guitar','Tele-Guitar'],
  28:['Strat-Guitar','Tele-Guitar'],
  29:['Classic-Guitar','Strat-Guitar'],
  30:['Metal-Guitar','Classic-Guitar'],
  31:['Strat-Guitar'],
  32:['Acoustic-Bass'],
  33:['Jazz-Bass','Pre-Bass'],
  34:['Pre-Bass','Jazz-Bass'],
  35:['Fretless-Bass','Jazz-Bass'],
  36:['Jazz-Bass','Modern-Bass'],
  37:['Modern-Bass','Jazz-Bass'],
  38:['FMSyn-Bass','OB-Bass'],
  39:['OB-Bass','FMSyn-Bass'],
  40:['Violin-Solo','Violin1-Ensemble'],
  41:['Viola-Solo','Violin1-Ensemble'],
  42:['Cello-Solo'],
  43:['Contrabass-Solo'],
  44:['Violin1-Ensemble'],
  45:['Violin1-Ensemble-Pizz','Violin1-Ensemble'],
  46:['Harp-Solo'],
  47:['TimpaniLo-Tuned'],
  48:['Violin1-Ensemble'],
  49:['Violin1-Ensemble'],
  50:['OBStrings-Pad','SolinaString-Pad'],
  51:['OBStrings-Pad','SolinaString-Pad'],
  52:['MetaChoir-Pad','Vocal-Pad'],
  53:['MetaChoir-Pad','Vocal-Pad'],
  54:['Vocal-Pad','MetaChoir-Pad'],
  55:['SolinaString-Pad','OBStrings-Pad'],
  56:['Trumpet-Solo'],
  57:['Trombone-Solo'],
  58:['BassTuba-Solo'],
  59:['Trumpet-Sordino-Solo','Trumpet-Solo'],
  60:['FrenchHorn-Solo'],
  61:['Trumpet-Ensemble','Trumpet-Solo'],
  62:['Simple-Brass','FM-Brass'],
  63:['FM-Brass','Simple-Brass'],
  64:['Soprano-Sax','Alto-Sax'],
  65:['Alto-Sax'],
  66:['Tenor-Sax'],
  67:['Baritone-Sax'],
  68:['Oboe-Solo'],
  69:['EnglishHorn-Solo'],
  70:['Bassoon-Solo'],
  71:['Clarinet-Solo'],
  72:['Piccolo-Solo','Flute-Solo'],
  73:['Flute-Solo'],
  74:['Recorder-Solo','Flute-Solo'],
  75:['Recorder-Solo','Flute-Solo'],
  76:['Recorder-Solo','Flute-Solo'],
  77:['Recorder-Solo','Flute-Solo'],
  78:['Recorder-Solo','Flute-Solo'],
  79:['Recorder-Solo','Flute-Solo'],
  80:['Classic-Lead'],
  81:['Dist-Lead','Classic-Lead'],
  82:['Brassy-Lead','Classic-Lead'],
  83:['Brassy-Lead','Classic-Lead'],
  84:['Dave-Lead','Classic-Lead'],
  85:['Dave-Lead','Classic-Lead'],
  86:['Dave-Lead','Classic-Lead'],
  87:['Dave-Lead','Classic-Lead'],
  88:['Warm-Pad','Lush-Pad'],
  89:['Warm-Pad','Lush-Pad'],
  90:['MetaChoir-Pad','Warm-Pad'],
  91:['MetaChoir-Pad','Warm-Pad'],
  92:['Lush-Pad','OBStrings-Pad','Warm-Pad'],
  93:['Lush-Pad','OBStrings-Pad','Warm-Pad'],
  94:['Lush-Pad','OBStrings-Pad','Warm-Pad'],
  95:['Lush-Pad','OBStrings-Pad','Warm-Pad'],
  104:['Electric-Sitar'],
  105:['5-Banjo'],
  106:['5-Banjo'],
  107:['5-Banjo'],
  108:['5-Banjo'],
  109:['Bagpipe'],
  110:['Violin-Solo'],
  111:['Oboe-Solo'],
};

/** Returns the default GP8 set id for `program` / `percussion` / `drumKit` if installed and enabled, or null. */
export function defaultGp8SetForProgram(
  program:number,
  percussion:boolean,
  drumKit?:number|null,
  status:Gp8Status=getSoundbankStatus(),
):string|null {
  if(!status.available)return null;
  const availableIds=new Set(status.sets.map(s=>s.id));
  const pick=(candidates:readonly string[])=>candidates.find(id=>availableIds.has(id))??null;
  if(percussion) {
    if(drumKit===8)return pick(['Drumkit-Oak','Drumkit-Master','Drumkit-Custom']);
    if(drumKit===32)return pick(['Drumkit-Vintage','Drumkit-Star','Drumkit-Custom']);
    if(drumKit===40)return pick(['Drumkit-Vintage','Drumkit-Custom']);
    return pick(['Drumkit-Custom','Drumkit-Master']);
  }
  const direct=PITCHED_GM_DEFAULT_SETS[program];
  if(direct)return pick(direct);
  if(program>=96&&program<=103)return pick(['Harpy-Seq','Warm-Pad']);
  if(program>=112&&program<=119)return pick(['Vibraphone-Tuned','Celesta-Tuned']);
  return null;
}

/** Resolves the active GP8 set metadata for a track sound if GP8 is active and plays it, or null (GM fallback). */
export function resolvedGp8Set(
  voiceId:string|null|undefined,
  program:number,
  percussion:boolean,
  drumKit:number|null|undefined,
  status:Gp8Status=getSoundbankStatus(),
):Gp8SetInfo|null {
  if(!status.available||voiceId==='gm')return null;
  let targetSetId:string|null=null;
  if(voiceId) {
    if(voiceId.startsWith('gp8:'))targetSetId=voiceId.slice(4);
    else if(Object.hasOwn(legacyVoiceToGp8Set,voiceId))targetSetId=legacyVoiceToGp8Set[voiceId as LegacyVoiceId];
  } else {
    targetSetId=defaultGp8SetForProgram(program,percussion,drumKit,status);
  }
  if(!targetSetId)return null;
  return status.sets.find(s=>s.id===targetSetId)??null;
}

/** What Automatic plays a track as: `gp8:<set>` when GP8 is available and covers it, otherwise `'gm'`. */
export function automaticVoice(
  program:number,
  percussion:boolean,
  status:Gp8Status=getSoundbankStatus(),
  drumKit?:number|null,
):VoiceId {
  const gp8Id=defaultGp8SetForProgram(program,percussion,drumKit,status);
  return gp8Id?`gp8:${gp8Id}`:'gm';
}

export function voiceDisplayName(
  voiceId:string|null|undefined,
  program:number,
  percussion:boolean,
  drumKit?:number|null,
  status:Gp8Status=getSoundbankStatus(),
):string {
  if(!voiceId) {
    const set=resolvedGp8Set(null,program,percussion,drumKit,status);
    return set?set.name:voiceNames.gm;
  }
  if(voiceId==='gm')return voiceNames.gm;
  if(voiceId.startsWith('gp8:')) {
    const id=voiceId.slice(4);
    return status.sets.find(s=>s.id===id)?.name??id;
  }
  const legacySet=resolvedGp8Set(voiceId,program,percussion,drumKit,status);
  if(legacySet)return legacySet.name;
  return voiceNames[voiceId]??voiceId;
}

export const GP8_CATEGORY_ORDER=['guitars','basses','drums','keys','strings','winds','synths','percussion','other'] as const;

export function gp8SetGroups(
  status:Gp8Status,
  percussion:boolean,
):Array<{category:string;sets:Gp8SetInfo[]}> {
  if(!status.available||status.sets.length===0)return [];
  const filtered=status.sets.filter(s=>percussion?s.isPercussion:!s.isPercussion);
  const byCategory=new Map<string,Gp8SetInfo[]>();
  for(const set of filtered) {
    const list=byCategory.get(set.category)??[];
    list.push(set);
    byCategory.set(set.category,list);
  }
  return GP8_CATEGORY_ORDER
    .filter(cat=>byCategory.has(cat))
    .map(cat=>({category:cat,sets:byCategory.get(cat)!}));
}

export function availablePickupsForVoice(
  voiceId:string|null|undefined,
  program:number,
  percussion:boolean,
  drumKit?:number|null,
  status:Gp8Status=getSoundbankStatus(),
):readonly PickupPosition[] {
  if(percussion)return [];
  const set=resolvedGp8Set(voiceId,program,false,drumKit,status);
  return set&&set.pickups.length>1?set.pickups:[];
}

/** Explicit non-automatic source options (`gm`, active/stored voiceId, plus installed GP8 sets). */
export function sourceChoices(
  percussion:boolean,
  voiceId?:string|null,
  status:Gp8Status=getSoundbankStatus(),
):VoiceId[] {
  const result:VoiceId[]=['gm'];
  if(status.available) {
    for(const group of gp8SetGroups(status,percussion)) {
      for(const set of group.sets)result.push(`gp8:${set.id}`);
    }
  }
  if(voiceId&&voiceId!=='gm'&&!result.includes(voiceId)) {
    result.push(voiceId);
  }
  return result;
}

export function playsRecordedKit(
  program:number,
  percussion:boolean,
  drumKit?:number|null,
  status:Gp8Status=getSoundbankStatus(),
):boolean {
  void program;
  void drumKit;
  return percussion&&status.available&&defaultGp8SetForProgram(program,true,drumKit,status)!==null;
}
