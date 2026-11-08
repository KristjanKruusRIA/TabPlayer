import type { EngravingCommand,EngravingOverrides } from './types';
import { withBarWidths } from './bar-widths';
import { busyGuard } from '../ui';
import { useI18n } from '../i18n';

export interface BarWidthsPanelProps {
  value:EngravingOverrides;
  /** Whether bar width handles are shown on the score. */
  design:boolean;onDesign:(on:boolean)=>void;
  /** The score is busy or locked: widths cannot be recorded. The controls keep focus. */
  busy:boolean;
  /** Whether the chosen score layout sizes bars by weight; the vertical and horizontal screen layouts do not. */
  honoured:boolean;
  onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown;
}

/** Design mode for bar widths. Widths are saved with the document and printed; they never change when a note sounds. */
export function BarWidthsPanel({value,design,onDesign,busy,honoured,onEdit}:BarWidthsPanelProps) {
  const { t } = useI18n();
  const custom=value.barWidths?.length??0;
  return <details><summary>{t('engraving.bar_widths_summary')}</summary>
    <label><input type="checkbox" checked={design} onChange={event=>onDesign(event.target.checked)}/> {t('engraving.bar_widths_show_handles')}</label>
    <p className="muted">{t('engraving.bar_widths_help')}</p>
    {!honoured&&<p role="status" className="muted">{t('engraving.bar_widths_unhonoured')}</p>}
    <p role="status" className="muted">{custom ? (custom === 1 ? t('engraving.bar_widths_custom_one') : t('engraving.bar_widths_custom_many', { count: custom })) : t('engraving.bar_widths_default_all')}</p>
    <button type="button" {...busyGuard({busy,unavailable:!custom,onClick:()=>{if(value.barWidths?.length)onEdit({type:'setEngraving',engraving:withBarWidths(value,[])});}})}>{t('engraving.bar_widths_restore')}</button>
  </details>;
}
