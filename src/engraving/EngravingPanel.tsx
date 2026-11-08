import { useEffect,useMemo,useState } from 'react';
import { type model,Settings } from '@coderline/alphatab';
import type { EngravingCommand,EngravingOverrides,InheritBool,TrackProfile } from './types';
import { defaultEngraving,validateEngravingTracks } from './projection';
import { StylePresetsPanel } from './StylePresetsPanel';
import { TypographyFields } from './TypographyFields';
import type { FontStatus } from './FontRolesFields';
import { busyGuard,busyRegion } from '../ui';
import { useI18n } from '../i18n';
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
type Options=ReadonlyArray<readonly [string,string]>;
const boolOptions:Options=[['true','Yes'],['false','No']];
const namePolicies:Options=[['hidden','Hidden'],['firstSystem','First system'],['allSystems','All systems']];
const names:Options=[['full','Full'],['short','Short']],directions:Options=[['horizontal','Horizontal'],['vertical','Vertical']];
const styleBooleans=[['hideDynamics','Hide dynamics','hideDynamics'],['extendBarLines','Extend bar lines','extendBarLines'],['systemSeparators','System separators','useSystemSignSeparator'],['tuning','Show tuning','globalDisplayTuning'],['hideEmptyStaves','Hide empty staves','hideEmptyStaves'],['hideEmptyFirstSystem','Hide empty staves in first system','hideEmptyStavesInFirstSystem'],['singleStaffBrackets','Single staff brackets','showSingleStaffBrackets']] as const;
const styleChoices=[
  ['brackets','Brackets','bracketExtendMode',[['none','None'],['staves','Group staves'],['similar','Group similar MIDI programs']]],
  ['singleNames','Single track names','singleTrackTrackNamePolicy',namePolicies],['multiNames','Multiple track names','multiTrackTrackNamePolicy',namePolicies],
  ['firstNames','First system names','firstSystemTrackNameMode',names],['otherNames','Other system names','otherSystemsTrackNameMode',names],
  ['firstNameDirection','First system name direction','firstSystemTrackNameOrientation',directions],['otherNameDirection','Other system name direction','otherSystemsTrackNameOrientation',directions],
  ['barNumbers','Bar numbers','barNumberDisplay',[['all','All bars'],['firstSystem','First of system'],['hidden','Hidden']]],
] as const;
const notationBooleans=[['smallGraceTab','Small grace tab notes','smallGraceTabNotes'],['extendBendArrows','Extend tied bend arrows','extendBendArrowsOnTiedNotes'],['extendLineEffects','Extend line effects to beat end','extendLineEffectsToBeatEnd']] as const;
const notationElements=[['parenthesizeTiedBends','Parenthesize tied bends',11],['showTiedBendNumbers','Show tied bend numbers',12],['showDiveWhammyZeros','Show dive whammy zeros',13]] as const;
const rhythmOptions:Options=[['hidden','Hidden'],['beams','Beams'],['connected','Connected bars'],['auto','Automatic']],fingeringOptions:Options=[['score','Score'],['piano','Piano'],['above','Above staff'],['abovePiano','Above staff, piano fingers']];
const profileOptions:ReadonlyArray<readonly [TrackProfile,string]>=[['source','Source/default'],['standard','Standard'],['tablature','Tablature'],['standardTab','Standard + tablature'],['slash','Slash'],['numbered','Numbered']];
const yesNo=(value:boolean)=>value?'Yes':'No';
function Choice({label,value,source,options,onChange}:{label:string;value:string;source:string;options:Options;onChange:(value:string)=>void}) {
  return <label>{label}<select value={value} onChange={e=>onChange(e.target.value)}><option value="inherit">Source/default ({source})</option>{options.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>;
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
  return <details><summary>Engraving</summary><fieldset {...busyRegion(busy)}>
    <p>Source/default keeps imported style and staff combinations. Notation choices use renderer defaults.</p>
    <details><summary>Staff profiles</summary>
      {score.tracks.map((track,index)=>{
        const id=trackIds[index],profile=draft.profiles.find(entry=>entry.trackId===id)?.profile??'source';
        return <fieldset key={id}><legend>{track.name}</legend><label>{track.name} notation profile<select value={profile} onChange={e=>{const next=e.target.value as TrackProfile;setDraft({...draft,profiles:[...draft.profiles.filter(entry=>entry.trackId!==id),...next==='source'?[]:[{trackId:id,profile:next}]]});setError(null);}}>
          {profileOptions.map(([key,label])=><option key={key} value={key} disabled={key==='tablature'?track.staves.some(staff=>!staff.tuning.length||staff.isPercussion):key==='numbered'&&track.staves.some(staff=>staff.isPercussion)}>{label}</option>)}
        </select></label>
          {track.staves.map((staff,si)=><p key={si}>Source staff {si+1}: {[[staff.showStandardNotation,'standard'],[staff.showTablature,'tablature'],[staff.showSlash,'slash'],[staff.showNumbered,'numbered']].filter(([shown])=>shown).map(([,name])=>name).join(', ')||'hidden'}</p>)}
        </fieldset>;
      })}
    </details>
    <details><summary>Stylesheet</summary>
      {styleBooleans.map(([key,label,field])=><Choice key={key} label={label} value={boolValue(draft.stylesheet[key])} source={yesNo(style[field])} options={boolOptions} onChange={next=>updateStyle(key,parseBool(next))}/>)}
      {styleChoices.map(([key,label,field,options])=><Choice key={key} label={label} value={draft.stylesheet[key]} source={options[style[field]]?.[1]??'Imported'} options={options} onChange={next=>updateStyle(key,next)}/>)}
      <Choice label="Chord diagrams" value={draft.stylesheet.chords} source={style.globalDisplayChordDiagramsOnTop?(style.globalDisplayChordDiagramsInScore?'Top and inline':'Top'):(style.globalDisplayChordDiagramsInScore?'Inline':'Hidden')} options={[["hidden","Hidden"],["top","Top"],["inline","Inline"],["both","Top and inline"]]} onChange={next=>updateStyle('chords',next)}/>
      <Choice label="Multiple measure rests" value={draft.stylesheet.multiRests} source={style.multiTrackMultiBarRest?'On':'Off'} options={[["off","Off"],["on","On"]]} onChange={next=>updateStyle('multiRests',next)}/>
      {(style.perTrackDisplayTuning?.size||style.perTrackChordDiagramsOnTop?.size||style.perTrackMultiBarRest?.size)?<p>Source/default also keeps imported per-track exceptions.</p>:null}
    </details>
    <details><summary>Notation</summary>
      <Choice label="Tab rhythm" value={draft.notation.tabRhythm} source={rhythmOptions[defaults.notation.rhythmMode]?.[1]??'Automatic'} options={rhythmOptions} onChange={next=>updateNotation('tabRhythm',next)}/>
      <Choice label="Fingering" value={draft.notation.fingering} source={fingeringOptions[defaults.notation.fingeringMode]?.[1]??'Score'} options={fingeringOptions} onChange={next=>updateNotation('fingering',next)}/>
      {notationBooleans.map(([key,label,field])=><Choice key={key} label={label} value={boolValue(draft.notation[key])} source={yesNo(defaults.notation[field])} options={boolOptions} onChange={next=>updateNotation(key,parseBool(next))}/>)}
      {notationElements.map(([key,label,element])=><Choice key={key} label={label} value={boolValue(draft.notation[key])} source={yesNo(defaults.notation.isNotationElementVisible(element))} options={boolOptions} onChange={next=>updateNotation(key,parseBool(next))}/>)}
    </details>
    <details><summary>{t('typography.title')}</summary>
      <TypographyFields value={typographyOf(draft)} onChange={next=>{setDraft(withTypography(draft,next));setError(null);}} onInvalid={setError} busy={busy} fonts={draft.fonts} onFonts={next=>{setDraft(withFonts(draft,next));setError(null);}} texts={texts} status={status}/>
    </details>
    <details><summary>Notation style presets</summary>
      <p>Presets fill the form; nothing changes until Apply engraving. System spacing and staff profiles are kept.</p>
      {notationPresets.map(preset=><div key={preset.id}><button type="button" onClick={()=>{setDraft(presetApplied(preset,draft));setError(null);}}>Load {preset.name} preset</button> {preset.description}</div>)}
    </details>
    <label>System spacing (%)<input type="number" min={25} max={400} step="any" placeholder="Source/default (100%)" value={draft.systemSpacing===null?'':draft.systemSpacing*100} onChange={e=>{setDraft({...draft,systemSpacing:e.target.value===''?null:Number(e.target.value)/100});setError(null);}}/></label>
    <p>Blank uses default system spacing.</p>
    {error&&<p role="alert">{error}</p>}
    <button type="button" {...busyGuard({busy,onClick:apply})}>Apply engraving</button><button type="button" {...busyGuard({busy,onClick:reset})}>Reset to source/default</button>
  </fieldset>
  <StylePresetsPanel score={score} trackIds={trackIds} value={value} unapplied={!sameEngraving(draft,value)} busy={busy} onEdit={onEdit}/>
  </details>;
}
