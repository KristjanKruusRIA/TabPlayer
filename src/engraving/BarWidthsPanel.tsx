import type { EngravingCommand,EngravingOverrides } from './types';
import { withBarWidths } from './bar-widths';
import { busyGuard } from '../ui';

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
  const custom=value.barWidths?.length??0;
  return <details><summary>Design: bar widths</summary>
    <label><input type="checkbox" checked={design} onChange={event=>onDesign(event.target.checked)}/> Design mode: show bar width handles</label>
    <p className="muted">Drag the right edge of a bar to widen or narrow it, or focus a handle (Tab, then Left and Right move between bars) and press Shift+Left or Shift+Right to change it, Page Up or Page Down for larger steps, Delete for the default width. A bar's width is a share of its system, so the other bars in that system give or take the space. Each drag is one undo step. Widths do not move beats within a bar and never change timing.</p>
    {!honoured&&<p role="status" className="muted">This score layout spaces bars by itself, so widths show in the continuous and page layouts and in PDF, not here.</p>}
    <p role="status" className="muted">{custom?`${custom} ${custom===1?'bar has':'bars have'} a width set here.`:'Every bar has its default width.'} A score imported from Guitar Pro keeps the widths its file gave until you change a bar; Restore returns to those.</p>
    <button type="button" {...busyGuard({busy,unavailable:!custom,onClick:()=>{if(value.barWidths?.length)onEdit({type:'setEngraving',engraving:withBarWidths(value,[])});}})}>Restore default widths</button>
  </details>;
}
