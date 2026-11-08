import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import { busySelect } from '../ui';
import type { EngravingTypography,TextFamily } from './types';
import type { EngravingFonts,FontRole } from './fonts';
import { FontRolesFields } from './FontRolesFields';
import type { FontStatus } from './FontRolesFields';
import { PercentField } from './PercentField';
import { TAB_SCALE_RANGE,TEXT_SCALE_RANGE,textFamilies } from './typography';

export interface TypographyFieldsProps {
  value:EngravingTypography;onChange:(value:EngravingTypography)=>void;onInvalid:(message:string)=>void;
  busy:boolean;
  /** The per-role fonts and the music font; the same draft rules as `value`. */
  fonts:EngravingFonts|undefined;onFonts:(fonts:EngravingFonts)=>void;
  texts:Partial<Record<FontRole,string[]>>;status:FontStatus|null;
}
export function TypographyFields({value,onChange,onInvalid,busy,fonts,onFonts,texts,status}:TypographyFieldsProps) {
  const {t}=useI18n();
  return <>
    <label>{t('typography.text_font')}<select {...busySelect(busy)} value={value.family} onChange={e=>{if(!busy)onChange({...value,family:e.target.value as TextFamily});}}><option value="inherit">{t('typography.source_default')}</option>{textFamilies.map(([id])=><option key={id} value={id}>{t(`typography.family_${id}` as MessageKey)}</option>)}</select></label>
    <PercentField label={t('typography.text_size')} value={value.textScale} range={TEXT_SCALE_RANGE} busy={busy} onCommit={textScale=>onChange({...value,textScale})} onInvalid={onInvalid}/>
    <PercentField label={t('typography.title_size')} value={value.titleScale} range={TEXT_SCALE_RANGE} busy={busy} onCommit={titleScale=>onChange({...value,titleScale})} onInvalid={onInvalid}/>
    <PercentField label={t('typography.tab_size')} value={value.tabScale} range={TAB_SCALE_RANGE} busy={busy} onCommit={tabScale=>onChange({...value,tabScale})} onInvalid={onInvalid}/>
    <p>{t('typography.blank_note')}</p>
    <p>{t('typography.export_note')}</p>
    <FontRolesFields value={fonts} onChange={onFonts} busy={busy} texts={texts} status={status} onInvalid={onInvalid}/>
  </>;
}
