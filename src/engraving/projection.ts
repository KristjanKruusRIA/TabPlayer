import { EngravingSettings,model,Settings,StaveProfile,SystemsLayoutMode } from '@coderline/alphatab';
import type { EngravingOverrides } from './types';
import { scoreFromJson } from '../model-clone';
import { captureNoteLinks,restoreNoteLinks,type NoteLinks } from '../editor/links';
import { copyGpInterchangeSource } from '../interchange/gp';
import { configureTypography,typographyOf,validateTypography } from './typography';
import { validateBarWidths } from './bar-widths';
import { validateSystemGaps } from './system-gaps';
import { configureRoleFonts,validateFonts } from './fonts';
import type { MusicFontData } from './font-loading';
import { validateStaffGaps,validateStaffGroups } from './staff-groups';
import { convertDrumTabJson,hideDrumTabTuning,type DrumTabMode,type DrumTabReport } from './drum-tab';

export interface EngravingProjection {
  score:model.Score;
  /** Each source beat and its rendered one. `tab` is the drum tab staff's beat when the track shows its percussion staff and a drum tab (both are drawn; `rendered` is the percussion one). */
  beats:Map<number,{source:model.Beat;rendered:model.Beat;tab?:model.Beat}>;
  /** Likewise for notes. A source note that drum tab left off (more than six hits in a beat, or no number) has no entry of its own on the tab. */
  notes:Map<number,{source:model.Note;rendered:model.Note;tab?:model.Note}>;
  /** Each rendered beat and note to the document's: found by object, so a copy that gave its new objects other ids than the document did still leads back. Drum tab beats and notes lead back too. */
  renderedBeats?:Map<model.Beat,model.Beat>;
  renderedNotes?:Map<model.Note,model.Note>;
  /** What the drum tab conversion did, when a track is shown as drum tab. Absent for every other score. */
  drumTab?:DrumTabReport;
  /** The rendered score's `stylesheet.bracketExtendMode` after overrides. */
  bracketMode:number;
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
  const defaults=defaultEngraving(),hasTypography=!!value&&typeof value==='object'&&Object.hasOwn(value,'typography'),hasWidths=!!value&&typeof value==='object'&&Object.hasOwn(value,'barWidths'),hasGaps=!!value&&typeof value==='object'&&Object.hasOwn(value,'systemGaps'),hasFonts=!!value&&typeof value==='object'&&Object.hasOwn(value,'fonts'),hasStaffGroups=!!value&&typeof value==='object'&&Object.hasOwn(value,'staffGroups'),hasStaffGaps=!!value&&typeof value==='object'&&Object.hasOwn(value,'staffGaps'),root=object(value,[...Object.keys(defaults),...hasTypography?['typography']:[],...hasWidths?['barWidths']:[],...hasGaps?['systemGaps']:[],...hasFonts?['fonts']:[],...hasStaffGroups?['staffGroups']:[],...hasStaffGaps?['staffGaps']:[]]),style=object(root.stylesheet,Object.keys(defaults.stylesheet)),notation=object(root.notation,Object.keys(defaults.notation));
  for(const [section,keys]of [[style,Object.keys(styleBooleans)],[notation,[...Object.keys(notationBooleans),...Object.keys(elementKeys)]]] as const)for(const key of keys)if(!validBool(section[key]))throw new Error('Invalid engraving boolean.');
  for(const [section,mappings]of [[style,styleEnums],[notation,notationEnums]] as const)for(const [key,mapping]of Object.entries(mappings))choice(section[key],['inherit',...Object.keys(mapping.values)]);
  choice(style.chords,['inherit','hidden','top','inline','both']);choice(style.multiRests,['inherit','off','on']);
  if(root.systemSpacing!==null&&(typeof root.systemSpacing!=='number'||!Number.isFinite(root.systemSpacing)||root.systemSpacing<.25||root.systemSpacing>4))throw new Error('System spacing must be between 25% and 400%.');
  if(hasTypography)validateTypography(root.typography);
  if(hasWidths)validateBarWidths(root.barWidths);
  if(hasGaps)validateSystemGaps(root.systemGaps);
  if(hasFonts)validateFonts(root.fonts);
  if(hasStaffGroups)validateStaffGroups(root.staffGroups);
  if(hasStaffGaps)validateStaffGaps(root.staffGaps);
  if(!Array.isArray(root.profiles))throw new Error('Invalid engraving profiles.');
  const ids=new Set<string>();for(const entry of root.profiles){const profile=object(entry,['trackId','profile']);if(typeof profile.trackId!=='string'||!profile.trackId.trim()||ids.has(profile.trackId))throw new Error('Engraving track IDs must be nonempty and unique.');ids.add(profile.trackId);choice(profile.profile,['source','standard','tablature','standardTab','slash','numbered']);}
}
/** A track drawn as drum tab: one percussion staff. Anything else with a percussion staff keeps the profiles it always had. */
export const isDrumTrack=(track:model.Track):boolean=>track.staves.length===1&&track.staves[0].isPercussion;
/** Whether the 'tablature' profile can show `track`: every staff tuned and not percussion, or a drum track (shown as drum tab). */
export const tablatureAllowed=(track:model.Track):boolean=>isDrumTrack(track)||!track.staves.some(staff=>!staff.tuning.length||staff.isPercussion);
/** The tracks `value` shows as drum tab, by index, and how: 'tablature' draws the tab alone, 'standardTab' the percussion staff and the tab. */
export function drumTabModes(source:model.Score,ids:readonly string[],value:EngravingOverrides):Map<number,DrumTabMode> {
  const modes=new Map<number,DrumTabMode>();
  for(const entry of value.profiles){
    if(entry.profile!=='tablature'&&entry.profile!=='standardTab')continue;
    const index=ids.indexOf(entry.trackId),track=index<0?undefined:source.tracks[index];
    if(track&&isDrumTrack(track))modes.set(index,entry.profile==='tablature'?'tab':'both');
  }
  return modes;
}
function liveTracks(score:model.Score,ids:readonly string[],value:EngravingOverrides,requireLive:boolean):void {
  if(ids.length!==score.tracks.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id.trim()))throw new Error('Invalid source track identities.');
  for(const entry of value.profiles){const index=ids.indexOf(entry.trackId);if(index<0){if(requireLive)throw new Error('Engraving profile refers to a missing track.');continue;}
    const staves=score.tracks[index].staves;
    if(entry.profile==='tablature'&&!tablatureAllowed(score.tracks[index]))throw new Error('Tablature requires tuned nonpercussion staves, or a track of one percussion staff.');
    if(entry.profile==='numbered'&&staves.some(staff=>staff.isPercussion))throw new Error('Numbered notation is unavailable for percussion.');
  }
}
export function validateEngravingTracks(score:model.Score,ids:readonly string[],value:EngravingOverrides):void {validateEngraving(value);liveTracks(score,ids,value,true);}
/** Gives the rendered copy `score` of `source` the display flags its track profiles ask for, and maps each source beat and note to its copy. */
export function mapProjection(source:model.Score,score:model.Score,ids:readonly string[],value:EngravingOverrides,drumTab?:DrumTabReport):Pick<EngravingProjection,'beats'|'notes'|'renderedBeats'|'renderedNotes'|'drumTab'> {
  const renderedBeats=new Map<model.Beat,model.Beat>(),renderedNotes=new Map<model.Note,model.Note>(),modes=drumTabModes(source,ids,value);
  if(modes.size&&!drumTab)throw new Error('Drum tablature needs its conversion report.');
  const beats:EngravingProjection['beats']=new Map(),notes:EngravingProjection['notes']=new Map(),profiles=new Map(value.profiles.map(entry=>[entry.trackId,entry.profile]));
  source.tracks.forEach((track,ti)=>{
    const mode=modes.get(ti);
    if(mode&&score.tracks[ti].staves.length!==track.staves.length+(mode==='both'?1:0))throw new Error('The display copy lacks its drum tab staff.');
    track.staves.forEach((staff,si)=>{
      const rendered=score.tracks[ti].staves[si],profile=profiles.get(ids[ti])??'source',stringed=staff.tuning.length>0&&!staff.isPercussion;
      // JSON replay normalizes untuned/percussion tablature flags; source means the original tuple.
      const flags=profile==='source'?[staff.showStandardNotation,staff.showTablature,staff.showSlash,staff.showNumbered]:profile==='standard'?[true,false,false,false]:profile==='tablature'?[false,true,false,false]:profile==='standardTab'?[true,stringed,false,false]:profile==='slash'?[false,false,true,false]:[false,false,false,true];
      [rendered.showStandardNotation,rendered.showTablature,rendered.showSlash,rendered.showNumbered]=flags;
      // A drum track's tab staff is the track's next staff, so every source staff keeps its index.
      const tabStaff=mode==='both'?score.tracks[ti].staves[si+1]:undefined;
      staff.bars.forEach((bar,bi)=>bar.voices.forEach((voice,vi)=>voice.beats.forEach((beat,bti)=>{
        const copy=rendered.bars[bi].voices[vi].beats[bti],tabCopy=tabStaff?.bars[bi].voices[vi].beats[bti];
        beats.set(beat.id,{source:beat,rendered:copy,...tabCopy?{tab:tabCopy}:{}});renderedBeats.set(copy,beat);if(tabCopy)renderedBeats.set(tabCopy,beat);
        // A drum tab staff holds only the hits it could write, in its own order: its notes lead back to the source notes by the conversion's map.
        const sourceOf=(drawn:model.Note)=>beat.notes.find(note=>note.id===drumTab?.notes.get(drawn.id));
        if(mode==='tab'){for(const drawn of copy.notes){const origin=sourceOf(drawn);if(origin){notes.set(origin.id,{source:origin,rendered:drawn});renderedNotes.set(drawn,origin);}}}
        else beat.notes.forEach((note,ni)=>{notes.set(note.id,{source:note,rendered:copy.notes[ni]});renderedNotes.set(copy.notes[ni],note);});
        if(tabCopy)for(const drawn of tabCopy.notes){const origin=sourceOf(drawn),pair=origin&&notes.get(origin.id);if(origin&&pair){pair.tab=drawn;renderedNotes.set(drawn,origin);}}
      })));
    });
  });
  // The public tie-ID JSON replay path omits the continued bend's origin link.
  for(const pair of notes.values())pair.rendered.bendOrigin=pair.source.bendOrigin?notes.get(pair.source.bendOrigin.id)?.rendered??null:null;
  return {beats,notes,renderedBeats,renderedNotes,...modes.size?{drumTab}:{}};
}
export function projectEngraving(source:model.Score,ids:readonly string[],value:EngravingOverrides):EngravingProjection {
  validateEngraving(value);liveTracks(source,ids,value,false);
  // Drum tab rewrites the display copy's JSON (never the source); without a drum tab profile the copy is made exactly as it always was.
  const modes=drumTabModes(source,ids,value);let json=model.JsonConverter.scoreToJson(source),report:DrumTabReport|undefined;
  if(modes.size){const parsed=JSON.parse(json) as Record<string,unknown>;report=convertDrumTabJson(parsed,source,modes);json=JSON.stringify(parsed) as typeof json;keepIdsAbove(report.highestIds);}
  const score=scoreFromJson(json,new Settings()),links=captureNoteLinks(source);restoreNoteLinks(score,report?drumTabLinks(links,report):links);copyGpInterchangeSource(source,score);
  const {beats,notes,renderedBeats,renderedNotes,drumTab}=mapProjection(source,score,ids,value,report);
  const style=score.stylesheet,overrides=value.stylesheet;
  for(const [key,field]of Object.entries(styleBooleans)){const override=overrides[key as keyof typeof styleBooleans];if(override!==null)Object.assign(style,{[field]:override});}
  for(const [key,mapping]of Object.entries(styleEnums)){const override=overrides[key as keyof typeof styleEnums];if(override!=='inherit')Object.assign(style,{[mapping.field]:(mapping.values as Record<string,number>)[override]});}
  if(overrides.tuning!==null)style.perTrackDisplayTuning?.clear();
  if(report)hideDrumTabTuning(score,report.hiddenTuningTracks);
  if(overrides.chords!=='inherit'){style.globalDisplayChordDiagramsOnTop=overrides.chords==='top'||overrides.chords==='both';style.globalDisplayChordDiagramsInScore=overrides.chords==='inline'||overrides.chords==='both';style.perTrackChordDiagramsOnTop?.clear();}
  if(overrides.barNumbers!=='inherit')for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)bar.barNumberDisplay=undefined;
  if(overrides.multiRests!=='inherit'){style.multiTrackMultiBarRest=overrides.multiRests==='on';style.perTrackMultiBarRest=new Set(overrides.multiRests==='on'?score.tracks.map((_,i)=>i):[]);}
  // A bar's width is its weight in the system: master bars decide it when several staves show, each bar when one does. Only the copy changes, so playback and MIDI read the unchanged source.
  for(const {bar,scale} of value.barWidths??[]){const master=score.masterBars[bar];if(!master)continue;master.displayScale=scale;for(const track of score.tracks)for(const staff of track.staves){const copy=staff.bars[bar];if(copy)copy.displayScale=scale;}}
  return {score,beats,notes,renderedBeats,renderedNotes,...drumTab?{drumTab}:{},bracketMode:score.stylesheet.bracketExtendMode};
}
const idCounters=model as unknown as {Note:{globalNoteId:number};Beat:{_globalBeatId:number};Bar:{_globalBarId:number};Voice:{_globalVoiceId:number}};
/** The ids the drum tab conversion made up must never be handed out again to a bar, voice, beat or note made later on the copy, so alphaTab's counters are lifted above them. */
function keepIdsAbove(highest:DrumTabReport['highestIds']):void {
  idCounters.Note.globalNoteId=Math.max(idCounters.Note.globalNoteId,highest.note+1);idCounters.Beat._globalBeatId=Math.max(idCounters.Beat._globalBeatId,highest.beat+1);
  idCounters.Bar._globalBarId=Math.max(idCounters.Bar._globalBarId,highest.bar+1);idCounters.Voice._globalVoiceId=Math.max(idCounters.Voice._globalVoiceId,highest.voice+1);
}
/**
 * The source's note links as the display copy needs them. A drum tab note keeps only ties (slurs, slides and hammer-ons mean nothing on a drum
 * hit); in 'both' mode the tab note has an id of its own, so each tie between two source notes that are both on the tab is repeated between their tab notes.
 */
function drumTabLinks(links:NoteLinks,report:DrumTabReport):NoteLinks {
  const drawn=new Set(report.notes.keys()),tabOf=new Map([...report.notes].map(([rendered,origin])=>[origin,rendered]));
  const kept=links.filter(link=>link.kind==='tie'||!(drawn.has(link.from)||drawn.has(link.to)));
  const added=links.flatMap(link=>{const from=tabOf.get(link.from),to=tabOf.get(link.to);return link.kind==='tie'&&from!==undefined&&to!==undefined&&from!==link.from?[{...link,from,to}]:[];});
  return [...kept,...added];
}
/**
 * Applies `value` to `settings`. The engraving settings always restart from Bravura's, so switching back from another music font leaves none of its
 * metrics behind; a non-Bravura font then refills them from its merged SMuFL metadata, which has to be passed already loaded.
 */
export function configureEngraving(settings:Settings,value:EngravingOverrides,music?:MusicFontData|null):void {
  validateEngraving(value);const defaults=new Settings(),musicId=value.fonts?.music??'bravura';
  if(musicId!=='bravura'&&(music?.id!==musicId||!music.metadata))throw new Error('Music font is not loaded.');
  const engravingSettings=EngravingSettings.bravuraDefaults;
  if(musicId!=='bravura')engravingSettings.fillFromSmufl(music!.metadata!,engravingSettings.musicFontSize);
  settings.display.resources.engravingSettings=engravingSettings;
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
