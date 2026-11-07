import { model,Settings,StaveProfile,SystemsLayoutMode } from '@coderline/alphatab';
import type { EngravingOverrides } from './types';
import { scoreFromJson } from '../model-clone';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { copyGpInterchangeSource } from '../interchange/gp';
import { configureTypography,typographyOf,validateTypography } from './typography';
import { validateBarWidths } from './bar-widths';
import { validateSystemGaps } from './system-gaps';
import { configureRoleFonts,validateFonts } from './fonts';

export interface EngravingProjection {
  score:model.Score;
  beats:Map<number,{source:model.Beat;rendered:model.Beat}>;
  notes:Map<number,{source:model.Note;rendered:model.Note}>;
}
export function defaultEngraving():EngravingOverrides {
  return {stylesheet:{hideDynamics:null,brackets:'inherit',extendBarLines:null,systemSeparators:null,tuning:null,chords:'inherit',singleNames:'inherit',multiNames:'inherit',firstNames:'inherit',otherNames:'inherit',firstNameDirection:'inherit',otherNameDirection:'inherit',barNumbers:'inherit',multiRests:'inherit',hideEmptyStaves:null,hideEmptyFirstSystem:null,singleStaffBrackets:null},notation:{tabRhythm:'inherit',fingering:'inherit',smallGraceTab:null,extendBendArrows:null,extendLineEffects:null,parenthesizeTiedBends:null,showTiedBendNumbers:null,showDiveWhammyZeros:null},systemSpacing:null,profiles:[]};
}
const styleBooleans={hideDynamics:'hideDynamics',extendBarLines:'extendBarLines',systemSeparators:'useSystemSignSeparator',tuning:'globalDisplayTuning',hideEmptyStaves:'hideEmptyStaves',hideEmptyFirstSystem:'hideEmptyStavesInFirstSystem',singleStaffBrackets:'showSingleStaffBrackets'} as const;
const styleEnums={
  brackets:{field:'bracketExtendMode',values:{none:0,staves:1,similar:2}},
  singleNames:{field:'singleTrackTrackNamePolicy',values:{hidden:0,firstSystem:1,allSystems:2}},
  multiNames:{field:'multiTrackTrackNamePolicy',values:{hidden:0,firstSystem:1,allSystems:2}},
  firstNames:{field:'firstSystemTrackNameMode',values:{full:0,short:1}},otherNames:{field:'otherSystemsTrackNameMode',values:{full:0,short:1}},
  firstNameDirection:{field:'firstSystemTrackNameOrientation',values:{horizontal:0,vertical:1}},otherNameDirection:{field:'otherSystemsTrackNameOrientation',values:{horizontal:0,vertical:1}},
  barNumbers:{field:'barNumberDisplay',values:{all:0,firstSystem:1,hidden:2}},
} as const;
const notationBooleans={smallGraceTab:'smallGraceTabNotes',extendBendArrows:'extendBendArrowsOnTiedNotes',extendLineEffects:'extendLineEffectsToBeatEnd'} as const;
const elementKeys={parenthesizeTiedBends:11,showTiedBendNumbers:12,showDiveWhammyZeros:13} as const;
const notationEnums={tabRhythm:{field:'rhythmMode',values:{hidden:0,beams:1,connected:2,auto:3}},fingering:{field:'fingeringMode',values:{score:0,piano:1,above:2,abovePiano:3}}} as const;
function object(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid engraving fields.');
  return value as Record<string,unknown>;
}
const validBool=(value:unknown)=>value===null||typeof value==='boolean';
function choice(value:unknown,choices:string[]):void {if(typeof value!=='string'||!choices.includes(value))throw new Error('Invalid engraving choice.');}
export function validateEngraving(value:unknown):asserts value is EngravingOverrides {
  const defaults=defaultEngraving(),hasTypography=!!value&&typeof value==='object'&&Object.hasOwn(value,'typography'),hasWidths=!!value&&typeof value==='object'&&Object.hasOwn(value,'barWidths'),hasGaps=!!value&&typeof value==='object'&&Object.hasOwn(value,'systemGaps'),hasFonts=!!value&&typeof value==='object'&&Object.hasOwn(value,'fonts'),root=object(value,[...Object.keys(defaults),...hasTypography?['typography']:[],...hasWidths?['barWidths']:[],...hasGaps?['systemGaps']:[],...hasFonts?['fonts']:[]]),style=object(root.stylesheet,Object.keys(defaults.stylesheet)),notation=object(root.notation,Object.keys(defaults.notation));
  for(const [section,keys]of [[style,Object.keys(styleBooleans)],[notation,[...Object.keys(notationBooleans),...Object.keys(elementKeys)]]] as const)for(const key of keys)if(!validBool(section[key]))throw new Error('Invalid engraving boolean.');
  for(const [section,mappings]of [[style,styleEnums],[notation,notationEnums]] as const)for(const [key,mapping]of Object.entries(mappings))choice(section[key],['inherit',...Object.keys(mapping.values)]);
  choice(style.chords,['inherit','hidden','top','inline','both']);choice(style.multiRests,['inherit','off','on']);
  if(root.systemSpacing!==null&&(typeof root.systemSpacing!=='number'||!Number.isFinite(root.systemSpacing)||root.systemSpacing<.25||root.systemSpacing>4))throw new Error('System spacing must be between 25% and 400%.');
  if(hasTypography)validateTypography(root.typography);
  if(hasWidths)validateBarWidths(root.barWidths);
  if(hasGaps)validateSystemGaps(root.systemGaps);
  if(hasFonts)validateFonts(root.fonts);
  if(!Array.isArray(root.profiles))throw new Error('Invalid engraving profiles.');
  const ids=new Set<string>();for(const entry of root.profiles){const profile=object(entry,['trackId','profile']);if(typeof profile.trackId!=='string'||!profile.trackId.trim()||ids.has(profile.trackId))throw new Error('Engraving track IDs must be nonempty and unique.');ids.add(profile.trackId);choice(profile.profile,['source','standard','tablature','standardTab','slash','numbered']);}
}
function liveTracks(score:model.Score,ids:readonly string[],value:EngravingOverrides,requireLive:boolean):void {
  if(ids.length!==score.tracks.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id.trim()))throw new Error('Invalid source track identities.');
  for(const entry of value.profiles){const index=ids.indexOf(entry.trackId);if(index<0){if(requireLive)throw new Error('Engraving profile refers to a missing track.');continue;}
    const staves=score.tracks[index].staves;
    if(entry.profile==='tablature'&&staves.some(staff=>!staff.tuning.length||staff.isPercussion))throw new Error('Tablature requires tuned nonpercussion staves.');
    if(entry.profile==='numbered'&&staves.some(staff=>staff.isPercussion))throw new Error('Numbered notation is unavailable for percussion.');
  }
}
export function validateEngravingTracks(score:model.Score,ids:readonly string[],value:EngravingOverrides):void {validateEngraving(value);liveTracks(score,ids,value,true);}
export function projectEngraving(source:model.Score,ids:readonly string[],value:EngravingOverrides):EngravingProjection {
  validateEngraving(value);liveTracks(source,ids,value,false);
  const score=scoreFromJson(model.JsonConverter.scoreToJson(source),new Settings());restoreNoteLinks(score,captureNoteLinks(source));copyGpInterchangeSource(source,score);
  const beats:EngravingProjection['beats']=new Map(),notes:EngravingProjection['notes']=new Map(),profiles=new Map(value.profiles.map(entry=>[entry.trackId,entry.profile]));
  source.tracks.forEach((track,ti)=>track.staves.forEach((staff,si)=>{
    const rendered=score.tracks[ti].staves[si],profile=profiles.get(ids[ti])??'source',stringed=staff.tuning.length>0&&!staff.isPercussion;
    // JSON replay normalizes untuned/percussion tablature flags; source means the original tuple.
    const flags=profile==='source'?[staff.showStandardNotation,staff.showTablature,staff.showSlash,staff.showNumbered]:profile==='standard'?[true,false,false,false]:profile==='tablature'?[false,true,false,false]:profile==='standardTab'?[true,stringed,false,false]:profile==='slash'?[false,false,true,false]:[false,false,false,true];
    [rendered.showStandardNotation,rendered.showTablature,rendered.showSlash,rendered.showNumbered]=flags;
    staff.bars.forEach((bar,bi)=>bar.voices.forEach((voice,vi)=>voice.beats.forEach((beat,bti)=>{
      const copy=rendered.bars[bi].voices[vi].beats[bti];beats.set(beat.id,{source:beat,rendered:copy});beat.notes.forEach((note,ni)=>notes.set(note.id,{source:note,rendered:copy.notes[ni]}));
    })));
  }));
  // The public tie-ID JSON replay path omits the continued bend's origin link.
  for(const pair of notes.values())pair.rendered.bendOrigin=pair.source.bendOrigin?notes.get(pair.source.bendOrigin.id)?.rendered??null:null;
  const style=score.stylesheet,overrides=value.stylesheet;
  for(const [key,field]of Object.entries(styleBooleans)){const override=overrides[key as keyof typeof styleBooleans];if(override!==null)Object.assign(style,{[field]:override});}
  for(const [key,mapping]of Object.entries(styleEnums)){const override=overrides[key as keyof typeof styleEnums];if(override!=='inherit')Object.assign(style,{[mapping.field]:(mapping.values as Record<string,number>)[override]});}
  if(overrides.tuning!==null)style.perTrackDisplayTuning?.clear();
  if(overrides.chords!=='inherit'){style.globalDisplayChordDiagramsOnTop=overrides.chords==='top'||overrides.chords==='both';style.globalDisplayChordDiagramsInScore=overrides.chords==='inline'||overrides.chords==='both';style.perTrackChordDiagramsOnTop?.clear();}
  if(overrides.barNumbers!=='inherit')for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)bar.barNumberDisplay=undefined;
  if(overrides.multiRests!=='inherit'){style.multiTrackMultiBarRest=overrides.multiRests==='on';style.perTrackMultiBarRest=new Set(overrides.multiRests==='on'?score.tracks.map((_,i)=>i):[]);}
  // A bar's width is its weight in the system: master bars decide it when several staves show, each bar when one does. Only the copy changes, so playback and MIDI read the unchanged source.
  for(const {bar,scale} of value.barWidths??[]){const master=score.masterBars[bar];if(!master)continue;master.displayScale=scale;for(const track of score.tracks)for(const staff of track.staves){const copy=staff.bars[bar];if(copy)copy.displayScale=scale;}}
  return {score,beats,notes};
}
export function configureEngraving(settings:Settings,value:EngravingOverrides):void {
  validateEngraving(value);const defaults=new Settings();
  for(const [key,field]of Object.entries(notationBooleans)){const override=value.notation[key as keyof typeof notationBooleans];settings.notation[field as typeof notationBooleans[keyof typeof notationBooleans]]=override??defaults.notation[field as typeof notationBooleans[keyof typeof notationBooleans]];}
  for(const [key,mapping]of Object.entries(notationEnums)){const override=value.notation[key as keyof typeof notationEnums];Object.assign(settings.notation,{[mapping.field]:override==='inherit'?defaults.notation[mapping.field]:(mapping.values as Record<string,number>)[override]});}
  for(const [key,element]of Object.entries(elementKeys)){const override=value.notation[key as keyof typeof elementKeys];if(override!==null)settings.notation.elements.set(element,override);else if(defaults.notation.elements.has(element))settings.notation.elements.set(element,defaults.notation.elements.get(element)!);else settings.notation.elements.delete(element);}
  for(const field of ['systemPaddingTop','systemPaddingBottom','lastSystemPaddingBottom'] as const)settings.display[field]=defaults.display[field]*(value.systemSpacing??1);
  const typography=typographyOf(value);configureTypography(settings,typography);configureRoleFonts(settings,value.fonts,typography);
  settings.display.staveProfile=StaveProfile.Default;settings.display.systemsLayoutMode=SystemsLayoutMode.UseModelLayout;
}
/** Gives the track inserted after `source` a copy of its per-track style and shifts later tracks. */
export function duplicateStylesheetTrack(stylesheet:model.Score['stylesheet'],source:number):void {
  const shift=(index:number)=>index>source?index+1:index;
  const copy=(map:Map<number,boolean>|null)=>map===null?null:new Map([...map].flatMap(([index,value])=>index===source?[[index,value],[index+1,value]] as const:[[shift(index),value] as const]));
  const rests=stylesheet.perTrackMultiBarRest===null?null:new Set([...stylesheet.perTrackMultiBarRest].flatMap(index=>index===source?[index,index+1]:[shift(index)]));
  stylesheet.perTrackDisplayTuning=copy(stylesheet.perTrackDisplayTuning);stylesheet.perTrackChordDiagramsOnTop=copy(stylesheet.perTrackChordDiagramsOnTop);stylesheet.perTrackMultiBarRest=rests;
}

export function remapStylesheetTracks(stylesheet:model.Score['stylesheet'],oldToNew:Array<number|null>):void {
  const seen=new Set<number>();if(!Array.isArray(oldToNew))throw new Error('Invalid stylesheet track mapping.');
  for(const target of oldToNew)if(target!==null){if(!Number.isInteger(target)||target<0||target>=oldToNew.length||seen.has(target))throw new Error('Invalid stylesheet track mapping.');seen.add(target);}
  const remap=(map:Map<number,boolean>|null)=>map===null?null:new Map([...map].flatMap(([old,value])=>{const next=oldToNew[old];return next===null||next===undefined?[]:[[next,value] as const];}));
  const tuning=remap(stylesheet.perTrackDisplayTuning),chords=remap(stylesheet.perTrackChordDiagramsOnTop),rests=stylesheet.perTrackMultiBarRest===null?null:new Set([...stylesheet.perTrackMultiBarRest].flatMap(old=>{const next=oldToNew[old];return next===null||next===undefined?[]:[next];}));
  stylesheet.perTrackDisplayTuning=tuning;stylesheet.perTrackChordDiagramsOnTop=chords;stylesheet.perTrackMultiBarRest=rests;
}
