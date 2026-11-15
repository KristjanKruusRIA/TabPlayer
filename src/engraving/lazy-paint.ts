/**
 * Which pieces of a laid-out score are drawn at once (THE-213, draw speed).
 *
 * alphaTab lays out the whole score and then paints it in pieces (one per system in the vertical layouts, one per few bars in the
 * horizontal one). With lazy loading on, it paints a piece only when the piece is on screen, and clears it again when it leaves.
 * The score area asks its browser which pieces are on screen one frame late; the draw therefore paints the pieces that are in
 * view itself, in the same turn as the layout, so a changed score is never shown blank or old for a frame. Everything else is
 * painted by alphaTab as it scrolls into view.
 */

/** The geometry of a laid-out piece, in pixels of alphaTab's canvas (its `partialLayoutFinished` event). */
export interface LayoutPartial {id:string;x:number;y:number;width:number;height:number;firstMasterBarIndex?:number;lastMasterBarIndex?:number}
export interface Box {left:number;top:number;right:number;bottom:number}

/** The positions (in layout order) of the pieces that intersect `view` (the score area, in the same coordinates as `canvas`, the canvas's own top left), widened by `margin` pixels on every side. */
export function visibleIndexes(partials:readonly LayoutPartial[],canvas:{left:number;top:number},view:Box,margin=0):number[] {
  const found:number[]=[];
  for(let index=0;index<partials.length;index++) {
    const piece=partials[index];
    if(!(piece.width>0)||!(piece.height>0))continue;
    const left=canvas.left+piece.x,top=canvas.top+piece.y;
    if(left>=view.right+margin||left+piece.width<=view.left-margin||top>=view.bottom+margin||top+piece.height<=view.top-margin)continue;
    found.push(index);
  }
  return found;
}
/** The ids of those pieces. */
export function visiblePartials(partials:readonly LayoutPartial[],canvas:{left:number;top:number},view:Box,margin=0):string[] {
  return visibleIndexes(partials,canvas,view,margin).map(index=>partials[index].id);
}
