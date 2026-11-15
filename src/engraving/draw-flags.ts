/**
 * How the score is drawn (THE-213, draw speed). Every field is on in the released app. In development, in tests and in the desktop test build
 * `globalThis.__tabplayerDrawFlags` is this object, so a driver can switch a change off and measure the old behaviour on the same build.
 */
export const drawFlags={
  /** Paint only the systems in view with the draw (the vertical live layouts); alphaTab paints the others as they scroll into view. */
  lazy:true,
  /**
   * How many times (16 ms each) a draw that paints only what is in view gives way to keys that are waiting before it runs anyway. Such a draw takes a few tens of milliseconds, and
   * what `isInputPending` reports while a key is typed held every draw back (see docs/validation/2026-11-15-the-213-draw-speed.md). The old behaviour is 6.
   */
  deferrals:0,
  /** The same for the layouts that still draw the whole score (the page layouts and the horizontal strip, 200 to 290 ms on a long score): a waiting key goes first. */
  completeDeferrals:6,
  /** The playback cursor has the system of its bar painted, and the highlight put back, before it highlights and scrolls (off: alphaTab paints it a frame later, blank for that frame). */
  paintOnCursor:true,
  /** Viewports of empty systems above and below the score area that are painted in the background after a draw and a scroll (0: none). */
  ahead:1,
};
/** Development, tests and the desktop test build: the flags, the draw check and the draw counts are reachable from outside. A release build has none of them. */
export const developerHooks=!!(import.meta.env.DEV||import.meta.env.MODE==='test'||import.meta.env.VITE_DESKTOP_TEST==='1');
if(developerHooks)(globalThis as {__tabplayerDrawFlags?:typeof drawFlags}).__tabplayerDrawFlags=drawFlags;
