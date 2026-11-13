/**
 * How far past the page's width the score area must grow before an automatic fit lets go. The area is measured without the vertical scrollbar,
 * and fitting can remove that scrollbar (about 17px on Windows), so the area can widen by a scrollbar when the fit starts. 24px is that plus a little slack:
 * a fit that starts at the page width cannot end by its own scrollbar going away.
 */
export const AUTO_FIT_RELEASE_MARGIN_PX=24;

/** Whether a page layout should fit its width by default: it starts when the page at `zoom` is wider than the area, and, once fitted, stays until the area is a margin wider. */
export function wantsAutoFit({pageWidth,zoom,available,fitted}:{pageWidth:number;zoom:number;available:number;fitted:boolean}):boolean {
  const page=pageWidth*zoom/100;
  return available<page+(fitted?AUTO_FIT_RELEASE_MARGIN_PX:0);
}
