import { useId } from 'react';
import type { ChangeEvent,KeyboardEvent,MouseEvent } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import { busySelect } from '../ui';
import { hasFace,musicFonts,textFonts } from './font-catalog';
import type { MusicFontId,TextFontId } from './font-catalog';
import { FONT_ROLES,missingGlyphs,sizeRange } from './fonts';
import type { EngravingFonts,FontRole,RoleFont } from './fonts';
import { PercentField } from './PercentField';

export interface FontStatus {failed:string[];substituted:string[]}
export interface FontRolesFieldsProps {
  value:EngravingFonts|undefined;onChange:(fonts:EngravingFonts)=>void;busy:boolean;
  /** The score's own text per role (see `roleTexts`), for the missing-glyph warning. */
  texts:Partial<Record<FontRole,string[]>>;
  /** What the screen reported about the fonts it is drawing with; null before the first report. */
  status:FontStatus|null;
  /** Receives the message for a size outside its range. */
  onInvalid?:(message:string)=>void;
}

const textFontIds=Object.keys(textFonts) as TextFontId[],musicFontIds=Object.keys(musicFonts) as MusicFontId[];
const flagChoice=(flag:boolean|undefined)=>flag===undefined?'inherit':flag?'on':'off';
const flagValue=(choice:string)=>choice==='on'?true:choice==='off'?false:undefined;
const roleKey=(role:FontRole)=>`font_roles.role_${role}` as MessageKey;

/** A bundled font file as a person would name it ("Noto Serif Italic"); a file the catalog does not know keeps its file name. */
function fileLabel(file:string):string {
  for(const font of Object.values(textFonts)){
    const face=font.faces.find(candidate=>candidate.file===file);
    if(face)return `${font.label} ${face.bold&&face.italic?'Bold Italic':face.bold?'Bold':face.italic?'Italic':'Regular'}`;
  }
  for(const font of Object.values(musicFonts))if(font.file===file||font.metadata===file)return font.family;
  return file;
}

/** A role's entry after one change: absent keys stay absent, a flag cannot outlive its font, and a font without the italic face loses an italic choice. */
function changed(entry:RoleFont|undefined,change:Partial<Record<keyof RoleFont,RoleFont[keyof RoleFont]|null>>):RoleFont|undefined {
  const merged:Record<string,unknown>={...entry};
  for(const [key,next] of Object.entries(change)){if(next===null||next===undefined)delete merged[key];else merged[key]=next;}
  const next=merged as RoleFont;
  if(next.font===undefined){delete next.bold;delete next.italic;}
  else if(next.italic===true&&!hasFace(next.font,next.bold===true,true))delete next.italic;
  return Object.keys(next).length?next:undefined;
}

/**
 * The music font select and one row per text role (font, size, bold, italic), with the notes the screen and the score give:
 * symbols drawn from Bravura, characters a chosen font lacks, and fonts that could not be loaded. Every change is passed on as
 * a whole `EngravingFonts` that holds only what is chosen; the caller decides when it is applied.
 */
export function FontRolesFields({value,onChange,busy,texts,status,onInvalid}:FontRolesFieldsProps) {
  const {t}=useI18n(),notes=useId();
  const music=value?.music??'bravura',roles=value?.roles??{};
  const guard=busySelect(busy);
  const emit=(next:EngravingFonts)=>{
    const clean:EngravingFonts={};
    if(next.music!==undefined&&next.music!=='bravura')clean.music=next.music;
    if(next.roles&&Object.keys(next.roles).length)clean.roles=next.roles;
    onChange(clean);
  };
  const setRole=(role:FontRole,change:Parameters<typeof changed>[1])=>{
    if(busy)return;
    const entry=changed(roles[role],change),next={...roles};
    if(entry)next[role]=entry;else delete next[role];
    emit({music:value?.music,roles:next});
  };
  const label=(role:FontRole)=>t(roleKey(role));
  const warnings=missingGlyphs(value,texts),substituted=music!=='bravura'?status?.substituted.length??0:0,failed=status?.failed??[];
  return <>
    <label>{t('font_roles.music')}<select {...guard} value={music} onChange={(event:ChangeEvent<HTMLSelectElement>)=>{if(!busy)emit({music:event.target.value as MusicFontId,roles:value?.roles});}}>
      {musicFontIds.map(id=><option key={id} value={id}>{musicFonts[id].family}</option>)}
    </select></label>
    <p className="muted">{t('font_roles.music_note')}</p>
    {substituted>0&&<p className="muted">{t(substituted===1?'font_roles.substituted_one':'font_roles.substituted_other',{count:substituted,font:musicFonts[music].family})}</p>}
    <p>{t('font_roles.roles_heading')}</p>
    <p className="muted">{t('font_roles.roles_note')}</p>
    {FONT_ROLES.map(role=>{
      const entry=roles[role],font=entry?.font,reason=`${notes}-${role}`;
      const noFont=font===undefined,noItalic=font!==undefined&&!hasFace(font,entry?.bold===true,true);
      // Bold and italic stay in the tab order (no `disabled`) and say why they do nothing.
      const unavailable=(blocked:boolean)=>blocked?{
        'aria-disabled':'true' as const,'aria-describedby':reason,
        onMouseDown:(event:MouseEvent<HTMLSelectElement>)=>event.preventDefault(),
        onKeyDown:(event:KeyboardEvent<HTMLSelectElement>)=>{if(event.key===' '||event.key==='Enter'||event.key==='F4'||event.key.startsWith('Arrow'))event.preventDefault();},
      }:guard;
      const reasonText=noFont?t('font_roles.needs_font',{role:label(role)}):noItalic?t('font_roles.no_italic',{font:textFonts[font].label,role:label(role)}):null;
      return <fieldset key={role}>
        <legend>{label(role)}</legend>
        <label>{t('font_roles.font',{role:label(role)})}<select {...guard} value={font??'inherit'} onChange={event=>setRole(role,{font:event.target.value==='inherit'?null:event.target.value as TextFontId})}>
          <option value="inherit">{t('typography.source_default')}</option>{textFontIds.map(id=><option key={id} value={id}>{textFonts[id].label}</option>)}
        </select></label>
        <PercentField label={t('font_roles.size',{role:label(role)})} value={entry?.size??null} range={sizeRange(role)} busy={busy} onInvalid={onInvalid??(()=>undefined)} onCommit={size=>setRole(role,{size})}/>
        <label>{t('font_roles.bold',{role:label(role)})}<select {...unavailable(noFont)} value={flagChoice(entry?.bold)} onChange={event=>{if(!noFont)setRole(role,{bold:flagValue(event.target.value)??null});}}>
          <option value="inherit">{t('typography.source_default')}</option><option value="on">{t('font_roles.on')}</option><option value="off">{t('font_roles.off')}</option>
        </select></label>
        <label>{t('font_roles.italic',{role:label(role)})}<select {...unavailable(noFont||noItalic)} value={flagChoice(entry?.italic)} onChange={event=>{if(!noFont&&!noItalic)setRole(role,{italic:flagValue(event.target.value)??null});}}>
          <option value="inherit">{t('typography.source_default')}</option><option value="on">{t('font_roles.on')}</option><option value="off">{t('font_roles.off')}</option>
        </select></label>
        {reasonText&&<p id={reason} className="muted">{reasonText}</p>}
      </fieldset>;
    })}
    {warnings.map(({role,chars})=><p key={role} className="muted">{t('font_roles.missing_glyph',{font:textFonts[roles[role]!.font!].label,chars:chars.join(' '),role:label(role)})}</p>)}
    {failed.length>0&&<p className="muted">{t('font_roles.load_failed',{files:failed.map(fileLabel).join(', ')})}</p>}
  </>;
}
