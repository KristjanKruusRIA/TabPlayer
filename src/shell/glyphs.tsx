/** Small drawn marks for the shell. One grammar: a 16 unit box, 1.5 unit strokes with square ends (staff lines, fret wire),
 * solid shapes only for the two things that make sound: play and stop. Always decorative; the control around them is named. */
import type { SVGProps } from 'react';
const base:SVGProps<SVGSVGElement>={viewBox:'0 0 16 16',width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'square',strokeLinejoin:'miter','aria-hidden':true,focusable:'false'};
type Glyph=(props:SVGProps<SVGSVGElement>)=>React.JSX.Element;
export const PlayGlyph:Glyph=p=><svg {...base} {...p}><path d="M4.5 2.5v11l9-5.5z" fill="currentColor" stroke="none"/></svg>;
export const PauseGlyph:Glyph=p=><svg {...base} {...p}><path d="M5 3v10M11 3v10" strokeWidth={2.5}/></svg>;
export const StopGlyph:Glyph=p=><svg {...base} {...p}><path d="M3.5 3.5h9v9h-9z" fill="currentColor" stroke="none"/></svg>;
export const LoopGlyph:Glyph=p=><svg {...base} {...p}><path d="M3 6V4.5h10V6M13 10v1.5H3V10"/><path d="M11 2.5l2 2-2 2M5 9.5l-2 2 2 2"/></svg>;
export const MetronomeGlyph:Glyph=p=><svg {...base} {...p}><path d="M5.5 14l1.2-11h2.6l1.2 11z"/><path d="M8 11L11 4.5"/></svg>;
export const MinusGlyph:Glyph=p=><svg {...base} {...p}><path d="M4 8h8"/></svg>;
export const PlusGlyph:Glyph=p=><svg {...base} {...p}><path d="M4 8h8M8 4v8"/></svg>;
export const UndoGlyph:Glyph=p=><svg {...base} {...p}><path d="M6 3L3 6l3 3"/><path d="M3 6h6.5a3.5 3.5 0 010 7H7"/></svg>;
export const RedoGlyph:Glyph=p=><svg {...base} {...p}><path d="M10 3l3 3-3 3"/><path d="M13 6H6.5a3.5 3.5 0 000 7H9"/></svg>;
export const MoreGlyph:Glyph=p=><svg {...base} {...p}><path d="M4 6l4 4 4-4"/></svg>;
export const PanelLeftGlyph:Glyph=p=><svg {...base} {...p}><path d="M2.5 3.5h11v9h-11zM6.5 3.5v9"/></svg>;
export const PanelRightGlyph:Glyph=p=><svg {...base} {...p}><path d="M2.5 3.5h11v9h-11zM9.5 3.5v9"/></svg>;
export const PanelBottomGlyph:Glyph=p=><svg {...base} {...p}><path d="M2.5 3.5h11v9h-11zM2.5 9h11"/></svg>;
/** The app mark: six tab lines with one fretted note. */
export const MarkGlyph:Glyph=p=><svg {...base} width={18} height={18} strokeWidth={1} {...p}><path d="M1 2.5h14M1 4.7h14M1 6.9h14M1 9.1h14M1 11.3h14M1 13.5h14" opacity={.55}/><circle cx="9.5" cy="8" r="2.6" fill="var(--tp-on)" stroke="none"/></svg>;
export const FirstBarGlyph:Glyph=p=><svg {...base} {...p}><path d="M3.5 3v10"/><path d="M13 3.5v9L6 8z" fill="currentColor" stroke="none"/></svg>;
export const PreviousBarGlyph:Glyph=p=><svg {...base} {...p}><path d="M11.5 3.5v9L4.5 8z" fill="currentColor" stroke="none"/></svg>;
export const NextBarGlyph:Glyph=p=><svg {...base} {...p}><path d="M4.5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/></svg>;
export const LastBarGlyph:Glyph=p=><svg {...base} {...p}><path d="M12.5 3v10"/><path d="M3 3.5v9L10 8z" fill="currentColor" stroke="none"/></svg>;
/** The editing palette: a grid of note cells. */
export const PaletteGlyph:Glyph=p=><svg {...base} {...p}><path d="M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11"/></svg>;
/** Export and print: a page with a fold. */
export const ExportGlyph:Glyph=p=><svg {...base} {...p}><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M8 6.5v5M5.8 9.5L8 11.7l2.2-2.2"/></svg>;
/** The score view: five staff lines with a bar line. */
export const ScoreGlyph:Glyph=p=><svg {...base} {...p}><path d="M1.5 4h13M1.5 6.5h13M1.5 9h13M1.5 11.5h13M10.5 4v7.5" strokeWidth={1.2}/></svg>;
/** The sound rig: an amplifier face with two knobs. */
export const AmpGlyph:Glyph=p=><svg {...base} {...p}><path d="M2 3.5h12v9H2z"/><circle cx="5.5" cy="8" r="1.6"/><circle cx="10.5" cy="8" r="1.6"/></svg>;
/** The mixer: three faders. */
export const MixerGlyph:Glyph=p=><svg {...base} {...p}><path d="M4 2v12M8 2v12M12 2v12"/><path d="M2.5 10h3M6.5 5h3M10.5 8h3" strokeWidth={2.2}/></svg>;
/** The instrument view: a fretboard with frets and strings. */
export const FretboardGlyph:Glyph=p=><svg {...base} {...p}><path d="M1.5 4.5h13v7h-13z"/><path d="M5.5 4.5v7M9.5 4.5v7M1.5 8h13" strokeWidth={1}/></svg>;
/** Practice: a stopwatch. */
export const PracticeGlyph:Glyph=p=><svg {...base} {...p}><circle cx="8" cy="9" r="5"/><path d="M8 9V6.5M6.5 1.5h3M12 4.5l1-1"/></svg>;
