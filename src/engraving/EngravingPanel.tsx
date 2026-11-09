import { useEffect,useMemo,useState } from 'react';
import { type model,Settings } from '@coderline/alphatab';
import type { EngravingCommand,EngravingOverrides,InheritBool,TrackProfile } from './types';
import { defaultEngraving,validateEngravingTracks } from './projection';
import { StylePresetsPanel } from './StylePresetsPanel';
import { TypographyFields } from './TypographyFields';
import type { FontStatus } from './FontRolesFields';
import { busyGuard,busyRegion } from '../ui';
import { useI18n, type MessageKey } from '../i18n';
import { fontsOf,roleTexts,withFonts } from './fonts';
import { headerFieldsOf } from './header-footer';
import type { HeaderFooter } from './header-footer';
import { notationPresets,presetApplied } from './notation-presets';
import { typographyOf,withTypography } from './typography';
import { withBarWidths } from './bar-widths';
import { withSystemGaps } from './system-gaps';
import { withStaffGaps,withStaffGroups } from './staff-groups';

export interface EngravingPanelProps {
  score:model.Score;trackIds:readonly string[];value:EngravingOverrides;busy:boolean;
  onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown;
  /** What the screen reported about the fonts it draws with (failed loads, music symbols taken from Bravura); null or absent before the first report. */
  fontStatus?:FontStatus|null;
  /** The document's page header and footer bands, which the missing-glyph warning reads; absent means the established page. */
  headerFooter?:HeaderFooter;
}
type Options=ReadonlyArray<readonly [string,MessageKey]>;
const boolOptions:Options=[['true','engraving.opt_yes'],['false','engraving.opt_no']];
const namePolicies:Options=[['hidden','engraving.opt_hidden'],['firstSystem','engraving.opt_first_system'],['allSystems','engraving.opt_all_systems']];
const names:Options=[['full','engraving.opt_full'],['short','engraving.opt_short']],directions:Options=[['horizontal','engraving.opt_horizontal'],['vertical','engraving.opt_vertical']];
const styleBooleans=[
  ['hideDynamics','engraving.style.hideDynamics','hideDynamics'],
  ['extendBarLines','engraving.style.extendBarLines','extendBarLines'],
  ['systemSeparators','engraving.style.systemSeparators','useSystemSignSeparator'],
  ['tuning','engraving.style.tuning','globalDisplayTuning'],
  ['hideEmptyStaves','engraving.style.hideEmptyStaves','hideEmptyStaves'],
  ['hideEmptyFirstSystem','engraving.style.hideEmptyFirstSystem','hideEmptyStavesInFirstSystem'],
  ['singleStaffBrackets','engraving.style.singleStaffBrackets','showSingleStaffBrackets']
] as const;
const styleChoices=[
  ['brackets','engraving.style.brackets','bracketExtendMode',[['none','engraving.opt_none'],['staves','engraving.opt_group_staves'],['similar','engraving.opt_group_similar']]],
  ['singleNames','engraving.style.singleNames','singleTrackTrackNamePolicy',namePolicies],['multiNames','engraving.style.multiNames','multiTrackTrackNamePolicy',namePolicies],
  ['firstNames','engraving.style.firstNames','firstSystemTrackNameMode',names],['otherNames','engraving.style.otherNames','otherSystemsTrackNameMode',names],
  ['firstNameDirection','engraving.style.firstNameDirection','firstSystemTrackNameOrientation',directions],['otherNameDirection','engraving.style.otherNameDirection','otherSystemsTrackNameOrientation',directions],
  ['barNumbers','engraving.style.barNumbers','barNumberDisplay',[['all','engraving.opt_all_bars'],['firstSystem','engraving.opt_first_of_system'],['hidden','engraving.opt_hidden']]],
] as const;
const notationBooleans=[
  ['smallGraceTab','engraving.notation.smallGraceTab','smallGraceTabNotes'],
  ['extendBendArrows','engraving.notation.extendBendArrows','extendBendArrowsOnTiedNotes'],
  ['extendLineEffects','engraving.notation.extendLineEffects','extendLineEffectsToBeatEnd']
] as const;
const notationElements=[
  ['parenthesizeTiedBends','engraving.notation.parenthesizeTiedBends',11],
  ['showTiedBendNumbers','engraving.notation.showTiedBendNumbers',12],
  ['showDiveWhammyZeros','engraving.notation.showDiveWhammyZeros',13]
] as const;
const rhythmOptions:Options=[['hidden','engraving.opt_hidden'],['beams','engraving.opt_beams'],['connected','engraving.opt_connected'],['auto','engraving.opt_auto']];
const fingeringOptions:Options=[['score','engraving.opt_score'],['piano','engraving.opt_piano'],['above','engraving.opt_above'],['abovePiano','engraving.opt_above_piano']];
const profileOptions:ReadonlyArray<readonly [TrackProfile,MessageKey]>=[
  ['source','engraving.profile_source'],
  ['standard','engraving.profile_standard'],
  ['tablature','engraving.profile_tablature'],
  ['standardTab','engraving.profile_standard_tab'],
  ['slash','engraving.profile_slash'],
  ['numbered','engraving.profile_numbered']
];

function Choice({label,value,source,options,onChange}:{label:string;value:string;source:string;options:Options;onChange:(value:string)=>void}) {
  const {t}=useI18n();
  return <label>{label}<select value={value} onChange={e=>onChange(e.target.value)}><option value="inherit">{t('engraving.choice_source',{source})}</option>{options.map(([id,key])=><option key={id} value={id}>{t(key)}</option>)}</select></label>;
}
/** The fonts as chosen, with every default explicit and every empty choice gone, so equal choices compare equal however they were built. */
const canonFonts=(value:EngravingOverrides)=>fontsOf(withFonts(value,value.fonts??{}));
/** Whether two engravings hold the same choices, ignoring the order of the staff profiles. */
const sameEngraving=(a:EngravingOverrides,b:EngravingOverrides)=>{
  const canon=(value:EngravingOverrides)=>JSON.stringify([value.stylesheet,value.notation,value.systemSpacing,value.profiles.map(entry=>[entry.trackId,entry.profile]).sort(([x],[y])=>x.localeCompare(y)),typographyOf(value),canonFonts(value)]);
  return canon(a)===canon(b);
};
const boolValue=(value:InheritBool)=>value===null?'inherit':String(value);
const parseBool=(value:string):InheritBool=>value==='inherit'?null:value==='true';
export function EngravingPanel({score,trackIds,value,busy,onEdit,fontStatus=null,headerFooter}:EngravingPanelProps) {
  const {t}=useI18n(),[draft,setDraft]=useState(()=>structuredClone(value)),[error,setError]=useState<string|null>(null),trackKey=JSON.stringify(trackIds);
  const yesNo=(v:boolean)=>t(v?'engraving.opt_yes':'engraving.opt_no');
  const acceptedKey=JSON.stringify([
    Object.entries(value.stylesheet).sort(([a],[b])=>a.localeCompare(b)),Object.entries(value.notation).sort(([a],[b])=>a.localeCompare(b)),value.systemSpacing,
    value.profiles.map(entry=>[entry.trackId,entry.profile]).sort(([a],[b])=>a.localeCompare(b)),typographyOf(value),canonFonts(value),
  ]);
  useEffect(()=>{setDraft(structuredClone(value));setError(null);},[score,acceptedKey,trackKey]);
  // The score's own text per role, for the missing-glyph warning; it changes only with the score or the page bands.
  const texts=useMemo(()=>roleTexts(score,headerFieldsOf(score),headerFooter),[score,headerFooter]);
  // The substituted-symbol count describes the music font on screen, so it is not shown for a different, unapplied choice.
  const status=fontStatus&&(draft.fonts?.music??'bravura')!==(value.fonts?.music??'bravura')?{...fontStatus,substituted:[]}:fontStatus;
  const defaults=new Settings(),style=score.stylesheet;
  const updateStyle=(key:keyof EngravingOverrides['stylesheet'],next:unknown)=>{setDraft({...draft,stylesheet:{...draft.stylesheet,[key]:next}});setError(null);};
  const updateNotation=(key:keyof EngravingOverrides['notation'],next:unknown)=>{setDraft({...draft,notation:{...draft.notation,[key]:next}});setError(null);};
  const keepStaffLayout=(engraving:EngravingOverrides)=>withStaffGaps(withStaffGroups(engraving,value.staffGroups??[]),value.staffGaps??[]);
  const apply=()=>{
    // Bar widths and system gaps are set elsewhere, not in this form: whatever the form holds, the applied ones stay.
    const engraving=keepStaffLayout(withFonts(withSystemGaps(withBarWidths(withTypography({...structuredClone(draft),profiles:trackIds.flatMap(id=>draft.profiles.filter(entry=>entry.trackId===id).map(entry=>({...entry})))},typographyOf(draft)),value.barWidths??[]),value.systemGaps??[]),draft.fonts??{}));
    try{
      validateEngravingTracks(score,trackIds,engraving);
      // Choosing what the document already has records nothing.
      if(sameEngraving(engraving,value)){setError(null);return;}
      onEdit({type:'setEngraving',engraving});setError(null);
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  };
  const reset=()=>{const engraving=keepStaffLayout(withSystemGaps(withBarWidths(defaultEngraving(),value.barWidths??[]),value.systemGaps??[]));setDraft(engraving);try{if(sameEngraving(engraving,value)){setError(null);return;}onEdit({type:'setEngraving',engraving});setError(null);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}};
  return <details><summary>{t('engraving.title')}</summary><fieldset {...busyRegion(busy)}>
    <p>{t('engraving.hint')}</p>
    <details><summary>{t('engraving.staff_profiles_summary')}</summary>
      {score.tracks.map((track,index)=>{
        const id=trackIds[index],profile=draft.profiles.find(entry=>entry.trackId===id)?.profile??'source';
        return <fieldset key={id}><legend>{track.name}</legend><label>{t('engraving.track_profile_label',{name:track.name})}<select value={profile} onChange={e=>{const next=e.target.value as TrackProfile;setDraft({...draft,profiles:[...draft.profiles.filter(entry=>entry.trackId!==id),...next==='source'?[]:[{trackId:id,profile:next}]]});setError(null);}}>
          {profileOptions.map(([key,msgKey])=><option key={key} value={key} disabled={key==='tablature'?track.staves.some(staff=>!staff.tuning.length||staff.isPercussion):key==='numbered'&&track.staves.some(staff=>staff.isPercussion)}>{t(msgKey)}</option>)}
        </select></label>
          {track.staves.map((staff,si)=><p key={si}>{t('engraving.source_staff_summary',{index:si+1,modes:[[staff.showStandardNotation,'engraving.staff_mode_standard'],[staff.showTablature,'engraving.staff_mode_tablature'],[staff.showSlash,'engraving.staff_mode_slash'],[staff.showNumbered,'engraving.staff_mode_numbered']].filter(([shown])=>shown).map(([,name])=>t(name as MessageKey)).join(', ')||t('engraving.source_staff_hidden')})}</p>)}
        </fieldset>;
      })}
    </details>
    <details><summary>{t('engraving.stylesheet_summary')}</summary>
      {styleBooleans.map(([key,labelKey,field])=><Choice key={key} label={t(labelKey)} value={boolValue(draft.stylesheet[key])} source={yesNo(style[field])} options={boolOptions} onChange={next=>updateStyle(key,parseBool(next))}/>)}
      {styleChoices.map(([key,labelKey,field,options])=><Choice key={key} label={t(labelKey)} value={draft.stylesheet[key]} source={options[style[field]]?.[1]?t(options[style[field]][1]):t('engraving.opt_imported')} options={options} onChange={next=>updateStyle(key,next)}/>)}
      <Choice label={t('engraving.style.chordDiagrams')} value={draft.stylesheet.chords} source={style.globalDisplayChordDiagramsOnTop?(style.globalDisplayChordDiagramsInScore?t('engraving.opt_both'):t('engraving.opt_top')):(style.globalDisplayChordDiagramsInScore?t('engraving.opt_inline'):t('engraving.opt_hidden'))} options={[["hidden","engraving.opt_hidden"],["top","engraving.opt_top"],["inline","engraving.opt_inline"],["both","engraving.opt_both"]]} onChange={next=>updateStyle('chords',next)}/>
      <Choice label={t('engraving.style.multiRests')} value={draft.stylesheet.multiRests} source={style.multiTrackMultiBarRest?t('engraving.opt_on'):t('engraving.opt_off')} options={[["off","engraving.opt_off"],["on","engraving.opt_on"]]} onChange={next=>updateStyle('multiRests',next)}/>
      {(style.perTrackDisplayTuning?.size||style.perTrackChordDiagramsOnTop?.size||style.perTrackMultiBarRest?.size)?<p>{t('engraving.exceptions_hint')}</p>:null}
    </details>
    <details><summary>{t('engraving.notation_summary')}</summary>
      <Choice label={t('engraving.notation.tabRhythm')} value={draft.notation.tabRhythm} source={rhythmOptions[defaults.notation.rhythmMode]?.[1]?t(rhythmOptions[defaults.notation.rhythmMode][1]):t('engraving.opt_auto')} options={rhythmOptions} onChange={next=>updateNotation('tabRhythm',next)}/>
      <Choice label={t('engraving.notation.fingering')} value={draft.notation.fingering} source={fingeringOptions[defaults.notation.fingeringMode]?.[1]?t(fingeringOptions[defaults.notation.fingeringMode][1]):t('engraving.opt_score')} options={fingeringOptions} onChange={next=>updateNotation('fingering',next)}/>
      {notationBooleans.map(([key,labelKey,field])=><Choice key={key} label={t(labelKey)} value={boolValue(draft.notation[key])} source={yesNo(defaults.notation[field])} options={boolOptions} onChange={next=>updateNotation(key,parseBool(next))}/>)}
      {notationElements.map(([key,labelKey,element])=><Choice key={key} label={t(labelKey)} value={boolValue(draft.notation[key])} source={yesNo(defaults.notation.isNotationElementVisible(element))} options={boolOptions} onChange={next=>updateNotation(key,parseBool(next))}/>)}
    </details>
    <details><summary>{t('typography.title')}</summary>
      <TypographyFields value={typographyOf(draft)} onChange={next=>{setDraft(withTypography(draft,next));setError(null);}} onInvalid={setError} busy={busy} fonts={draft.fonts} onFonts={next=>{setDraft(withFonts(draft,next));setError(null);}} texts={texts} status={status}/>
    </details>
    <details><summary>{t('engraving.presets_summary')}</summary>
      <p>{t('engraving.presets_hint')}</p>
      {notationPresets.map(preset=><div key={preset.id}><button type="button" onClick={()=>{setDraft(presetApplied(preset,draft));setError(null);}}>{t('engraving.load_preset',{name:t(preset.nameKey)})}</button> {t(preset.descriptionKey)}</div>)}
    </details>
    <label>{t('engraving.system_spacing')}<input type="number" min={25} max={400} step="any" placeholder={t('engraving.system_spacing_placeholder')} value={draft.systemSpacing===null?'':draft.systemSpacing*100} onChange={e=>{setDraft({...draft,systemSpacing:e.target.value===''?null:Number(e.target.value)/100});setError(null);}}/></label>
    <p>{t('engraving.system_spacing_hint')}</p>
    {error&&<p role="alert">{error}</p>}
    <button type="button" {...busyGuard({busy,onClick:apply})}>{t('engraving.apply')}</button><button type="button" {...busyGuard({busy,onClick:reset})}>{t('engraving.reset')}</button>
  </fieldset>
  <StylePresetsPanel score={score} trackIds={trackIds} value={value} unapplied={!sameEngraving(draft,value)} busy={busy} onEdit={onEdit}/>
  </details>;
}
